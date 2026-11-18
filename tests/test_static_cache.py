"""Cache headers on the built frontend: the HTML shell revalidates, hashed assets are immutable."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import SpaStaticFiles


def _client(tmp_path: Path) -> TestClient:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>shell</html>", encoding="utf-8")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    app = FastAPI()
    app.mount("/", SpaStaticFiles(directory=str(tmp_path), html=True), name="static")
    return TestClient(app)


def test_html_shell_must_revalidate(tmp_path: Path) -> None:
    client = _client(tmp_path)
    for url in ("/", "/index.html", "/series"):  # /series is a client route -> index.html
        resp = client.get(url)
        assert resp.status_code == 200
        assert resp.headers["cache-control"] == "no-cache"


def test_hashed_assets_are_immutable(tmp_path: Path) -> None:
    resp = _client(tmp_path).get("/assets/index-abc123.js")
    assert resp.status_code == 200
    assert "immutable" in resp.headers["cache-control"]


def test_missing_asset_is_still_404(tmp_path: Path) -> None:
    assert _client(tmp_path).get("/assets/gone.js").status_code == 404
