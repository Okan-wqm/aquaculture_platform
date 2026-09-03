"""Plan ARIA-V10.4 Phase 3.H.6 — cross-reviewer canonical envelope SSoT invariants.

Closes F-018 (cross_reviewer agent emits non-canonical envelope shape,
kernel validator rejects with ``agent-response.status unknown: 'ok'``).

The bug class:

The cross-reviewer agent prompt at .claude/agents/aria-cross-reviewer.md
did NOT reference the shared canonical envelope SSoT
(.claude/knowledge/layer-2-aria-canonical-envelope.md) that
``aria-primary-planner`` and ``aria-challenger-planner`` already
reference. Without that anchor, the cross-reviewer prompt carried an
inline ``Output envelope`` section that diverged from the kernel
contract in three independent ways:

1. Top-level ``status`` field absent from the schema sketch → Opus
   improvised ``"ok"`` which is NOT in
   ``RESPONSE_STATUSES = ("submitted", "accepted", "rejected", "partial")``
   (agent_contract.py:109). Kernel ``validate_response`` rejected the
   envelope at agent_contract.py:326 with rejection_reasons
   ``["response_schema: agent-response.status unknown: 'ok']``.
2. ``details.cross_review`` shape sketched as ``{reviews: [...], verdict}``
   while ``submit_cross_review_v8`` (plan_convergence.py:230-385) reads
   ``review.get("risks", [])`` and ``review.get("reviewer_agent")``.
   The legacy ``reviews[]`` array produced an empty risks list, which
   would have caused record_cross_review to no-op even if the status
   gate had passed.
3. ``satisfaction_matrix[]`` entries sketched without explicit canonical
   field names (``id`` + ``verdict``), letting Opus emit alternate
   field names (``constraint_id`` + ``satisfied:bool``) that the
   ``agent_contract._validate_satisfaction_entry`` path silently
   ignored.

Tier-1 architectural fix: cross-reviewer prompt now references the
shared SSoT (``@.claude/knowledge/layer-2-aria-canonical-envelope.md``)
plus 3 explicit kernel-contract anchors covering the failure surface.
The shared SSoT carries the canonical envelope shape; the agent prompt
no longer duplicates a divergent inline copy.

Tier-3 layer (this file): make the missing SSoT reference DETECTABLE so
the same drift class cannot regress silently.

Invariants:

- I-V10.4-3.H.6-01 — aria-cross-reviewer.md references
  ``@.claude/knowledge/layer-2-aria-canonical-envelope.md`` (the SSoT).
- I-V10.4-3.H.6-02 — the canonical envelope SSoT lists all three ARIA
  planner-pool agents (primary, challenger, cross-reviewer) as
  referring sites.
- I-V10.4-3.H.6-03 — every ``aria/agent-response/v1`` shape sketch in
  any aria-* agent prompt that includes a ``status`` field uses ONLY
  values from the canonical ``RESPONSE_STATUSES`` tuple, OR omits the
  inline sketch entirely (preferring SSoT reference).
- I-V10.4-3.H.6-04 — cross-reviewer prompt explicitly mentions all
  three kernel anchors: ``submit_cross_review_v8``, the canonical
  ``RESPONSE_STATUSES`` enum, and the ``risks[]`` field name (NOT the
  legacy ``reviews[]``).
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

from aria_kernel.agent_contract import RESPONSE_STATUSES

REPO_ROOT = Path(__file__).resolve().parents[4]
AGENTS_DIR = REPO_ROOT / ".claude" / "agents"
KNOWLEDGE_FILE = REPO_ROOT / ".claude" / "knowledge" / "layer-2-aria-canonical-envelope.md"
CROSS_REVIEWER_FILE = AGENTS_DIR / "aria-cross-reviewer.md"
PRIMARY_PLANNER_FILE = AGENTS_DIR / "aria-primary-planner.md"
CHALLENGER_PLANNER_FILE = AGENTS_DIR / "aria-challenger-planner.md"

CANONICAL_SSOT_REFERENCE = "@.claude/knowledge/layer-2-aria-canonical-envelope.md"


class CrossReviewerCanonicalEnvelopeSSoTInvariants(unittest.TestCase):
    """Plan ARIA-V10.4 Phase 3.H.6 — F-018 closure invariants."""

    def test_i_v10_4_3_h_6_01_cross_reviewer_references_canonical_ssot(self):
        """The cross-reviewer prompt must point at the shared envelope SSoT.

        F-018 root cause was the missing reference — Opus improvised the
        envelope shape because no canonical anchor was cited. Other ARIA
        planner-pool agents (primary, challenger) already reference the
        SSoT; cross-reviewer was the gap.
        """
        body = CROSS_REVIEWER_FILE.read_text(encoding="utf-8")
        self.assertIn(
            CANONICAL_SSOT_REFERENCE,
            body,
            (
                "I-V10.4-3.H.6-01: aria-cross-reviewer.md must reference the "
                f"canonical envelope SSoT {CANONICAL_SSOT_REFERENCE!r} (the "
                "same anchor primary + challenger prompts already cite). "
                "Missing the reference recreates F-018."
            ),
        )

    def test_i_v10_4_3_h_6_02_canonical_ssot_lists_all_three_agents(self):
        """The SSoT introduction must enumerate every agent that depends on it.

        The reverse direction of I-01: the SSoT itself must declare which
        agents are downstream consumers so a future agent-contract author
        knows the SSoT is authoritative for their work.
        """
        body = KNOWLEDGE_FILE.read_text(encoding="utf-8")
        for agent_name in (
            "aria-primary-planner",
            "aria-challenger-planner",
            "aria-cross-reviewer",
        ):
            self.assertIn(
                agent_name,
                body,
                (
                    f"I-V10.4-3.H.6-02: canonical envelope SSoT must list "
                    f"{agent_name!r} as a referring agent. Missing entry "
                    "means a future agent author may not discover the SSoT."
                ),
            )

    def test_i_v10_4_3_h_6_03_no_aria_agent_emits_non_canonical_status(self):
        """No aria-* agent prompt may sketch a status value outside RESPONSE_STATUSES.

        Scans every aria-*.md prompt for inline ``"status": "<value>"``
        sketches. Any sketch must use ONLY values from the canonical
        ``RESPONSE_STATUSES`` tuple. The cleanest path is to omit the
        inline sketch and reference the SSoT, but if a sketch is present
        it must be canonical.
        """
        # Inline status-value pattern: "status": "<word>" with word boundary.
        status_pattern = re.compile(r'"status"\s*:\s*"([a-zA-Z_]+)"')
        canonical_values = set(RESPONSE_STATUSES)
        violations: list[str] = []
        for prompt in sorted(AGENTS_DIR.glob("aria-*.md")):
            body = prompt.read_text(encoding="utf-8")
            for match in status_pattern.finditer(body):
                value = match.group(1)
                if value not in canonical_values:
                    line_no = body[: match.start()].count("\n") + 1
                    violations.append(f"{prompt.name}:{line_no} emits status={value!r}")
        self.assertFalse(
            violations,
            (
                "I-V10.4-3.H.6-03: aria-* agent prompts must only sketch "
                f"canonical RESPONSE_STATUSES values {sorted(canonical_values)!r}. "
                f"Violations: {violations}"
            ),
        )

    def test_i_v10_4_3_h_6_04_cross_reviewer_mentions_kernel_anchors(self):
        """The cross-reviewer prompt must cite the three kernel-contract anchors.

        F-018 happened because the prompt did not connect the agent's
        output shape to the kernel validator code. Naming the anchors
        (``submit_cross_review_v8``, ``RESPONSE_STATUSES``, ``risks[]``)
        gives the operator + the agent a direct trace from output field
        to the line of kernel code that consumes it.
        """
        body = CROSS_REVIEWER_FILE.read_text(encoding="utf-8")
        for anchor in (
            "submit_cross_review_v8",
            "RESPONSE_STATUSES",
            "risks",
        ):
            self.assertIn(
                anchor,
                body,
                (
                    f"I-V10.4-3.H.6-04: aria-cross-reviewer.md must cite "
                    f"kernel-contract anchor {anchor!r} so the agent + the "
                    "operator can trace agent fields to the kernel code "
                    "that consumes them."
                ),
            )


if __name__ == "__main__":
    unittest.main()
