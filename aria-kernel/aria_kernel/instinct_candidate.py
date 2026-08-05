"""Plan 020 Phase 12 — instinct candidate ledger (auto-mutation BANNED).

WHY this module exists
----------------------
Plan v3.3 hard rule: continuous-learning auto-mutation is BANNED. Pre-Plan-
020 the kernel's `learning.py:_skill_or_agent_genesis` could promote
patterns into skills/agents/commands without operator intervention. Phase
12 closes that loop by routing every promotion through a kernel-side
operator approval gate:

- New patterns get RECORDED as 'PROPOSED' candidates (audit trail).
- Promotion (PROPOSED → PROMOTED) REQUIRES operator_approval_ref +
  promotion_pr_url, kernel-enforced.
- Auto-promotion attempts without those fields raise GovernanceError at
  the kernel boundary.

Plan 020 surface
----------------
instinct_candidates is in OBSERVE_PERMITTED_SURFACES (PROPOSED records are
observation-class — recording does NOT mutate behaviour) AND in
PLAN_020_WRITE_SURFACES (frozen blocks the persist).
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .confidence import validated_confidence
from .ledger import append_declared_jsonl
from .runtime_profile import enforce_profile_for_write
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    utc_now,
)

INSTINCT_CANDIDATES_FILENAME = "instinct-candidates.jsonl"
CANDIDATE_SCHEMA = "aria/instinct-candidate/v1"

CANDIDATE_STATUSES: tuple[str, ...] = (
    "PROPOSED",
    "UNDER_REVIEW",
    "PROMOTED",
    "REJECTED",
)
PROMOTION_TARGETS: tuple[str, ...] = ("skill", "agent", "command")

_CANDIDATE_ID_RE = re.compile(r"^IC-\d{4}-\d{2}-\d{2}-\d{3}$")
_PR_URL_RE = re.compile(r"^https?://[^\s/]+/[^\s]+/pull/\d+$")


def _ledger_path(tools_root: Path) -> Path:
    return tools_root / INSTINCT_CANDIDATES_FILENAME


def _allocate_candidate_id(tools_root: Path, *, when: str) -> str:
    date_part = when[:10]  # YYYY-MM-DD
    existing = list_candidates(base_dir=tools_root)
    seq = 1 + sum(
        1 for c in existing if str(c.get("candidate_id", "")).startswith(f"IC-{date_part}-")
    )
    return f"IC-{date_part}-{seq:03d}"


def record_candidate(
    *,
    trigger_signal: str,
    action_observation: str,
    evidence_refs: list[str],
    confidence_0_to_1: float,
    observation_count: int = 1,
    repo_hash: str | None = None,
    branch: str | None = None,
    plan_id_origin: str | None = None,
    finding_id_origin: str | None = None,
    source_session_id: str | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Record a PROPOSED candidate. NO promotion side-effect."""
    enforce_profile_for_write("instinct_candidates", base_dir=base_dir)
    # ORPHAN-HIGH-541 — the range definition lives in confidence.py so this
    # surface and the adapter-candidate surface cannot drift apart again.
    confidence_0_to_1 = validated_confidence(confidence_0_to_1, kind="instinct_score")
    if not isinstance(evidence_refs, list):
        raise GovernanceError("evidence_refs must be a list")
    root = ensure_tools_dir(base_dir)
    now = utc_now()
    candidate = {
        "$schema": CANDIDATE_SCHEMA,
        "schema_version": 1,
        "candidate_id": _allocate_candidate_id(root, when=now),
        "recorded_at": now,
        "repo_hash": repo_hash,
        "branch": branch,
        "plan_id_origin": plan_id_origin,
        "finding_id_origin": finding_id_origin,
        "trigger_signal": trigger_signal,
        "action_observation": action_observation,
        "evidence_refs": list(evidence_refs),
        "confidence_0_to_1": float(confidence_0_to_1),
        "observation_count": int(observation_count),
        "source_session_id": source_session_id,
        "status": "PROPOSED",
        "promoted_to": None,
        "promotion_pr_url": None,
    }
    append_declared_jsonl(
        _ledger_path(root),
        candidate,
        expected_surface="instinct_candidates",
    )
    append_tools_governance(
        root,
        "instinct_candidate_recorded",
        {
            "candidate_id": candidate["candidate_id"],
            "trigger_signal": trigger_signal,
            "confidence_0_to_1": candidate["confidence_0_to_1"],
        },
    )
    return candidate


def promote_candidate(
    *,
    candidate_id: str,
    operator_approval_ref: str,
    promotion_pr_url: str,
    promoted_to: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Mark a candidate PROMOTED. Kernel REQUIRES operator approval +
    promotion PR URL — the promotion record IS the audit trail.

    Raises GovernanceError when:
    - operator_approval_ref empty/whitespace.
    - promotion_pr_url shape invalid.
    - promoted_to not in {skill, agent, command}.
    - candidate_id has no PROPOSED record.
    """
    enforce_profile_for_write("instinct_candidates", base_dir=base_dir)
    if not (operator_approval_ref or "").strip():
        raise GovernanceError(
            "instinct promotion requires operator_approval_ref (auto-mutation BANNED)"
        )
    if not _PR_URL_RE.match(promotion_pr_url or ""):
        raise GovernanceError(
            f"promotion_pr_url shape invalid: {promotion_pr_url!r}"
        )
    if promoted_to not in PROMOTION_TARGETS:
        raise GovernanceError(
            f"promoted_to {promoted_to!r} not in {PROMOTION_TARGETS}"
        )
    if not _CANDIDATE_ID_RE.match(candidate_id or ""):
        raise GovernanceError(f"candidate_id format invalid: {candidate_id!r}")

    root = ensure_tools_dir(base_dir)
    candidates = list_candidates(base_dir=root)
    proposed = next(
        (c for c in reversed(candidates)
         if c.get("candidate_id") == candidate_id and c.get("status") == "PROPOSED"),
        None,
    )
    if proposed is None:
        raise GovernanceError(
            f"candidate {candidate_id} not found in PROPOSED state"
        )
    promoted = {
        **proposed,
        "status": "PROMOTED",
        "promoted_to": promoted_to,
        "promotion_pr_url": promotion_pr_url,
        "promotion_operator_approval_ref": operator_approval_ref,
        "promoted_at": utc_now(),
    }
    append_declared_jsonl(
        _ledger_path(root),
        promoted,
        expected_surface="instinct_candidates",
    )
    append_tools_governance(
        root,
        "instinct_candidate_promoted",
        {
            "candidate_id": candidate_id,
            "promoted_to": promoted_to,
            "promotion_pr_url": promotion_pr_url,
            "operator_approval_ref": operator_approval_ref,
        },
    )
    return promoted


def list_candidates(
    *, base_dir: str | Path | None = None, status: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    path = _ledger_path(root)
    if not path.exists():
        return []
    rows = [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if status is not None:
        rows = [r for r in rows if r.get("status") == status]
    if limit is not None and limit > 0:
        rows = rows[-limit:]
    return rows


__all__ = [
    "INSTINCT_CANDIDATES_FILENAME",
    "CANDIDATE_SCHEMA",
    "CANDIDATE_STATUSES",
    "PROMOTION_TARGETS",
    "record_candidate",
    "promote_candidate",
    "list_candidates",
]
