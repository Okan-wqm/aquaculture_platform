"""Plan ARIA-V10.4 Phase 3.H.9 — evidence_refs SSoT path-only invariant.

Closes F-020 (canonical envelope SSoT advertised bare finding-id as a
valid evidence_refs entry, but the kernel's existence-validator
``_check_agent_ref`` rejected agents that followed the SSoT).

The bug class:

The kernel has TWO evidence_refs validators with inconsistent rules:

1. ``plan_convergence._valid_evidence_ref`` (line 2232) — shape
   validator. Accepts FINDING_ID_RE patterns (severity-tagged like
   ``ORPHAN-HIGH-082``) OR file paths. Loose layer.
2. ``evidence_validator._check_agent_ref`` (line 237) — existence
   validator. Requires file path resolvable to a real file at the
   workspace SHA. Strict layer.

The canonical envelope SSoT advertised the LOOSE layer's
``OR a finding-id`` form. A Round-2 primary planner — instructed by
the cross-reviewer to ``tightly anchor evidence`` — wrote
``"F-019"`` into satisfaction_matrix[].evidence_refs and was rejected
at the strict layer with ``agent_evidence_path_missing``.

Lesson: documentation MUST reflect the STRICTEST validator. The
SSoT now states evidence_refs are file paths only and to cite a
finding use the path form ``aria-findings/F-NNN.json[:<line>]``.

Tier-3 invariants (this file) make the regression class detectable:
no future SSoT revision may silently re-advertise the bare
finding-id form for evidence_refs.

Invariants:

- I-V10.4-3.H.9-01 — layer-2 SSoT's evidence_refs row mentions
  ``aria-findings/F-NNN.json`` path form (the canonical citation
  for finding evidence).
- I-V10.4-3.H.9-02 — layer-2 SSoT's evidence_refs row names the
  strict existence-validator ``_check_agent_ref`` so the operator +
  the agent can trace the contract to source.
- I-V10.4-3.H.9-03 — layer-2 SSoT's evidence_refs row does NOT
  advertise bare finding-id form as a valid alternative (the failed
  ``OR a finding-id`` pattern that triggered F-020).
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from . import _helpers  # noqa: F401

REPO_ROOT = Path(__file__).resolve().parents[4]
KNOWLEDGE_FILE = REPO_ROOT / ".claude" / "knowledge" / "layer-2-aria-canonical-envelope.md"


def _evidence_refs_row(body: str) -> str:
    """Locate the ``evidence_refs`` table row in the SSoT."""
    for line in body.splitlines():
        if "`evidence_refs`" in line and "|" in line:
            return line
    return ""


class EvidenceRefsPathOnlyInvariants(unittest.TestCase):
    """Plan ARIA-V10.4 Phase 3.H.9 — F-020 closure invariants."""

    def test_i_v10_4_3_h_9_01_ssot_cites_path_form(self):
        """The SSoT must show the canonical path form for finding evidence.

        Agents reading the SSoT need a concrete example of how to cite
        a finding as evidence. The path form
        ``aria-findings/F-NNN.json`` resolves at the strict validator;
        any other form is rejected.
        """
        body = KNOWLEDGE_FILE.read_text(encoding="utf-8")
        row = _evidence_refs_row(body)
        self.assertTrue(
            row,
            "I-V10.4-3.H.9-01 prerequisite: SSoT must contain an "
            "evidence_refs row in the required-fields table.",
        )
        self.assertIn(
            "aria-findings/F-NNN.json",
            row,
            (
                "I-V10.4-3.H.9-01: layer-2 SSoT's evidence_refs row must "
                "name the path form 'aria-findings/F-NNN.json' as the "
                "canonical citation for finding evidence. Missing the "
                "example recreates F-020 — agents improvise the form."
            ),
        )

    def test_i_v10_4_3_h_9_02_ssot_names_strict_validator(self):
        """The SSoT must name the strict existence-validator.

        Naming ``_check_agent_ref`` traces the SSoT's strictness claim
        to the actual kernel code that enforces it. Operators auditing
        the chain see SSoT → validator name → kernel file → enforcement
        line in one read.
        """
        body = KNOWLEDGE_FILE.read_text(encoding="utf-8")
        row = _evidence_refs_row(body)
        self.assertIn(
            "_check_agent_ref",
            row,
            (
                "I-V10.4-3.H.9-02: layer-2 SSoT's evidence_refs row must "
                "name the strict existence-validator '_check_agent_ref' "
                "so the SSoT's claim ties to the kernel code that enforces "
                "it. Future SSoT edits that drop the citation lose the "
                "trace from documentation to enforcement."
            ),
        )

    def test_i_v10_4_3_h_9_03_ssot_does_not_advertise_bare_finding_id(self):
        """The SSoT must NOT advertise bare finding-id form for evidence.

        The pre-F-020 SSoT said evidence_refs accept ``OR a finding-id
        (ORPHAN-HIGH-082, F-014)`` — that is the failed pattern that
        misled the round-2 primary planner. The replacement language
        directs agents to the path form; this invariant catches a
        regression where the bare form re-enters the row.
        """
        body = KNOWLEDGE_FILE.read_text(encoding="utf-8")
        row = _evidence_refs_row(body)
        # Failed pattern (bare F-014 / ORPHAN-HIGH-082 listed as an alternative).
        bare_pattern = re.compile(
            r"OR\s+a\s+finding-id\s*\(",
            re.IGNORECASE,
        )
        self.assertFalse(
            bare_pattern.search(row),
            (
                "I-V10.4-3.H.9-03: layer-2 SSoT's evidence_refs row must "
                "NOT re-advertise bare finding-id form ('OR a finding-id "
                "(...)'). The strict existence-validator rejects bare "
                "ids; the SSoT must direct agents to the "
                "aria-findings/F-NNN.json path form instead. Re-introducing "
                "the bare form recreates F-020."
            ),
        )


if __name__ == "__main__":
    unittest.main()
