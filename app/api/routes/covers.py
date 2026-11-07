"""Cover uploads: store an image, get back a URL to put in ``cover_url``.

Every cover lives under the CURRENT user's ``covers/`` folder (resolved from the per-user
data context), never a shared directory. Serving validates the name and reads only that
folder, so one user can never fetch another user's cover.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.deps import CurrentUser
from app.services import books as service
from app.userdata import current_covers_dir

router = APIRouter(prefix="/covers", tags=["covers"])

_NAME = re.compile(r"^[0-9a-f]{32}\.(jpg|png|webp)$")


class CoverUploaded(BaseModel):
    url: str


@router.post("", response_model=CoverUploaded, status_code=status.HTTP_201_CREATED)
async def upload_cover(file: UploadFile, _user: CurrentUser) -> CoverUploaded:
    data = await file.read(service.MAX_COVER_BYTES + 1)
    try:
        name = service.save_cover(current_covers_dir(), data)
    except service.CoverError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    return CoverUploaded(url=f"/api/covers/{name}")


@router.get("/{name}")
async def get_cover(name: str, _user: CurrentUser) -> FileResponse:
    # Only names this service generated: no path separators, no traversal.
    if not _NAME.fullmatch(name):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cover not found")
    path = current_covers_dir() / name
    # Defence in depth: the resolved path must stay inside the user's covers folder.
    covers_root = current_covers_dir().resolve()
    if not str(path.resolve()).startswith(str(covers_root)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cover not found")
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cover not found")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})
