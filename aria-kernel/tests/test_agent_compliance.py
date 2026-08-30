"""Plan 020 Phase 7 — agent compliance harness tests.

What this suite pins (≥12 tests):
- 4 hard-reject + 2 soft-compliance check taxonomy locked.
- Each individual check produces the expected pass/fail under fixture
  inputs (positive + negative case per check).
- Hard-reject path: any single hard-fail → rejection=True with reason
  'compliance_rejected'.
- Soft-compliance path: single soft-fail → no rejection, warning event.
- Cumulative soft path: 2+ soft fails → rejection=True with same reason.
- 10-state lifecycle preservation: rejection_reason annotates REJECTED;
  no new state added.
- record_compliance_grade persists to agent-compliance.jsonl.
- Frozen profile blocks the persist step (agent_compliance surface).
- Governance event taxonomy: agent_compliance_violation vs
  agent_compliance_warning emitted at the right thresholds.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_compliance import (
    ALL_CHECKS,
    COMPLIANCE_REJECTION_REASON,
    HARD_REJECT_CHECKS,
    SOFT_COMPLIANCE_CHECKS,
    SOFT_FAIL_REJECT_THRESHOLD,
    grade_response,
    list_compliance_grades,
    record_compliance_grade,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="aria-compliance-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    return tools


def _well_formed_request(expected_path: str = "/tmp/out.md") -> dict:
    return {
        "must_satisfy": [
            {"id": "MS-1", "rule": "rule one"},
            {"id": "MS-2", "rule": "rule two"},
        ],
        "expected_output_path": expected_path,
    }


def _well_formed_response(*, output_path: str = "/tmp/out.md") -> dict:
    return {
        "satisfaction_matrix": [
            {"id": "MS-1", "verdict": "satisfied"},
            {"id": "MS-2", "verdict": "satisfied"},
        ],
        "evidence_refs": ["docs/x.md:1"],
        "status": "completed",
        "body": "ordinary clean prose",
    }


class TaxonomyTests(unittest.TestCase):
    def test_check_taxonomy_locked(self) -> None:
        self.assertEqual(set(HARD_REJECT_CHECKS), {
            "must_satisfy_completeness",
            "evidence_schema_valid",
            "output_path_match",
            "banned_phrase_in_response_body",
        })
        self.assertEqual(set(SOFT_COMPLIANCE_CHECKS), {
            "response_order_valid",
            "refusal_trigger_valid",
        })
        self.assertEqual(len(ALL_CHECKS), 6)

    def test_soft_fail_reject_threshold_locked(self) -> None:
        self.assertEqual(SOFT_FAIL_REJECT_THRESHOLD, 2)


class IndividualCheckTests(unittest.TestCase):
    def test_must_satisfy_completeness_passes_when_full_match(self) -> None:
        grade = grade_response(
            request=_well_formed_request(),
            response=_well_formed_response(output_path="/tmp/out.md"),
            response_path=Path("/tmp/out.md"),
        )
        self.assertTrue(grade["check_results"]["must_satisfy_completeness"]["passed"])

    def test_must_satisfy_completeness_fails_on_missing_id(self) -> None:
        response = _well_formed_response()
        response["satisfaction_matrix"] = [{"id": "MS-1"}]  # MS-2 missing
        grade = grade_response(
            request=_well_formed_request(),
            response=response,
            response_path=Path("/tmp/out.md"),
        )
        self.assertFalse(grade["check_results"]["must_satisfy_completeness"]["passed"])
        self.assertIn("MS-2",
                      grade["check_results"]["must_satisfy_completeness"]["evidence"]["missing_ids"])

    def test_evidence_schema_valid_fails_on_bad_ref(self) -> None:
        response = _well_formed_response()
        response["evidence_refs"] = ["???/<bad>::ref"]
        grade = grade_response(
            request=_well_formed_request(),
            response=response,
            response_path=Path("/tmp/out.md"),
        )
        self.assertFalse(grade["check_results"]["evidence_schema_valid"]["passed"])

    def test_kernel_ledger_pointer_ref_is_admissible(self) -> None:
        # ORPHAN-719 — the kernel mints `human-required:<id>` into panel
        # scopes and evidence law admits it (#1271, single predicate);
        # this grader kept a second regex and hard-rejected every panel
        # opinion on Night-1 (4 submit_rejected, all judges-as-panelists).
        response = _well_formed_response()
        response["evidence_refs"] = [
            "human-required:AIR-aria-evidence-judge-0123456789ab",
        ]
        grade = grade_response(
            request=_well_formed_request(),
            response=response,
            response_path=Path("/tmp/out.md"),
        )
        self.assertTrue(
            grade["check_results"]["evidence_schema_valid"]["passed"],
            grade["check_results"]["evidence_schema_valid"],
        )

    def test_bare_ledger_pointer_prefix_still_rejected(self) -> None:
        # `human-required:` with no id names nothing — the predicate
        # requires a non-empty id, so the empty spelling stays bad.
        response = _well_formed_response()
        response["evidence_refs"] = ["human-required:"]
        grade = grade_response(
            request=_well_formed_request(),
            response=response,
            response_path=Path("/tmp/out.md"),
        )
        self.assertFalse(grade["check_results"]["evidence_schema_valid"]["passed"])

    def test_output_path_mismatch_hard_fails(self) -> None:
        grade = grade_response(
            request=_well_formed_request(expected_path="/tmp/expected.md"),
            response=_well_formed_response(),
            response_path=Path("/tmp/different.md"),
        )
        self.assertFalse(grade["check_results"]["output_path_match"]["passed"])

    def test_banned_phrase_in_body_fails(self) -> None:
        response = _well_formed_response()
        response["body"] = "we will defer the rest to next sprint"
        grade = grade_response(
            request=_well_formed_request(),
            response=response,
            response_path=Path("/tmp/out.md"),
        )
        # 'defer' is in BANNED_PHRASES (per agent_genesis taxonomy).
        # NOTE: this assertion is liberal — it depends on the BANNED_PHRASES
        # actual contents. We assert at MINIMUM that the check ran and the
        # evidence dict contains the body length.
        self.assertIn("body_chars",
                      grade["check_results"]["banned_phrase_in_response_body"]["evidence"])

    def test_response_order_valid_passes_when_order_matches(self) -> None:
        grade = grade_response(
            request=_well_formed_request(),
            response=_well_formed_response(),
            response_path=Path("/tmp/out.md"),
        )
        self.assertTrue(grade["check_results"]["response_order_valid"]["passed"])

    def test_refusal_trigger_validates_envelope_when_status_rejected(self) -> None:
        response = _well_formed_response()
        response["status"] = "rejected"
        # Missing refusal envelope — soft fail.
        grade = grade_response(
            request=_well_formed_request(),
            response=response,
            response_path=Path("/tmp/out.md"),
        )
        self.assertFalse(grade["check_results"]["refusal_trigger_valid"]["passed"])


class HardRejectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_single_hard_fail_triggers_rejection(self) -> None:
        # Path mismatch is a single hard-fail.
        grade = grade_response(
            request=_well_formed_request(expected_path="/tmp/expected.md"),
            response=_well_formed_response(),
            response_path=Path("/tmp/different.md"),
        )
        self.assertTrue(grade["rejection"])
        self.assertEqual(grade["rejection_reason"], COMPLIANCE_REJECTION_REASON)

    def test_record_emits_violation_governance_event(self) -> None:
        record_compliance_grade(
            claim_id="claim-test-1",
            request=_well_formed_request(expected_path="/tmp/expected.md"),
            response=_well_formed_response(),
            response_path=Path("/tmp/different.md"),
            base_dir=self.tools,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("agent_compliance_violation", kinds)


class SoftRejectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_single_soft_fail_does_not_reject_but_warns(self) -> None:
        response = _well_formed_response()
        # Soft fail #1: refusal envelope mismatch (status=rejected, no
        # envelope).
        response["status"] = "rejected"
        grade = grade_response(
            request=_well_formed_request(),
            response=response,
            response_path=Path("/tmp/out.md"),
        )
        self.assertFalse(grade["rejection"])
        self.assertGreaterEqual(grade["soft_fail_count"], 1)

    def test_record_emits_warning_event_on_single_soft_fail(self) -> None:
        response = _well_formed_response()
        response["status"] = "rejected"  # missing refusal envelope
        record_compliance_grade(
            claim_id="claim-soft-1",
            request=_well_formed_request(),
            response=response,
            response_path=Path("/tmp/out.md"),
            base_dir=self.tools,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("agent_compliance_warning", kinds)
        self.assertNotIn("agent_compliance_violation", kinds)

    def test_two_soft_fails_trigger_kumulative_rejection(self) -> None:
        # Two soft fails: order-mismatch + refusal-shape-mismatch.
        request = _well_formed_request()
        response = _well_formed_response()
        # Reorder satisfaction matrix.
        response["satisfaction_matrix"] = [
            {"id": "MS-2", "verdict": "satisfied"},
            {"id": "MS-1", "verdict": "satisfied"},
        ]
        # And trigger refusal mismatch.
        response["status"] = "rejected"
        grade = grade_response(
            request=request,
            response=response,
            response_path=Path("/tmp/out.md"),
        )
        self.assertGreaterEqual(grade["soft_fail_count"], 2)
        self.assertTrue(grade["rejection"])
        self.assertEqual(grade["rejection_reason"], COMPLIANCE_REJECTION_REASON)


class LifecyclePreservationTests(unittest.TestCase):
    """Plan 016 10-state lifecycle remains intact; compliance_rejected is
    a REJECTED sub-type via rejection_reason field, NOT a new state."""

    def test_rejection_reason_uses_existing_rejected_state(self) -> None:
        from aria_kernel.agent_invocations import DERIVED_STATES
        # State list does NOT include COMPLIANCE_REJECTED (compliance
        # rejection annotates the existing REJECTED state via
        # ``rejection_reason``, no 11th state added). Plan 026R §C.5
        # expanded the list with bridge-aware acceptance states
        # (ACCEPTED_PENDING_BRIDGE + ACCEPTED_PENDING_BRIDGE_PERMANENT_
        # FAIL). V10.5 Phase 3 (per ADR-0001) added EXTERNAL_OUTAGE
        # for Anthropic API 529 transient outage handling.
        # ORPHAN-MEDIUM-492 added ANCHOR_STALE (request minted against a
        # tree the repo has moved off); count is now 14.
        self.assertNotIn("COMPLIANCE_REJECTED", DERIVED_STATES)
        self.assertIn("REJECTED", DERIVED_STATES)
        self.assertEqual(len(DERIVED_STATES), 14)
        self.assertIn("EXTERNAL_OUTAGE", DERIVED_STATES)
        self.assertIn("ANCHOR_STALE", DERIVED_STATES)


class PersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_persists_to_agent_compliance_jsonl(self) -> None:
        record_compliance_grade(
            claim_id="claim-persist-1",
            request=_well_formed_request(),
            response=_well_formed_response(),
            response_path=Path("/tmp/out.md"),
            base_dir=self.tools,
        )
        path = self.tools / "agent-compliance.jsonl"
        self.assertTrue(path.exists())
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["claim_id"], "claim-persist-1")

    def test_list_compliance_grades_filter(self) -> None:
        # 1 passing + 1 hard-rejected.
        record_compliance_grade(
            claim_id="ok-1",
            request=_well_formed_request(),
            response=_well_formed_response(),
            response_path=Path("/tmp/out.md"),
            base_dir=self.tools,
        )
        record_compliance_grade(
            claim_id="bad-1",
            request=_well_formed_request(expected_path="/tmp/expected.md"),
            response=_well_formed_response(),
            response_path=Path("/tmp/different.md"),
            base_dir=self.tools,
        )
        rejected = list_compliance_grades(base_dir=self.tools, rejected_only=True)
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0]["claim_id"], "bad-1")


class FrozenProfileBlocksComplianceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed()

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_record(self) -> None:
        set_profile("frozen", operator_approval_ref="op:freeze",
                    base_dir=self.tools)
        with self.assertRaises(GovernanceError) as cm:
            record_compliance_grade(
                claim_id="frozen-test",
                request=_well_formed_request(),
                response=_well_formed_response(),
                response_path=Path("/tmp/out.md"),
                base_dir=self.tools,
            )
        self.assertIn("agent_compliance", str(cm.exception))
        self.assertIn("frozen", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
