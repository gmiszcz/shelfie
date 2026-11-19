"""``POST /api/warmup``: a free, one-time warm-up of the mic and agent paths.

The browser calls it once when the app opens (see ``frontend/src/warmup.ts``). It
makes no Bedrock call and opens no Transcribe stream, see ``app/services/warmup.py``.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter

from app.api.deps import AppSettings, CurrentAuthUser
from app.services import warmup

router = APIRouter(prefix="/warmup", tags=["warmup"])


@router.post("")
async def warm(_user: CurrentAuthUser, settings: AppSettings) -> dict[str, dict[str, float]]:
    return {"timings_ms": await asyncio.to_thread(warmup.warm, settings)}
