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
    _skip_if_unchanged: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Propose a gold corpus for one tool from its labelled feedback.

    ``_skip_if_unchanged`` carries the tool's most recent proposal; when the
    computed picture matches it the function returns None and appends nothing,
    which is what keeps the per-cycle producer from writing an identical row
    every night. Direct callers (the CLI ceremony) leave it None and always
    get a row.
    """
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
    if _skip_if_unchanged is not None and all(
        _skip_if_unchanged.get(field) == row[field]
        for field in (
            "status",
            "true_positive_count",
            "known_false_positive_count",
            "target_true_positive_count",
            "target_known_false_positive_count",
        )
    ):
        return None
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


def propose_goldsets_for_labelled_tools(
    *,
    cycle_id: str | None = None,
    target_true_positives: int = DEFAULT_TARGET_TRUE_POSITIVES,
    target_known_false_positives: int = DEFAULT_TARGET_KNOWN_FALSE_POSITIVES,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """The producer ``propose_goldset`` never had.

    ``propose_goldset`` has existed since Plan 025 §B and NOTHING ever called
    it: the curator agent wrote into a void, `promote_goldset_proposal` had no
    `ready` proposal to promote, and `judge_replay` / `proactive_priority` read
    an active corpus that could never come into being. The read side was live
    and the write side was unreachable — the gap this closes.

    Every labelled tool gets a proposal so the operator sees distance-to-ready
    ("3 more true positives") instead of silence. A proposal is appended only
    when the picture CHANGED against the last one for that tool: the nightly
    runs forever, and a ledger row per cycle per tool would bury the real
    transitions under identical repeats.
    """
    root = ensure_tools_dir(base_dir)
    labelled_tools = sorted(
        {
            str(row.get("tool_id"))
            for row in load_feedback(base_dir=root)
            if row.get("tool_id")
            and row.get("verdict") in ("true_positive", "false_positive")
            and row.get("source_type") in ("human", "ai_consensus", None)
        }
    )
    latest: dict[str, dict[str, Any]] = {}
    for proposal in list_goldset_proposals(base_dir=root):
        tool_id = proposal.get("tool_id")
        if isinstance(tool_id, str):
            latest[tool_id] = proposal

    proposed: list[dict[str, Any]] = []
    unchanged: list[str] = []
    for tool_id in labelled_tools:
        row = propose_goldset(
            tool_id=tool_id,
            cycle_id=cycle_id,
            target_true_positives=target_true_positives,
            target_known_false_positives=target_known_false_positives,
            base_dir=root,
            _skip_if_unchanged=latest.get(tool_id),
        )
        if row is None:
            unchanged.append(tool_id)
            continue
        proposed.append(
            {
                "tool_id": tool_id,
                "status": row.get("status"),
                "true_positive_count": row.get("true_positive_count"),
                "known_false_positive_count": row.get("known_false_positive_count"),
                "blocked_by": row.get("blocked_by", []),
            }
        )
    return {
        "labelled_tool_count": len(labelled_tools),
        "proposed": proposed,
        "unchanged_tool_ids": unchanged,
        "ready_tool_ids": [p["tool_id"] for p in proposed if p["status"] == "ready"],
    }


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
