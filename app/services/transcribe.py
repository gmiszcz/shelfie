"""Streaming speech-to-text over Amazon Transcribe.

The browser records microphone audio as 16-bit little-endian PCM at 16 kHz and
streams the raw frames to the ``/api/transcribe/stream`` WebSocket. This module
wraps the `amazon-transcribe <https://github.com/awslabs/amazon-transcribe-streaming-sdk>`_
streaming SDK and turns its result stream into the small JSON messages the
frontend reads:

    {"type": "partial", "text": "..."}   # interim hypothesis, keeps changing
    {"type": "final",   "text": "..."}   # a stabilised segment
    {"type": "error",   "message": "..."}

Credentials come from the standard AWS chain (SSO / ``aws configure``); only the
region is configured in the app. The client is created lazily and behind a small
``TranscribeStreamer`` seam so the WebSocket route and the unit tests can inject
a fake without any AWS call or audio hardware.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from amazon_transcribe.auth import CredentialResolver

logger = logging.getLogger(__name__)

# Fixed by the browser capture pipeline (AudioWorklet downsamples to this).
SAMPLE_RATE_HZ = 16_000
MEDIA_ENCODING = "pcm"

# Streaming is supported for these; pl-PL is the Shelfie default, en-US the toggle.
SUPPORTED_LANGUAGES: frozenset[str] = frozenset({"pl-PL", "en-US"})
DEFAULT_LANGUAGE = "pl-PL"


@dataclass(frozen=True)
class Transcript:
    """One transcription result pushed back to the client."""

    text: str
    is_final: bool

    def to_message(self) -> dict[str, str]:
        return {"type": "final" if self.is_final else "partial", "text": self.text}


def normalize_language(code: str | None) -> str:
    """Return a supported language code, falling back to the default."""
    if code and code in SUPPORTED_LANGUAGES:
        return code
    return DEFAULT_LANGUAGE


class TranscribeStreamer(Protocol):
    """Transcribe one audio stream to text results.

    ``audio_chunks`` yields raw PCM frames (16-bit LE, 16 kHz, mono). The
    implementation yields :class:`Transcript` objects as Transcribe returns
    partial and final results, and completes when ``audio_chunks`` is exhausted.
    """

    def transcribe(
        self, audio_chunks: AsyncIterator[bytes], *, language: str
    ) -> AsyncIterator[Transcript]: ...


def _resolve_credentials() -> CredentialResolver | None:
    """Resolve AWS credentials via boto3 (SSO/`aws configure`-aware) for the SDK.

    The amazon-transcribe SDK's default resolver uses awscrt's chain, which does
    not read boto3's cached SSO credentials. We resolve them with boto3 (which
    does) and hand the SDK a static resolver. Returns ``None`` when no frozen
    credentials are available, so the SDK's own default chain still applies
    (e.g. an EC2 instance role or raw environment variables).
    """
    try:
        import boto3  # type: ignore[import-untyped]
        from amazon_transcribe.auth import StaticCredentialResolver

        from app.config import get_settings

        # Preferred: the dedicated Transcribe-only IAM keys from .env (no SSO needed).
        settings = get_settings()
        if settings.transcribe_aws_access_key_id and settings.transcribe_aws_secret_access_key:
            return StaticCredentialResolver(
                access_key_id=settings.transcribe_aws_access_key_id,
                secret_access_key=settings.transcribe_aws_secret_access_key.get_secret_value(),
            )

        frozen = boto3.Session().get_credentials()
        if frozen is None:
            return None
        creds = frozen.get_frozen_credentials()
        return StaticCredentialResolver(
            access_key_id=creds.access_key,
            secret_access_key=creds.secret_key,
            session_token=creds.token,
        )
    except Exception:  # noqa: BLE001 - fall back to the SDK default chain
        logger.warning("boto3 credential resolution failed; using SDK default chain", exc_info=True)
        return None


class AwsTranscribeStreamer:
    """Real :class:`TranscribeStreamer` backed by the amazon-transcribe SDK."""

    def __init__(self, region: str) -> None:
        self._region = region

    async def transcribe(
        self, audio_chunks: AsyncIterator[bytes], *, language: str
    ) -> AsyncIterator[Transcript]:
        # Imported lazily so importing this module never requires the SDK or awscrt.
        from amazon_transcribe.client import TranscribeStreamingClient
        from amazon_transcribe.handlers import TranscriptResultStreamHandler
        from amazon_transcribe.model import TranscriptEvent

        queue: asyncio.Queue[Transcript | None] = asyncio.Queue()

        class _Handler(TranscriptResultStreamHandler):
            async def handle_transcript_event(self, transcript_event: TranscriptEvent) -> None:
                for result in transcript_event.transcript.results:
                    alts = result.alternatives
                    if not alts:
                        continue
                    text = alts[0].transcript or ""
                    if text:
                        queue.put_nowait(Transcript(text=text, is_final=not result.is_partial))

        client = TranscribeStreamingClient(
            region=self._region, credential_resolver=_resolve_credentials()
        )
        stream = await client.start_stream_transcription(
            language_code=language,
            media_sample_rate_hz=SAMPLE_RATE_HZ,
            media_encoding=MEDIA_ENCODING,
        )

        async def pump_audio() -> None:
            try:
                async for chunk in audio_chunks:
                    if chunk:
                        await stream.input_stream.send_audio_event(audio_chunk=chunk)
            finally:
                await stream.input_stream.end_stream()

        async def pump_results() -> None:
            handler = _Handler(stream.output_stream)
            try:
                await handler.handle_events()
            finally:
                queue.put_nowait(None)

        audio_task = asyncio.create_task(pump_audio())
        result_task = asyncio.create_task(pump_results())
        try:
            while (item := await queue.get()) is not None:
                yield item
        finally:
            for task in (audio_task, result_task):
                if not task.done():
                    task.cancel()


def default_streamer_factory(region: str) -> Callable[[], TranscribeStreamer]:
    """Factory used by the WebSocket route to build the real AWS streamer."""

    def factory() -> TranscribeStreamer:
        return AwsTranscribeStreamer(region)

    return factory


async def run_transcription(
    streamer: TranscribeStreamer,
    audio_chunks: AsyncIterator[bytes],
    *,
    language: str,
    on_result: Callable[[dict[str, str]], Awaitable[None]],
) -> None:
    """Drive one transcription session and deliver each result via ``on_result``.

    Any error is reported as a single ``{"type": "error", ...}`` message rather
    than raised, so the WebSocket route can close cleanly.
    """
    lang = normalize_language(language)
    try:
        async for transcript in streamer.transcribe(audio_chunks, language=lang):
            await on_result(transcript.to_message())
    except Exception as exc:  # noqa: BLE001 - surfaced to the client as an error message
        logger.exception("transcription failed")
        await on_result({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
