"""Cover upload tests."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def covers_client(client: TestClient, tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(covers_dir=str(tmp_path / "covers"))
    app.dependency_overrides[get_settings] = lambda: settings
    yield client
    app.dependency_overrides.pop(get_settings, None)


def test_upload_and_fetch_png(covers_client: TestClient) -> None:
    resp = covers_client.post("/api/covers", files={"file": ("c.png", PNG, "image/png")})
    assert resp.status_code == 201
    url = resp.json()["url"]
    assert url.startswith("/api/covers/") and url.endswith(".png")
    fetched = covers_client.get(url)
    assert fetched.status_code == 200
    assert fetched.content == PNG


def test_reject_non_image_even_with_image_type(covers_client: TestClient) -> None:
    resp = covers_client.post(
        "/api/covers", files={"file": ("evil.png", b"<script>alert(1)</script>", "image/png")}
    )
    assert resp.status_code == 422


def test_reject_empty_file(covers_client: TestClient) -> None:
    resp = covers_client.post("/api/covers", files={"file": ("e.png", b"", "image/png")})
    assert resp.status_code == 422


def test_unknown_or_traversal_names_404(covers_client: TestClient) -> None:
    assert covers_client.get("/api/covers/" + "a" * 32 + ".png").status_code == 404
    assert covers_client.get("/api/covers/..%2F..%2Fpyproject.toml").status_code == 404
