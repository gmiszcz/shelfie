"""Voice input: a WebSocket that streams microphone PCM to Amazon Transcribe.

Protocol (client -> server):
    1. A JSON text frame to start:  {"action": "start", "language": "pl-PL"}
       (language optional; falls back to the pl-PL default).
    2. Binary frames of raw PCM audio (16-bit LE, 16 kHz, mono).
    3. A JSON text frame to stop:   {"action": "stop"}  (or just close).

Server -> client (JSON text frames):
    {"type": "ready",   "language": "pl-PL"}
    {"type": "partial", "text": "..."}
    {"type": "final",   "text": "..."}
    {"type": "error",   "message": "..."}

The real AWS streamer is injected via a module-level factory so tests can swap
in a fake without any AWS call.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.services import transcribe as svc
from app.services.transcribe import TranscribeStreamer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/transcribe", tags=["transcribe"])

# Overridable seam: returns a fresh streamer per connection. Tests replace this.
_streamer_factory: Callable[[], TranscribeStreamer] | None = None


def set_streamer_factory(factory: Callable[[], TranscribeStreamer] | None) -> None:
    """Install (or clear) the streamer factory used by the WebSocket route."""
    global _streamer_factory
    _streamer_factory = factory


def _build_streamer() -> TranscribeStreamer:
    if _streamer_factory is not None:
        return _streamer_factory()
    return svc.AwsTranscribeStreamer(get_settings().aws_region)


@router.websocket("/stream")
async def transcribe_stream(ws: WebSocket) -> None:
    await ws.accept()

    audio: asyncio.Queue[bytes | None] = asyncio.Queue()
    language = svc.DEFAULT_LANGUAGE
    started = False

    async def audio_chunks() -> AsyncIterator[bytes]:
        while (chunk := await audio.get()) is not None:
            yield chunk

    async def on_result(message: dict[str, str]) -> None:
        await ws.send_text(json.dumps(message, ensure_ascii=False))

    transcription: asyncio.Task[None] | None = None
    try:
        while True:
            event = await ws.receive()
            if event["type"] == "websocket.disconnect":
                break

            text = event.get("text")
            if text is not None:
                try:
                    control = json.loads(text)
                except json.JSONDecodeError:
                    continue
                action = control.get("action")
                if action == "start" and not started:
                    language = svc.normalize_language(control.get("language"))
                    started = True
                    await ws.send_text(
                        json.dumps({"type": "ready", "language": language}, ensure_ascii=False)
                    )
                    transcription = asyncio.create_task(
                        svc.run_transcription(
                            _build_streamer(),
                            audio_chunks(),
                            language=language,
                            on_result=on_result,
                        )
                    )
                elif action == "stop":
                    await audio.put(None)
                    break
                continue

            data = event.get("bytes")
            if data is not None and started:
                await audio.put(data)
    except WebSocketDisconnect:
        pass
    finally:
        await audio.put(None)
        if transcription is not None:
            try:
                await asyncio.wait_for(transcription, timeout=10)
            except (TimeoutError, asyncio.CancelledError):
                transcription.cancel()
        try:
            await ws.close()
        except RuntimeError:
            pass  # already closed
