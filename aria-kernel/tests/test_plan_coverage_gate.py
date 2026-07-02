"""Plan-coverage gate — kernel-side pins.

WHY this suite exists: convergence measures AGREEMENT (primary vs challenger),
not COVERAGE — two planners can share a blind spot and converge on it. The
gate turns the planner prompts' "trace recursive impact" obligation into
machine-verified structure: a ``coverage_computed`` event per round, a
verdict-driven evaluator gate, and a defense-in-depth check at the
implementation seam. Applicability key: plan_started schema_version >= 2 —
every historical plan and fixture is v1, pinned here as the legacy test.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    content_hash,
    evaluate_plan,
    events_path,
    fold_plan_state,
    plan_status,
    record_coverage,
    record_cross_review,
    record_revision,
    request_cross_review,
    request_implementation,
    request_critics,
    record_critique,
    start_plan,
    submit_challenger_plan,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture

MANIFEST_PATH = "aria-tools/coverage/plan-1-r1.json"


class PlanCoverageGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        for name, owns in (("farm-expert", "apps/farm-service/**"), ("access-boundary-auditor", "web/**")):
            (agents / f"{name}.md").write_text(
                f"---\nname: {name}\ndescription: reviewer.\n---\n\nOwns `{owns}`.\n",
                encoding="utf-8",
            )

    def tearDown(self):
        self.tmp.cleanup()

    # ------------------------------------------------------------------ tests

    def test_schema_v1_legacy_plan_converges_without_coverage_event(self):
        self.start(schema_version=1)
        self.drive_to_cross_reviewed(1)
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(result["event"]["payload"]["terminal_state"], "CONVERGED")
        gate = self.gate_decision(result["event"]["payload"], "plan_coverage")
        self.assertFalse(gate["applicable"])
        self.assertTrue(gate["passed"])

    def test_schema_v2_without_coverage_event_is_human_required(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        payload = result["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("coverage_missing", payload["reason_codes"])
        self.assertFalse(self.gate_decision(payload, "plan_coverage")["passed"])

    def test_coverage_covered_verdict_allows_converged(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        record_coverage(plan_id="plan-1", coverage=self.coverage_payload(), base_dir=self.tools_dir)
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        payload = result["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "CONVERGED")
        self.assertTrue(self.gate_decision(payload, "plan_coverage")["passed"])
        self.assertEqual(payload["risks_rollup_summary"]["coverage_verdict"], "covered")

    def test_coverage_gaps_blocks_next_round_without_event(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        record_coverage(plan_id="plan-1", coverage=self.gaps_payload(1), base_dir=self.tools_dir)
        before = len(load_jsonl(events_path(self.tools_dir)))
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        after = len(load_jsonl(events_path(self.tools_dir)))
        self.assertEqual(result["status"], "next_round_required")
        self.assertFalse(result["event_appended"])
        self.assertEqual(before, after)
        self.assertIn("coverage_gaps_present", result["reason_codes"])
        # Double-layer: the synthetic material risk also trips the existing gate.
        self.assertIn("material_cross_review_risks_present", result["reason_codes"])

    def test_coverage_gaps_at_max_rounds_is_human_required(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        record_coverage(plan_id="plan-1", coverage=self.gaps_payload(1), base_dir=self.tools_dir)
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir, max_rounds=1)
        payload = result["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("max_rounds_reached", payload["reason_codes"])
        self.assertIn("coverage_gaps_present", payload["reason_codes"])

    def test_environment_unable_is_human_required_immediately(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        record_coverage(
            plan_id="plan-1",
            coverage=self.coverage_payload(verdict="environment_unable"),
            base_dir=self.tools_dir,
        )
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        payload = result["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("coverage_environment_unable", payload["reason_codes"])

    def test_waiver_covered_with_waivers_converges(self):
        self.start(schema_version=2, coverage_block={"waivers": [{"node": "project:notification-service", "reason": "type-only change"}]})
        self.drive_to_cross_reviewed(1)
        record_coverage(
            plan_id="plan-1",
            coverage=self.coverage_payload(
                verdict="covered_with_waivers",
                waived=[{"node_id": "project:notification-service", "reason": "type-only change"}],
            ),
            base_dir=self.tools_dir,
        )
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(result["event"]["payload"]["terminal_state"], "CONVERGED")

    def test_record_coverage_is_idempotent(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        payload = self.coverage_payload()
        first = record_coverage(plan_id="plan-1", coverage=payload, base_dir=self.tools_dir)
        second = record_coverage(plan_id="plan-1", coverage=payload, base_dir=self.tools_dir)
        self.assertTrue(first["event_appended"])
        self.assertTrue(second["idempotent"])
        events = [row for row in load_jsonl(events_path(self.tools_dir)) if row["event_type"] == "coverage_computed"]
        self.assertEqual(len(events), 1)

    def test_record_coverage_stale_target_hash_rejected(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        stale = self.coverage_payload()
        stale["target_plan_content_hash"] = content_hash({"stale": True})
        before = len(load_jsonl(events_path(self.tools_dir)))
        with self.assertRaisesRegex(GovernanceError, "coverage must target"):
            record_coverage(plan_id="plan-1", coverage=stale, base_dir=self.tools_dir)
        self.assertEqual(before, len(load_jsonl(events_path(self.tools_dir))))

    def test_record_coverage_on_draft_state_refused(self):
        self.start(schema_version=2)
        with self.assertRaisesRegex(GovernanceError, "cannot record coverage"):
            record_coverage(plan_id="plan-1", coverage=self.coverage_payload(round_number=1), base_dir=self.tools_dir)

    def test_crafted_ledger_coverage_on_draft_fails_replay(self):
        self.start(schema_version=2)
        payload = self.coverage_payload(round_number=1)
        append_declared_fixture(
            events_path(self.tools_dir),
            {
                "schema_version": 1,
                "event_id": "evt-crafted",
                "event_type": "coverage_computed",
                "plan_id": "plan-1",
                "recorded_at": "2026-07-02T00:00:00+00:00",
                "idempotency_key": content_hash({"crafted": True}),
                "payload": payload,
            },
            expected_surface="plan_convergence_events",
        )
        with self.assertRaisesRegex(GovernanceError, "invalid_transition"):
            fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)

    def test_synthetic_risks_fold_into_round_and_resolve_via_revision(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        record_coverage(plan_id="plan-1", coverage=self.gaps_payload(1), base_dir=self.tools_dir)
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        risk_ids = [risk["risk_id"] for risk in state["cross_review_risks_by_round"][1]]
        self.assertIn("COV-R1-deadbeef", risk_ids)
        self.revision("rev-1", "widen affected_surfaces", addresses_review_risk_ids=["COV-R1-deadbeef"])
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        self.assertIn("COV-R1-deadbeef", state["resolved_review_risk_ids"])

    def test_round_scoped_gap_ids_are_not_masked_by_prior_addresses(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        record_coverage(plan_id="plan-1", coverage=self.gaps_payload(1), base_dir=self.tools_dir)
        evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.revision("rev-1", "claims to address the gap", addresses_review_risk_ids=["COV-R1-deadbeef"])
        self.submit_challenger("challenger-rev-1")
        self.drive_to_cross_reviewed(2, submit=False)
        # Machine verification re-detects the SAME node in round 2 under a
        # fresh round-scoped id — the accumulated resolved set cannot mask it.
        record_coverage(plan_id="plan-1", coverage=self.gaps_payload(2, risk_id="COV-R2-deadbeef"), base_dir=self.tools_dir)
        result = evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools_dir)
        self.assertEqual(result["status"], "next_round_required")
        self.assertIn("coverage_gaps_present", result["reason_codes"])

    def test_request_implementation_refused_without_coverage_for_v2_plan(self):
        # The critique-only path (_evaluate_state) has no coverage gate — a v2
        # plan CAN converge through it. The implementation seam must refuse.
        self.start(schema_version=2)
        self.request_critic_round(1)
        self.critique("farm-expert", [])
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(result["event"]["payload"]["terminal_state"], "CONVERGED")
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        with self.assertRaisesRegex(GovernanceError, "implementation_requires_coverage_verdict"):
            request_implementation(
                plan_id="plan-1",
                implementer_agent="aria-implementer",
                converged_plan_revision_id=state["latest_revision"]["revision_id"],
                converged_plan_content_hash=state["latest_revision"]["content_hash"],
                base_dir=self.tools_dir,
            )

    def test_v1_plan_request_implementation_needs_no_coverage(self):
        self.start(schema_version=1)
        self.request_critic_round(1)
        self.critique("farm-expert", [])
        evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        result = request_implementation(
            plan_id="plan-1",
            implementer_agent="aria-implementer",
            converged_plan_revision_id=state["latest_revision"]["revision_id"],
            converged_plan_content_hash=state["latest_revision"]["content_hash"],
            base_dir=self.tools_dir,
        )
        self.assertTrue(result["event_appended"])

    def test_plan_content_coverage_block_validation(self):
        with self.assertRaisesRegex(GovernanceError, "coverage waiver reason"):
            self.start(schema_version=2, coverage_block={"waivers": [{"node": "project:x"}]})
        result = self.start(schema_version=2, coverage_block={"waivers": [{"node": "project:x", "reason": "verified"}]})
        self.assertTrue(result["event_appended"])

    def test_gaps_verdict_requires_uncovered_and_risks(self):
        self.start(schema_version=2)
        self.drive_to_cross_reviewed(1)
        inconsistent = self.coverage_payload(verdict="gaps")
        with self.assertRaisesRegex(GovernanceError, "gaps verdict requires"):
            record_coverage(plan_id="plan-1", coverage=inconsistent, base_dir=self.tools_dir)
        covered_with_leftovers = self.gaps_payload(1)
        covered_with_leftovers["verdict"] = "covered"
        with self.assertRaisesRegex(GovernanceError, "must carry no uncovered"):
            record_coverage(plan_id="plan-1", coverage=covered_with_leftovers, base_dir=self.tools_dir)

    # ---------------------------------------------------------------- helpers

    def gate_decision(self, payload: dict, gate: str) -> dict:
        return next(item for item in payload["gate_decisions"] if item["gate"] == gate)

    def start(self, *, schema_version: int, coverage_block: dict | None = None):
        return start_plan(
            plan_id="plan-1",
            initial_revision_id="rev-0",
            plan_content=self.plan(schema_version, coverage_block),
            base_dir=self.tools_dir,
        )

    def drive_to_cross_reviewed(self, round_number: int, *, submit: bool = True):
        if submit:
            self.submit_challenger(f"challenger-rev-{round_number}")
        self.request_cross_round(round_number)
        self.cross_review(f"task-p2c-{round_number}", "farm-expert", "primary_to_challenger")
        self.cross_review(f"task-c2p-{round_number}", "access-boundary-auditor", "challenger_to_primary")
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["state"], "CROSS_REVIEWED")

    def coverage_payload(self, *, verdict: str = "covered", round_number: int | None = None, waived: list | None = None):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        latest = state["latest_revision"]
        return {
            "round_number": round_number or state.get("current_round") or 1,
            "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"],
            "verdict": verdict,
            "closure_manifest_path": MANIFEST_PATH,
            "closure_manifest_hash": content_hash({"manifest": verdict}),
            "closure_summary": {"projects": 2, "event_consumers": 0, "migration_couplings": 0},
            "uncovered": [],
            "waived": waived or [],
            "synthetic_risks": [],
            "computed_at_sha": "0" * 40,
            "witness": {"tool": "tools/gates/plan-coverage-witness.ts", "exit_code": 0},
        }

    def gaps_payload(self, round_number: int, *, risk_id: str = "COV-R1-deadbeef"):
        payload = self.coverage_payload(verdict="gaps", round_number=round_number)
        payload["uncovered"] = [
            {"node_id": "project:notification-service", "kind": "nx_project", "why": "reverse dependent of farm-shared"},
        ]
        payload["synthetic_risks"] = [
            {
                "risk_id": risk_id,
                "risk_category": "coverage_gap",
                "severity": "material",
                "summary": "Impact-closure node project:notification-service is not addressed",
                "recommendation": "Widen affected_surfaces or add a coverage.waivers entry",
                "affected_files": [MANIFEST_PATH],
                "evidence_refs": [f"{MANIFEST_PATH}:1"],
            },
        ]
        return payload

    def submit_challenger(self, challenger_revision_id: str):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        plan = self.plan(2, None)
        plan["title"] = "Challenger Plan"
        return submit_challenger_plan(
            plan_id="plan-1",
            challenger={
                "challenger_agent": "access-boundary-auditor",
                "challenger_revision_id": challenger_revision_id,
                "source_revision_id": state["latest_revision"]["revision_id"],
                "source_plan_content_hash": state["latest_revision"]["content_hash"],
                "plan_content": plan,
            },
            base_dir=self.tools_dir,
        )

    def request_cross_round(self, round_number: int):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        latest = state["latest_revision"]
        return request_cross_review(
            plan_id="plan-1",
            request={
                "round_number": round_number,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [
                    self.cross_task(f"task-p2c-{round_number}", "farm-expert", "primary_to_challenger", latest),
                    self.cross_task(f"task-c2p-{round_number}", "access-boundary-auditor", "challenger_to_primary", latest),
                ],
            },
            base_dir=self.tools_dir,
        )

    def request_critic_round(self, round_number: int):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        latest = state["latest_revision"]
        return request_critics(
            plan_id="plan-1",
            request={
                "round_number": round_number,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [
                    {
                        "task_id": f"task-{round_number}",
                        "task_packet_hash": content_hash({"task_id": f"task-{round_number}"}),
                        "target_agent": "farm-expert",
                        "target_revision_id": latest["revision_id"],
                        "target_plan_content_hash": latest["content_hash"],
                        "sla_deadline": self.deadline(60),
                    },
                ],
            },
            base_dir=self.tools_dir,
        )

    def critique(self, reviewer: str, risks: list[dict]):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        task = next(iter(state["rounds"][state["current_round"]]["tasks"].values()))
        return record_critique(
            plan_id="plan-1",
            critique={
                "task_packet_hash": task["task_packet_hash"],
                "target_revision_id": task["target_revision_id"],
                "target_plan_content_hash": task["target_plan_content_hash"],
                "reviewer": reviewer,
                "risks": risks,
                "critique_content_hash": content_hash({"reviewer": reviewer, "risks": risks}),
            },
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )

    def cross_review(self, task_id: str, reviewer: str, direction: str):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        task = next(
            task for task in state["cross_reviews"][state["current_round"]]["tasks"].values()
            if task["task_id"] == task_id
        )
        return record_cross_review(
            plan_id="plan-1",
            review={
                "task_packet_hash": task["task_packet_hash"],
                "target_revision_id": task["target_revision_id"],
                "target_plan_content_hash": task["target_plan_content_hash"],
                "reviewer_agent": reviewer,
                "review_direction": direction,
                "risks": [],
                "review_content_hash": content_hash({"reviewer": reviewer, "direction": direction}),
            },
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )

    def revision(self, revision_id: str, content: str, *, addresses_review_risk_ids: list[str] | None = None):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        return record_revision(
            plan_id="plan-1",
            revision={
                "revision_id": revision_id,
                "round": state["current_round"],
                "content_hash": content_hash({"content": content}),
                "parent_revision_hash": state["latest_revision"]["content_hash"],
                "content": content,
                "addresses_review_risk_ids": addresses_review_risk_ids or [],
            },
            base_dir=self.tools_dir,
        )

    def cross_task(self, task_id: str, reviewer: str, direction: str, latest: dict):
        return {
            "task_id": task_id,
            "task_packet_hash": content_hash({"task_id": task_id, "reviewer_agent": reviewer, "review_direction": direction, "target_revision_id": latest["revision_id"]}),
            "reviewer_agent": reviewer,
            "review_direction": direction,
            "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"],
            "sla_deadline": self.deadline(60),
        }

    def plan(self, schema_version: int, coverage_block: dict | None):
        plan = {
            "schema_version": schema_version,
            "title": "ARIA Plan Coverage",
            "summary": "Coverage gate plan.",
            "affected_surfaces": [{"paths": ["libs/farm-shared/src/index.ts"]}],
            "key_changes": ["widen shared lib"],
            "validation_commands": [{"cmd": "python3 -m unittest discover aria-kernel -p '*test*.py'"}],
            "evidence_refs": ["docs/aria/SPEC.md"],
        }
        if coverage_block is not None:
            plan["coverage"] = coverage_block
        return plan

    def deadline(self, seconds: int) -> str:
        return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).replace(microsecond=0).isoformat()


if __name__ == "__main__":
    unittest.main()
