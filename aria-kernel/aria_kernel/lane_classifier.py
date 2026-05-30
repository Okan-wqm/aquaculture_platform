"""Plan ARIA-V3 §2c + §A0 — kernel-derived lane classification.

The `lane` value (e.g. ``L3-snowball``, ``L0-main``) is the trust gate
that decides whether autonomous materialization is permissible. Phase 1
of the architectural fix (CRIT-V3-002) makes the lane **kernel-derived**
from PR metadata — the operator CLI has no ``--lane`` flag and cannot
forge the value. This makes lane spoofing structurally impossible
(Tier-1): a malicious or sloppy CLI invocation simply has no surface
to attack.

Lane derivation rules (from PR base branch):

  * ``snowball``         → ``L3-snowball``
  * ``main``             → ``L0-main``
  * anything else        → ``None``  (autonomous loop refuses)

Why a separate module: lane derivation MUST be invoked from
``auto_action_gate.AutoActionGate.from_policy`` AND
``auto_merge.merge_if_green`` AND the diff classifier. A free-standing
module guarantees a single source of truth (no implementation drift
between materialize-time and merge-time decisions).
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_L3_BASE_BRANCH = "snowball"
_L0_BASE_BRANCH = "main"


@dataclass(frozen=True)
class LaneDecision:
    """Plan ARIA-V3 §2c — immutable lane classification result.

    ``lane`` is the canonical decision string consumed by AutoActionGate.
    ``base_branch`` records the derivation input for audit replay.
    ``decision_reason`` is a short enum-like string for governance rows.
    """

    lane: str | None
    base_branch: str
    decision_reason: str

    def is_autonomous_eligible(self) -> bool:
        """Only the L3-snowball lane permits autonomous materialization
        + merge (Plan ARIA-V3 §B2 + §B3 SPEC amendment).
        """
        return self.lane == "L3-snowball"


def derive_lane_from_base_branch(base_branch: str) -> LaneDecision:
    """Plan ARIA-V3 §2c — pure function mapping base branch → lane.

    The function is deliberately narrow: only ``snowball`` and ``main``
    are recognised. Anything else returns ``lane=None`` so the
    autonomous loop refuses to engage. Adding a new lane requires an
    explicit code change here + a corresponding ADR per Plan ARIA-V3 §B3.
    """
    normalized = (base_branch or "").strip().lower()
    if normalized == _L3_BASE_BRANCH:
        return LaneDecision(
            lane="L3-snowball",
            base_branch=base_branch,
            decision_reason="base_branch_is_snowball",
        )
    if normalized == _L0_BASE_BRANCH:
        return LaneDecision(
            lane="L0-main",
            base_branch=base_branch,
            decision_reason="base_branch_is_main",
        )
    return LaneDecision(
        lane=None,
        base_branch=base_branch,
        decision_reason="base_branch_not_recognised",
    )


def derive_lane_from_pr_metadata(pr_metadata: dict[str, Any]) -> LaneDecision:
    """Plan ARIA-V3 §2c — extract base branch from a PR metadata dict
    and dispatch to ``derive_lane_from_base_branch``.

    ``pr_metadata`` is the shape returned by ``gh pr view --json`` and
    matches the contract of ``GhCliGitHubAdapter.get_pr``.
    """
    base_ref = (
        (pr_metadata.get("baseRefName") if isinstance(pr_metadata, dict) else None)
        or (pr_metadata.get("base") or {}).get("ref")
        or ""
    )
    return derive_lane_from_base_branch(base_ref)


def derive_lane_from_gh_pr(pr_number: int, *, cwd: str | Path = ".") -> LaneDecision:
    """Plan ARIA-V3 §2c — fetch PR metadata via gh CLI and derive lane.

    Wraps a ``gh pr view --json baseRefName`` invocation. Fails closed
    on any error path (returns ``LaneDecision(lane=None, ...)``).
    """
    try:
        completed = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                str(pr_number),
                "--json",
                "baseRefName",
            ],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return LaneDecision(
            lane=None,
            base_branch="",
            decision_reason=f"gh_cli_unavailable:{type(exc).__name__}",
        )
    if completed.returncode != 0:
        return LaneDecision(
            lane=None,
            base_branch="",
            decision_reason="gh_pr_view_nonzero",
        )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return LaneDecision(
            lane=None,
            base_branch="",
            decision_reason="gh_pr_view_malformed_json",
        )
    return derive_lane_from_pr_metadata(payload)


_CLASSIFIER_VERSION: str = "v1.0.0-plan-aria-v3-b2"


def emit_lane_classification_audit_row(
    *,
    base_dir: str | Path,
    decision: LaneDecision,
    classifier_inputs: dict[str, Any],
    allowed_paths: list[str] | None = None,
    rejected_paths: list[str] | None = None,
    linked_materialize_event_id: str | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V3 §B2 + AUDITTRAIL-HIGH-007 — emit the
    ``l3_lane_classification_decided`` governance event.

    The audit row carries every field needed to replay the lane
    decision later:
      * ``classifier_inputs`` — the raw PR metadata dict the
        classifier consumed (base_branch, baseRefName from gh, etc.)
      * ``decision`` — the LaneDecision (lane + base_branch +
        decision_reason)
      * ``allowed_paths`` / ``rejected_paths`` — what the diff
        classifier accepted / rejected at this lane level
      * ``classifier_version`` — version of the lane-classifier
        contract for downward compatibility (an old replay against
        a new classifier sees the version mismatch and refuses)
      * ``linked_materialize_event_id`` — links this lane decision
        to the materialize chain (Plan ARIA-V3 §2g three-event
        chain), enabling per-materialize audit replay.

    Caller MUST be the autonomous orchestrator entering an L3 path;
    other callers (CLI inspect, test harness) use the LaneDecision
    object directly without emitting an audit row.
    """
    from .tool_registry import append_tools_governance, ensure_tools_dir

    root = ensure_tools_dir(base_dir)
    details = {
        "classifier_inputs": classifier_inputs,
        "decision": {
            "lane": decision.lane,
            "base_branch": decision.base_branch,
            "decision_reason": decision.decision_reason,
            "is_autonomous_eligible": decision.is_autonomous_eligible(),
        },
        "allowed_paths": allowed_paths or [],
        "rejected_paths": rejected_paths or [],
        "classifier_version": _CLASSIFIER_VERSION,
        "linked_materialize_event_id": linked_materialize_event_id,
    }
    append_tools_governance(
        root,
        "l3_lane_classification_decided",
        details,
    )
    return details


__all__ = [
    "LaneDecision",
    "derive_lane_from_base_branch",
    "derive_lane_from_pr_metadata",
    "derive_lane_from_gh_pr",
    "emit_lane_classification_audit_row",
]
