from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import load_feedback
from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


DEFAULT_TARGET_TRUE_POSITIVES = 20
DEFAULT_TARGET_KNOWN_FALSE_POSITIVES = 10


def propose_goldset(
    *,
    tool_id: str,
    cycle_id: str | None = None,
    target_true_positives: int = DEFAULT_TARGET_TRUE_POSITIVES,
    target_known_false_positives: int = DEFAULT_TARGET_KNOWN_FALSE_POSITIVES,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if target_true_positives <= 0 or target_known_false_positives < 0:
        raise GovernanceError("goldset targets must be positive true positives and non-negative known false positives")
    rows = [
        row
        for row in load_feedback(tool_id=tool_id, base_dir=base_dir)
        if row.get("source_type") in ("human", "ai_consensus", None)
    ]
    true_positives = [_gold_item(row) for row in rows if row.get("verdict") == "true_positive"]
    known_false_positives = [_gold_item(row) for row in rows if row.get("verdict") == "false_positive"]
    status = (
        "ready"
        if len(true_positives) >= target_true_positives and len(known_false_positives) >= target_known_false_positives
        else "blocked"
    )
    blockers = []
    if len(true_positives) < target_true_positives:
        blockers.append("insufficient_true_positive_gold_items")
    if len(known_false_positives) < target_known_false_positives:
        blockers.append("insufficient_known_false_positive_gold_items")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "tool_id": tool_id,
        "status": status,
        "target_true_positive_count": target_true_positives,
        "target_known_false_positive_count": target_known_false_positives,
        "true_positive_count": len(true_positives),
        "known_false_positive_count": len(known_false_positives),
        "true_positive_items": true_positives[:target_true_positives],
        "known_false_positive_items": known_false_positives[:target_known_false_positives],
        "blocked_by": blockers,
    }
    root = ensure_tools_dir(base_dir)
    stored = append_declared_jsonl(
        root / "goldsets" / "proposals.jsonl",
        row,
        expected_surface="goldset_proposals",
    )
    if status == "ready":
        append_declared_jsonl(
            root / "memory" / "learning-events.jsonl",
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "cycle_id": cycle_id,
                "event_type": "goldset_promoted",
                "target_type": "tool",
                "target_id": tool_id,
                "repo_state_id": None,
                "base_commit_sha": None,
                "evidence_hashes": [],
                "details": {
                    "true_positive_count": len(true_positives),
                    "known_false_positive_count": len(known_false_positives),
                },
            },
            expected_surface="memory_learning_events",
        )
    return stored


def list_goldset_proposals(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        ensure_tools_dir(base_dir) / "goldsets" / "proposals.jsonl",
        expected_surface="goldset_proposals",
    )


def _gold_item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_id": row.get("run_id"),
        "finding_id": row.get("finding_id"),
        "finding_fingerprint": row.get("finding_fingerprint"),
        "verdict": row.get("verdict"),
        "severity": row.get("severity"),
        "source_type": row.get("source_type", "human"),
        "confidence": row.get("confidence"),
        "evidence_refs": row.get("evidence_refs", []),
        "rationale": row.get("rationale") or row.get("note"),
    }
