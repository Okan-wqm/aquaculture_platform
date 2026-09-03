"""Plan 022 C-1b — task candidate evidence normalization.

Pre-Plan-022 task.py:86 read pressure.get('evidence') (legacy v1 schema).
Plan 022 C-1 populates pressure['evidence_refs'] (canonical v2). C-1b
makes task.py read evidence_refs first with legacy fallback.

This suite pins:
1. v2 pressure (evidence_refs populated) → task candidate evidence_refs
   == pressure.evidence_refs.
2. v1 legacy pressure (evidence populated, evidence_refs missing) →
   task candidate evidence_refs == legacy evidence (backward-compat).
3. Both missing → empty list.
"""
from __future__ import annotations

import unittest

from aria_kernel.task import _candidate_from_pressure


def _make_pressure(**overrides) -> dict:
    base = {
        "pressure_id": "PE-test",
        "primitive": "UNKNOWN",
        "subtype": "repeated_unknown_capability",
        "score": 0.7,
        "reason": "synthetic test pressure",
        "recommended_action": "investigation",
        "candidate_tools": ["banned-phrase-adapter"],
    }
    base.update(overrides)
    return base


class TaskCandidateEvidenceNormalizationTests(unittest.TestCase):
    def test_v2_pressure_evidence_refs_used(self) -> None:
        """Plan 022 C-1 schema: pressure['evidence_refs'] is the canonical field."""
        pressure = _make_pressure(evidence_refs=["apps/x/foo.ts:1", "apps/y/bar.ts:7"])
        candidate = _candidate_from_pressure("cycle-1", pressure)
        self.assertEqual(
            sorted(candidate["evidence_refs"]),
            sorted(["apps/x/foo.ts:1", "apps/y/bar.ts:7"]),
        )

    def test_v1_legacy_evidence_falls_back(self) -> None:
        """Legacy v1 ledger rows used 'evidence' field. Backward-compat must hold."""
        pressure = _make_pressure(evidence=["docs/legacy.md:1", "docs/legacy.md:42"])
        candidate = _candidate_from_pressure("cycle-1", pressure)
        self.assertEqual(
            sorted(candidate["evidence_refs"]),
            sorted(["docs/legacy.md:1", "docs/legacy.md:42"]),
        )

    def test_canonical_takes_precedence_over_legacy(self) -> None:
        """When both fields are present (transition state), canonical wins."""
        pressure = _make_pressure(
            evidence_refs=["new-canonical.ts:1"],
            evidence=["old-legacy.ts:1"],
        )
        candidate = _candidate_from_pressure("cycle-1", pressure)
        self.assertEqual(candidate["evidence_refs"], ["new-canonical.ts:1"])

    def test_neither_field_yields_empty_list(self) -> None:
        pressure = _make_pressure()
        candidate = _candidate_from_pressure("cycle-1", pressure)
        self.assertEqual(candidate["evidence_refs"], [])


if __name__ == "__main__":
    unittest.main()
