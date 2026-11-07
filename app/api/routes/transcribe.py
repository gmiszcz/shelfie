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

from app import authdb
from app.config import get_settings
from app.services import auth_service
from app.services import transcribe as svc
from app.services.auth_service import SESSION_COOKIE
from app.services.transcribe import TranscribeStreamer
from app.userdata import UserData, set_current_user_data

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


# Overridable seam for the handshake auth. Returns the authenticated user and sets the
# per-user data context, or None to reject. Tests (the logged-in ``client`` fixture) install
# a stub that returns the test user without a real session; production uses the cookie flow.
_ws_authenticator: Callable[[WebSocket], object] | None = None


def set_ws_authenticator(func: Callable[[WebSocket], object] | None) -> None:
    global _ws_authenticator
    _ws_authenticator = func


async def _authenticate_ws(ws: WebSocket) -> object | None:
    """Resolve the session cookie to a user and set the per-user data context.

    Returns the user (truthy) on success, ``None`` when the cookie is missing/invalid.
    """
    if _ws_authenticator is not None:
        return _ws_authenticator(ws)
    settings = get_settings()
    token = ws.cookies.get(SESSION_COOKIE)
    auth_conn = await authdb.connect(settings.auth_database_file)
    try:
        user = await auth_service.resolve_session(auth_conn, settings, token)
    finally:
        await auth_conn.close()
    if user is None:
        return None
    user_data = UserData.for_user(settings.data_path, user.id)
    user_data.ensure_dirs()
    set_current_user_data(user_data)
    return user


@router.websocket("/stream")
async def transcribe_stream(ws: WebSocket) -> None:
    # WebSocket handshake auth: the session cookie must resolve to an active user, or we
    # close with 4401 before accepting (docs/features/auth.md). Sets the per-user context.
    user = await _authenticate_ws(ws)
    if not user:
        await ws.close(code=4401)
        return

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
