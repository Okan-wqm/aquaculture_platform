"""Plan 025 §C — gold-set replay recall.

Plan 024 calibration measured recall only over *surfaced* findings (a judge
voted and ground truth happened to exist). True recall asks: when a judge is
shown a finding it never saw whose verdict is already known, does it get it
right? This module replays the judges on the promoted gold corpus: it seeds each
gold item's known verdict as the replay's ground-truth anchor (under a dedicated
``replay:`` judgment group) and mints two judge envelopes per item (reusing the
Plan 025 §A fan-out). Once the judges respond, recall falls out of
``compute_judge_calibration(judgment_group_prefix="replay:")`` — no new recall
math is needed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .agent_invocations import create_agent_invocation_request
from .feedback_store import (
    FEEDBACK_SEVERITIES,
    FEEDBACK_VERDICTS,
    GROUND_TRUTH_SOURCE_TYPES,
    load_feedback,
    record_operator_feedback,
)
from .goldset import load_active_goldset
from .judge_fanout import JUDGE_FANOUT, _render_prompt
from .tool_registry import ensure_tools_dir


REPLAY_GROUP_PREFIX = "replay:"


def _replay_group(tool_id: str, run_id: str, finding_id: str) -> str:
    return f"{REPLAY_GROUP_PREFIX}{tool_id}:{run_id}:{finding_id}"


def replay_judges_on_goldset(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
    target_sha: str | None = None,
) -> dict[str, Any]:
    """Seed gold ground truth + mint judge envelopes for each gold item."""
    root = ensure_tools_dir(base_dir)
    active = load_active_goldset(tool_id=tool_id, base_dir=root)
    if not active:
        return {"schema_version": 1, "status": "no_active_goldset", "replayed_items": 0, "minted": [], "seeded": []}
    items = list(active.get("true_positive_items") or []) + list(active.get("known_false_positive_items") or [])
    # Replay is idempotent: the gold ground-truth seed is appended only once per
    # (run, finding, replay-group). record_operator_feedback is an unconditional
    # append, so without this guard every re-run would duplicate the anchor row
    # and re-skew calibration. Envelope minting is already idempotent (request_id).
    existing_seeds = {
        (str(r.get("run_id")), str(r.get("finding_id")), str(r.get("judgment_group_id")))
        for r in load_feedback(base_dir=root)
        if r.get("judge_id") == "goldset-replay"
    }
    minted: list[dict[str, Any]] = []
    seeded: list[str] = []
    unprovable: list[dict[str, str]] = []
    for gi in items:
        run_id = str(gi.get("run_id") or "")
        finding_id = str(gi.get("finding_id") or "")
        verdict = str(gi.get("verdict") or "")
        if not run_id or not finding_id or verdict not in FEEDBACK_VERDICTS:
            continue
        group = _replay_group(tool_id, run_id, finding_id)
        severity = str(gi.get("severity") or "medium")
        if severity not in FEEDBACK_SEVERITIES:
            severity = "medium"
        # Ground-truth anchor for the replay, under the replay group so
        # compute_judge_calibration joins the judges' replay verdicts to it.
        # Seeded once per (run, finding, group) — re-runs do not duplicate it.
        #
        # JJ-1 (ORPHAN-HIGH-731) — the seed RESTATES the gold item's own
        # provenance instead of minting a fresh authority. Pre-JJ-1 it wrote
        # a bare ai_consensus row, which under the anchor rule would be a
        # 0-judge row: the replay's own ground truth would have stopped
        # counting as ground truth and recall would have silently read zero.
        # An operator-labelled gold item seeds as `human`; an anchor-backed
        # one seeds with the anchor's own (judge_count, judges_voted).
        #
        # WHAT THIS MUST NEVER DO IS SYNTHESISE `human`. The pre-fix branch
        # resolved an item whose provenance did not add up (ai_consensus with
        # no judge_count — i.e. every goldset promoted before JJ-1) UPWARD to
        # source_type="human", the top tier of _build_ground_truth. A machine
        # was minting operator verdicts, and five of them satisfied the very
        # promotion gate JJ-2a introduced (`operator_group_keys` non-empty ->
        # precision_anchored with zero anchors). Absence fails CLOSED here:
        # an item whose provenance cannot be proved is SKIPPED, loudly, and
        # its judges are not sat down in front of a question no answer can be
        # scored against. A curated label is not an operator verdict.
        if (run_id, finding_id, group) not in existing_seeds:
            seed_source = str(gi.get("source_type") or "human")
            seed_judge_count = gi.get("judge_count")
            seed_judges_voted = gi.get("judges_voted")
            if seed_source not in GROUND_TRUTH_SOURCE_TYPES:
                unprovable.append({
                    "run_id": run_id, "finding_id": finding_id,
                    "reason": f"source_type_not_ground_truth:{seed_source!r}",
                })
                continue
            if seed_source == "ai_consensus" and not (
                isinstance(seed_judge_count, int)
                and not isinstance(seed_judge_count, bool)
                and isinstance(seed_judges_voted, int)
                and not isinstance(seed_judges_voted, bool)
            ):
                unprovable.append({
                    "run_id": run_id, "finding_id": finding_id,
                    "reason": "ai_consensus_item_without_anchor_counts",
                })
                continue
            record_operator_feedback(
                tool_id=tool_id, run_id=run_id, finding_id=finding_id, verdict=verdict,
                severity=severity, note="goldset_replay_ground_truth",
                source_type=seed_source, judge_id="goldset-replay",
                judgment_group_id=group, judge_count=seed_judge_count,
                judges_voted=seed_judges_voted,
                base_dir=root,
            )
            existing_seeds.add((run_id, finding_id, group))
            seeded.append(group)
        item = {
            "tool_id": tool_id, "run_id": run_id, "finding_id": finding_id,
            "rule": gi.get("finding_fingerprint") or "goldset", "severity": severity,
            "path": "", "message": "goldset replay finding",
            "evidence": gi.get("evidence_refs") or [],
        }
        prompt = _render_prompt(item)
        for role, agent in JUDGE_FANOUT:
            req = create_agent_invocation_request(
                target_agent=agent, role=role, suggested_prompt=prompt,
                must_satisfy=[{"id": "verdict", "criterion": "Return true_positive or false_positive with file:line evidence"}],
                allowed_scope=["**"],
                finding_id=finding_id, tool_id=tool_id, run_id=run_id,
                judgment_group_id=group, target_sha=target_sha, base_dir=root,
            )
            minted.append({"request_id": req.get("request_id"), "role": role, "judgment_group_id": group})
    return {
        "schema_version": 1, "status": "dispatched", "replayed_items": len(seeded),
        "minted": minted, "seeded": seeded,
        # Skipped items are REPORTED, never silent: a gold corpus whose
        # provenance stopped proving anything is a fact the operator's daily
        # report should carry, not a number that quietly reads zero.
        "unprovable_provenance": unprovable,
    }


def compute_replay_recall(*, base_dir: str | Path | None = None, min_samples: int = 1) -> dict[str, Any]:
    """Judge recall over the gold-set replay alone (judgment_group_prefix='replay:')."""
    from .judge_calibration import compute_judge_calibration
    return compute_judge_calibration(
        base_dir=base_dir, judgment_group_prefix=REPLAY_GROUP_PREFIX, min_samples=min_samples,
    )
