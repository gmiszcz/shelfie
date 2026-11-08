"""Conditional GET (ETag / If-None-Match → 304) for list endpoints.

``GET /api/books`` and ``GET /api/series`` return the whole per-user collection on every
call. The frontend's React Query cache refetches them in the background on every tab
return (stale-while-revalidate), so most refetches send back a body that is byte-for-byte
what the client already holds. An ETag lets the client skip that: it echoes the last
ETag in ``If-None-Match`` and the server answers ``304 Not Modified`` with no body when
the data is unchanged.

The ETag is a strong validator: the SHA-256 of the exact JSON body the route would return.
It is therefore correct per user (the body already contains only that user's rows) and
changes whenever any field of any row changes. No shared state, no cache invalidation to
get wrong — the hash is derived from the response itself.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

from fastapi import Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel


def _etag_for(body: bytes) -> str:
    """A strong ETag: a quoted SHA-256 hex digest of the serialized body."""
    return '"' + hashlib.sha256(body).hexdigest() + '"'


def conditional_json(request: Request, payload: Sequence[BaseModel]) -> Response:
    """Return ``payload`` as JSON with an ETag, or ``304`` when the client's copy matches.

    ``payload`` is the list of response models the route would otherwise return. The body is
    encoded the same way FastAPI would (``jsonable_encoder`` + compact JSON) so the ETag is
    stable across calls. If the request's ``If-None-Match`` contains this ETag, a bodyless
    ``304`` is returned (still carrying the ETag and ``Cache-Control: private``).
    """
    encoded = jsonable_encoder(payload)
    # JSONResponse.render() produces the compact UTF-8 bytes a normal response would send.
    body = bytes(JSONResponse(encoded).body)
    etag = _etag_for(body)

    # If-None-Match may be a comma-separated list; match any member (ignoring a weak prefix).
    inm = request.headers.get("if-none-match", "")
    candidates = {tag.strip().removeprefix("W/") for tag in inm.split(",") if tag.strip()}
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if etag in candidates:
        return Response(status_code=304, headers=headers)

    return Response(content=body, media_type="application/json", headers=headers)
