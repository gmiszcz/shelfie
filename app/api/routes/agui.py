"""``POST /api/agui`` - the Shelfie assistant over the AG-UI protocol.

The body is an AG-UI ``RunAgentInput``; the response is an AG-UI event stream (SSE).
The ``threadId`` (a UUID owned by the browser) is the conversation: the agent keeps
the history server-side, so only the new input of each run is read. Sessions are
per logged-in user, see :mod:`app.agent.sessions`.

``DELETE /api/agui/threads/{thread_id}`` forgets a conversation ("new chat").
"""

from __future__ import annotations

import json

from ag_ui.core import RunAgentInput
from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import ValidationError
from strands_compose_agentcore.agui.inbound import (
    AguiInputError,
    run_input_to_invocation,
    validate_thread_id,
)
from strands_compose_agentcore.agui.sse import AguiSseStream

from app.api.deps import Agents, CurrentAuthUser

router = APIRouter(prefix="/agui", tags=["agui"])

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _problem(detail: str, type_uri: str = "about:blank", **extra: object) -> JSONResponse:
    body = {"type": type_uri, "title": "Unprocessable Content", "status": 422, "detail": detail}
    return JSONResponse({**body, **extra}, status_code=422, media_type="application/problem+json")


@router.post("")
async def run(request: Request, user: CurrentAuthUser, agents: Agents) -> Response:
    try:
        run_input = RunAgentInput.model_validate_json(await request.body())
    except ValidationError as exc:
        errors = json.loads(exc.json(include_url=False))
        return _problem("The body is not a valid RunAgentInput.", errors=errors)
    try:
        validate_thread_id(run_input.thread_id)
        invocation = run_input_to_invocation(run_input)
    except AguiInputError as exc:
        return _problem(str(exc), exc.type_uri)

    sse = AguiSseStream(invocation.thread_id, invocation.run_id)
    return StreamingResponse(
        sse.frames(agents.stream(user.id, invocation)),
        media_type=sse.media_type,
        headers=_SSE_HEADERS,
    )


@router.delete("/threads/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
async def reset_thread(thread_id: str, user: CurrentAuthUser, agents: Agents) -> None:
    agents.reset(user.id, thread_id.lower())
