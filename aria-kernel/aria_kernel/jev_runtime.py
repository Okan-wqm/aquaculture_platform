"""System One transport — one bounded HTTPS call to TypeSafe Jev (ARIA-LOW-252).

PRIVATE to ``system_one``: no other module may import this one
(``tests/test_jev_runtime.py`` pins it), because ``system_one`` is where the
egress law lives — what may be sent, built from references, and checked as
the exact bytes that leave. This module only moves those bytes:

* the endpoint is pinned (``https`` and ``api.typesafe.ai``) and checked at
  every call; no caller can name another;
* no redirect is followed and any 3xx is refused, environment proxies are
  ignored, and TLS is verified with the default context — the bearer key
  can reach no other host;
* one monotonic deadline (``TIMEOUT_CEILING_SECONDS``) bounds both attempts
  together; the response is capped by Content-Length and by the read;
* the key comes ONLY from the file ``ARIA_JEV_API_KEY_FILE`` names, opened
  without following a symlink and accepted only as a regular file owned by
  this euid with no group/other bits, of a fixed charset — so it can never
  inject a header;
* every failure is a RETURNED, named ``JevUnavailable`` carrying an
  exception CLASS name at most, never a message (a message can carry the
  request, and the request carries the key).
"""
from __future__ import annotations

import http.client
import json
import os
import re
import ssl
import stat
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
JEV_HOST = "api.typesafe.ai"
# Not a `model_fleet` row (those host roles; Jev hosts none). Secret-shaped: agent children never see it.
JEV_CREDENTIAL_FILE_ENV = "ARIA_JEV_API_KEY_FILE"
TIMEOUT_CEILING_SECONDS = 5.0  # the WHOLE call, both attempts included
MAX_ATTEMPTS = 2
RETRY_BACKOFF_SECONDS = 0.2
MAX_RESPONSE_BYTES = 64 * 1024
MAX_KEY_FILE_BYTES = 4096
_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{16,256}$")
_MODEL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
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
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(file_path, flags)
    except OSError as exc:  # a symlink (ELOOP), absent, or unreadable
        raise _Refused("credential_file_unreadable") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise _Refused("credential_file_unreadable")
        if info.st_uid != os.geteuid():
            raise _Refused("credential_file_owner")
        if info.st_mode & 0o077:  # readable beyond its owner: every process on the host has a copy
            raise _Refused("credential_file_permissions")
        data = os.read(descriptor, MAX_KEY_FILE_BYTES + 1)
    except OSError as exc:
        raise _Refused("credential_file_unreadable") from exc
    finally:
        os.close(descriptor)
    if len(data) > MAX_KEY_FILE_BYTES:
        raise _Refused("credential_file_too_large")
    try:
        secret = data.decode("ascii")
    except UnicodeDecodeError as exc:
        raise _Refused("credential_file_malformed") from exc
    secret = secret[:-1] if secret.endswith("\n") else secret
    if not secret:
        raise _Refused("credential_file_empty")
    if not _KEY_RE.match(secret):
        raise _Refused("credential_file_malformed")
    return secret


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow: the bearer key must reach the pinned host and nothing else."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def _pinned_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),  # environment proxies are ignored
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        _RefuseRedirect(),
    )


def _urllib_opener(request: urllib.request.Request, timeout_seconds: float) -> tuple[int, bytes]:
    try:
        with _pinned_opener().open(request, timeout=timeout_seconds) as response:
            declared = response.headers.get("Content-Length")
            if declared is not None and (not declared.strip().isdigit() or int(declared) > MAX_RESPONSE_BYTES):
                raise _Refused("response_too_large")
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise _Refused("response_too_large")
            return int(response.status), body
    except urllib.error.HTTPError as exc:  # 3xx (not followed), 4xx and 5xx all land here
        return int(exc.code), b""
    except (OSError, http.client.HTTPException) as exc:  # URLError names its cause in .reason
        raise _Refused(f"transport_error:{type(getattr(exc, 'reason', exc)).__name__}", retryable=True) from exc


def _attempt(key: str, body: bytes, *, timeout: float, opener: Opener) -> JevReply:
    request = urllib.request.Request(
        JEV_ENDPOINT, data=body, method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "Accept": "application/json", "User-Agent": "aria-kernel-jev-runtime/1"},
    )
    status, raw = opener(request, timeout)
    if 300 <= status < 400:
        raise _Refused(f"redirect_refused_http_{status}")
    if status in (401, 403):
        raise _Refused(f"auth_rejected_http_{status}")
    if status == 429 or status >= 500:
        raise _Refused(f"{'rate_limited' if status == 429 else 'vendor_error'}_http_{status}", retryable=True)
    if status != 200:
        raise _Refused(f"request_refused_http_{status}")
    if len(raw) > MAX_RESPONSE_BYTES:
        raise _Refused("response_too_large")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise _Refused("response_malformed") from exc
    model, answers = (parsed.get("model"), parsed.get("answers")) if isinstance(parsed, dict) else (None, None)
    if not (isinstance(model, str) and _MODEL_RE.match(model) and isinstance(answers, dict)):
        raise _Refused("response_malformed")
    usage = parsed.get("usage")
    tokens = usage.get("input_tokens") if isinstance(usage, dict) else None
    bounded = tokens if type(tokens) is int and 0 <= tokens <= 10_000_000 else None
    return JevReply(model=model, answers=answers, input_tokens=bounded)


def post_systemone(
    payload: Mapping[str, Any], *, environ: Mapping[str, str] | None = None, opener: Opener | None = None,
    breaker: CircuitBreaker | None = None, timeout_seconds: float = TIMEOUT_CEILING_SECONDS,
    sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
) -> JevReply | JevUnavailable:
    """POST one ``{model, state, questions}`` body to the pinned endpoint; the reply or a named ``JevUnavailable``."""
    try:
        return _post(payload, environ=environ, opener=opener, breaker=breaker,
                     timeout_seconds=timeout_seconds, sleep=sleep, clock=clock)
    except Exception as exc:  # noqa: BLE001 — the CLASS only; a message can carry the key
        return JevUnavailable(f"transport_raised:{type(exc).__name__}")


def _post(
    payload: Mapping[str, Any], *, environ: Mapping[str, str] | None, opener: Opener | None,
    breaker: CircuitBreaker | None, timeout_seconds: float, sleep: Callable[[float], None],
    clock: Callable[[], float],
) -> JevReply | JevUnavailable:
    target = urlsplit(JEV_ENDPOINT)
    if target.scheme != "https" or target.hostname != JEV_HOST:
        return JevUnavailable("endpoint_not_pinned")
    gate = _DEFAULT_BREAKER if breaker is None else breaker
    if not gate.allow():
        return JevUnavailable("circuit_open")
    try:
        key = _read_key(os.environ if environ is None else environ)
    except _Refused as refused:
        # Configuration, not an outage: never opens the breaker, so a fixed file works at once.
        return JevUnavailable(refused.reason)
    body = json.dumps(payload).encode("utf-8")
    deadline = clock() + max(0.1, min(float(timeout_seconds), TIMEOUT_CEILING_SECONDS))
    attempt = 1
    while True:
        remaining = deadline - clock()
        if remaining <= 0:
            gate.record(False)
            return JevUnavailable("deadline_exceeded")
        try:
            reply = _attempt(key, body, timeout=remaining, opener=opener or _urllib_opener)
        except _Refused as refused:
            if refused.retryable and attempt < MAX_ATTEMPTS and deadline - clock() > RETRY_BACKOFF_SECONDS:
                attempt += 1
                sleep(RETRY_BACKOFF_SECONDS)
                continue
            gate.record(False)
            return JevUnavailable(refused.reason)
        gate.record(True)
        return reply
