"""Time the cold parts of the mic and the agent (no Bedrock call, no Transcribe stream)."""

import socket
import ssl
import time
from collections.abc import Callable
from typing import Any

from app.config import get_settings


def t(label: str, fn: Callable[[], Any]) -> Any:
    s = time.perf_counter()
    out = fn()
    print(f"{label:34s}{(time.perf_counter() - s) * 1000:8.0f} ms")
    return out


settings = get_settings()
host = f"transcribestreaming.{settings.aws_region}.amazonaws.com"
t("import amazon_transcribe", lambda: __import__("amazon_transcribe.client"))
t("import boto3", lambda: __import__("boto3"))
from app.services import transcribe as svc  # noqa: E402

t("resolve credentials (1st)", svc._resolve_credentials)
t("resolve credentials (2nd)", svc._resolve_credentials)
ip = t("DNS lookup", lambda: socket.getaddrinfo(host, 443)[0][4][0])


def tls() -> None:
    with socket.create_connection((host, 443), timeout=10) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host):
            pass


t("TCP+TLS connect", tls)
t("TCP+TLS connect (again)", tls)
from app.agent.sessions import AgentSessions  # noqa: E402

sessions = t("AgentSessions.from_settings", lambda: AgentSessions.from_settings(settings))
from strands_compose_agentcore.session import close_session, resolve_session  # noqa: E402

st = t("resolve_session (1st agent)", lambda: resolve_session(sessions._config, "x" * 36))
close_session(st)
st = t("resolve_session (2nd agent)", lambda: resolve_session(sessions._config, "y" * 36))
close_session(st)
