"""One free warm-up of the voice and agent paths, run once per process.

Nothing here costs money: no Bedrock call, no Transcribe stream, no audio. It only
pays the one-time Python/network setup so the first mic click and the first agent
run do not:

- import ``boto3`` and the Transcribe SDK (about 1 s),
- resolve the Transcribe credentials,
- resolve DNS and finish one TCP+TLS handshake to the Transcribe host (about 0.2 s),
- build the agent config and the first agent (about 0.9 s the first time, 0.3 s after).
"""

from __future__ import annotations

import logging
import socket
import ssl
import time
from collections.abc import Callable

from app.config import Settings

logger = logging.getLogger(__name__)

_done = False


def _warm_transcribe(settings: Settings) -> None:
    from amazon_transcribe import client, handlers, model  # noqa: F401

    from app.services.transcribe import _resolve_credentials

    _resolve_credentials()
    host = f"transcribestreaming.{settings.aws_region}.amazonaws.com"
    with socket.create_connection((host, 443), timeout=5) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host):
            pass  # handshake only: no request is sent


def _warm_agent() -> None:
    from strands_compose_agentcore.session import close_session, resolve_session

    from app.api.deps import agent_sessions

    sessions = agent_sessions()
    # Builds (and drops) one agent: loads the libraries and the Bedrock client class.
    close_session(resolve_session(sessions._config, "w" * 36))


def warm(settings: Settings) -> dict[str, float]:
    """Run the warm-up once; later calls return ``{}`` at once. Never raises."""
    global _done
    if _done:
        return {}
    _done = True
    steps: dict[str, Callable[[], None]] = {
        "transcribe": lambda: _warm_transcribe(settings),
        "agent": _warm_agent,
    }
    timings: dict[str, float] = {}
    for name, step in steps.items():
        start = time.perf_counter()
        try:
            step()
        except Exception:  # noqa: BLE001 - a failed warm-up only means a slower first use
            logger.warning("warm-up step %s failed", name, exc_info=True)
        timings[name] = round((time.perf_counter() - start) * 1000)
    return timings
