"""ARIA-HIGH-370 (review of #1829, HIGH-2) — attributions the kernel has since voided.

WHY. An attribution reads the evidence the kernel recorded at the time. When
that evidence was produced by a KERNEL defect — the kernel handed the agent
the very ref the evidence law then refused — the episode names the agent,
but the cause was the kernel's, and a fix has removed it. Teaching the
agent's next envelope that lesson, or refusing a candidate on it, punishes
the agent for a defect it could not avoid and that no longer exists.

WHAT. :data:`ATTRIBUTION_VOID` is a closed registry. Each entry names a mode,
the attributed role, the merge time of the fix and the PR. An attributed
episode with that mode and role that occurred BEFORE the fix is recorded
unattributed, with ``voided_by`` naming the PR; one after the fix stands.
Adding an entry is a reviewed code change, never a ledger write.

:func:`gate_epoch` is a digest of the kernel modules whose rules decide
whether work is refused (the evidence law, the plan contract, the release
vocabulary, the envelope minters). Episodes carry the epoch they were
recorded under; admission (``admission_lessons``) re-admits one probe of a
refused candidate once the epoch has moved, because the gate that refused it
may no longer refuse it.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .tool_registry import parse_utc_stamp


@dataclass(frozen=True)
class VoidEntry:
    failure_mode: str
    role: str
    before: str
    fixed_by: str
    why: str


ATTRIBUTION_VOID: tuple[VoidEntry, ...] = (
    # The completeness critic cited `tools/coverage/<plan>-r1.json`, the
    # closure manifest the kernel minted into its own envelope; the evidence
    # law refuses a state-store path (plan-cyc-20261004T073028Z). #1797 hands
    # agents only citable evidence (ARIA-HIGH-354..357).
    VoidEntry("agent_evidence_path_missing", "completeness_critique", "2026-10-06T16:50:33+00:00", "#1797",
              "the kernel minted a non-citable store path into the critic's envelope"),
    # The failing_ci seed carried `gh-run-list:ci-run-*` as its only evidence
    # ref; the challenger copied it (2026-08-16, refused as malformed) or
    # refused the request for it (2026-09-29, 2026-09-30). #1731 builds those
    # plans from the workflow file and moves the run to provenance_refs.
    VoidEntry("agent_evidence_ref_malformed", "challenger_plan", "2026-10-04T06:10:37+00:00", "#1731",
              "the kernel seeded the plan with a pseudo-ref the evidence law refuses"),
    VoidEntry("agent_refused_evidence", "drafter", "2026-10-04T06:10:37+00:00", "#1731",
              "the kernel seeded the plan with a pseudo-ref the evidence law refuses"),
)

#: The modules whose rules decide whether submitted work is refused.
GATE_MODULES: tuple[str, ...] = (
    "evidence_validator.py", "plan_contract.py", "release_reason.py", "agent_contract.py",
    "convergent_planning_bridge.py", "cross_review_bridge.py", "plan_round_controller.py",
)


def void_for(failure_mode: str, role: str, occurred_at: Any) -> VoidEntry | None:
    at = parse_utc_stamp(str(occurred_at or ""))
    for entry in ATTRIBUTION_VOID:
        before = parse_utc_stamp(entry.before)
        if entry.failure_mode == failure_mode and entry.role == role and at is not None and before is not None \
                and at < before:
            return entry
    return None


@lru_cache(maxsize=1)
def gate_epoch() -> str:
    digest = hashlib.sha256()
    here = Path(__file__).resolve().parent
    for name in GATE_MODULES:
        digest.update(name.encode("utf-8") + b"\0" + (here / name).read_bytes())
    return "sha256:" + digest.hexdigest()


__all__ = ["ATTRIBUTION_VOID", "GATE_MODULES", "VoidEntry", "gate_epoch", "void_for"]
