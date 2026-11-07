"""Process settings. Environment variables and the .env file, no secrets in code."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]


def resolve_path(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return ROOT / path


class Settings(BaseSettings):
    """Server configuration. Field names match the environment variables."""

    model_config = SettingsConfigDict(
        env_file=str(ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    host: str = "0.0.0.0"  # nosec B104  # container default; bind a real interface in prod
    port: int = Field(default=8000, ge=1, le=65535)
    # The data root holds the shared auth DB and the per-user folders (data/users/<id>/).
    data_dir: str = "data"
    # Legacy single-user paths. The bootstrap command moves these into data/users/1/ and
    # the server never reads them again; they stay here only so bootstrap can find them.
    db_path: str = "data/shelfie.sqlite"
    dataset_path: str = "data/books.json"
    covers_dir: str = "data/covers"
    log_level: str = "INFO"
    static_dir: str = "frontend/dist"

    # External APIs
    google_books_api_key: str | None = None
    google_books_base_url: str = "https://www.googleapis.com/books/v1"
    # Per-process ceiling on live Google Books calls; the client refuses past it.
    google_books_max_calls: int = Field(default=50, ge=0)
    # On-disk response cache for Google Books (JSON per normalised query); TTL in days.
    google_books_cache_dir: str = "data/cache/google_books"
    google_books_cache_ttl_days: int = Field(default=30, ge=0)

    # Web release-research step (DuckDuckGo HTML + page fetch, disk-cached). Never Google Books.
    web_cache_dir: str = "data/cache/web"
    web_cache_ttl_days: int = Field(default=7, ge=0)
    web_research_max_calls: int = Field(default=12, ge=1, le=100)

    # Library assistant (AWS Bedrock via strands-compose). Credentials come from the AWS chain.
    bedrock_model_id: str = "eu.anthropic.claude-haiku-5-5"
    aws_region: str = "eu-central-1"
    # Whether adding/enriching a book runs the Bedrock insights model. Default true in
    # production; the test suite sets it false so no test ever calls Bedrock or the network.
    enrichment_enabled: bool = True

    # --- Accounts, login and per-user data (see docs/features/auth.md) ---
    # Shared auth database: accounts, sessions, setup tokens, login attempts.
    auth_db_path: str = "data/auth.sqlite"
    # Session cookie lifetime (days) and the sliding-renewal floor: when fewer than
    # ``session_renew_days`` remain the expiry is pushed back to ``session_days``.
    session_days: int = Field(default=30, ge=1)
    session_renew_days: int = Field(default=15, ge=0)
    # Whether the session cookie carries ``Secure``. "auto" sets it only on an HTTPS
    # request (scheme or X-Forwarded-Proto); "true"/"false" force it on/off.
    cookie_secure: str = "auto"
    # Setup/reset link lifetime in hours.
    setup_token_hours: int = Field(default=24, ge=1)
    # Login throttle window (minutes) and the failed-attempt ceiling per e-mail/IP.
    login_window_minutes: int = Field(default=15, ge=1)
    login_max_attempts: int = Field(default=5, ge=1)
    # Minimum password length for passwords chosen in the web app (register, setup, change).
    password_min_length: int = Field(default=8, ge=1)
    # Public self-registration (POST /api/auth/register). New accounts are never admins and
    # start with an empty library.
    registration_enabled: bool = True

    # Permissive by default for local dev (Vite on :5173 -> API on :8000).
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    @field_validator("google_books_api_key", mode="before")
    @classmethod
    def blank_to_none(cls, value: object) -> object:
        if isinstance(value, str) and value.strip() == "":
            return None
        return value

    @field_validator("log_level")
    @classmethod
    def normalize_level(cls, value: str) -> str:
        normalized = value.strip().upper()
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if normalized not in allowed:
            raise ValueError(f"LOG_LEVEL must be one of {sorted(allowed)}")
        return normalized

    @field_validator("cookie_secure")
    @classmethod
    def normalize_cookie_secure(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"auto", "true", "false"}:
            raise ValueError("COOKIE_SECURE must be one of 'auto', 'true', 'false'")
        return normalized

    @property
    def data_path(self) -> Path:
        """The data root: holds auth.sqlite, the shared caches and data/users/<id>/."""
        return resolve_path(self.data_dir)

    @property
    def users_root(self) -> Path:
        """``data/users`` — the parent of every per-user data folder."""
        return self.data_path / "users"

    @property
    def auth_database_file(self) -> Path:
        return resolve_path(self.auth_db_path)

    # --- Legacy single-user paths. Read only by the bootstrap command, which moves them
    #     into data/users/1/. Derived from the data root so they follow DATA_DIR (and so
    #     bootstrap/tests that point DATA_DIR at a temp dir see the right files). The running
    #     server resolves per-user paths via UserData, never these. ---
    @property
    def database_file(self) -> Path:
        return self.data_path / "shelfie.sqlite"

    @property
    def dataset_file(self) -> Path:
        return self.data_path / "books.json"

    @property
    def covers_path(self) -> Path:
        return self.data_path / "covers"

    @property
    def google_books_cache_path(self) -> Path:
        return resolve_path(self.google_books_cache_dir)

    @property
    def web_cache_path(self) -> Path:
        return resolve_path(self.web_cache_dir)

    @property
    def static_path(self) -> Path:
        return resolve_path(self.static_dir)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
