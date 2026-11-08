"""Library assistant chat: one POST = one agent invocation streamed as Server-Sent Events."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import APIRouter, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.deps import Chat, CurrentAuthUser

router = APIRouter(prefix="/agent", tags=["agent"])


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    session_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    #: "library" (default, full read+write data assistant) or "library_readonly"
    #: (answer-only: the write tools are pruned server-side). The legacy "ui" value is
    #: accepted and treated as "library" (the UI-control scope was removed). The UI
    #: agent's ask_librarian tool uses "library_readonly".
    scope: Literal["library", "library_readonly", "ui"] = "library"


@router.post("/chat")
async def chat(data: ChatIn, engine: Chat, user: CurrentAuthUser) -> StreamingResponse:
    async def events() -> AsyncIterator[str]:
        try:
            async for event in engine.stream(user.id, data.message, data.session_id, data.scope):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001 - e.g. missing AWS credentials at session load
            yield (
                "data: "
                + json.dumps({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
                + "\n\n"
            )
            yield (
                "data: " + json.dumps({"type": "session_finish", "text": "", "ok": False}) + "\n\n"
            )

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def reset_session(session_id: str, engine: Chat, user: CurrentAuthUser) -> None:
    engine.reset(user.id, session_id)
