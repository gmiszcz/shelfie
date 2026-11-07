"""The browser-side (frontend-tools) AG-UI agent endpoint.

``POST /api/agui/run`` is a **thin LLM runner**: one request = one model turn.
The browser owns the tools (they are defined and executed there); the server only
holds the Bedrock credentials. The request carries the running conversation, the
browser's tool schemas and a snapshot of the UI state; the response is an AG-UI
event stream (SSE). See :mod:`app.agent.ui_agent` and
``docs/agent-ag-ui-bedrock.md``.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent import ui_agent
from app.api.deps import AppSettings, CurrentUser

router = APIRouter(prefix="/agui", tags=["agui"])


class AgUiTool(BaseModel):
    """A browser-owned tool, described to the model as a JSON-Schema function."""

    name: str = Field(min_length=1, max_length=64)
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class AgUiToolCall(BaseModel):
    id: str = ""
    name: str = ""
    args: dict[str, Any] | str = Field(default_factory=dict)


class AgUiMessage(BaseModel):
    """One AG-UI conversation message.

    ``role`` is ``user`` | ``assistant`` | ``tool``. An assistant message may carry
    ``toolCalls``; a tool message carries ``toolCallId`` and the tool's result as
    ``content``.
    """

    role: str
    content: Any = ""
    toolCalls: list[AgUiToolCall] = Field(default_factory=list)
    toolCallId: str | None = None


class RunIn(BaseModel):
    threadId: str = Field(default="", max_length=128)
    runId: str = Field(default="", max_length=128)
    messages: list[AgUiMessage] = Field(default_factory=list)
    tools: list[AgUiTool] = Field(default_factory=list)
    state: dict[str, Any] | None = None


@router.post("/run")
async def run(data: RunIn, settings: AppSettings, _user: CurrentUser) -> StreamingResponse:
    messages = [m.model_dump() for m in data.messages]
    tools = [t.model_dump() for t in data.tools]

    async def events() -> AsyncIterator[str]:
        try:
            for event in ui_agent.run_stream(
                thread_id=data.threadId,
                run_id=data.runId,
                messages=messages,
                tools=tools,
                state=data.state,
                model_id=settings.bedrock_model_id,
                region=settings.aws_region,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001 - e.g. missing AWS credentials when the client is built
            err = {
                "type": ui_agent.RUN_ERROR,
                "threadId": data.threadId,
                "runId": data.runId,
                "message": f"{type(exc).__name__}: {exc}",
            }
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
