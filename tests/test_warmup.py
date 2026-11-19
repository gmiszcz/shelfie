"""The free warm-up route: needs a login, runs its steps once, makes no network call."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.services import warmup


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    monkeypatch.setattr(warmup, "_done", False)
    monkeypatch.setattr(warmup, "_warm_transcribe", lambda _s: calls.append("transcribe"))
    monkeypatch.setattr(warmup, "_warm_agent", lambda: calls.append("agent"))
    return calls


def test_warmup_requires_login(auth_client: TestClient, _no_network: list[str]) -> None:
    resp = auth_client.post("/api/warmup", headers={"X-Shelfie-Client": "web"})
    assert resp.status_code == 401
    assert _no_network == []


def test_warmup_runs_each_step_once(client: TestClient, _no_network: list[str]) -> None:
    first = client.post("/api/warmup")
    assert first.status_code == 200
    assert set(first.json()["timings_ms"]) == {"transcribe", "agent"}
    assert client.post("/api/warmup").json() == {"timings_ms": {}}
    assert _no_network == ["transcribe", "agent"]


def test_a_failing_step_does_not_break_the_route(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(_s: object) -> None:
        raise OSError("offline")

    monkeypatch.setattr(warmup, "_warm_transcribe", boom)
    resp = client.post("/api/warmup")
    assert resp.status_code == 200
    assert "agent" in resp.json()["timings_ms"]
