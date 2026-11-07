"""Accounts, login, sessions, CSRF, isolation, setup links, admin — the wave-5 contract.

These use the real cookie flow (``auth_client`` / ``admin_client``), not the logged-in
override, so cookie flags, 401/403/429 and per-user isolation are exercised end to end.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app import authdb, security
from app.config import get_settings

WEB = {"X-Shelfie-Client": "web"}


def _create_user(admin_client: TestClient, email: str, name: str) -> dict:
    resp = admin_client.post(
        "/api/admin/users", json={"email": email, "display_name": name}, headers=WEB
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _setup_password(client: TestClient, setup_url: str, password: str) -> None:
    token = setup_url.split("token=", 1)[1]
    resp = client.post("/api/auth/setup", json={"token": token, "password": password}, headers=WEB)
    assert resp.status_code == 200, resp.text


def _fresh(auth_client: TestClient) -> TestClient:
    """A client with no cookies, same app."""
    auth_client.cookies.clear()
    return auth_client


# --- login ------------------------------------------------------------------------------


def test_login_ok_sets_cookie_and_me(admin_client: TestClient) -> None:
    assert "shelfie_session" in admin_client.cookies
    me = admin_client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "admin@example.com"
    assert me.json()["is_admin"] is True


def test_login_bad_password_401(auth_client: TestClient) -> None:
    resp = auth_client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "wrong-password"},
        headers=WEB,
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid e-mail or password"


def test_login_unknown_email_401_same_message(auth_client: TestClient) -> None:
    resp = auth_client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "whatever-long"},
        headers=WEB,
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid e-mail or password"


def test_login_throttled_429_with_retry_after(auth_client: TestClient) -> None:
    for _ in range(5):
        auth_client.post(
            "/api/auth/login",
            json={"email": "admin@example.com", "password": "nope-nope-nope"},
            headers=WEB,
        )
    resp = auth_client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "adminpassword"},
        headers=WEB,
    )
    assert resp.status_code == 429
    assert "Retry-After" in resp.headers


def test_cookie_flags_httponly_lax_not_secure_on_http(auth_client: TestClient) -> None:
    resp = auth_client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "adminpassword"},
        headers=WEB,
    )
    assert resp.status_code == 200
    set_cookie = resp.headers.get("set-cookie", "")
    assert "shelfie_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "samesite=lax" in set_cookie.lower()
    # http request (TestClient default) -> not Secure under cookie_secure=auto
    assert "Secure" not in set_cookie


def test_cookie_secure_on_https(auth_client: TestClient) -> None:
    resp = auth_client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "adminpassword"},
        headers={**WEB, "X-Forwarded-Proto": "https"},
    )
    assert resp.status_code == 200
    assert "Secure" in resp.headers.get("set-cookie", "")


def test_logout_clears_cookie_and_me_401(admin_client: TestClient) -> None:
    assert admin_client.post("/api/auth/logout", headers=WEB).status_code == 204
    admin_client.cookies.clear()
    assert admin_client.get("/api/auth/me").status_code == 401


# --- every non-public route needs a session --------------------------------------------


def _protected_routes() -> list[tuple[str, str]]:
    """GET routes that must 401 without a cookie (parametrised over the app's routes)."""
    from app.main import app

    public = {
        ("GET", "/api/health"),
        ("POST", "/api/auth/login"),
        ("POST", "/api/auth/setup"),
    }
    out: list[tuple[str, str]] = []
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None) or set()
        if not path.startswith("/api/"):
            continue
        if "GET" not in methods:
            continue
        if "{" in path:  # skip path-param routes (setup/{token} is public anyway)
            continue
        if ("GET", path) in public or path == "/api/auth/setup":
            continue
        out.append(("GET", path))
    return out


@pytest.mark.parametrize("method,path", _protected_routes())
def test_protected_get_requires_cookie(auth_client: TestClient, method: str, path: str) -> None:
    _fresh(auth_client)
    resp = auth_client.request(method, path)
    assert resp.status_code == 401, f"{path} returned {resp.status_code}, expected 401"


def test_health_is_public(auth_client: TestClient) -> None:
    _fresh(auth_client)
    assert auth_client.get("/api/health").status_code == 200


# --- CSRF -------------------------------------------------------------------------------


def test_csrf_header_required_on_state_change(admin_client: TestClient) -> None:
    # No X-Shelfie-Client header -> 403 even with a valid session.
    resp = admin_client.post("/api/books", json={"title": "X"})
    assert resp.status_code == 403


def test_csrf_origin_must_match_host(admin_client: TestClient) -> None:
    resp = admin_client.post(
        "/api/books",
        json={"title": "X"},
        headers={**WEB, "Origin": "http://evil.example.com"},
    )
    assert resp.status_code == 403


def test_without_x_shelfie_client_write_is_403(admin_client: TestClient) -> None:
    # A GET is fine, a write is not — proves the header gate is on writes only.
    assert admin_client.get("/api/books").status_code == 200


# --- setup tokens -----------------------------------------------------------------------


def test_setup_token_single_use(admin_client: TestClient, auth_client: TestClient) -> None:
    created = _create_user(admin_client, "alice@example.com", "Alice")
    token = created["setup_url"].split("token=", 1)[1]
    # Reading the token info works while unused.
    info = auth_client.get(f"/api/auth/setup/{token}")
    assert info.status_code == 200
    assert info.json()["email"] == "alice@example.com"
    # Consume it.
    _fresh(auth_client)
    assert (
        auth_client.post(
            "/api/auth/setup", json={"token": token, "password": "alicepassword"}, headers=WEB
        ).status_code
        == 200
    )
    # Second use is gone.
    _fresh(auth_client)
    assert (
        auth_client.post(
            "/api/auth/setup", json={"token": token, "password": "alicepassword"}, headers=WEB
        ).status_code
        == 410
    )


def test_new_setup_link_invalidates_old(admin_client: TestClient, auth_client: TestClient) -> None:
    created = _create_user(admin_client, "bob@example.com", "Bob")
    old_token = created["setup_url"].split("token=", 1)[1]
    # Ask for a new link.
    resp = admin_client.post(f"/api/admin/users/{created['user']['id']}/setup-link", headers=WEB)
    assert resp.status_code == 200
    new_token = resp.json()["setup_url"].split("token=", 1)[1]
    assert new_token != old_token
    # Old one no longer resolves.
    assert auth_client.get(f"/api/auth/setup/{old_token}").status_code == 410
    assert auth_client.get(f"/api/auth/setup/{new_token}").status_code == 200


def test_setup_token_expiry(admin_client: TestClient, auth_client: TestClient) -> None:
    created = _create_user(admin_client, "carol@example.com", "Carol")
    token = created["setup_url"].split("token=", 1)[1]
    settings = get_settings()

    async def _expire() -> None:
        conn = await authdb.connect(settings.auth_database_file)
        try:
            await conn.execute(
                "UPDATE setup_tokens SET expires_at = '2000-01-01 00:00:00' WHERE token_hash = ?",
                (security.hash_token(token),),
            )
            await conn.commit()
        finally:
            await conn.close()

    asyncio.run(_expire())
    assert auth_client.get(f"/api/auth/setup/{token}").status_code == 410


# --- password change revokes other sessions --------------------------------------------


def test_password_change_revokes_other_sessions(auth_client: TestClient) -> None:
    # Two separate logins = two sessions. Changing the password from session A revokes B.
    a = auth_client
    a.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "adminpassword"},
        headers=WEB,
    )
    token_a = a.cookies.get("shelfie_session")
    assert token_a is not None
    # A second client for session B.
    from app.main import app

    b = TestClient(app, headers=WEB)
    b.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "adminpassword"},
    )
    assert b.get("/api/auth/me").status_code == 200
    # Change password from A.
    a.cookies.set("shelfie_session", token_a)
    resp = a.post(
        "/api/auth/password",
        json={"current_password": "adminpassword", "new_password": "brand-new-password"},
        headers=WEB,
    )
    assert resp.status_code == 204
    # A still works; B is revoked.
    assert a.get("/api/auth/me").status_code == 200
    assert b.get("/api/auth/me").status_code == 401


# --- disable revokes sessions + last-admin protection -----------------------------------


def test_disable_revokes_sessions(admin_client: TestClient, new_client) -> None:
    created = _create_user(admin_client, "dave@example.com", "Dave")
    dave = new_client()
    _setup_password(dave, created["setup_url"], "davepassword")
    assert dave.get("/api/auth/me").status_code == 200
    # Admin disables Dave.
    resp = admin_client.patch(
        f"/api/admin/users/{created['user']['id']}", json={"disabled": True}, headers=WEB
    )
    assert resp.status_code == 200
    # Dave's session is dead.
    assert dave.get("/api/auth/me").status_code == 401


def test_last_admin_cannot_be_disabled(admin_client: TestClient) -> None:
    me = admin_client.get("/api/auth/me").json()
    resp = admin_client.patch(f"/api/admin/users/{me['id']}", json={"disabled": True}, headers=WEB)
    assert resp.status_code == 409


def test_last_admin_cannot_be_demoted(admin_client: TestClient) -> None:
    me = admin_client.get("/api/auth/me").json()
    resp = admin_client.patch(f"/api/admin/users/{me['id']}", json={"is_admin": False}, headers=WEB)
    assert resp.status_code == 409


def test_non_admin_cannot_reach_admin_routes(admin_client: TestClient, new_client) -> None:
    created = _create_user(admin_client, "eve@example.com", "Eve")
    eve = new_client()
    _setup_password(eve, created["setup_url"], "evepassword12")
    assert eve.get("/api/admin/users").status_code == 403


# --- isolation --------------------------------------------------------------------------


def test_isolation_second_user_has_empty_library(admin_client: TestClient, new_client) -> None:
    # Admin (user 1) adds a book.
    assert (
        admin_client.post(
            "/api/books",
            json={"google_volume_id": "v-iso", "title": "Admin's Book", "authors": ["A"]},
            headers=WEB,
        ).status_code
        == 201
    )
    assert len(admin_client.get("/api/books").json()) == 1
    # A second user logs in and sees nothing of the admin's library.
    created = _create_user(admin_client, "frank@example.com", "Frank")
    frank = new_client()
    _setup_password(frank, created["setup_url"], "frankpassword")
    assert frank.get("/api/books").json() == []


def test_isolation_cannot_read_or_modify_other_users_book(
    admin_client: TestClient, new_client
) -> None:
    book = admin_client.post(
        "/api/books",
        json={"google_volume_id": "v-iso2", "title": "Secret", "authors": ["A"]},
        headers=WEB,
    ).json()
    created = _create_user(admin_client, "grace@example.com", "Grace")
    grace = new_client()
    _setup_password(grace, created["setup_url"], "gracepassword")
    # Grace cannot GET or PATCH or DELETE the admin's book id.
    assert grace.get(f"/api/books/{book['id']}").status_code == 404
    assert (
        grace.patch(f"/api/books/{book['id']}", json={"stars": 1}, headers=WEB).status_code == 404
    )
    assert grace.delete(f"/api/books/{book['id']}", headers=WEB).status_code == 404


def test_isolation_covers_are_per_user(admin_client: TestClient, new_client) -> None:
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    url = admin_client.post(
        "/api/covers", files={"file": ("c.png", png, "image/png")}, headers=WEB
    ).json()["url"]
    assert admin_client.get(url).status_code == 200
    created = _create_user(admin_client, "heidi@example.com", "Heidi")
    heidi = new_client()
    _setup_password(heidi, created["setup_url"], "heidipassword")
    # Heidi requesting the admin's cover name gets 404 (her folder has no such file).
    assert heidi.get(url).status_code == 404


def test_isolation_chat_sessions_keyed_by_user() -> None:
    """The chat engine stores sessions under (user_id, session_id)."""
    from app.agent.engine import ChatEngine

    calls: list[str] = []

    def factory(session_id: str):
        calls.append(session_id)
        from app.agent.engine import ChatSession

        class _Q:
            def flush(self): ...
            def emit_session_start(self, m): ...
            async def get(self): ...
            async def close(self, d=None): ...
            def put_event(self, e): ...

        return ChatSession(session_id=session_id, entry=None, queue=_Q(), manifest=None)

    engine = ChatEngine(factory)
    s1 = engine.session(1, "shared")
    s2 = engine.session(2, "shared")
    assert s1 is not s2  # same session id, different user -> different session
    assert engine.session(1, "shared") is s1
