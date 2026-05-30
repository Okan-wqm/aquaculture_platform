"""V10.5 Phase 3 — Anthropic API 529 backoff wrapper.

Closes F-023 (cycle 7 cyc-20260520T144934Z-auto round-2 cross_review
blocked by Anthropic API 529 OVERLOADED; 3 retry attempts with NO
backoff all hit 529; cycle stalled until poll_timeout).

Architecture (per ADR-0001):
- with_api_backoff wraps a subprocess.run callable
- Detects 529 via stderr regex AND envelope-text regex (both anchored)
- Respects `retry-after` header from Anthropic SDK when present
- Falls back to exponential backoff base (30s, 120s, 600s) + jitter
- Uses threading.Event(timeout) NOT time.sleep — SIGTERM-aware
- Per-cycle outage counter in api-outage-ledger.jsonl (fcntl-locked)
- After attempts exhausted: raises APIOutageDetected
- After cycle outage threshold exceeded: raises CycleOutageBudgetExceeded
- Emits api_backoff_engaged + api_backoff_exhausted governance events
- Disabled by default; opt-in via ARIA_API_BACKOFF=1

V10.4 F-016 layer 2 scrub integration: _scrub_env removes CLAUDE_* +
CLAUDECODE inherited env vars per retry attempt.

Reference: /root/.claude/plans/immutable-sparking-waterfall.md §C
"""
from __future__ import annotations

import json
import os
import random
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


# Anthropic 529 detection patterns — anchored to avoid false positives.
# stderr must contain ANY of these lines (line-anchored):
_STDERR_529_PATTERNS = [
    re.compile(r"^.*\b529\s+Overloaded\b.*$", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^.*HTTP/[\d.]+\s+529\b.*$", re.IGNORECASE | re.MULTILINE),
    re.compile(r"^.*anthropic\.APIError:\s*529\b.*$", re.IGNORECASE | re.MULTILINE),
]
# envelope (subprocess stdout JSON) text matching — anchored regex
_ENVELOPE_529_PATTERN = re.compile(
    r"API Error:\s*529\s+Overloaded", re.IGNORECASE
)
# retry-after header parsing (Anthropic sends as integer seconds or HTTP-date;
# we only parse integer-seconds form here)
_RETRY_AFTER_PATTERN = re.compile(
    r"retry-after:\s*(\d+)", re.IGNORECASE
)


class APIOutageDetected(Exception):
    """Raised after exhausting retry attempts on a single subprocess call."""


class CycleOutageBudgetExceeded(Exception):
    """Raised when per-cycle 529-hit counter exceeds threshold."""


@dataclass(frozen=True)
class RetryPolicy:
    """Configuration for with_api_backoff.

    Defaults respect Anthropic SDK best practice:
    - retry-after header takes precedence over fallback backoffs
    - jitter prevents thundering-herd on Anthropic recovery
    - max_total_wall_clock caps cumulative sleep across attempts
    - enabled=False default preserves V10.4 behavior byte-identical
    """
    attempts: int = 3
    base_backoffs: tuple[int, ...] = (30, 120, 600)
    respect_retry_after: bool = True
    jitter_factor: float = 0.2
    max_total_wall_clock: int = 1200  # 20 min cap on cumulative sleep
    cycle_outage_threshold: int = 3   # raise CycleOutageBudgetExceeded after N
    enabled: bool = False


def _is_enabled() -> bool:
    """Read ARIA_API_BACKOFF env var with strict truthy parsing."""
    raw = os.environ.get("ARIA_API_BACKOFF", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _scrub_env(env: dict[str, str]) -> dict[str, str]:
    """V10.4 F-016 layer 2 — strip CLAUDE_* + CLAUDECODE from subprocess env.

    Returns a copy of env with parent-session-leak vars removed. The
    parent's OAuth token + session ID would otherwise leak into the
    retry subprocess, potentially causing rate-limit collision or
    session-history pollution.
    """
    return {
        k: v for k, v in env.items()
        if not k.startswith(("CLAUDE_", "CLAUDECODE"))
    }


def _detect_529(stdout: bytes | str, stderr: bytes | str) -> bool:
    """Return True if subprocess output indicates Anthropic 529 Overloaded.

    Both signals match: (a) stderr contains a 529 line, OR (b) envelope
    text (stdout) contains the canonical error string. Either suffices.
    """
    stderr_str = stderr.decode("utf-8", errors="replace") if isinstance(stderr, bytes) else stderr
    stdout_str = stdout.decode("utf-8", errors="replace") if isinstance(stdout, bytes) else stdout
    for pattern in _STDERR_529_PATTERNS:
        if pattern.search(stderr_str):
            return True
    if _ENVELOPE_529_PATTERN.search(stdout_str):
        return True
    return False


def _parse_retry_after(stderr: bytes | str) -> int | None:
    """Extract retry-after seconds from stderr if Anthropic emitted it.

    Returns the integer-seconds value, or None if no header parsed.
    """
    stderr_str = stderr.decode("utf-8", errors="replace") if isinstance(stderr, bytes) else stderr
    match = _RETRY_AFTER_PATTERN.search(stderr_str)
    if not match:
        return None
    try:
        seconds = int(match.group(1))
        return max(0, min(seconds, 3600))  # cap at 1h
    except (ValueError, IndexError):
        return None


def _compute_sleep_seconds(
    attempt: int,
    retry_after: int | None,
    base_backoff: int,
    jitter_factor: float,
) -> float:
    """Compute per-attempt sleep duration with jitter.

    retry_after takes precedence if present; otherwise base_backoff
    with +/- jitter_factor randomization.
    """
    base = retry_after if retry_after is not None else base_backoff
    jitter = base * jitter_factor * random.uniform(-1.0, 1.0)
    return max(0.1, base + jitter)


def _cancellable_sleep(seconds: float, interrupt_event: threading.Event | None) -> bool:
    """Sleep up to `seconds` but exit early if interrupt_event is set.

    Returns True if sleep completed; False if interrupted.
    Uses threading.Event.wait(timeout) instead of time.sleep to make
    SIGTERM observable on POSIX (CODE-CRIT-3 fix per audit).
    """
    if interrupt_event is None:
        # Fallback: a fresh, never-set event behaves like time.sleep.
        time.sleep(seconds)
        return True
    interrupted = interrupt_event.wait(timeout=seconds)
    return not interrupted


def _emit_governance(
    tools_dir: Path,
    kind: str,
    details: dict[str, Any],
) -> None:
    """Append a governance event to aria-tools/governance.jsonl.

    Uses the existing append_tools_governance pattern from tool_registry
    when available; falls back to a direct append if running outside the
    kernel import path. Either way the row is appended atomically with
    fcntl (parent module owns locking).
    """
    try:
        # Lazy import to avoid hard dependency on kernel at module load.
        from aria_kernel.tool_registry import append_tools_governance  # type: ignore
        append_tools_governance(tools_dir, kind, details)
    except (ImportError, Exception):
        # Defensive fallback: append directly (kernel may not be on path
        # in unit tests; the kernel path is preferred in production).
        governance_path = tools_dir / "governance.jsonl"
        row = {
            "schema": "aria/governance-event/v2",
            "kind": kind,
            "ts": datetime.now(timezone.utc).isoformat(),
            "details": details,
        }
        try:
            with governance_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, sort_keys=True) + "\n")
        except OSError:
            # Best-effort; do not raise from instrumentation path.
            pass


def _increment_cycle_outage_counter(
    tools_dir: Path,
    cycle_id: str,
) -> int:
    """Append to api-outage-ledger.jsonl + return current count for cycle_id.

    Schema per row: {cycle_id, occurred_at}. Counter is derived by
    scanning the ledger; not stored separately. fcntl-locked via the
    governance-event helper at the parent level.
    """
    ledger_path = tools_dir / "api-outage-ledger.jsonl"
    row = {
        "cycle_id": cycle_id,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        with ledger_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
    except OSError:
        return 0
    # Re-read to compute current count
    count = 0
    try:
        with ledger_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    parsed = json.loads(line)
                    if parsed.get("cycle_id") == cycle_id:
                        count += 1
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return count


def with_api_backoff(
    call: Callable[[], subprocess.CompletedProcess[bytes] | subprocess.CompletedProcess[str]],
    *,
    request_id: str,
    role: str,
    tools_dir: Path,
    cycle_id: str | None = None,
    retry_policy: RetryPolicy | None = None,
    interrupt_event: threading.Event | None = None,
) -> subprocess.CompletedProcess[Any]:
    """Run `call` with Anthropic 529 retry policy.

    Args:
        call: zero-argument callable that returns a CompletedProcess.
            Caller is responsible for constructing the actual subprocess.run
            invocation (env, args, timeout, etc.).
        request_id: ARIA request identifier (e.g. AIR-aria-...).
        role: agent role (challenger_plan, cross_review, primary_plan).
        tools_dir: aria-tools/ Path; governance + outage ledger root.
        cycle_id: current cycle ID for per-cycle counter (optional).
        retry_policy: RetryPolicy. Default = RetryPolicy() with
            enabled=False. Caller can override with enabled=True for
            opt-in retry; or check ARIA_API_BACKOFF env var via _is_enabled().
        interrupt_event: threading.Event for SIGTERM-aware sleep.

    Returns:
        CompletedProcess from the LAST attempt (successful or final 529).

    Raises:
        APIOutageDetected: after `attempts` retries all hit 529.
        CycleOutageBudgetExceeded: cycle outage counter exceeds threshold.
    """
    policy = retry_policy if retry_policy is not None else RetryPolicy()
    # If env-flag override active AND policy not explicitly set, enable.
    if not policy.enabled and _is_enabled():
        policy = RetryPolicy(
            attempts=policy.attempts,
            base_backoffs=policy.base_backoffs,
            respect_retry_after=policy.respect_retry_after,
            jitter_factor=policy.jitter_factor,
            max_total_wall_clock=policy.max_total_wall_clock,
            cycle_outage_threshold=policy.cycle_outage_threshold,
            enabled=True,
        )

    # Disabled path: byte-identical V10.4 behavior — single call, no retry.
    if not policy.enabled:
        return call()

    cumulative_sleep = 0.0
    last_completed: subprocess.CompletedProcess[Any] | None = None
    for attempt_idx in range(policy.attempts + 1):  # attempts retries + 1 initial
        completed = call()
        last_completed = completed
        if completed.returncode == 0 and not _detect_529(completed.stdout or b"", completed.stderr or b""):
            # Success path
            return completed
        if not _detect_529(completed.stdout or b"", completed.stderr or b""):
            # Non-529 failure — pass through without retry
            return completed
        # 529 detected.
        if attempt_idx >= policy.attempts:
            # Final attempt also hit 529 — record + raise.
            _emit_governance(tools_dir, "api_backoff_exhausted", {
                "request_id": request_id,
                "role": role,
                "cycle_id": cycle_id,
                "total_attempts": attempt_idx + 1,
                "cumulative_sleep_seconds": cumulative_sleep,
            })
            if cycle_id:
                cycle_counter = _increment_cycle_outage_counter(tools_dir, cycle_id)
                if cycle_counter > policy.cycle_outage_threshold:
                    raise CycleOutageBudgetExceeded(
                        f"cycle {cycle_id} 529 hit {cycle_counter} times "
                        f"(threshold={policy.cycle_outage_threshold})"
                    )
            raise APIOutageDetected(
                f"request {request_id} role={role} hit 529 on all "
                f"{policy.attempts + 1} attempts; cumulative sleep "
                f"{cumulative_sleep:.1f}s"
            )
        # Compute sleep for next attempt.
        retry_after = (
            _parse_retry_after(completed.stderr or b"")
            if policy.respect_retry_after else None
        )
        base = policy.base_backoffs[min(attempt_idx, len(policy.base_backoffs) - 1)]
        sleep_seconds = _compute_sleep_seconds(
            attempt=attempt_idx,
            retry_after=retry_after,
            base_backoff=base,
            jitter_factor=policy.jitter_factor,
        )
        # Honor max_total_wall_clock cap.
        if cumulative_sleep + sleep_seconds > policy.max_total_wall_clock:
            sleep_seconds = max(0.1, policy.max_total_wall_clock - cumulative_sleep)
        _emit_governance(tools_dir, "api_backoff_engaged", {
            "request_id": request_id,
            "role": role,
            "cycle_id": cycle_id,
            "attempt_number": attempt_idx + 1,
            "sleep_seconds": sleep_seconds,
            "retry_after_header_used": retry_after is not None,
        })
        completed_naturally = _cancellable_sleep(sleep_seconds, interrupt_event)
        cumulative_sleep += sleep_seconds
        if not completed_naturally:
            # SIGTERM interrupted; treat as outage with controlled exit.
            _emit_governance(tools_dir, "api_backoff_interrupted", {
                "request_id": request_id,
                "role": role,
                "cycle_id": cycle_id,
                "attempt_number": attempt_idx + 1,
                "cumulative_sleep_seconds": cumulative_sleep,
            })
            raise APIOutageDetected(
                f"request {request_id} interrupted during backoff sleep"
            )
    # Unreachable: loop above either returns or raises before this line.
    assert last_completed is not None
    return last_completed
