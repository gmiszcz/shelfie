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

    # Library assistant (AWS Bedrock via strands-compose). Credentials come from the AWS chain.
    bedrock_model_id: str = "eu.anthropic.claude-haiku-5-5"
    aws_region: str = "eu-central-1"

    # Auth seam (single-user now, JWT-ready). Not enforced yet in the MVP.
    jwt_secret: str = "change-me-long-random-secret"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = Field(default=10_080, ge=1)

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

    @property
    def database_file(self) -> Path:
        return resolve_path(self.db_path)

    @property
    def dataset_file(self) -> Path:
        return resolve_path(self.dataset_path)

    @property
    def covers_path(self) -> Path:
        return resolve_path(self.covers_dir)

    @property
    def google_books_cache_path(self) -> Path:
        return resolve_path(self.google_books_cache_dir)

    @property
    def static_path(self) -> Path:
        return resolve_path(self.static_dir)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
