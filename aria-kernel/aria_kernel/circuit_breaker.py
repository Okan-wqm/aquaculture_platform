"""Plan ARIA-V3 §B2 + §2j + AUDITTRAIL-CRITICAL-005 — autonomous-loop failure breaker.

Co-equal with the cost circuit breaker (B0). The cost breaker trips on
$cost overruns; this one trips on a sum-of-all failures across the
6-kind taxonomy enumerated by Plan ARIA-V3 §2j:

  * ``validator_rejection`` — draft_validator rejected the rendered
    intent (banned phrase, missing section, classifier veto).
  * ``sandbox_red`` — sandbox CI failed for an autonomous-loop draft.
  * ``ci_red`` — post-merge CI failed (the auto-merge regressed main).
  * ``gh_api_failure`` — ``gh`` CLI returned non-zero on a merge / PR
    inspection call.
  * ``subprocess_timeout`` — claude CLI exceeded
    ``MAX_TIMEOUT_SECONDS`` (default 1800).
  * ``operator_rollback`` — the operator ran ``aria-kernel rollback
    materialize <id>`` within 24h of the autonomous materialize.

Each kind counts toward the same sliding window; sum > N trips the
breaker. ``N`` is configurable in ``genesis_policy_default.json``
under ``circuit_breaker.failure_threshold`` (default 3), counted over
``circuit_breaker.failure_window_hours`` (default 72).

AUDITTRAIL-CRITICAL-005 atomic-with-event invariant:
  ``record_failure`` MUST write the failure row AND emit the
  ``circuit_breaker_failure_recorded`` governance event AS ONE
  atomic unit (single ``append_tools_governance`` call). A kill-9
  between the two writes would leave the kernel believing it has
  N-1 failures when the operator audit sees N — re-reading the
  failures.jsonl tail at startup re-derives the canonical state
  from the persisted rows.

State survives kernel restart (I-V3-25b): the entire state is
disk-only. ``current_state(base_dir)`` re-reads ``failures.jsonl``
on every call.

ORPHAN-CRITICAL-418 fail-closed invariant:
  The breaker is a safety net, so it answers ``tripped`` whenever it
  cannot prove it is safe. Evidence damage is evaluated BEFORE the
  threshold comparison, which makes ``ok``-under-damage unreachable:

    * ledger unreadable         → ``tripped`` (``evidence_unreadable``)
    * rows lost to corruption   → ``tripped`` (``evidence_incomplete``)
    * ``ts`` missing/unparseable → row counts as IN-window

  Pre-fix all three drained the sliding-window count instead, so a
  crash mid-append, a truncated artifact round-trip, or deliberate
  tampering silently returned the kernel to a permissive state. With
  a threshold of 3, three valid failure rows tripped the breaker but
  corrupting two of them answered ``ok``.

  :func:`evaluate_breaker` is the primitive; it returns the reason
  alongside the state so that persisting one persists the other.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
)

_BREAKER_DIR_RELATIVE = ("breakers",)
_FAILURES_FILENAME = "autonomous-failures.jsonl"
_STATE_FILENAME = "autonomous-state.json"

# Plan ARIA-V3 §2j — closed failure taxonomy. Any caller passing an
# unknown kind raises GovernanceError; this prevents typo-class kinds
# from silently failing to count toward the trip threshold.
FAILURE_KINDS: frozenset[str] = frozenset(
    {
        "validator_rejection",
        "sandbox_red",
        "ci_red",
        "gh_api_failure",
        "subprocess_timeout",
        "operator_rollback",
    }
)

# ORPHAN-MEDIUM-468 — these are fallbacks for a policy read that failed, not
# the policy itself. The authoritative values live in
# genesis_policy.CIRCUIT_BREAKER_DEFAULTS; they are duplicated here only so a
# broken policy file cannot leave the breaker with no threshold at all.
_DEFAULT_FAILURE_THRESHOLD: int = 3
_DEFAULT_FAILURE_WINDOW_HOURS: int = 72


def _breaker_dir(base_dir: str | Path) -> Path:
    return Path(base_dir).joinpath(*_BREAKER_DIR_RELATIVE)


def _failures_path(base_dir: str | Path) -> Path:
    return _breaker_dir(base_dir) / _FAILURES_FILENAME


def _state_path(base_dir: str | Path) -> Path:
    return _breaker_dir(base_dir) / _STATE_FILENAME


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{id(payload)}")
    tmp.write_text(
        json.dumps(payload, sort_keys=True, indent=2),
        encoding="utf-8",
    )
    tmp.replace(path)


def _load_breaker_policy(base_dir: str | Path) -> tuple[int, int]:
    """ORPHAN-MEDIUM-468 — (failure_threshold, failure_window_hours) from policy.

    Reads through genesis_policy.circuit_breaker_policy() rather than reaching
    into the raw dict, so the block gets the same typed-accessor treatment every
    other nested policy block already had — and so an operator override still
    carrying the pre-468 ``threshold_24h`` key raises instead of being silently
    replaced by defaults.

    A malformed VALUE still falls back per-field rather than raising: a policy
    file with a non-integer threshold should not make the breaker unreadable,
    because an unreadable breaker is itself a fail-open path. A renamed KEY is
    different — it is a migration error the operator must see.
    """
    from .genesis_policy import circuit_breaker_policy

    repo_root = Path(base_dir).parent
    block = circuit_breaker_policy(repo_root)
    try:
        threshold = int(block.get("failure_threshold", _DEFAULT_FAILURE_THRESHOLD))
    except (TypeError, ValueError):
        threshold = _DEFAULT_FAILURE_THRESHOLD
    try:
        window_hours = int(block.get("failure_window_hours", _DEFAULT_FAILURE_WINDOW_HOURS))
    except (TypeError, ValueError):
        window_hours = _DEFAULT_FAILURE_WINDOW_HOURS
    if window_hours <= 0:
        window_hours = _DEFAULT_FAILURE_WINDOW_HOURS
    return threshold, window_hours


@dataclass(frozen=True)
class BreakerEvidence:
    """The failure ledger as actually read, plus how much of it was lost.

    ``rows_present`` is the number of non-blank lines the ledger held;
    ``rows`` is what survived decoding into objects. Any shortfall is
    lost failure evidence, which is why the two are carried together
    instead of returning a bare row list — a caller cannot compute a
    trip decision without also seeing what it could not read.
    """

    rows: tuple[dict[str, Any], ...]
    rows_present: int
    unreadable: bool
    read_error: str | None

    @property
    def dropped_rows(self) -> int:
        return max(0, self.rows_present - len(self.rows))

    @property
    def intact(self) -> bool:
        return not self.unreadable and self.dropped_rows == 0


@dataclass(frozen=True)
class BreakerVerdict:
    """Why the breaker is in the state it is in.

    ``state`` alone collapses "no failures" and "cannot tell" into the
    same string, which is how damaged evidence used to read as ``ok``.
    The reason is part of the return type so a caller that persists or
    logs the state also persists why.
    """

    state: str
    reason: str
    sliding_count: int
    # ORPHAN-MEDIUM-468 — `threshold` and `window_hours` replace the single
    # `threshold_24h` field. The old name conflated a COUNT with the window it
    # was counted over, and hardcoded the window into an identifier, so the
    # name would have started lying the moment the window moved off 24h.
    threshold: int
    window_hours: int
    evidence: BreakerEvidence


BREAKER_STATE_OK: str = "ok"
BREAKER_STATE_TRIPPED: str = "tripped"

BREAKER_REASON_WITHIN_THRESHOLD: str = "within_threshold"
BREAKER_REASON_THRESHOLD_EXCEEDED: str = "threshold_exceeded"
BREAKER_REASON_EVIDENCE_INCOMPLETE: str = "evidence_incomplete"
BREAKER_REASON_EVIDENCE_UNREADABLE: str = "evidence_unreadable"


def _read_failures_evidence(base_dir: str | Path) -> BreakerEvidence:
    """Plan ARIA-V3 §B2 — read the failures ledger via the strict
    JSONL reader (Plan 026R §A.3 invariant), reporting what was lost.

    Tolerant mode stays because a corrupt row must not raise on the
    read path — but the count of rows the reader had to skip is
    returned rather than discarded. Pre-fix this function returned a
    bare list, so a truncated or tampered ledger was indistinguishable
    from a short one and the sliding-window count silently fell below
    the trip threshold (ORPHAN-CRITICAL-418). A non-dict row that
    happens to be valid JSON (``123``, ``"x"``, ``[]``) is lost
    evidence for the same reason and is counted as dropped.

    Line counting happens BEFORE the row read so that a concurrent
    append (the appender holds the file lock, this reader does not)
    can only ever make ``rows`` longer than ``rows_present`` — never
    shorter. That ordering makes a false "incomplete" verdict
    impossible while still catching real loss.
    """
    from .strict_jsonl_reader import read_strict_jsonl

    path = _failures_path(base_dir)
    if not path.exists():
        return BreakerEvidence(rows=(), rows_present=0, unreadable=False, read_error=None)
    try:
        rows_present = sum(
            1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
        )
    except OSError as exc:
        return BreakerEvidence(
            rows=(), rows_present=0, unreadable=True, read_error=str(exc),
        )
    try:
        decoded = tuple(
            row
            for row in read_strict_jsonl(
                path,
                on_corruption="tolerant",
                base_dir=Path(base_dir),
            )
            if isinstance(row, dict)
        )
    except (OSError, GovernanceError) as exc:
        return BreakerEvidence(
            rows=(), rows_present=rows_present, unreadable=True, read_error=str(exc),
        )
    return BreakerEvidence(
        rows=decoded, rows_present=rows_present, unreadable=False, read_error=None,
    )


def _count_failures_in_window(
    rows: tuple[dict[str, Any], ...] | list[dict[str, Any]],
    *,
    window_hours: int,
) -> int:
    """Plan ARIA-V3 §2j — sliding window. A failure ages out when its ``ts``
    is more than ``window_hours`` behind ``utcnow``.

    ORPHAN-MEDIUM-468 — the window was a hardcoded 24h, which equalled the
    nightly cron cadence. A prior night's row therefore sat exactly on the
    boundary and whether it still counted depended on where inside each run the
    failure landed. The window is now policy-driven and defaults to 72h, so
    accumulation across nights is decided by the number of failures rather than
    by scheduler jitter.

    A missing or unparseable ``ts`` counts as IN-window. Pre-fix such a
    row was skipped, so blanking the timestamps on a ledger dropped the
    count below the threshold and un-tripped the breaker
    (ORPHAN-CRITICAL-418). A failure whose age cannot be established
    has not been shown to have aged out.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    counted = 0
    for row in rows:
        ts_raw = row.get("ts", "")
        try:
            ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            counted += 1
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts >= cutoff:
            counted += 1
    return counted


def evaluate_breaker(base_dir: str | Path) -> BreakerVerdict:
    """Plan ARIA-V3 §B2 — derive the breaker verdict from disk.

    Damaged evidence is decided BEFORE the threshold comparison, so
    ``ok`` is unreachable whenever the ledger is unreadable or lost
    rows. For a safety net, evidence that cannot be read means tripped:
    the alternative — the pre-fix behaviour — let a crash mid-append, a
    truncated artifact round-trip, or deliberate tampering return the
    kernel to a permissive state (ORPHAN-CRITICAL-418).

    Re-derived on every call so kill-9-mid-materialize cannot
    desynchronise the in-memory and on-disk views (I-V3-25b).
    """
    evidence = _read_failures_evidence(base_dir)
    threshold, window_hours = _load_breaker_policy(base_dir)
    sliding = _count_failures_in_window(evidence.rows, window_hours=window_hours)
    if evidence.unreadable:
        return BreakerVerdict(
            state=BREAKER_STATE_TRIPPED,
            reason=BREAKER_REASON_EVIDENCE_UNREADABLE,
            sliding_count=sliding,
            threshold=threshold,
            window_hours=window_hours,
            evidence=evidence,
        )
    if evidence.dropped_rows:
        return BreakerVerdict(
            state=BREAKER_STATE_TRIPPED,
            reason=BREAKER_REASON_EVIDENCE_INCOMPLETE,
            sliding_count=sliding,
            threshold=threshold,
            window_hours=window_hours,
            evidence=evidence,
        )
    tripped = sliding >= threshold
    return BreakerVerdict(
        state=BREAKER_STATE_TRIPPED if tripped else BREAKER_STATE_OK,
        reason=(
            BREAKER_REASON_THRESHOLD_EXCEEDED
            if tripped
            else BREAKER_REASON_WITHIN_THRESHOLD
        ),
        sliding_count=sliding,
        threshold=threshold,
        window_hours=window_hours,
        evidence=evidence,
    )


def current_state(base_dir: str | Path) -> str:
    """Plan ARIA-V3 §B2 — return ``ok`` or ``tripped``.

    Thin projection of :func:`evaluate_breaker`; callers that need to
    record WHY should take the verdict instead of this string.
    """
    return evaluate_breaker(base_dir).state


def record_failure(
    *,
    base_dir: str | Path,
    kind: str,
    materialize_event_id: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B2 + §2j + AUDITTRAIL-CRITICAL-005 — append one
    failure row AND emit the matching governance event as ONE atomic
    write. ``extra`` carries kind-specific context (validator complaint
    string, sandbox run URL, gh stderr tail, etc.) but cannot replace
    the closed-set ``kind`` field.

    Raises GovernanceError on unknown kind so a typo cannot silently
    fail to count.
    """
    if kind not in FAILURE_KINDS:
        raise GovernanceError(
            f"circuit_breaker_unknown_failure_kind: {kind!r} "
            f"(allowed: {sorted(FAILURE_KINDS)})"
        )
    root = ensure_tools_dir(base_dir)
    row = {
        "schema_version": 1,
        "kind": kind,
        "ts": _utc_now_iso(),
        "materialize_event_id": materialize_event_id,
        "extra": extra or {},
    }
    # Atomic append to failures.jsonl. The kernel's ``append_jsonl``
    # acquires the file lock + writes the row before this call
    # returns; subsequent ``current_state`` reads see the new row.
    from .ledger import append_jsonl

    path = _failures_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    append_jsonl(path, row)
    # Atomic-with-event invariant: same call site emits the
    # governance row recording the failure. Replay-reconstructable.
    append_tools_governance(
        root,
        "circuit_breaker_failure_recorded",
        {
            "kind": kind,
            "materialize_event_id": materialize_event_id,
            "extra": extra or {},
        },
    )
    # If the breaker is now tripped, persist the tripped state + emit
    # the trip event. ``evaluate_breaker`` reads from disk so the
    # just-appended row is included. The verdict's reason is recorded
    # because a trip caused by lost evidence is a different operator
    # action than a trip caused by real failures crossing the
    # threshold, and attributing the former to ``kind`` would be a
    # false audit row.
    verdict = evaluate_breaker(root)
    if verdict.state == BREAKER_STATE_TRIPPED:
        _atomic_write_json(
            _state_path(root),
            {
                "state": BREAKER_STATE_TRIPPED,
                "tripped_at": _utc_now_iso(),
                "tripped_reason": verdict.reason,
                "tripped_by_kind": kind,
                "tripped_by_event_id": materialize_event_id,
                "sliding_count": verdict.sliding_count,
                "evidence_rows_present": verdict.evidence.rows_present,
                "evidence_dropped_rows": verdict.evidence.dropped_rows,
                "threshold": verdict.threshold,
                "window_hours": verdict.window_hours,
            },
        )
        append_tools_governance(
            root,
            "circuit_breaker_tripped",
            {
                "tripped_reason": verdict.reason,
                "tripped_by_kind": kind,
                "materialize_event_id": materialize_event_id,
                "sliding_count": verdict.sliding_count,
                "evidence_dropped_rows": verdict.evidence.dropped_rows,
                "threshold": verdict.threshold,
                "window_hours": verdict.window_hours,
            },
        )
    return row


def record_attempt_started(
    *,
    base_dir: str | Path,
    materialize_event_id: str,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B2 + AUDITTRAIL-CRITICAL-005 — emit one
    ``materialize_attempt_started`` governance row per autonomous
    materialize entry. Pre-attempt emission means a kill-9
    mid-materialize still leaves the attempt in the audit log;
    operator post-mortem can correlate to whichever failure kind
    applies.
    """
    root = ensure_tools_dir(base_dir)
    append_tools_governance(
        root,
        "materialize_attempt_started",
        {"materialize_event_id": materialize_event_id},
    )
    return {"status": "recorded", "materialize_event_id": materialize_event_id}


def reset_breaker(
    *,
    base_dir: str | Path,
    operator_approval_ref: str,
    reason: str,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B2 — operator clears the tripped flag AND
    truncates ``failures.jsonl`` (the 24h sliding window starts
    fresh). The truncate-on-reset semantic is the operator's
    "investigated + resolved + want clean slate" signal.
    """
    if not (operator_approval_ref or "").strip():
        raise GovernanceError("circuit_breaker_reset_requires_approval_ref")
    if not (reason or "").strip():
        raise GovernanceError("circuit_breaker_reset_requires_reason")
    root = ensure_tools_dir(base_dir)
    _atomic_write_json(_state_path(root), {"state": "ok"})
    failures_path = _failures_path(root)
    if failures_path.exists():
        failures_path.write_text("", encoding="utf-8")
    append_tools_governance(
        root,
        "circuit_breaker_reset",
        {
            "operator_approval_ref": operator_approval_ref,
            "reason": reason,
        },
    )
    return {"status": "ok"}


def assert_within_breaker(base_dir: str | Path) -> dict[str, Any]:
    """Plan ARIA-V3 §B2 — call BEFORE entering the autonomous path.
    Raises ``GovernanceError`` when the breaker is tripped.

    The refusal message carries the verdict reason so an operator can
    tell "3 real failures in 24h" apart from "the failure ledger lost
    rows" without re-deriving it by hand.
    """
    verdict = evaluate_breaker(base_dir)
    if verdict.state == BREAKER_STATE_TRIPPED:
        raise GovernanceError(
            f"circuit_breaker_tripped: reason={verdict.reason} "
            f"sliding_count={verdict.sliding_count} "
            f"threshold={verdict.threshold} "
            f"window_hours={verdict.window_hours} "
            f"evidence_dropped_rows={verdict.evidence.dropped_rows}"
        )
    return {
        "status": "ok",
        "state": verdict.state,
        "reason": verdict.reason,
        "sliding_count": verdict.sliding_count,
        "threshold": verdict.threshold,
                "window_hours": verdict.window_hours,
    }


__all__ = [
    "BREAKER_REASON_EVIDENCE_INCOMPLETE",
    "BREAKER_REASON_EVIDENCE_UNREADABLE",
    "BREAKER_REASON_THRESHOLD_EXCEEDED",
    "BREAKER_REASON_WITHIN_THRESHOLD",
    "BREAKER_STATE_OK",
    "BREAKER_STATE_TRIPPED",
    "BreakerEvidence",
    "BreakerVerdict",
    "FAILURE_KINDS",
    "assert_within_breaker",
    "current_state",
    "evaluate_breaker",
    "record_attempt_started",
    "record_failure",
    "reset_breaker",
]
