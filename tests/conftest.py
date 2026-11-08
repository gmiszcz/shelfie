"""Test fixtures: a logged-in test user with an isolated temp data folder.

Since wave 5 every protected route resolves the CURRENT user's library through the
per-user data context. The ``client`` fixture therefore stands up a temp data root, a test
admin (id 1) with their own ``data/users/1/`` folder, overrides ``current_user`` to that
user (setting the context var per request) and ``db_connection`` to that user's SQLite —
so every existing test runs exactly as a logged-in person against their own data.

``auth_client`` is the un-overridden app (real cookie flow) for the auth/admin/isolation
tests. ``make_user`` creates extra users and logs them in with a real session cookie.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import aiosqlite
import pytest
from fastapi.testclient import TestClient

from app import authdb
from app.api.deps import current_user, db_connection, google_books_client
from app.authdb import AuthUser
from app.config import get_settings
from app.db import get_connection, init_db
from app.integrations.google_books import GoogleBooksClient
from app.main import app
from app.schemas.books import VolumeSearchResult
from app.userdata import UserData, set_current_user_data

TEST_USER_ID = 1


@pytest.fixture(autouse=True, scope="session")
def _fast_password_hash() -> Iterator[None]:
    """Use cheap argon2 parameters for the whole test session.

    argon2's defaults are deliberately slow (~50-100 ms per hash); the auth/isolation tests
    run many logins and setups, so the real parameters would make the suite minutes long.
    This only changes the cost used during tests, never the stored format or production.
    """
    from argon2 import PasswordHasher

    from app import security

    security.configure_hasher(
        PasswordHasher(time_cost=1, memory_cost=8, parallelism=1, hash_len=16, salt_len=8)
    )
    yield


@pytest.fixture(autouse=True)
def _no_bedrock_enrichment(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """Disable Bedrock enrichment, neutralise the Google Books budget, isolate caches.

    (Unchanged in intent from before auth; see the per-test comment history.) ``get_settings``
    is lru-cached, so we flip the fields on the single cached instance for each test.

    Also makes the series release-research model build raise immediately: a watch-toggle or
    ``/series/check`` schedules ``research_series_releases`` as a background task, which (unless
    a test injects ``research_fn``) would build a real Bedrock model and block on the network.
    Raising here sends ``research_next_volumes`` straight into its all-unknown fallback, so no
    test ever calls AWS. Tests that inject their own ``model=`` never reach ``_build_model``.
    """
    from app.agent import series_research
    from app.integrations import google_books

    settings = get_settings()

    def _no_model(_settings: object) -> object:
        raise RuntimeError("Bedrock model build disabled in tests")

    series_research._build_model = _no_model  # type: ignore[assignment]

    cache_root = tmp_path_factory.mktemp("caches")
    original = {
        "enrichment_enabled": settings.enrichment_enabled,
        "google_books_max_calls": settings.google_books_max_calls,
        "google_books_cache_dir": settings.google_books_cache_dir,
        "web_cache_dir": settings.web_cache_dir,
    }
    settings.enrichment_enabled = False
    if settings.google_books_max_calls < 50:
        settings.google_books_max_calls = 50
    settings.google_books_cache_dir = str(cache_root / "google_books")
    settings.web_cache_dir = str(cache_root / "web")
    google_books._reset_call_count()
    yield
    for key, value in original.items():
        setattr(settings, key, value)
    google_books._reset_call_count()


class FakeGoogleBooksClient(GoogleBooksClient):
    """Returns canned results without any network call."""

    def __init__(self, results: list[VolumeSearchResult] | None = None) -> None:
        super().__init__(base_url="http://fake")
        self.results = results or [
            VolumeSearchResult(
                google_volume_id="vol-dune",
                title="Dune",
                authors=["Frank Herbert"],
                published_date="1965",
                description="Desert planet epic.",
                isbn_13="9780441013593",
                cover_url="https://example.test/dune.jpg",
            )
        ]

    async def search(self, query: str, max_results: int = 20, lang: str | None = None):
        return len(self.results), list(self.results)


@pytest.fixture
def data_root(tmp_path: Path) -> Iterator[Path]:
    """A temp data root; the auth DB and per-user folders live under it for one test."""
    root = tmp_path / "data"
    root.mkdir(parents=True, exist_ok=True)
    settings = get_settings()
    original = {
        "data_dir": settings.data_dir,
        "auth_db_path": settings.auth_db_path,
        "cookie_secure": settings.cookie_secure,
    }
    settings.data_dir = str(root)
    settings.auth_db_path = str(root / "auth.sqlite")
    settings.cookie_secure = "auto"  # independent of the worktree .env
    yield root
    settings.data_dir = original["data_dir"]
    settings.auth_db_path = original["auth_db_path"]
    settings.cookie_secure = original["cookie_secure"]


@pytest.fixture
def test_user_data(data_root: Path) -> UserData:
    ud = UserData.for_user(data_root, TEST_USER_ID)
    ud.ensure_dirs()
    return ud


@pytest.fixture
def db_file(test_user_data: UserData) -> Path:
    return test_user_data.database_file


@pytest.fixture
def fake_books() -> FakeGoogleBooksClient:
    return FakeGoogleBooksClient()


@pytest.fixture
def client(
    data_root: Path,
    test_user_data: UserData,
    fake_books: FakeGoogleBooksClient,
) -> Iterator[TestClient]:
    """A logged-in test client: current_user is the test admin, data is the temp folder."""
    db_target = test_user_data.database_file
    test_user = AuthUser(
        id=TEST_USER_ID,
        email="test@example.com",
        display_name="Test User",
        is_admin=True,
        has_password=True,
    )

    async def override_db() -> AsyncIterator[aiosqlite.Connection]:
        async for conn in get_connection(db_target):
            yield conn

    async def override_current_user() -> AuthUser:
        set_current_user_data(test_user_data)
        return test_user

    def override_books() -> GoogleBooksClient:
        return fake_books

    app.dependency_overrides[db_connection] = override_db
    app.dependency_overrides[current_user] = override_current_user
    app.dependency_overrides[google_books_client] = override_books

    from app.api.routes import transcribe as transcribe_route

    def ws_auth(_ws: object) -> AuthUser:
        set_current_user_data(test_user_data)
        return test_user

    transcribe_route.set_ws_authenticator(ws_auth)

    import asyncio

    asyncio.run(init_db(db_target))

    with TestClient(app, headers={"X-Shelfie-Client": "web"}) as test_client:
        yield test_client

    transcribe_route.set_ws_authenticator(None)
    app.dependency_overrides.clear()


# --- real cookie-flow fixtures (auth / admin / isolation tests) -------------------------


@pytest.fixture
def auth_client(data_root: Path, fake_books: FakeGoogleBooksClient) -> Iterator[TestClient]:
    """The app with NO auth override — exercises the real session-cookie flow.

    Only the Google Books client is faked (no network). An admin (id 1) exists with a known
    password so tests can log in; extra users are created via ``make_user``.
    """

    def override_books() -> GoogleBooksClient:
        return fake_books

    app.dependency_overrides[google_books_client] = override_books

    import asyncio

    settings = get_settings()

    async def _seed() -> None:
        from app.services import auth_service

        await authdb.init_auth_db(settings.auth_database_file)
        conn = await authdb.connect(settings.auth_database_file)
        try:
            admin = await auth_service.create_account(
                conn,
                settings,
                email="admin@example.com",
                display_name="Admin",
                is_admin=True,
                user_id=1,
            )
            from app import security

            await authdb.set_password(conn, admin.id, security.hash_password("adminpassword"))
        finally:
            await conn.close()

    asyncio.run(_seed())

    with TestClient(app) as test_client:
        yield test_client

    app.dependency_overrides.clear()


def _login(test_client: TestClient, email: str, password: str) -> TestClient:
    resp = test_client.post(
        "/api/auth/login",
        json={"email": email, "password": password},
        headers={"X-Shelfie-Client": "web"},
    )
    assert resp.status_code == 200, resp.text
    return test_client


@pytest.fixture
def admin_client(auth_client: TestClient) -> TestClient:
    """A client logged in as the seeded admin (session cookie set)."""
    return _login(auth_client, "admin@example.com", "adminpassword")


@pytest.fixture
def new_client() -> Iterator[object]:
    """Factory for additional TestClients with their own cookie jar (same app).

    Used so a user's login/setup flow does not overwrite the admin client's session
    cookie (TestClients share a cookie jar only if they are the same instance).
    """
    created: list[TestClient] = []

    def make() -> TestClient:
        c = TestClient(app, headers={"X-Shelfie-Client": "web"})
        created.append(c)
        return c

    yield make
    for c in created:
        c.close()


@pytest.fixture(autouse=True)
def _no_openlibrary_cover_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hermetic tests: the OpenLibrary cover-by-ISBN fallback never reaches the network.

    A test that needs a cover patches ``openlibrary.cover_by_isbn`` itself (later patch wins).
    """
    from app.integrations import openlibrary

    async def _none(isbn: str | None, client: object = None) -> None:
        return None

    monkeypatch.setattr(openlibrary, "cover_by_isbn", _none)
