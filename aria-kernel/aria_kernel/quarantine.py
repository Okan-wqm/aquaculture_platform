from __future__ import annotations

from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, get_tool, transition_tool, utc_now


def quarantine_log_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / "quarantine.jsonl"


def append_quarantine_event(
    event: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    payload = {"schema_version": 1, "at": utc_now(), **event}
    return append_declared_jsonl(quarantine_log_path(base_dir), payload, expected_surface="quarantine_log")


def quarantine_tool(
    tool_id: str,
    reason: str,
    *,
    base_dir: str | Path | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    if not reason:
        raise GovernanceError("quarantine reason is required")
    previous = get_tool(tool_id, base_dir)
    updated = transition_tool(
        tool_id,
        "QUARANTINED",
        reason=reason,
        base_dir=base_dir,
    )
    # One quarantine, one stamp: the ledger row carries the transition's
    # own `at`, so the two records of the same event agree to the byte and
    # `tool_sit_out.standing_quarantine` reads either one as the anchor
    # (the nightly manifest re-sync drops the registry row's transition; the
    # ledger row is what survives). A second utc_now() here sat ~35 ms
    # after the first and crossed the second boundary ~4% of the time.
    append_quarantine_event(
        {
            "at": updated["last_transition"]["at"],
            "tool_id": tool_id,
            "run_id": run_id,
            "reason": reason,
            "previous_status": previous["status"],
            "prior_findings_revalidation": "required",
            "status": "QUARANTINED",
        },
        base_dir,
    )
    return updated
