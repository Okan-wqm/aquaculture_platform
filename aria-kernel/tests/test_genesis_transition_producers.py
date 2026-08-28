"""C4-c (ORPHAN-676) — the genesis ledger records how an agent comes to be.

`record_transition` had zero production callers and the HUMAN_REQUIRED
gate demanded an evidence shape (`verdict` + `coverage_score`) that NO
producer anywhere could mint — capability_resolver, the only coverage
authority, writes `decision ∈ {reuse, extend, request}`. An unproducible
predicate is a locked door with no key. The gate now reads the real
vocabulary and the draft flow emits the legal prefix chain from real
artifacts.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_genesis import record_draft_lifecycle_chain
from aria_kernel.genesis_lifecycle import (
    current_lifecycle_state,
    validate_transition,
)
from aria_kernel.tool_registry import ensure_tools_dir

_GAP = {
    "gap_id": "gap-c4c-1",
    "capability_gap_key": "svc:farm:tenant-audit",
    "primary_source": "coverage_gap",
    "source_types": ["coverage_gap", "shadow_summary"],
}


class GateVocabularyTests(unittest.TestCase):
    def test_resolver_decision_admits_human_required(self) -> None:
        verdict = validate_transition(
            from_state="CANDIDATE_PROPOSED",
            to_state="HUMAN_REQUIRED",
            evidence={"capability_resolution": {"decision": "request"}},
        )
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_reuse_decision_is_refused(self) -> None:
        verdict = validate_transition(
            from_state="CANDIDATE_PROPOSED",
            to_state="HUMAN_REQUIRED",
            evidence={"capability_resolution": {"decision": "reuse"}},
        )
        self.assertFalse(verdict.valid)

    def test_the_old_unproducible_shape_no_longer_opens_the_gate(self) -> None:
        # Deliberate-break of the phantom predicate: the verdict/score
        # shape nothing could produce must not remain a secret key.
        verdict = validate_transition(
            from_state="CANDIDATE_PROPOSED",
            to_state="HUMAN_REQUIRED",
            evidence={
                "existing_capability_coverage": {
                    "verdict": "positive",
                    "coverage_score": 0.95,
                }
            },
        )
        self.assertFalse(verdict.valid)


class DraftChainProducerTests(unittest.TestCase):
    def _record(self, root: Path) -> list[dict]:
        return record_draft_lifecycle_chain(
            entity_id="aria-svc-farm-auditor",
            gap=_GAP,
            capability_resolution={"decision": "request"},
            operator_approval_ref="operator:approval:c4c-1",
            draft_ref="sha256:" + "e" * 64,
            base_dir=root,
        )

    def test_the_ledger_finally_gets_its_first_production_chain(self) -> None:
        # Deliberate-break for the original defect: genesis-lifecycle/
        # events.jsonl had NO production writer; every consumer read an
        # empty ledger.
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            recorded = self._record(root)
            state = current_lifecycle_state(
                entity_id="aria-svc-farm-auditor", base_dir=root
            )
        self.assertEqual(
            [row["to_state"] for row in recorded],
            ["PRESSURE", "CANDIDATE_PROPOSED", "HUMAN_REQUIRED", "REQUEST", "DRAFT"],
        )
        self.assertEqual(state, "DRAFT")

    def test_rerun_continues_idempotently(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self._record(root)
            again = self._record(root)
        self.assertEqual(again, [])

    def test_shadow_stays_out_of_reach_of_this_producer(self) -> None:
        # SANDBOX-family transitions demand the C4-d proof chain; the
        # draft producer must not be able to fake its way there.
        from aria_kernel.agent_invocations import _target_is_shadow

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self._record(root)
            self.assertFalse(_target_is_shadow(root, "aria-svc-farm-auditor"))


if __name__ == "__main__":
    unittest.main()
