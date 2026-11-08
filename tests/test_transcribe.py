"""Voice transcription: service logic and the WebSocket route (mocked Transcribe)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app.api.routes import transcribe as route
from app.services import transcribe as svc
from app.services.transcribe import Transcript


def test_normalize_language() -> None:
    assert svc.normalize_language("pl-PL") == "pl-PL"
    assert svc.normalize_language("en-US") == "en-US"
    assert svc.normalize_language(None) == "pl-PL"
    assert svc.normalize_language("de-DE") == "pl-PL"  # unsupported -> default


def test_transcript_to_message() -> None:
    assert Transcript("hi", is_final=False).to_message() == {"type": "partial", "text": "hi"}
    assert Transcript("done", is_final=True).to_message() == {"type": "final", "text": "done"}


class FakeStreamer:
    """A TranscribeStreamer that drains the audio then emits canned results."""

    def __init__(self, results: list[Transcript]) -> None:
        self.results = results
        self.language: str | None = None
        self.audio_bytes = 0

    async def transcribe(
        self, audio_chunks: AsyncIterator[bytes], *, language: str
    ) -> AsyncIterator[Transcript]:
        self.language = language
        async for chunk in audio_chunks:
            self.audio_bytes += len(chunk)
        for result in self.results:
            yield result


async def test_run_transcription_delivers_results() -> None:
    streamer = FakeStreamer([Transcript("czesc", False), Transcript("cześć świat", True)])

    async def audio() -> AsyncIterator[bytes]:
        yield b"\x00\x01"
        yield b"\x02\x03"

    out: list[dict[str, str]] = []

    async def collect(message: dict[str, str]) -> None:
        out.append(message)

    await svc.run_transcription(streamer, audio(), language="pl-PL", on_result=collect)

    assert streamer.language == "pl-PL"
    assert streamer.audio_bytes == 4
    assert out == [
        {"type": "partial", "text": "czesc"},
        {"type": "final", "text": "cześć świat"},
    ]


async def test_run_transcription_reports_error_once() -> None:
    class Boom:
        async def transcribe(
            self, audio_chunks: AsyncIterator[bytes], *, language: str
        ) -> AsyncIterator[Transcript]:
            raise RuntimeError("transcribe exploded")
            yield Transcript("", True)  # pragma: no cover - makes this an async generator

    async def audio() -> AsyncIterator[bytes]:
        yield b"x"

    out: list[dict[str, str]] = []

    async def collect(message: dict[str, str]) -> None:
        out.append(message)

    await svc.run_transcription(Boom(), audio(), language="pl-PL", on_result=collect)
    assert out == [{"type": "error", "message": "RuntimeError: transcribe exploded"}]


@pytest.fixture
def streamer() -> FakeStreamer:
    return FakeStreamer([Transcript("hello", False), Transcript("hello world", True)])


def test_websocket_streams_transcripts(client: TestClient, streamer: FakeStreamer) -> None:
    route.set_streamer_factory(lambda: streamer)
    try:
        with client.websocket_connect("/api/transcribe/stream") as ws:
            ws.send_json({"action": "start", "language": "en-US"})
            assert ws.receive_json() == {"type": "ready", "language": "en-US"}
            ws.send_bytes(b"\x00\x01\x02\x03")
            ws.send_json({"action": "stop"})
            assert ws.receive_json() == {"type": "partial", "text": "hello"}
            assert ws.receive_json() == {"type": "final", "text": "hello world"}
    finally:
        route.set_streamer_factory(None)
    assert streamer.language == "en-US"
    assert streamer.audio_bytes == 4


def test_websocket_defaults_to_pl_pl(client: TestClient, streamer: FakeStreamer) -> None:
    route.set_streamer_factory(lambda: streamer)
    try:
        with client.websocket_connect("/api/transcribe/stream") as ws:
            ws.send_json({"action": "start"})
            assert ws.receive_json() == {"type": "ready", "language": "pl-PL"}
            ws.send_json({"action": "stop"})
    finally:
        route.set_streamer_factory(None)
    assert streamer.language == "pl-PL"


class CompletionTrackingStreamer:
    """Records whether the audio generator was fully drained (clean close)."""

    def __init__(self) -> None:
        self.completed = False

    async def transcribe(
        self, audio_chunks: AsyncIterator[bytes], *, language: str
    ) -> AsyncIterator[Transcript]:
        async for _chunk in audio_chunks:
            pass
        self.completed = True
        yield Transcript("done", is_final=True)


def test_websocket_closes_stream_cleanly_on_stop(client: TestClient) -> None:
    """A `stop` drains the audio generator to its end — no dangling stream."""
    streamer = CompletionTrackingStreamer()
    route.set_streamer_factory(lambda: streamer)
    try:
        with client.websocket_connect("/api/transcribe/stream") as ws:
            ws.send_json({"action": "start", "language": "en-US"})
            assert ws.receive_json() == {"type": "ready", "language": "en-US"}
            ws.send_bytes(b"\x00\x01")
            ws.send_json({"action": "stop"})
            assert ws.receive_json() == {"type": "final", "text": "done"}
    finally:
        route.set_streamer_factory(None)
    # The generator saw the sentinel (None) and returned: the stream is closed.
    assert streamer.completed is True


def test_websocket_closes_stream_cleanly_on_disconnect(client: TestClient) -> None:
    """Closing the socket without an explicit stop still drains the stream."""
    streamer = CompletionTrackingStreamer()
    route.set_streamer_factory(lambda: streamer)
    try:
        with client.websocket_connect("/api/transcribe/stream") as ws:
            ws.send_json({"action": "start"})
            assert ws.receive_json() == {"type": "ready", "language": "pl-PL"}
            ws.send_bytes(b"\x00\x01\x02\x03")
            # Leaving the context closes the socket (no "stop" frame sent).
    finally:
        route.set_streamer_factory(None)
    assert streamer.completed is True


class HangingStreamer:
    """Never completes on its own — must be cancelled when audio ends."""

    def __init__(self) -> None:
        self.cancelled = False

    async def transcribe(
        self, audio_chunks: AsyncIterator[bytes], *, language: str
    ) -> AsyncIterator[Transcript]:
        async for _chunk in audio_chunks:
            pass
        try:
            await asyncio.Event().wait()  # block forever
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        yield Transcript("", is_final=True)  # pragma: no cover


def test_run_transcription_cancels_a_hanging_stream() -> None:
    """run_transcription awaited with a timeout cancels a stream that hangs."""
    streamer = HangingStreamer()

    async def audio() -> AsyncIterator[bytes]:
        yield b"x"

    async def collect(_message: dict[str, str]) -> None:  # pragma: no cover - none emitted
        pass

    async def drive() -> None:
        task = asyncio.create_task(
            svc.run_transcription(streamer, audio(), language="pl-PL", on_result=collect)
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(drive())
    assert streamer.cancelled is True
