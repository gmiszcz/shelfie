"""Request/response schemas for the auth and admin API."""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

# A pragmatic e-mail check (the full RFC grammar is not worth a dependency here): one
# ``@`` with non-space text either side and a dot in the domain.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _valid_email(value: str) -> str:
    cleaned = (value or "").strip()
    if not _EMAIL_RE.fullmatch(cleaned):
        raise ValueError("invalid e-mail address")
    return cleaned.lower()


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _valid_email(v)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)


class SetupCompleteIn(BaseModel):
    token: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=1024)


class UserOut(BaseModel):
    id: int
    email: str
    display_name: str
    is_admin: bool


class SetupInfo(BaseModel):
    email: str
    display_name: str
    purpose: str


class AdminUserOut(BaseModel):
    id: int
    email: str
    display_name: str
    is_admin: bool
    disabled: bool
    has_password: bool
    created_at: str | None = None
    book_count: int = 0


class AdminUserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    display_name: str = Field(min_length=1, max_length=200)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _valid_email(v)


class AdminUserPatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    disabled: bool | None = None
    is_admin: bool | None = None


class SetupLinkOut(BaseModel):
    setup_url: str
    expires_at: str


class AdminUserCreated(BaseModel):
    user: UserOut
    setup_url: str
    expires_at: str
