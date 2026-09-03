from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_priors import reviewer_names
from aria_kernel.ledger import LedgerIntegrityError, load_jsonl
from aria_kernel.plan_convergence import (
    abandon_plan,
    content_hash,
    evaluate_plan,
    events_path,
    fold_plan_state,
    plan_status,
    reap_stale_tasks,
    record_critique,
    record_cross_review,
    record_revision,
    request_cross_review,
    request_cross_review_retry,
    request_critics,
    start_plan,
    submit_challenger_plan,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture


class PlanConvergenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        agents = self.root / ".claude" / "agents"
        (agents / "product-audit").mkdir(parents=True)
        (agents / "farm-expert.md").write_text(
            "\n".join(
                [
                    "---",
                    "name: farm-expert",
                    "description: Farm reviewer.",
                    "---",
                    "",
                    "Owns `apps/farm-service/**`.",
                ],
            ),
            encoding="utf-8",
        )
        (agents / "product-audit" / "access-boundary-auditor.md").write_text(
            "\n".join(
                [
                    "---",
                    "name: access-boundary-auditor",
                    "description: Access reviewer.",
                    "---",
                    "",
                    "Owns `web/**`.",
                ],
            ),
            encoding="utf-8",
        )
        (agents / "invalid.md").write_text("description: no frontmatter name\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_canonical_file_payload_idempotency_returns_existing_event(self):
        first = self.start()
        equivalent_plan = {
            "evidence_refs": ["docs/aria/SPEC.md"],
            "validation_commands": [{"cmd": "python3 -m unittest discover aria-kernel -p '*test*.py'"}],
            "key_changes": ["add ledger"],
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "summary": "Plan convergence.",
            "title": "ARIA Plan Convergence",
            "schema_version": 1,
        }
        second = start_plan(
            plan_id="plan-1",
            initial_revision_id="rev-0",
            plan_content=equivalent_plan,
            base_dir=self.tools_dir,
        )
        self.assertTrue(first["event_appended"])
        self.assertFalse(second["event_appended"])
        self.assertTrue(second["idempotent"])
        self.assertEqual(len(load_jsonl(events_path(self.tools_dir))), 1)

    def test_round_one_zero_risk_derives_critiqued_and_converges(self):
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["state"], "CRITIQUED")
        evaluated = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(evaluated["event"]["payload"]["terminal_state"], "CONVERGED")
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["state"], "CONVERGED")

    def test_round_two_new_category_requires_round_three_without_event(self):
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [self.risk("schema", "MEDIUM")])
        self.revision("rev-1", "round one revision")
        self.request_round(2, "farm-expert")
        self.critique("farm-expert", [self.risk("schema", "LOW"), self.risk("access", "LOW")])
        before = len(load_jsonl(events_path(self.tools_dir)))
        result = evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools_dir)
        after = len(load_jsonl(events_path(self.tools_dir)))
        self.assertFalse(result["event_appended"])
        self.assertEqual(result["status"], "next_round_required")
        self.assertEqual(before, after)

    def test_round_three_new_category_produces_human_required(self):
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [self.risk("schema", "MEDIUM")])
        self.revision("rev-1", "round one revision")
        self.request_round(2, "farm-expert")
        self.critique("farm-expert", [self.risk("schema", "LOW"), self.risk("access", "LOW")])
        evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools_dir)
        self.revision("rev-2", "round two revision")
        self.request_round(3, "access-boundary-auditor")
        self.critique("access-boundary-auditor", [self.risk("workflow", "LOW")])
        result = evaluate_plan(plan_id="plan-1", round_number=3, base_dir=self.tools_dir)
        self.assertEqual(result["event"]["payload"]["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("new_risk_category_round_3", result["event"]["payload"]["reason_codes"])

    def test_submit_challenger_from_revised_state_enables_cross_review_redo(self):
        # Phase-4.1 D1 — submit_challenger_plan accepts {DRAFT, REVISED}, not only DRAFT.
        # Why: without REVISED a primary cannot start a fresh challenger after a critique
        # round, blocking the cross-review re-do path required for late-discovered risks.
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [self.risk("schema", "MEDIUM")])
        self.revision("rev-1", "round one revision")
        # State must be REVISED before submit_challenger.
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["state"], "REVISED")
        # Submit a challenger plan from REVISED — must transition to CHALLENGER_DRAFTED.
        self.submit_challenger()
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        self.assertEqual(state["state"], "CHALLENGER_DRAFTED")
        self.assertIsNotNone(state.get("challenger_plan"))

    def test_cross_review_zero_risk_converges_from_cross_reviewed(self):
        self.start()
        self.submit_challenger()
        self.request_cross_round(1)
        self.cross_review("task-p2c-1", "farm-expert", "primary_to_challenger", [])
        self.cross_review("task-c2p-1", "access-boundary-auditor", "challenger_to_primary", [])
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["state"], "CROSS_REVIEWED")
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(result["status"], "evaluated")
        self.assertEqual(result["event"]["payload"]["terminal_state"], "CONVERGED")

    def test_cross_review_material_risk_requires_transient_next_round(self):
        self.start()
        self.submit_challenger()
        self.request_cross_round(1)
        self.cross_review("task-p2c-1", "farm-expert", "primary_to_challenger", [self.cross_risk("RISK-1", "material")])
        self.cross_review("task-c2p-1", "access-boundary-auditor", "challenger_to_primary", [])
        before = len(load_jsonl(events_path(self.tools_dir)))
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        after = len(load_jsonl(events_path(self.tools_dir)))
        self.assertFalse(result["event_appended"])
        self.assertEqual(result["status"], "next_round_required")
        self.assertEqual(before, after)
        self.revision("rev-1", "addresses risk", addresses_review_risk_ids=["RISK-1"])
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["resolved_review_risk_ids"], ["RISK-1"])

    def test_cross_review_retry_replaces_timed_out_task_in_same_round(self):
        self.start()
        self.submit_challenger()
        self.request_cross_round(1, deadline=self.deadline(-60))
        reap_stale_tasks(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        self.assertEqual(state["state"], "CROSS_REVIEW_REQUESTED")
        retry = request_cross_review_retry(
            plan_id="plan-1",
            request={
                "round_number": 1,
                "target_revision_id": state["latest_revision"]["revision_id"],
                "target_plan_content_hash": state["latest_revision"]["content_hash"],
                "replaces_task_ids": ["task-p2c-1", "task-c2p-1"],
                "tasks": [
                    self.cross_task("task-p2c-1b", "farm-expert", "primary_to_challenger", state["latest_revision"]["revision_id"], state["latest_revision"]["content_hash"]),
                    self.cross_task("task-c2p-1b", "access-boundary-auditor", "challenger_to_primary", state["latest_revision"]["revision_id"], state["latest_revision"]["content_hash"]),
                ],
            },
            base_dir=self.tools_dir,
        )
        self.assertTrue(retry["event_appended"])
        self.cross_review("task-p2c-1b", "farm-expert", "primary_to_challenger", [])
        self.cross_review("task-c2p-1b", "access-boundary-auditor", "challenger_to_primary", [])
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["state"], "CROSS_REVIEWED")

    def test_cross_review_hash_mismatch_rejects_without_event(self):
        self.start()
        self.submit_challenger()
        self.request_cross_round(1)
        append_declared_fixture(
            self.tools_dir / "agent-invocations" / "results.jsonl",
            {
                "schema_version": 1,
                "request_id": "AIR-1",
                "content_hash": content_hash({"actual": "review"}),
            },
            expected_surface="agent_invocation_results",
        )
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        task = next(task for task in state["cross_reviews"][1]["tasks"].values() if task["task_id"] == "task-p2c-1")
        result = record_cross_review(
            plan_id="plan-1",
            review={
                "task_packet_hash": task["task_packet_hash"],
                "target_revision_id": task["target_revision_id"],
                "target_plan_content_hash": task["target_plan_content_hash"],
                "reviewer_agent": "farm-expert",
                "review_direction": "primary_to_challenger",
                "risks": [],
                "review_content_hash": content_hash({"wrong": "review"}),
                "agent_invocation_request_id": "AIR-1",
            },
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(result["status"], "rejected")
        self.assertFalse(result["event_appended"])

    def test_human_required_can_be_abandoned_as_soft_archive(self):
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [self.risk("schema", "HIGH")])
        evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        abandoned = abandon_plan(plan_id="plan-1", reason="operator archive", base_dir=self.tools_dir)
        repeated = abandon_plan(plan_id="plan-1", reason="different reason ignored", base_dir=self.tools_dir)
        self.assertEqual(abandoned["event"]["payload"]["abandoned_from_state"], "HUMAN_REQUIRED")
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["state"], "ABANDONED")
        self.assertFalse(repeated["event_appended"])
        self.assertEqual(repeated["event"]["event_id"], abandoned["event"]["event_id"])

    def test_no_op_reap_writes_no_event(self):
        self.start()
        self.request_round(1, "farm-expert", deadline=self.deadline(60))
        before = len(load_jsonl(events_path(self.tools_dir)))
        result = reap_stale_tasks(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        after = len(load_jsonl(events_path(self.tools_dir)))
        self.assertFalse(result["event_appended"])
        self.assertEqual(result["reaped_task_ids"], [])
        self.assertEqual(before, after)

    def test_late_critique_after_timeout_is_rejected(self):
        self.start()
        self.request_round(1, "farm-expert", deadline=self.deadline(-60))
        result = reap_stale_tasks(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertTrue(result["event_appended"])
        with self.assertRaisesRegex(GovernanceError, "late critique"):
            self.critique("farm-expert", [])

    def test_frontmatter_reviewer_whitelist_includes_nested_agents_and_rejects_typos(self):
        self.start()
        self.assertIn("access-boundary-auditor", reviewer_names(workspace_root=self.root))
        self.request_round(1, "access-boundary-auditor")
        self.critique("access-boundary-auditor", [])
        self.revision("rev-1", "first revision")
        self.request_round(2, "farm-expert")
        with self.assertRaisesRegex(GovernanceError, "unknown reviewer"):
            self.critique("farm-expertt", [])

    def test_duplicate_frontmatter_names_raise_reviewer_name_conflict(self):
        duplicate = self.root / ".claude" / "agents" / "product-audit" / "farm-copy.md"
        duplicate.write_text("---\nname: farm-expert\ndescription: duplicate\n---\n", encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "reviewer_name_conflict"):
            reviewer_names(workspace_root=self.root)

    def test_validation_commands_and_evidence_refs_are_enforced(self):
        plan = self.plan()
        plan["validation_commands"] = [{"cmd": "python3 -m unittest", "timeout_ms": 0}]
        with self.assertRaisesRegex(GovernanceError, "timeout_ms"):
            start_plan(plan_id="bad-plan", initial_revision_id="rev-0", plan_content=plan, base_dir=self.tools_dir)
        plan = self.plan()
        plan["evidence_refs"] = ["/absolute/path.ts"]
        with self.assertRaisesRegex(GovernanceError, "evidence_refs"):
            start_plan(plan_id="bad-plan-2", initial_revision_id="rev-0", plan_content=plan, base_dir=self.tools_dir)
        plan = self.plan()
        plan["evidence_refs"] = ["PLAT-MEDIUM-901"]
        result = start_plan(plan_id="good-plan", initial_revision_id="rev-0", plan_content=plan, base_dir=self.tools_dir)
        self.assertTrue(result["event_appended"])

    def test_per_round_critic_fanout_over_fifty_is_rejected(self):
        self.start()
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        tasks = [
            self.task(f"task-{index}", "farm-expert", state["latest_revision"]["revision_id"], state["latest_revision"]["content_hash"])
            for index in range(51)
        ]
        with self.assertRaisesRegex(GovernanceError, "critic tasks per round"):
            request_critics(
                plan_id="plan-1",
                request={
                    "round_number": 1,
                    "target_revision_id": state["latest_revision"]["revision_id"],
                    "target_plan_content_hash": state["latest_revision"]["content_hash"],
                    "tasks": tasks,
                },
                base_dir=self.tools_dir,
            )

    def test_broken_ledger_blocks_mutating_command_before_append(self):
        self.start()
        path = events_path(self.tools_dir)
        rows = path.read_text(encoding="utf-8").splitlines()
        first = json.loads(rows[0])
        first["payload"]["initial_revision_id"] = "tampered"
        path.write_text(json.dumps(first, sort_keys=True) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(LedgerIntegrityError, "strict verification failed"):
            self.request_round(1, "farm-expert")

    def test_replay_fold_is_deterministic(self):
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        first = fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)
        second = fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)
        self.assertEqual(first, second)

    def test_initial_and_subsequent_revision_references_are_enforced(self):
        self.start()
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        bad_task = self.task("task-1", "farm-expert", "wrong-rev", state["latest_revision"]["content_hash"])
        with self.assertRaisesRegex(GovernanceError, "latest revision"):
            request_critics(
                plan_id="plan-1",
                request={
                    "round_number": 1,
                    "target_revision_id": "wrong-rev",
                    "target_plan_content_hash": state["latest_revision"]["content_hash"],
                    "tasks": [bad_task],
                },
                base_dir=self.tools_dir,
            )
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        with self.assertRaisesRegex(GovernanceError, "parent_revision_hash"):
            record_revision(
                plan_id="plan-1",
                revision={
                    "revision_id": "rev-1",
                    "round": 1,
                    "content_hash": content_hash({"content": "bad"}),
                    "parent_revision_hash": content_hash({"not": "parent"}),
                    "content": "bad",
                },
                base_dir=self.tools_dir,
            )

    def test_invalid_event_payload_schema_is_rejected_during_replay(self):
        append_declared_fixture(
            events_path(self.tools_dir),
            {
                "schema_version": 1,
                "event_id": "evt-invalid",
                "event_type": "plan_started",
                "plan_id": "invalid-plan",
                "recorded_at": self.deadline(0),
                "idempotency_key": content_hash({"idempotency": "invalid"}),
                "payload": {"missing": "contract"},
            },
            expected_surface="plan_convergence_events",
        )
        with self.assertRaisesRegex(GovernanceError, "plan content"):
            fold_plan_state(plan_id="invalid-plan", base_dir=self.tools_dir)

    def start(self):
        return start_plan(
            plan_id="plan-1",
            initial_revision_id="rev-0",
            plan_content=self.plan(),
            base_dir=self.tools_dir,
        )

    def request_round(self, round_number: int, reviewer: str, *, deadline: str | None = None):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        latest = state["latest_revision"]
        return request_critics(
            plan_id="plan-1",
            request={
                "round_number": round_number,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [self.task(f"task-{round_number}", reviewer, latest["revision_id"], latest["content_hash"], deadline=deadline)],
            },
            base_dir=self.tools_dir,
        )

    def critique(self, reviewer: str, risks: list[dict]):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        current = state["rounds"][state["current_round"]]
        task = next(iter(current["tasks"].values()))
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

    def submit_challenger(self):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        plan = self.plan()
        plan["title"] = "Challenger Plan"
        return submit_challenger_plan(
            plan_id="plan-1",
            challenger={
                "challenger_agent": "access-boundary-auditor",
                "challenger_revision_id": "challenger-rev-0",
                "source_revision_id": state["latest_revision"]["revision_id"],
                "source_plan_content_hash": state["latest_revision"]["content_hash"],
                "plan_content": plan,
            },
            base_dir=self.tools_dir,
        )

    def request_cross_round(self, round_number: int, *, deadline: str | None = None):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        latest = state["latest_revision"]
        return request_cross_review(
            plan_id="plan-1",
            request={
                "round_number": round_number,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [
                    self.cross_task(f"task-p2c-{round_number}", "farm-expert", "primary_to_challenger", latest["revision_id"], latest["content_hash"], deadline=deadline),
                    self.cross_task(f"task-c2p-{round_number}", "access-boundary-auditor", "challenger_to_primary", latest["revision_id"], latest["content_hash"], deadline=deadline),
                ],
            },
            base_dir=self.tools_dir,
        )

    def cross_review(self, task_id: str, reviewer: str, direction: str, risks: list[dict]):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        current = state["cross_reviews"][state["current_round"]]
        task = next(task for task in current["tasks"].values() if task["task_id"] == task_id)
        return record_cross_review(
            plan_id="plan-1",
            review={
                "task_packet_hash": task["task_packet_hash"],
                "target_revision_id": task["target_revision_id"],
                "target_plan_content_hash": task["target_plan_content_hash"],
                "reviewer_agent": reviewer,
                "review_direction": direction,
                "risks": risks,
                "review_content_hash": content_hash({"reviewer": reviewer, "direction": direction, "risks": risks}),
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

    def plan(self):
        return {
            "schema_version": 1,
            "title": "ARIA Plan Convergence",
            "summary": "Plan convergence.",
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "key_changes": ["add ledger"],
            "validation_commands": [{"cmd": "python3 -m unittest discover aria-kernel -p '*test*.py'"}],
            "evidence_refs": ["docs/aria/SPEC.md"],
        }

    def task(self, task_id: str, reviewer: str, revision_id: str, plan_hash: str, *, deadline: str | None = None):
        return {
            "task_id": task_id,
            "task_packet_hash": content_hash({"task_id": task_id, "reviewer": reviewer}),
            "target_agent": reviewer,
            "target_revision_id": revision_id,
            "target_plan_content_hash": plan_hash,
            "sla_deadline": deadline or self.deadline(60),
        }

    def cross_task(self, task_id: str, reviewer: str, direction: str, revision_id: str, plan_hash: str, *, deadline: str | None = None):
        return {
            "task_id": task_id,
            "task_packet_hash": content_hash({"task_id": task_id, "reviewer_agent": reviewer, "review_direction": direction, "target_revision_id": revision_id}),
            "reviewer_agent": reviewer,
            "review_direction": direction,
            "target_revision_id": revision_id,
            "target_plan_content_hash": plan_hash,
            "sla_deadline": deadline or self.deadline(60),
        }

    def risk(self, category: str, severity: str):
        return {
            "risk_category": category,
            "severity": severity,
            "invariant": f"{category} invariant",
            "affected_files": ["aria-kernel/aria_kernel/plan_convergence.py"],
            "recommendation": "tighten validation",
            "evidence_refs": ["docs/aria/SPEC.md"],
        }

    def cross_risk(self, risk_id: str, severity: str):
        return {
            "risk_id": risk_id,
            "risk_category": "architecture",
            "severity": severity,
            "summary": "cross review risk",
            "affected_files": ["aria-kernel/aria_kernel/plan_convergence.py"],
            "recommendation": "tighten validation",
            "evidence_refs": ["docs/aria/SPEC.md"],
        }

    def deadline(self, seconds: int) -> str:
        return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).replace(microsecond=0).isoformat()


if __name__ == "__main__":
    unittest.main()
