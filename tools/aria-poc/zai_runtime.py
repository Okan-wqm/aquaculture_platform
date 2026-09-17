"""Z.ai (GLM) runtime — a DISTINCT HTTP transport, never a redirected managed CLI.

WHY A SEPARATE MODULE. The Anthropic and OpenAI providers run through their
vendors' managed-subscription CLIs (`claude`, `codex`); the operator policy
of 2026-09-11 admits Z.ai ONLY through its own subscription API and forbids
handing the Z.ai credential to either CLI as a child. The earlier
`claude_runtime.provider_redirect_env` route did exactly that — it spawned
the `claude` binary with ANTHROPIC_BASE_URL pointed at Z.ai — and is retired
with this module. Here the kernel speaks the OpenAI-compatible chat
completions protocol to Z.ai directly, with `urllib` from the standard
library: no vendor SDK, no shared binary, no shared credential file.

WHICH ENDPOINT, AND WHY IT IS NOT A GUESS. Z.ai documents three base URLs
that bill differently (docs.z.ai/devpack/tool/others): the Coding-Plan
OpenAI route `/api/coding/paas/v4` draws the subscription quota, the general
route `/api/paas/v4` draws the prepaid wallet, and `/api/anthropic` is the
Anthropic-protocol Coding-Plan route the CLI redirect used. The GLM-5.3 page
adds that Coding-Plan subscribers reach the model API "only through the
OpenAI Chat Completion-compatible protocol". The operator's credential is a
subscription key, so the default is the Coding route — but which route a
given key is ENTITLED to is an empirical fact the probe records from the
vendor's answer, never inferred from the key's shape and never silently
substituted (CURRENT_STATE.md, Z.ai row).

THE CREDENTIAL BOUNDARY. The secret is read from a root-only file named by
ARIA_ZAI_API_KEY_FILE (or, for CI-secret injection, from ARIA_ZAI_API_KEY),
held in a `ZaiCredential` whose repr, str and dataclass fields never expose
it, and used exactly once per call to build an Authorization header. It is
never placed in os.environ, argv, a ledger row, a governance event, an
exception message or a transcript — the `settings_hash` the executor records
covers endpoint/model/transport only. `agent_env.SECRET_SHAPED_ENV_NAME`
already drops both variable names from every agent child.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from aria_kernel.model_fleet import zai_provider as _zai_provider
from aria_kernel.status_probe import StatusDecision

_PROVIDER = _zai_provider()
ZAI_PROVIDER_KEY = _PROVIDER.key
ZAI_TRANSPORT = "openai_chat_completions_v1"
# The variable NAMES are the fleet's (aria_kernel.model_fleet), so the cheap
# availability signal and this transport cannot disagree about which
# variables exist. The values never leave this module.
ZAI_CREDENTIAL_FILE_ENV = _PROVIDER.credential_file_env or "ARIA_ZAI_API_KEY_FILE"
ZAI_CREDENTIAL_ENV = _PROVIDER.credential_env or "ARIA_ZAI_API_KEY"
ZAI_MODEL_ENV = _PROVIDER.model_env or "ARIA_ZAI_MODEL"
ZAI_ENDPOINT_ENV = "ARIA_ZAI_ENDPOINT"
DEFAULT_ZAI_ENDPOINT = "coding"
DEFAULT_ZAI_MODEL = _PROVIDER.default_model
ZAI_AUTH_METHOD = "subscription_api_key"
DEFAULT_ZAI_TIMEOUT_SECONDS = 600
PROBE_TIMEOUT_CEILING_SECONDS = 30
# GLM-5.3 thinks by default ("forced deep thinking", docs.z.ai migrate-to-glm-new)
# and its reasoning draws on the same max_tokens as the answer: the first
# live planner run spent 8,191 of 8,192 tokens reasoning and returned an
# empty content with finish_reason=length. The documented maximum output is
# 128K; the default here leaves room for a full plan after deep reasoning and
# the operator can move it without a code change.
ZAI_MAX_TOKENS_ENV = "ARIA_ZAI_MAX_TOKENS"
DEFAULT_ZAI_MAX_TOKENS = 65_536
# The documented JSON response format is OFF by default. Measured on
# 2026-09-11 with glm-5.3: under response_format=json_object the model
# rewrote every `.json` evidence path as `package.:13` / `project.:7`
# (three attempts, prompt refs intact) and the kernel's evidence gate rightly
# refused the submission; with the mode off the same task produced an intact
# envelope that was ACCEPTED — the first accepted native planner result. The
# executor extracts the envelope from text exactly as it does for the CLI
# runtimes, so the mode buys nothing and costs the refs. ARIA_ZAI_JSON_OBJECT=1
# turns it on for a model where the measurement comes out the other way.
ZAI_JSON_OBJECT_ENV = "ARIA_ZAI_JSON_OBJECT"


def resolve_zai_json_object(environ: dict[str, str] | None = None) -> bool:
    env = dict(os.environ if environ is None else environ)
    raw = env.get(ZAI_JSON_OBJECT_ENV, "").strip().lower()
    if raw in ("", "0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    raise ZaiCredentialUnavailable("json_object_invalid", f"{ZAI_JSON_OBJECT_ENV}={raw!r}")
# The vendor's reasoning_effort vocabulary; ARIA's profile efforts map onto it.
ZAI_REASONING_EFFORTS: dict[str, str] = {
    "low": "low", "medium": "medium", "high": "high",
    "xhigh": "max", "max": "max", "ultra": "max",
}
USER_AGENT = "aria-kernel-zai-runtime/1"

# Documented base URLs (docs.z.ai/devpack/tool/others, 2026-09-11). The
# Anthropic-protocol route is deliberately absent: it exists for tools that
# speak Anthropic Messages, i.e. the redirected CLI this module replaces.
ZAI_ENDPOINTS: dict[str, str] = {
    "coding": "https://api.z.ai/api/coding/paas/v4",
    "general": "https://api.z.ai/api/paas/v4",
}
CHAT_COMPLETIONS_PATH = "/chat/completions"

# Vendor business codes that name a quota/balance condition even when the
# HTTP status alone would read as a generic client error. Recorded verbatim
# in every observation; used only to name the classification.
_QUOTA_ERROR_CODES = frozenset({"1113", "1302", "1303", "1305"})
_AUTH_ERROR_CODES = frozenset({"1000", "1001", "1002", "1003", "1004"})


class ZaiCredentialUnavailable(RuntimeError):
    """A named reason the Z.ai credential could not be established."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


class ZaiTransportUnavailable(RuntimeError):
    """The transport could not complete a request (timeout, DNS, connection)."""


@dataclass(frozen=True)
class ZaiCredential:
    """The secret, held once, exposed only as an Authorization header value."""

    source: str
    """``file`` or ``env`` — which boundary supplied it. Never the value."""

    location: str
    """The file path or the env var NAME. Never the value."""

    _secret: str = field(repr=False, compare=False, default="")

    def authorization_header(self) -> str:
        return "Bearer " + self._secret

    def __str__(self) -> str:
        return f"ZaiCredential(source={self.source})"

    def __repr__(self) -> str:
        return f"ZaiCredential(source={self.source!r}, location={self.location!r})"


def read_zai_credential(environ: dict[str, str] | None = None) -> ZaiCredential:
    """Establish the credential from ONE boundary, refusing by name otherwise.

    Two sources are never combined: a file path AND an env value present at
    once is ``credential_sources_ambiguous`` — the operator must say which
    one is live, because a stale one of the pair would otherwise decide
    silently. The file must be a regular file readable by its owner only
    (``credential_file_permissions``): a group- or world-readable key is a
    copy every process on the host can take.
    """
    env = dict(os.environ if environ is None else environ)
    file_path = env.get(ZAI_CREDENTIAL_FILE_ENV, "").strip()
    env_value = env.get(ZAI_CREDENTIAL_ENV, "").strip()
    if file_path and env_value:
        raise ZaiCredentialUnavailable(
            "credential_sources_ambiguous",
            f"both {ZAI_CREDENTIAL_FILE_ENV} and {ZAI_CREDENTIAL_ENV} are set; keep one",
        )
    if file_path:
        path = Path(file_path)
        try:
            info = path.stat()
        except OSError as exc:
            raise ZaiCredentialUnavailable("credential_file_unreadable", type(exc).__name__) from exc
        if not stat.S_ISREG(info.st_mode):
            raise ZaiCredentialUnavailable("credential_file_unreadable", "not a regular file")
        if info.st_mode & 0o077:
            raise ZaiCredentialUnavailable(
                "credential_file_permissions",
                f"{path} mode {stat.S_IMODE(info.st_mode):04o} is readable beyond its owner; chmod 0600",
            )
        try:
            secret = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            raise ZaiCredentialUnavailable("credential_file_unreadable", type(exc).__name__) from exc
        if not secret or "\n" in secret:
            raise ZaiCredentialUnavailable("credential_file_empty", "expected exactly one non-empty line")
        return ZaiCredential(source="file", location=str(path), _secret=secret)
    if env_value:
        return ZaiCredential(source="env", location=ZAI_CREDENTIAL_ENV, _secret=env_value)
    raise ZaiCredentialUnavailable(
        "credential_not_configured",
        f"set {ZAI_CREDENTIAL_FILE_ENV} to a 0600 file holding the key (or {ZAI_CREDENTIAL_ENV} in CI)",
    )


def zai_credential_configured(environ: dict[str, str] | None = None) -> bool:
    """Cheap, read-only availability signal for the fleet: a boundary is named.

    Presence only. Whether the key WORKS is `probe_zai_status`' business.
    """
    env = dict(os.environ if environ is None else environ)
    return bool(env.get(ZAI_CREDENTIAL_FILE_ENV, "").strip() or env.get(ZAI_CREDENTIAL_ENV, "").strip())


def resolve_zai_endpoint(environ: dict[str, str] | None = None) -> tuple[str, str]:
    """(endpoint name, base URL) from the operator's selection; unknown names refuse.

    The selection is a documented NAME (``coding`` / ``general``) or, for an
    operator-run gateway that fronts the vendor, an explicit ``http(s)://``
    base URL recorded under the name ``custom`` — never silently rewritten to
    a documented route, so every observation says which URL answered.
    """
    env = dict(os.environ if environ is None else environ)
    selection = env.get(ZAI_ENDPOINT_ENV, "").strip() or DEFAULT_ZAI_ENDPOINT
    if selection.startswith(("http://", "https://")):
        return "custom", selection.rstrip("/")
    if selection not in ZAI_ENDPOINTS:
        raise ZaiCredentialUnavailable(
            "endpoint_unknown",
            f"{ZAI_ENDPOINT_ENV}={selection!r}; known: {sorted(ZAI_ENDPOINTS)} or an explicit base URL",
        )
    return selection, ZAI_ENDPOINTS[selection]


def resolve_zai_model(environ: dict[str, str] | None = None, *, default: str = DEFAULT_ZAI_MODEL) -> str:
    env = dict(os.environ if environ is None else environ)
    return env.get(ZAI_MODEL_ENV, "").strip() or default


def zai_settings_hash(*, endpoint: str, base_url: str, model: str) -> str:
    """Identity of the transport configuration for attempt rows. No secret."""
    payload = json.dumps(
        {"transport": ZAI_TRANSPORT, "endpoint": endpoint, "base_url": base_url, "model": model},
        sort_keys=True, separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class ZaiHttpResponse:
    status: int
    body: bytes
    elapsed_ms: int


Opener = Callable[[urllib.request.Request, float], ZaiHttpResponse]


def _urllib_opener(request: urllib.request.Request, timeout_seconds: float) -> ZaiHttpResponse:
    """The one place a socket is opened. Vendor errors carry a body; keep it."""
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read()
            status = int(response.status)
    except urllib.error.HTTPError as exc:
        body = exc.read()
        status = int(exc.code)
    except urllib.error.URLError as exc:
        raise ZaiTransportUnavailable(f"transport_error:{type(exc.reason).__name__}") from exc
    except TimeoutError as exc:
        raise ZaiTransportUnavailable("transport_timeout") from exc
    except OSError as exc:
        raise ZaiTransportUnavailable(f"transport_error:{type(exc).__name__}") from exc
    return ZaiHttpResponse(status=status, body=body, elapsed_ms=int((time.monotonic() - started) * 1000))


def _post_chat_completion(
    credential: ZaiCredential, *, base_url: str, payload: dict[str, Any],
    timeout_seconds: float, opener: Opener | None,
) -> ZaiHttpResponse:
    request = urllib.request.Request(
        base_url.rstrip("/") + CHAT_COMPLETIONS_PATH,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": credential.authorization_header(),
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    return (opener or _urllib_opener)(request, timeout_seconds)


def _vendor_error(body: bytes) -> tuple[str | None, str | None]:
    """The documented ``{"error": {"code", "message"}}`` shape, if present."""
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeError):
        return None, None
    error = parsed.get("error") if isinstance(parsed, dict) else None
    if not isinstance(error, dict):
        return None, None
    code = error.get("code")
    message = error.get("message")
    return (str(code) if code is not None else None,
            message[:300] if isinstance(message, str) else None)


@dataclass(frozen=True)
class ZaiStatusObservation:
    """What one minimal call to the selected endpoint actually said.

    `decision` is the fleet's three-valued verdict (`status_probe.StatusDecision`)
    stated where the HTTP answer was read: a 200 is DECIDED available; an
    auth rejection, a quota/rate refusal and an authenticated refusal (a
    model the plan does not carry) are all DECIDED unavailable — the vendor
    answered, and its answer was no for this dispatch; a 5xx, an
    unclassified status and a transport failure are UNDECIDED — the vendor
    was not heard, so the fleet retries within its liveness bound.
    """

    auth_observation: str
    quota_observation: str
    reason: str
    endpoint: str
    base_url: str
    model: str
    http_status: int | None
    error_code: str | None
    error_message: str | None
    elapsed_ms: int
    decision: StatusDecision
    transport: str = ZAI_TRANSPORT

    def as_row(self) -> dict[str, Any]:
        return {
            "auth_observation": self.auth_observation,
            "quota_observation": self.quota_observation,
            "reason": self.reason, "endpoint": self.endpoint, "base_url": self.base_url,
            "model": self.model, "http_status": self.http_status,
            "error_code": self.error_code, "error_message": self.error_message,
            "elapsed_ms": self.elapsed_ms, "transport": self.transport,
            "decision": self.decision.value,
        }


def _classify(status: int, code: str | None) -> tuple[str, str, str, StatusDecision]:
    """(auth, quota, reason, decision) from HTTP status + vendor code.
    Conservative: anything not named stays ``unknown`` and UNDECIDED rather
    than being rounded to a verdict; anything the vendor refused is DECIDED
    unavailable, whichever of auth or quota it refused on."""
    if status == 200:
        return "available", "available", "chat_completion_ok", StatusDecision.AVAILABLE
    if status in (401, 403) or (code in _AUTH_ERROR_CODES):
        return "unavailable", "unknown", f"auth_rejected_http_{status}", StatusDecision.UNAVAILABLE
    if status == 429 or status == 402 or (code in _QUOTA_ERROR_CODES):
        # Authenticated, out of quota (or rate): a provider-level fact the
        # operator's 2026-09-12 decision answers with the next vendor.
        return "available", "exhausted", f"quota_or_rate_limited_http_{status}", StatusDecision.UNAVAILABLE
    if 400 <= status < 500:
        # Authenticated, but the request was refused: a model the plan does
        # not carry, or a route the key is not entitled to. Named, not admitted.
        return "available", "unknown", f"request_refused_http_{status}", StatusDecision.UNAVAILABLE
    if status >= 500:
        return "unknown", "unknown", f"vendor_error_http_{status}", StatusDecision.UNDECIDED
    return "unknown", "unknown", f"unclassified_http_{status}", StatusDecision.UNDECIDED


def probe_zai_status(
    credential: ZaiCredential, *, endpoint: str, base_url: str, model: str,
    timeout_seconds: float, opener: Opener | None = None,
) -> ZaiStatusObservation:
    """One minimal completion against the SELECTED endpoint; report what came back.

    This is the runtime's genuine auth/quota observation for the fleet's
    admission — a vendor answer, not a file-exists guess. It spends one
    output token by design; an entitlement question cannot be settled for
    free, and the alternative (assume) is how a Coding-Plan key ends up
    billed against a wallet nobody funded.
    """
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the single word OK."}],
        "max_tokens": 1,
        "temperature": 0,
        "stream": False,
    }
    timeout = max(1.0, min(float(timeout_seconds), PROBE_TIMEOUT_CEILING_SECONDS))
    try:
        response = _post_chat_completion(
            credential, base_url=base_url, payload=payload, timeout_seconds=timeout, opener=opener,
        )
    except ZaiTransportUnavailable as exc:
        return ZaiStatusObservation(
            auth_observation="unknown", quota_observation="unknown", reason=str(exc),
            endpoint=endpoint, base_url=base_url, model=model, http_status=None,
            error_code=None, error_message=None, elapsed_ms=0, decision=StatusDecision.UNDECIDED,
        )
    code, message = _vendor_error(response.body)
    auth, quota, reason, decision = _classify(response.status, code)
    return ZaiStatusObservation(
        auth_observation=auth, quota_observation=quota, reason=reason,
        endpoint=endpoint, base_url=base_url, model=model, http_status=response.status,
        error_code=code, error_message=message, elapsed_ms=response.elapsed_ms, decision=decision,
    )


@dataclass(frozen=True)
class ZaiRunResult:
    """One completed (or refused) chat call, classified the way the executor reads it."""

    http_status: int | None
    final_message: str
    usage: dict[str, int] | None
    """``{"input_tokens", "output_tokens"}`` from the vendor's ``usage`` block, or None."""

    auth_failure: str | None
    credit_exhaustion: str | None
    error_code: str | None
    error_message: str | None
    response_id: str | None
    model: str | None
    finish_reason: str | None
    elapsed_ms: int
    raw_body: bytes = field(repr=False, default=b"")

    @property
    def returncode(self) -> int:
        """0 for an admitted completion; 1 otherwise. Mirrors the CLI runtimes."""
        return 0 if self.http_status == 200 and self.final_message else 1


def resolve_zai_max_tokens(environ: dict[str, str] | None = None) -> int:
    env = dict(os.environ if environ is None else environ)
    raw = env.get(ZAI_MAX_TOKENS_ENV, "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError as exc:
            raise ZaiCredentialUnavailable("max_tokens_invalid", f"{ZAI_MAX_TOKENS_ENV}={raw!r}") from exc
        if value <= 0:
            raise ZaiCredentialUnavailable("max_tokens_invalid", f"{ZAI_MAX_TOKENS_ENV}={raw!r}")
        return value
    return DEFAULT_ZAI_MAX_TOKENS


def run_zai_chat(
    credential: ZaiCredential, *, base_url: str, model: str, system: str, user: str,
    timeout_seconds: float = DEFAULT_ZAI_TIMEOUT_SECONDS, max_tokens: int = DEFAULT_ZAI_MAX_TOKENS,
    temperature: float = 0.0, reasoning_effort: str | None = None, json_object: bool = False,
    opener: Opener | None = None,
) -> ZaiRunResult:
    """Send one agent prompt as a chat completion and return the classified result.

    No tool loop: the kernel supplies evidence inline (the envelope's
    excerpts and repository map), and the agent answers with the
    ``aria/agent-response/v1`` JSON the executor validates. Streaming is off
    so the vendor's ``usage`` block arrives with the body — the executor
    refuses a result whose usage is unknown rather than pricing it as zero.
    ``reasoning_effort`` is the route's effort in the vendor's vocabulary (an
    unmapped effort is omitted, leaving the vendor default); ``json_object``
    asks for the documented JSON response format — off by default, see
    ZAI_JSON_OBJECT_ENV for the measurement that decided it.
    """
    payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": int(max_tokens),
        "temperature": float(temperature),
        "stream": False,
    }
    mapped = ZAI_REASONING_EFFORTS.get(str(reasoning_effort or "").lower())
    if mapped:
        payload["reasoning_effort"] = mapped
    if json_object:
        payload["response_format"] = {"type": "json_object"}
    response = _post_chat_completion(
        credential, base_url=base_url, payload=payload,
        timeout_seconds=max(1.0, float(timeout_seconds)), opener=opener,
    )
    code, message = _vendor_error(response.body)
    # The run reads the same classification as the probe; the admission
    # decision is the probe's business, the run keeps auth/quota/reason.
    auth, quota, reason, _decision = _classify(response.status, code)
    final_message = ""
    usage: dict[str, int] | None = None
    response_id: str | None = None
    responded_model: str | None = None
    finish_reason: str | None = None
    if response.status == 200:
        try:
            parsed = json.loads(response.body.decode("utf-8"))
        except (ValueError, UnicodeError):
            parsed = None
        if isinstance(parsed, dict):
            response_id = parsed.get("id") if isinstance(parsed.get("id"), str) else None
            responded_model = parsed.get("model") if isinstance(parsed.get("model"), str) else None
            choices = parsed.get("choices")
            if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                choice = choices[0]
                finish_reason = choice.get("finish_reason") if isinstance(choice.get("finish_reason"), str) else None
                content = (choice.get("message") or {}).get("content") if isinstance(choice.get("message"), dict) else None
                if isinstance(content, str):
                    final_message = content
            usage_block = parsed.get("usage")
            if (isinstance(usage_block, dict)
                    and type(usage_block.get("prompt_tokens")) is int
                    and type(usage_block.get("completion_tokens")) is int
                    and usage_block["prompt_tokens"] >= 0 and usage_block["completion_tokens"] >= 0):
                usage = {"input_tokens": usage_block["prompt_tokens"],
                         "output_tokens": usage_block["completion_tokens"]}
    if response.status == 200 and not final_message and finish_reason == "length":
        # The budget ran out before any answer: a named result, not a mystery
        # "provider_nonzero". The executor raises the max_tokens or lowers the
        # reasoning effort; it never prices an empty answer as a result.
        error_code = code or "output_budget_exhausted"
        message = message or "finish_reason=length with empty content; reasoning consumed max_tokens"
        return ZaiRunResult(
            http_status=response.status, final_message="", usage=usage, auth_failure=None,
            credit_exhaustion=None, error_code=error_code, error_message=message,
            response_id=response_id, model=responded_model, finish_reason=finish_reason,
            elapsed_ms=response.elapsed_ms, raw_body=response.body,
        )
    return ZaiRunResult(
        http_status=response.status, final_message=final_message, usage=usage,
        auth_failure=reason if auth == "unavailable" else None,
        credit_exhaustion=reason if quota == "exhausted" else None,
        error_code=code, error_message=message, response_id=response_id,
        model=responded_model, finish_reason=finish_reason,
        elapsed_ms=response.elapsed_ms, raw_body=response.body,
    )


@dataclass(frozen=True)
class ZaiExecutionContext:
    """What the executor holds between admission and the call: never the secret's value."""

    credential: ZaiCredential
    endpoint: str
    base_url: str
    model: str

    @property
    def settings_hash(self) -> str:
        return zai_settings_hash(endpoint=self.endpoint, base_url=self.base_url, model=self.model)

    @property
    def auth_method(self) -> str:
        return ZAI_AUTH_METHOD

    def __repr__(self) -> str:
        return (f"ZaiExecutionContext(endpoint={self.endpoint!r}, model={self.model!r}, "
                f"credential={self.credential!r})")


def prepare_zai_context(environment: dict[str, str], *, default_model: str = DEFAULT_ZAI_MODEL) -> ZaiExecutionContext:
    """Resolve credential, endpoint and model from the operator's environment.

    Raises ``ZaiCredentialUnavailable`` with the named reason; the executor
    turns that into a status observation, never into a silent skip.
    """
    credential = read_zai_credential(environment)
    endpoint, base_url = resolve_zai_endpoint(environment)
    model = resolve_zai_model(environment, default=default_model)
    return ZaiExecutionContext(credential=credential, endpoint=endpoint, base_url=base_url, model=model)


__all__ = [
    "CHAT_COMPLETIONS_PATH", "DEFAULT_ZAI_ENDPOINT", "DEFAULT_ZAI_MODEL",
    "DEFAULT_ZAI_TIMEOUT_SECONDS", "ZAI_CREDENTIAL_ENV", "ZAI_CREDENTIAL_FILE_ENV",
    "DEFAULT_ZAI_MAX_TOKENS", "ZAI_ENDPOINTS", "ZAI_ENDPOINT_ENV", "ZAI_MAX_TOKENS_ENV", "ZAI_MODEL_ENV",
    "ZAI_PROVIDER_KEY", "ZAI_REASONING_EFFORTS", "ZAI_TRANSPORT",
    "ZAI_AUTH_METHOD", "ZaiCredential", "ZaiCredentialUnavailable", "ZaiExecutionContext",
    "ZaiHttpResponse", "ZaiRunResult", "prepare_zai_context",
    "ZaiStatusObservation", "ZaiTransportUnavailable", "probe_zai_status",
    "ZAI_JSON_OBJECT_ENV", "read_zai_credential", "resolve_zai_endpoint", "resolve_zai_json_object",
    "resolve_zai_max_tokens", "resolve_zai_model", "run_zai_chat",
    "zai_credential_configured", "zai_settings_hash",
]
