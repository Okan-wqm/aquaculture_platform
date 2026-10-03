"""System One transport — one bounded HTTP call to TypeSafe Jev (ARIA-LOW-252).

In the kernel, unlike ``tools/aria-poc/zai_runtime.py``: Jev's callers are kernel
decision points run as ``python3 -m aria_kernel`` (no ``tools/aria-poc`` there).
The key comes ONLY from the 0600 file ``ARIA_JEV_API_KEY_FILE`` names and never
enters a result. Bounded (5 s ceiling, one retry for 429/5xx/transport, an
in-process breaker); every failure is a RETURNED, named ``JevUnavailable``.
"""
from __future__ import annotations

import http.client
import json
import os
import stat
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"  # the one host; `endpoint=` exists for tests
# Not a `model_fleet` row (those host roles; Jev hosts none). Secret-shaped: agent children never see it.
JEV_CREDENTIAL_FILE_ENV = "ARIA_JEV_API_KEY_FILE"
TIMEOUT_CEILING_SECONDS = 5.0
MAX_ATTEMPTS = 2
RETRY_BACKOFF_SECONDS = 0.2
Opener = Callable[[urllib.request.Request, float], tuple[int, bytes]]


@dataclass(frozen=True)
class JevReply:
    model: str  # the EXACT model id the vendor ran (jev-1.13.0), never the alias
    answers: Mapping[str, Any]
    input_tokens: int | None


@dataclass(frozen=True)
class JevUnavailable:
    reason: str


@dataclass
class CircuitBreaker:
    """Open for ``cooldown_seconds`` after ``threshold`` consecutive failures; per process by design."""

    threshold: int = 3
    cooldown_seconds: float = 60.0
    clock: Callable[[], float] = time.monotonic
    _failures: int = field(default=0, repr=False)
    _open_until: float | None = field(default=None, repr=False)

    def allow(self) -> bool:
        if self._open_until is not None and self.clock() >= self._open_until:
            self._open_until, self._failures = None, 0
        return self._open_until is None

    def record(self, ok: bool) -> None:
        self._failures = 0 if ok else self._failures + 1
        if self._failures >= self.threshold:
            self._open_until = self.clock() + self.cooldown_seconds


_DEFAULT_BREAKER = CircuitBreaker()


class _Refused(Exception):
    def __init__(self, reason: str, *, retryable: bool = False) -> None:
        super().__init__(reason)
        self.reason, self.retryable = reason, retryable


def _read_key(environ: Mapping[str, str]) -> str:
    file_path = str(environ.get(JEV_CREDENTIAL_FILE_ENV) or "").strip()
    if not file_path:
        raise _Refused("credential_not_configured")
    try:
        info = Path(file_path).stat()
        if not stat.S_ISREG(info.st_mode):
            raise _Refused("credential_file_unreadable")
        if info.st_mode & 0o077:  # readable beyond its owner: every process on the host has a copy
            raise _Refused("credential_file_permissions")
        secret = Path(file_path).read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as exc:
        raise _Refused("credential_file_unreadable") from exc
    if not secret or "\n" in secret:
        raise _Refused("credential_file_empty")
    return secret


def _urllib_opener(request: urllib.request.Request, timeout_seconds: float) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return int(response.status), response.read()
    except urllib.error.HTTPError as exc:
        return int(exc.code), b""
    except (OSError, http.client.HTTPException) as exc:  # URLError names its cause in .reason
        raise _Refused(f"transport_error:{type(getattr(exc, 'reason', exc)).__name__}", retryable=True) from exc


def _attempt(key: str, payload: Mapping[str, Any], *, endpoint: str, timeout: float, opener: Opener) -> JevReply:
    request = urllib.request.Request(
        endpoint, data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "Accept": "application/json", "User-Agent": "aria-kernel-jev-runtime/1"},
    )
    status, body = opener(request, timeout)
    if status in (401, 403):
        raise _Refused(f"auth_rejected_http_{status}")
    if status == 429 or status >= 500:
        raise _Refused(f"{'rate_limited' if status == 429 else 'vendor_error'}_http_{status}", retryable=True)
    if status != 200:
        raise _Refused(f"request_refused_http_{status}")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise _Refused("response_malformed") from exc
    model, answers = (parsed.get("model"), parsed.get("answers")) if isinstance(parsed, dict) else (None, None)
    if not (isinstance(model, str) and model and isinstance(answers, dict)):
        raise _Refused("response_malformed")
    usage = parsed.get("usage")
    tokens = usage.get("input_tokens") if isinstance(usage, dict) else None
    return JevReply(model=model, answers=answers, input_tokens=tokens if type(tokens) is int else None)


def call_systemone(
    payload: Mapping[str, Any], *, environ: Mapping[str, str] | None = None, opener: Opener | None = None,
    breaker: CircuitBreaker | None = None, timeout_seconds: float = TIMEOUT_CEILING_SECONDS,
    sleep: Callable[[float], None] = time.sleep, endpoint: str = JEV_ENDPOINT,
) -> JevReply | JevUnavailable:
    """POST one ``{model, state, questions}`` body; return the reply or a named ``JevUnavailable``."""
    gate = _DEFAULT_BREAKER if breaker is None else breaker
    if not gate.allow():
        return JevUnavailable("circuit_open")
    try:
        key = _read_key(os.environ if environ is None else environ)
    except _Refused as refused:
        # Configuration, not an outage: never opens the breaker, so a fixed file works at once.
        return JevUnavailable(refused.reason)
    timeout = max(0.1, min(float(timeout_seconds), TIMEOUT_CEILING_SECONDS))
    attempt = 1
    while True:
        try:
            reply = _attempt(key, payload, endpoint=endpoint, timeout=timeout, opener=opener or _urllib_opener)
        except _Refused as refused:
            if refused.retryable and attempt < MAX_ATTEMPTS:
                attempt += 1
                sleep(RETRY_BACKOFF_SECONDS)
                continue
            gate.record(False)
            return JevUnavailable(refused.reason)
        gate.record(True)
        return reply
