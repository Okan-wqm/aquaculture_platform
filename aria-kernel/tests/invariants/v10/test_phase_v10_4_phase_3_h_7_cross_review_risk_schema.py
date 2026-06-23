"""Plan ARIA-V10.4 Phase 3.H.7 — cross-reviewer risks[] entry schema invariants.

Closes F-019 (cross-reviewer emits risk entries with non-canonical
field names; kernel ``_validate_cross_review_risk`` rejects each entry
with ``agent_bridge_warning: risk_category must be a non-empty string``).

The bug class:

Phase 3.H.6 (F-018) closed the outer envelope drift by adding an SSoT
reference. F-019 surfaced one layer deeper: even with the SSoT cited,
the cross-reviewer agent improvised the per-entry shape inside
``details.cross_review.risks[]``. The SSoT's risk-entry sketch used
pipe-separated example notation
(e.g. ``"severity": "HIGH | MEDIUM | LOW"``) which the model parsed as
``"illustrative only — pick any close variant"`` and produced its own
field names (``description`` instead of ``summary``; ``applies_to``
not in schema; ``risk_category`` omitted).

Lesson: SSoT indirection alone is insufficient for per-entry schemas
inside a top-level container. The agent prompt MUST inline a
fully-filled concrete example with EXACTLY the kernel-required field
names. Show > tell.

Tier-1 architectural fix (Phase 3.H.7):

1. ``.claude/agents/aria-cross-reviewer.md`` anchor 2 now inlines a
   fully-filled concrete example with all 7 required kernel fields
   (risk_id, risk_category, severity, summary, recommendation,
   affected_files, evidence_refs) + names the kernel validator
   file:line so the agent + the operator can trace the contract.
2. ``.claude/knowledge/layer-2-aria-canonical-envelope.md`` risk-entry
   sketch cleaned: removed pipe-notation, populated concrete values,
   added validator file:line reference.

Tier-3 layer (this file): make the missing fields + pipe-notation
DETECTABLE so the same drift class cannot regress silently.

Invariants:

- I-V10.4-3.H.7-01 — aria-cross-reviewer.md inlines every required
  kernel risk-entry field name (risk_id, risk_category, severity,
  summary, recommendation, affected_files, evidence_refs) so the
  model sees the canonical schema without indirection.
- I-V10.4-3.H.7-02 — aria-cross-reviewer.md cites the kernel
  validator path ``plan_convergence._validate_cross_review_risk`` so
  the agent + the operator can trace the contract to source.
- I-V10.4-3.H.7-03 — the canonical envelope SSoT's risk-entry example
  uses concrete populated values, NOT pipe-notation
  (e.g. ``"HIGH | MEDIUM | LOW"``) that LLMs interpret as
  ``illustrative only``.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

# WS2 — the cross-review risk-entry field set is owned by the kernel
# (plan_convergence.CROSS_REVIEW_RISK_REQUIRED, the SSoT). This test used
# to carry its own CANONICAL_RISK_FIELDS literal — a 6th hardcoded copy
# that could silently drift from the kernel. We now import the kernel
# constant and iterate it, so the kernel is the ONE source.
from aria_kernel.plan_convergence import CROSS_REVIEW_RISK_REQUIRED

REPO_ROOT = Path(__file__).resolve().parents[4]
CROSS_REVIEWER_FILE = REPO_ROOT / ".claude" / "agents" / "aria-cross-reviewer.md"
KNOWLEDGE_FILE = REPO_ROOT / ".claude" / "knowledge" / "layer-2-aria-canonical-envelope.md"


class CrossReviewRiskSchemaInvariants(unittest.TestCase):
    """Plan ARIA-V10.4 Phase 3.H.7 — F-019 closure invariants."""

    def test_i_v10_4_3_h_7_01_cross_reviewer_inlines_canonical_risk_fields(self):
        """The cross-reviewer prompt must inline every kernel risk-entry field.

        F-019 root cause was that SSoT indirection alone let the model
        improvise field names. Inlining each required name in the agent
        prompt makes the schema visible at the model's reading surface,
        eliminating the improvisation vector.
        """
        body = CROSS_REVIEWER_FILE.read_text(encoding="utf-8")
        for field_name in CROSS_REVIEW_RISK_REQUIRED:
            self.assertIn(
                field_name,
                body,
                (
                    f"I-V10.4-3.H.7-01: aria-cross-reviewer.md must inline "
                    f"the canonical kernel risk-entry field {field_name!r} "
                    f"(the kernel _validate_cross_review_risk requires it "
                    f"non-empty). Missing the inline reference recreates F-019."
                ),
            )

    def test_i_v10_4_3_h_7_02_cross_reviewer_cites_validator_path(self):
        """The cross-reviewer prompt must name the kernel validator file:line.

        Tracing the contract to source lets a future operator audit
        whether agent + kernel diverged. The agent prompt + the kernel
        code share a single authoritative pointer.
        """
        body = CROSS_REVIEWER_FILE.read_text(encoding="utf-8")
        self.assertIn(
            "_validate_cross_review_risk",
            body,
            (
                "I-V10.4-3.H.7-02: aria-cross-reviewer.md must cite the "
                "kernel validator name '_validate_cross_review_risk' so the "
                "agent + the operator can trace the risk-entry contract to "
                "source code (plan_convergence.py)."
            ),
        )

    def test_i_v10_4_3_h_7_03_ssot_risk_example_uses_concrete_values(self):
        """The canonical envelope SSoT risk example must not use pipe-notation.

        Pipe-notation (e.g. ``"HIGH | MEDIUM | LOW"``) reads as
        ``illustrative only`` to LLMs and lets the model substitute its
        own field values or skip the field entirely. The SSoT must show
        a concrete populated value so the model can copy the shape
        directly.
        """
        body = KNOWLEDGE_FILE.read_text(encoding="utf-8")
        # Locate the risks[] example block (between "risks": [ and ]).
        # Pipe-notation inside JSON-string values is the violation pattern.
        # Pattern: a JSON string value containing ` | ` (space-pipe-space)
        # within the risks[] block.
        pipe_in_string = re.compile(r'"[a-zA-Z_]+":\s*"[^"\n]*\s\|\s[^"\n]*"')
        # Restrict the scan to the risks[] block to avoid false positives
        # in unrelated parts of the SSoT.
        m_open = body.find('"risks": [')
        if m_open < 0:
            self.fail(
                "I-V10.4-3.H.7-03 prerequisite: SSoT must contain a "
                "'risks': [...]' example block."
            )
        # Find the matching close bracket of the risks array (naive but
        # adequate for the SSoT's single-block layout).
        depth = 0
        end = -1
        for i in range(m_open, len(body)):
            if body[i] == "[":
                depth += 1
            elif body[i] == "]":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        block = body[m_open : end + 1] if end > 0 else body[m_open:]
        violations = pipe_in_string.findall(block)
        self.assertFalse(
            violations,
            (
                "I-V10.4-3.H.7-03: the canonical envelope SSoT's risks[] "
                "example block must use concrete populated values, not "
                "pipe-notation ('foo | bar | baz'). Pipe-notation reads as "
                f"illustrative-only to LLMs and recreates F-019. Violations: "
                f"{violations}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
