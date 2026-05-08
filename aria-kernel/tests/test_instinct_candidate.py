"""Plan 020 Phase 12 — instinct candidate ledger tests (auto-mutation BANNED)."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.instinct_candidate import (
    CANDIDATE_STATUSES,
    PROMOTION_TARGETS,
    list_candidates,
    promote_candidate,
    record_candidate,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-instinct-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    return tools


def _record(tools: Path) -> dict:
    return record_candidate(
        trigger_signal="repeat-banned-phrase-violation",
        action_observation="9 of last 12 PRs caught by L1 gate",
        evidence_refs=["aria-tools/governance.jsonl:42"],
        confidence_0_to_1=0.85,
        observation_count=9,
        base_dir=tools,
    )


class TaxonomyTests(unittest.TestCase):
    def test_4_statuses_locked(self) -> None:
        self.assertEqual(set(CANDIDATE_STATUSES), {
            "PROPOSED", "UNDER_REVIEW", "PROMOTED", "REJECTED",
        })

    def test_3_promotion_targets_locked(self) -> None:
        self.assertEqual(set(PROMOTION_TARGETS), {"skill", "agent", "command"})


class RecordCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_record_emits_proposed_status(self) -> None:
        c = _record(self.tools)
        self.assertEqual(c["status"], "PROPOSED")
        self.assertIsNone(c["promoted_to"])
        self.assertIsNone(c["promotion_pr_url"])

    def test_record_emits_governance_event(self) -> None:
        _record(self.tools)
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("instinct_candidate_recorded", kinds)

    def test_invalid_confidence_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            record_candidate(
                trigger_signal="x", action_observation="y",
                evidence_refs=[], confidence_0_to_1=2.0,
                base_dir=self.tools,
            )


class PromoteCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()
        self.candidate = _record(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_auto_promotion_without_approval_rejected(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            promote_candidate(
                candidate_id=self.candidate["candidate_id"],
                operator_approval_ref="",  # missing — auto-mutation rule
                promotion_pr_url="https://github.com/o/r/pull/1",
                promoted_to="skill",
                base_dir=self.tools,
            )
        self.assertIn("operator_approval_ref", str(cm.exception))
        self.assertIn("auto-mutation BANNED", str(cm.exception))

    def test_invalid_pr_url_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            promote_candidate(
                candidate_id=self.candidate["candidate_id"],
                operator_approval_ref="op:approve",
                promotion_pr_url="not-a-url",
                promoted_to="skill",
                base_dir=self.tools,
            )

    def test_invalid_promoted_to_rejected(self) -> None:
        with self.assertRaises(GovernanceError):
            promote_candidate(
                candidate_id=self.candidate["candidate_id"],
                operator_approval_ref="op:approve",
                promotion_pr_url="https://github.com/o/r/pull/1",
                promoted_to="rocket",
                base_dir=self.tools,
            )

    def test_full_promotion_flow_emits_promoted_event(self) -> None:
        promote_candidate(
            candidate_id=self.candidate["candidate_id"],
            operator_approval_ref="op:approve-ic-001",
            promotion_pr_url="https://github.com/o/r/pull/42",
            promoted_to="skill",
            base_dir=self.tools,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("instinct_candidate_promoted", kinds)


class ProfileGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_record(self) -> None:
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            _record(self.tools)

    def test_observe_permits_record(self) -> None:
        set_profile("observe", operator_approval_ref="op:observe",
                    base_dir=self.tools)
        # observe permits PROPOSED records (observation-class).
        c = _record(self.tools)
        self.assertEqual(c["status"], "PROPOSED")


if __name__ == "__main__":
    unittest.main()
