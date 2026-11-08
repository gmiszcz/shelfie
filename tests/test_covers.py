"""Cover upload tests. Covers are stored under the current user's covers/ folder."""

from __future__ import annotations

from fastapi.testclient import TestClient

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def test_upload_and_fetch_png(client: TestClient) -> None:
    resp = client.post("/api/covers", files={"file": ("c.png", PNG, "image/png")})
    assert resp.status_code == 201
    url = resp.json()["url"]
    assert url.startswith("/api/covers/") and url.endswith(".png")
    fetched = client.get(url)
    assert fetched.status_code == 200
    assert fetched.content == PNG


def test_reject_non_image_even_with_image_type(client: TestClient) -> None:
    resp = client.post(
        "/api/covers", files={"file": ("evil.png", b"<script>alert(1)</script>", "image/png")}
    )
    assert resp.status_code == 422
