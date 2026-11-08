"""Self-registration, profile edit and the public auth config."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

WEB = {"X-Shelfie-Client": "web"}


def _fresh(client: TestClient) -> TestClient:
    client.cookies.clear()
    return client


def test_config_is_public(auth_client: TestClient) -> None:
    _fresh(auth_client)
    resp = auth_client.get("/api/auth/config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["registration_enabled"] is True
    assert body["password_min_length"] == 8


def test_register_creates_empty_non_admin_and_logs_in(auth_client: TestClient) -> None:
    _fresh(auth_client)
    resp = auth_client.post(
        "/api/auth/register",
        json={"email": "Ola@Example.com", "display_name": "Ola", "password": "secret-pass"},
        headers=WEB,
    )
    assert resp.status_code == 201, resp.text
    user = resp.json()
    assert user["email"] == "ola@example.com"
    assert user["is_admin"] is False
    assert "shelfie_session" in resp.cookies or auth_client.cookies.get("shelfie_session")
    me = auth_client.get("/api/auth/me")
    assert me.status_code == 200 and me.json()["email"] == "ola@example.com"
    books = auth_client.get("/api/books")
    assert books.status_code == 200
    payload = books.json()
    items = payload if isinstance(payload, list) else payload.get("items", payload.get("books", []))
    assert items == []
    admin = auth_client.get("/api/admin/users")
    assert admin.status_code == 403


def test_register_duplicate_email_is_409(auth_client: TestClient) -> None:
    _fresh(auth_client)
    body = {"email": "admin@example.com", "display_name": "X", "password": "secret-pass"}
    resp = auth_client.post("/api/auth/register", json=body, headers=WEB)
    assert resp.status_code == 409


def test_register_weak_password_is_422(auth_client: TestClient) -> None:
    _fresh(auth_client)
    body = {"email": "weak@example.com", "display_name": "W", "password": "short"}
    resp = auth_client.post("/api/auth/register", json=body, headers=WEB)
    assert resp.status_code == 422


def test_register_needs_client_header(auth_client: TestClient) -> None:
    _fresh(auth_client)
    body = {"email": "nohdr@example.com", "display_name": "N", "password": "secret-pass"}
    resp = auth_client.post("/api/auth/register", json=body)
    assert resp.status_code == 403


def test_register_closed(auth_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "registration_enabled", False)
    _fresh(auth_client)
    body = {"email": "closed@example.com", "display_name": "C", "password": "secret-pass"}
    resp = auth_client.post("/api/auth/register", json=body, headers=WEB)
    assert resp.status_code == 403


def test_update_own_display_name(admin_client: TestClient) -> None:
    resp = admin_client.patch("/api/auth/me", json={"display_name": "  New Name "}, headers=WEB)
    assert resp.status_code == 200, resp.text
    assert resp.json()["display_name"] == "New Name"
    assert admin_client.get("/api/auth/me").json()["display_name"] == "New Name"


def test_update_profile_needs_login(auth_client: TestClient) -> None:
    _fresh(auth_client)
    resp = auth_client.patch("/api/auth/me", json={"display_name": "X"}, headers=WEB)
    assert resp.status_code == 401
