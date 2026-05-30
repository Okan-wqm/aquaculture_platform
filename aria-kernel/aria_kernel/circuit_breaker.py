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

Each kind counts toward the same 24h sliding window; sum > N trips the
breaker. ``N`` is configurable in ``genesis_policy_default.json``
under ``circuit_breaker.threshold_24h`` (default 3).

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
"""

from __future__ import annotations

import json
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

_DEFAULT_THRESHOLD_24H: int = 3


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


def _load_threshold(base_dir: str | Path) -> int:
    """Plan ARIA-V3 §2j — read ``circuit_breaker.threshold_24h`` from
    genesis policy (defaults to 3). Same load-path semantics as B0
    ``cost_budget._load_caps`` — repo_root is the parent of tools_dir.
    """
    from .genesis_policy import load_policy

    repo_root = Path(base_dir).parent
    policy = load_policy(repo_root)
    cb = policy.get("circuit_breaker") or {}
    if not isinstance(cb, dict):
        return _DEFAULT_THRESHOLD_24H
    raw = cb.get("threshold_24h", _DEFAULT_THRESHOLD_24H)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return _DEFAULT_THRESHOLD_24H


def _read_failures(base_dir: str | Path) -> list[dict[str, Any]]:
    """Plan ARIA-V3 §B2 — read the failures ledger via the strict
    JSONL reader (Plan 026R §A.3 invariant).

    Tolerant mode is correct here: a corrupt row in the breaker
    ledger should NOT block the breaker's current-state read
    (failing closed on a single bad row would defeat the breaker's
    own purpose of being the kernel's safety net). The strict
    reader still emits ``ledger_corruption_diagnostic`` so an
    operator audit catches the corruption.
    """
    from .strict_jsonl_reader import read_strict_jsonl

    path = _failures_path(base_dir)
    if not path.exists():
        return []
    return list(
        read_strict_jsonl(
            path,
            on_corruption="tolerant",
            base_dir=Path(base_dir),
        )
    )


def _count_failures_24h(rows: list[dict[str, Any]]) -> int:
    """Plan ARIA-V3 §2j — sliding 24h window. A failure ages out when
    its ``ts`` is more than 24 hours behind ``utcnow``.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    counted = 0
    for row in rows:
        ts_raw = row.get("ts", "")
        try:
            ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        if ts >= cutoff:
            counted += 1
    return counted


def current_state(base_dir: str | Path) -> str:
    """Plan ARIA-V3 §B2 — return ``ok`` or ``tripped``. Re-derived
    from disk every call so kill-9-mid-materialize cannot
    desynchronise the in-memory and on-disk views (I-V3-25b).
    """
    rows = _read_failures(base_dir)
    threshold = _load_threshold(base_dir)
    sliding = _count_failures_24h(rows)
    return "tripped" if sliding >= threshold else "ok"


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
    # If this failure tipped the breaker over the threshold, persist
    # the tripped state + emit the trip event. ``current_state``
    # reads from disk so the just-appended row is included.
    if current_state(root) == "tripped":
        _atomic_write_json(
            _state_path(root),
            {
                "state": "tripped",
                "tripped_at": _utc_now_iso(),
                "tripped_by_kind": kind,
                "tripped_by_event_id": materialize_event_id,
                "threshold_24h": _load_threshold(root),
            },
        )
        append_tools_governance(
            root,
            "circuit_breaker_tripped",
            {
                "tripped_by_kind": kind,
                "materialize_event_id": materialize_event_id,
                "threshold_24h": _load_threshold(root),
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
    """
    state = current_state(base_dir)
    if state == "tripped":
        raise GovernanceError(
            f"circuit_breaker_tripped: threshold_24h="
            f"{_load_threshold(base_dir)} exceeded"
        )
    return {"status": "ok", "state": state}


__all__ = [
    "FAILURE_KINDS",
    "assert_within_breaker",
    "current_state",
    "record_attempt_started",
    "record_failure",
    "reset_breaker",
]
