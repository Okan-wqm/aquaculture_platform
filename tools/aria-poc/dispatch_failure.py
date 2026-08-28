"""ARIA-HIGH-002 — the typed executor failure contract (Task 4).

The baseline drain's 26 jobs produced one success and 25 mostly
unclassified ``claude_cli_exit_1`` failures: every perimeter condition —
expired session, missing CLI, unauthorised provider redirect, timeout,
quota wall — collapsed into a single exit code, so no ledger, breaker, or
operator could tell them apart. This module is the one shared classifier
both executors call; it maps existing Claude exceptions, result markers,
and exit codes onto a closed vocabulary with an explicit retryability
policy, and produces the sanitized ``aria/dispatch-result/v1`` child
summary that travels out of the runner without ever carrying raw
stdout/stderr, prompts, or credential-shaped strings.

Boundary with Task 5: ``resolve_dispatch_route`` is resolved BEFORE the
claim so a drain can key its circuit on provider/model, and the predicted
route is what the child summary records. The executed-route-equals-
predicted-route assertion is the drain's contract (``classify_route_mismatch``
is the shared classifier for it); this module never guesses an executed
tier from stream-json model ids, which are vendor names, not ARIA tier
aliases.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping

_POC_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _POC_DIR.parents[1]
_ARIA_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
for _path in (str(_POC_DIR), str(_ARIA_KERNEL_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import claude_runtime  # noqa: E402
from aria_kernel.agent_runtime_profile import resolve_claude_model  # noqa: E402

DispatchFailureClass = Literal[
    "cli_unavailable",
    "auth_unavailable",
    "auth_failed",
    "usage_unavailable",
    "credit_exhausted",
    "provider_redirect_unavailable",
    "policy_violation",
    "timeout",
    "response_schema_rejected",
    "process_exit",
    "unknown",
]

#: The closed vocabulary. A failure outside this set is a programming
#: error, not a new category someone may improvise at a callsite.
DISPATCH_FAILURE_CLASSES: tuple[DispatchFailureClass, ...] = (
    "cli_unavailable",
    "auth_unavailable",
    "auth_failed",
    "usage_unavailable",
    "credit_exhausted",
    "provider_redirect_unavailable",
    "policy_violation",
    "timeout",
    "response_schema_rejected",
    "process_exit",
    "unknown",
)

#: Where in the dispatch lifecycle a failure was observed.
DISPATCH_PHASES: tuple[str, ...] = (
    "preflight", "spawn", "runtime", "submit", "drain",
)

#: Terminal child outcomes for the v1 summary wire.
DISPATCH_OUTCOMES: tuple[str, ...] = ("succeeded", "failed", "refused")

DISPATCH_RESULT_SCHEMA = "aria/dispatch-result/v1"
DISPATCH_RESULT_SCHEMA_VERSION = 1

#: The provider every non-redirected model routes through (managed Claude
#: session). Redirected models resolve theirs from the redirect SSoT.
DEFAULT_PROVIDER = "anthropic"

# A detail code is a slug from OUR vocabularies (exception prefixes, marker
# names, exit codes) — never free text. Anything that fails this shape
# (raw stderr fragments, tokens, prose) is dropped, which is what makes the
# summary safe by construction rather than by redaction.
_DETAIL_CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")

# The request id becomes a filename under RUNNER_TEMP and a value inside
# GITHUB_OUTPUT; a newline-bearing id is an output-injection attempt, not a
# request id. Fail closed instead of sanitizing: the trusted envelope owes
# us a well-formed id.
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


@dataclass(frozen=True, slots=True)
class DispatchFailure:
    failure_class: DispatchFailureClass
    retryable: bool
    detail_code: str
    phase: Literal["preflight", "spawn", "runtime", "submit", "drain"]
    exit_code: int | None = None

    def __post_init__(self) -> None:
        if self.failure_class not in DISPATCH_FAILURE_CLASSES:
            raise ValueError(
                f"unknown_dispatch_failure_class: {self.failure_class!r}; "
                f"vocabulary is {DISPATCH_FAILURE_CLASSES}"
            )
        if self.phase not in DISPATCH_PHASES:
            raise ValueError(f"unknown_dispatch_phase: {self.phase!r}")


@dataclass(frozen=True, slots=True)
class DispatchRoute:
    provider: str
    model: str
    role: str
    target_agent: str


# Exception types are imported lazily-safe above; the mapping is ordered so
# a future subclass relationship cannot silently shadow a more specific
# class. Retryability: the perimeter family is terminal for the request
# (auth/credit/CLI/policy/redirect conditions do not heal inside a drain);
# timeout and process exits follow the existing bounded per-request retry
# policy, so they stay retryable and visible.
_EXCEPTION_CLASSES: tuple[tuple[type[BaseException], DispatchFailureClass], ...] = (
    (claude_runtime.ClaudeAuthUnavailable, "auth_unavailable"),
    (claude_runtime.ClaudeAuthFailure, "auth_failed"),
    (claude_runtime.ClaudeCliUnavailable, "cli_unavailable"),
    (claude_runtime.ClaudeUsageUnavailable, "usage_unavailable"),
    (claude_runtime.ClaudeCreditExhausted, "credit_exhausted"),
    (claude_runtime.ProviderRedirectUnavailable, "provider_redirect_unavailable"),
    (claude_runtime.ClaudePolicyViolation, "policy_violation"),
    (subprocess.TimeoutExpired, "timeout"),
)


def _sanitized_detail_code(raw: str) -> str:
    """The leading slug of a message, only if it is a slug at all."""
    text = raw.strip()
    if not text:
        return ""
    head = text.split(None, 1)[0].rstrip(":")
    return head if _DETAIL_CODE_PATTERN.fullmatch(head) else ""


def _detail_from_exception(exc: BaseException, failure_class: str) -> str:
    return _sanitized_detail_code(str(exc)) or failure_class


def _detail_from_marker(marker: Mapping[str, Any] | None, failure_class: str) -> str:
    if isinstance(marker, Mapping):
        code = _sanitized_detail_code(str(marker.get("matched_marker") or ""))
        if code:
            return code
    return failure_class


def classify_dispatch_failure(
    *,
    exception: BaseException | None = None,
    result: Any = None,
    phase: str,
) -> DispatchFailure | None:
    """Classify one terminal dispatch signal, or return ``None`` for success.

    Exactly one of ``exception``/``result`` carries the signal. A model
    refusal is NOT a failure — the runtime's refusal record is a request-
    scoped terminal outcome, and classifying it as a build failure is the
    defect this contract exists to prevent.
    """
    if phase not in DISPATCH_PHASES:
        raise ValueError(f"unknown_dispatch_phase: {phase!r}")
    if exception is not None:
        for exc_type, failure_class in _EXCEPTION_CLASSES:
            if isinstance(exception, exc_type):
                return DispatchFailure(
                    failure_class=failure_class,
                    retryable=failure_class == "timeout",
                    detail_code=_detail_from_exception(exception, failure_class),
                    phase=phase,
                    exit_code=getattr(exception, "returncode", None),
                )
        # ValueError/TypeError at the runtime boundary is the response-
        # contract validator refusing an envelope: the child ran, its answer
        # did not satisfy the schema.
        if isinstance(exception, (ValueError, TypeError)):
            return DispatchFailure(
                failure_class="response_schema_rejected",
                retryable=False,
                detail_code=_detail_from_exception(exception, "response_schema_rejected"),
                phase=phase,
            )
        return DispatchFailure(
            failure_class="unknown",
            retryable=True,
            detail_code=_detail_from_exception(exception, "unknown"),
            phase=phase,
        )
    if result is not None:
        auth_failure = getattr(result, "auth_failure", None)
        if auth_failure:
            return DispatchFailure(
                failure_class="auth_failed",
                retryable=False,
                detail_code=_detail_from_marker(auth_failure, "auth_failed"),
                phase=phase,
            )
        credit_exhaustion = getattr(result, "credit_exhaustion", None)
        if credit_exhaustion:
            return DispatchFailure(
                failure_class="credit_exhausted",
                retryable=False,
                detail_code=_detail_from_marker(credit_exhaustion, "credit_exhausted"),
                phase=phase,
            )
        returncode = getattr(result, "returncode", 0)
        if returncode != 0:
            return DispatchFailure(
                failure_class="process_exit",
                retryable=True,
                detail_code=f"claude_exit_{int(returncode)}",
                phase=phase,
                exit_code=int(returncode),
            )
        return None
    return None


def resolve_dispatch_route(
    *, request: Mapping[str, Any], repo_root: str | Path,
) -> DispatchRoute:
    """The route a dispatch on ``request`` will take, resolved pre-claim.

    Model comes from the frontmatter SSoT (``resolve_claude_model``);
    provider comes from the redirect SSoT (``provider_redirect_disclosure``)
    — an unredirected model resolves the default Anthropic route byte-for-
    byte, because this function never touches spawn environment at all.
    """
    target_agent = str(request.get("target_agent") or "").strip()
    if not target_agent:
        raise ValueError("dispatch_route_target_agent_missing")
    role = str(request.get("role") or "").strip()
    model = resolve_claude_model(target_agent, repo_root=repo_root)
    disclosure = claude_runtime.provider_redirect_disclosure(model)
    provider = str(disclosure.get("provider") or DEFAULT_PROVIDER)
    return DispatchRoute(
        provider=provider, model=model, role=role, target_agent=target_agent,
    )


def classify_route_mismatch(
    *, predicted: DispatchRoute, executed: DispatchRoute,
) -> DispatchFailure | None:
    """A child that executed a different route than the predicted one.

    The dispatch contract (route resolved pre-claim, child dispatched on
    that same route) is runtime policy; violating it is a classified
    contract failure, not an unclassified exit.
    """
    if predicted == executed:
        return None
    return DispatchFailure(
        failure_class="policy_violation",
        retryable=False,
        detail_code="dispatch_route_mismatch",
        phase="runtime",
    )


def build_dispatch_result_summary(
    *,
    route: DispatchRoute,
    request_id: str,
    outcome: str,
    failure: DispatchFailure | None,
    exit_code: int | None,
) -> dict[str, Any]:
    """The exact ``aria/dispatch-result/v1`` wire shape — nothing else."""
    if outcome not in DISPATCH_OUTCOMES:
        raise ValueError(f"unknown_dispatch_outcome: {outcome!r}")
    rid = str(request_id)
    if not _REQUEST_ID_PATTERN.fullmatch(rid):
        raise ValueError("dispatch_result_request_id_invalid")
    return {
        "$schema": DISPATCH_RESULT_SCHEMA,
        "schema_version": DISPATCH_RESULT_SCHEMA_VERSION,
        "request_id": rid,
        "role": route.role,
        "target_agent": route.target_agent,
        "provider": route.provider,
        "model": route.model,
        "outcome": outcome,
        "failure_class": failure.failure_class if failure is not None else None,
        "retryable": bool(failure.retryable) if failure is not None else False,
        "failure_detail_code": failure.detail_code if failure is not None else None,
        "exit_code": int(exit_code) if exit_code is not None else None,
    }


def write_dispatch_result_summary(
    summary: Mapping[str, Any], *, runnertemp: str | None = None,
) -> Path | None:
    """Write the summary under RUNNER_TEMP through the artifact-safety SSoT.

    No RUNNER_TEMP (local dev, daemon context) means no file — same
    fail-open convention as the envelope-path publisher, because the
    summary is telemetry and the dispatch outcome must not depend on it.
    """
    base = runnertemp or os.environ.get("RUNNER_TEMP")
    if not base:
        return None
    from aria_kernel.artifact_safety import write_sanitized_json

    path = Path(base) / f"dispatch-result-{summary['request_id']}.json"
    write_sanitized_json(path, dict(summary))
    return path


def publish_dispatch_summary_path(
    path: Path | None, *, github_output: str | None = None,
) -> None:
    """Append ``dispatch_summary_path`` to GITHUB_OUTPUT — the path only."""
    output_file = github_output or os.environ.get("GITHUB_OUTPUT")
    if output_file is None or path is None:
        return
    with open(output_file, "a", encoding="utf-8") as handle:
        handle.write(f"dispatch_summary_path={Path(path).resolve().as_posix()}\n")


def emit_dispatch_result_summary(
    *,
    route: DispatchRoute,
    request_id: str,
    outcome: str,
    failure: DispatchFailure | None = None,
    exit_code: int | None = None,
    runnertemp: str | None = None,
    github_output: str | None = None,
) -> Path | None:
    """One terminal-path emitter: build, sanitize-write, publish the path."""
    summary = build_dispatch_result_summary(
        route=route,
        request_id=request_id,
        outcome=outcome,
        failure=failure,
        exit_code=exit_code,
    )
    path = write_dispatch_result_summary(summary, runnertemp=runnertemp)
    if path is not None:
        publish_dispatch_summary_path(path, github_output=github_output)
    return path
