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

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_genesis import record_draft_lifecycle_chain
from aria_kernel.genesis_lifecycle import (
    current_lifecycle_state,
    record_transition,
    validate_transition,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

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


class PolicyOverrideTests(unittest.TestCase):
    """ARIA-MEDIUM-468 — the CANDIDATE maturity gate reads the BOUND workspace's policy.

    The production producer (agent_genesis) calls record_transition with no
    repo_root, and validate_transition read only the package defaults, so an
    operator's aria-config/genesis_policy.json never reached this gate.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.ws / "aria-tools")
        record_transition(
            entity_id="agent-policy", entity_kind="agent", to_state="PRESSURE",
            evidence={}, base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _override_min_cycles(self, value: int) -> None:
        override = self.ws / "aria-config" / "genesis_policy.json"
        override.parent.mkdir(parents=True, exist_ok=True)
        override.write_text(
            json.dumps({"genesis_lifecycle": {"shadow_min_clean_cycles": value}}),
            encoding="utf-8",
        )

    def _propose(self) -> dict:
        return record_transition(
            entity_id="agent-policy", entity_kind="agent", to_state="CANDIDATE_PROPOSED",
            evidence={"valid_cycles": 2, "source_types": ["coverage_gap"]},
            base_dir=self.tools,
        )

    def test_bound_workspace_override_is_honoured_without_repo_root(self) -> None:
        self._override_min_cycles(2)
        self.assertEqual(self._propose()["to_state"], "CANDIDATE_PROPOSED")

    def test_package_default_holds_without_an_override(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "candidate_requires_5_valid_cycles"):
            self._propose()

    def test_validate_transition_reads_the_given_repo_root(self) -> None:
        self._override_min_cycles(2)
        verdict = validate_transition(
            from_state="PRESSURE",
            to_state="CANDIDATE_PROPOSED",
            evidence={"valid_cycles": 2, "source_types": ["coverage_gap"]},
            repo_root=self.ws,
        )
        self.assertTrue(verdict.valid, verdict.reasons)


class DraftChainProducerTests(unittest.TestCase):
    def _record(self, root: Path) -> list[dict]:
        from tests._helpers.operator_acts import bind_github_operator_acts

        if not hasattr(self, "_acts"):
            self._acts = bind_github_operator_acts(self)
        return record_draft_lifecycle_chain(
            entity_id="aria-svc-farm-auditor",
            gap=_GAP,
            capability_resolution={"decision": "request"},
            operator_approval_ref=self._acts.approve(
                "genesis_request", {"entity": "aria-svc-farm-auditor"},
            ),
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
        # SE-5 — the claim-side SHADOW predicate is production_block_reason, the lifecycle owner's own answer.
        from aria_kernel import genesis_lifecycle

        owner = getattr(genesis_lifecycle, "production_block_reason", None)
        self.assertIsNotNone(
            owner, "genesis_lifecycle.production_block_reason does not exist: the claim-side SHADOW predicate has no owner"
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self._record(root)
            self.assertNotEqual(owner("aria-svc-farm-auditor", base_dir=root), "shadow")


if __name__ == "__main__":
    unittest.main()
