from __future__ import annotations

import json
import re
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


def _safe_tool_id(tool_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(tool_id))


def _active_goldset_path(tools_root: Path, tool_id: str) -> Path:
    return tools_root / "goldsets" / "active" / f"{_safe_tool_id(tool_id)}.json"


def promote_goldset_proposal(
    *,
    tool_id: str,
    curator: str,
    base_dir: str | Path | None = None,
    proposal: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Plan 025 §B — turn a ``ready`` proposal into the ACTIVE gold corpus.

    Before this, ``goldset.py`` was dead-ended: ``propose_goldset`` wrote a
    proposal and a misnamed ``goldset_promoted`` marker, but nothing ever
    promoted or consumed it. Promotion is an explicit operator act (a named
    ``curator`` accepts a proposal) that writes the approved TP/FP gold items
    to a stable per-tool active file, which the Plan 025 §C judge-replay reads.

    NOTE: the gold corpus is JUDGE ground truth (findings + verdicts), not an
    adapter regression fixture — the proposal carries no adapter input/expected,
    so it is deliberately NOT forced into a semantic_regression case.

    NOTE: passing ``proposal=`` is a deliberate operator override that bypasses
    the hash-chained ``proposals.jsonl`` ledger verification (the default path,
    ``proposal=None``, reads ``ready`` proposals from that verified ledger). The
    named ``curator`` is the accountable act; callers supplying a hand-built
    proposal own its provenance.
    """
    if not isinstance(curator, str) or not curator.strip():
        raise GovernanceError("curator is required")
    root = ensure_tools_dir(base_dir)
    if proposal is None:
        ready = [
            p for p in list_goldset_proposals(base_dir=root)
            if p.get("tool_id") == tool_id and p.get("status") == "ready"
        ]
        if not ready:
            raise GovernanceError(f"no ready goldset proposal for tool {tool_id!r}")
        proposal = ready[-1]
    if proposal.get("status") != "ready":
        raise GovernanceError("only a 'ready' goldset proposal can be promoted")
    record = {
        "schema_version": 1,
        "status": "active",
        "promoted_at": utc_now(),
        "tool_id": tool_id,
        "curator": curator.strip(),
        "source_proposal_recorded_at": proposal.get("recorded_at"),
        "true_positive_count": proposal.get("true_positive_count"),
        "known_false_positive_count": proposal.get("known_false_positive_count"),
        "true_positive_items": proposal.get("true_positive_items", []),
        "known_false_positive_items": proposal.get("known_false_positive_items", []),
    }
    path = _active_goldset_path(root, tool_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return record


def load_active_goldset(
    *, tool_id: str, base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """The active gold corpus for a tool, or None if none has been promoted."""
    path = _active_goldset_path(ensure_tools_dir(base_dir), tool_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


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
