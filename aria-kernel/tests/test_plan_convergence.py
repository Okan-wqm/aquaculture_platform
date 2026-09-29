from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel import plan_convergence as plan_convergence_module
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
            "validation_commands": [{"cmd": "nx affected --target=test"}],
            "architectural_tier": 2,
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

    def _historical_observation_fixture(self) -> dict:
        """Rev-0 is reviewed but only the genuine revised body converges."""
        started = self.start()
        original_hash = started["event"]["payload"]["content_hash"]
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        revised_body = self.plan()
        revised_body["title"] = "Reviewed historical revision"
        revised_body["summary"] = "Recover exactly this reviewed body after implementation dispatch."
        revised_body["affected_surfaces"] = [{"paths": ["apps/farm-service/src/farm.service.ts"]}]
        revised_hash = content_hash(revised_body)
        revision = record_revision(
            plan_id="plan-1",
            revision={
                "revision_id": "rev-1", "round": 1,
                "content_hash": revised_hash, "parent_revision_hash": original_hash,
                "content": json.dumps(revised_body, sort_keys=True),
                "addresses_review_risk_ids": [],
            },
            base_dir=self.tools_dir,
        )
        self.assertTrue(revision["event_appended"])
        self.request_round(2, "farm-expert")
        self.critique("farm-expert", [])
        evaluated = evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools_dir)
        self.assertEqual(evaluated["event"]["payload"]["terminal_state"], "CONVERGED")
        dispatched = plan_convergence_module.request_implementation(
            plan_id="plan-1", implementer_agent="aria-implementer",
            converged_plan_revision_id="rev-1",
            converged_plan_content_hash=revised_hash, base_dir=self.tools_dir,
        )
        self.assertTrue(dispatched["event_appended"])
        self.assertEqual(
            fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)["state"],
            "IMPLEMENTATION_REQUESTED",
        )
        return {
            "original_hash": original_hash, "revised_body": revised_body,
            "revised_hash": revised_hash, "convergence_event": evaluated["event"],
        }

    def _historical_ledger_bytes(self) -> dict[str, bytes]:
        return {
            path.relative_to(self.tools_dir).as_posix(): path.read_bytes()
            for path in self.tools_dir.rglob("*.jsonl")
        }

    def test_historical_observation_resolves_revised_body_after_dispatch(self) -> None:
        fixture = self._historical_observation_fixture()
        before = self._historical_ledger_bytes()
        observation = plan_convergence_module.resolve_converged_plan_observation(
            plan_id="plan-1", revision_id="rev-1",
            expected_content_hash=fixture["revised_hash"], base_dir=self.tools_dir,
        )
        self.assertEqual(observation["plan_content"], fixture["revised_body"])
        self.assertEqual(observation["revision_id"], "rev-1")
        self.assertEqual(observation["content_hash"], fixture["revised_hash"])
        self.assertEqual(observation["convergence_event_id"], fixture["convergence_event"]["event_id"])
        self.assertEqual(observation["convergence_event_hash"], fixture["convergence_event"]["ledger_hash"])
        self.assertEqual(self._historical_ledger_bytes(), before)
        self.assertEqual(
            fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)["state"],
            "IMPLEMENTATION_REQUESTED",
        )

    def test_historical_observation_refuses_revision_without_matching_convergence(self) -> None:
        fixture = self._historical_observation_fixture()
        before = self._historical_ledger_bytes()
        for revision_id, expected_hash in (
            ("rev-0", fixture["original_hash"]),
            ("rev-1", "sha256:" + "0" * 64),
        ):
            with self.subTest(revision_id=revision_id, expected_hash=expected_hash):
                with self.assertRaises(GovernanceError):
                    plan_convergence_module.resolve_converged_plan_observation(
                        plan_id="plan-1", revision_id=revision_id,
                        expected_content_hash=expected_hash, base_dir=self.tools_dir,
                    )
                self.assertEqual(self._historical_ledger_bytes(), before)

    def test_historical_observation_rechecks_same_size_tamper_after_cached_fold(self) -> None:
        fixture = self._historical_observation_fixture()
        self.assertEqual(
            fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)["state"],
            "IMPLEMENTATION_REQUESTED",
        )
        path = events_path(self.tools_dir)
        original = path.read_bytes()
        lines = original.splitlines(keepends=True)
        tail_hash = json.loads(lines[-1])["ledger_hash"].encode("ascii")
        replacement = tail_hash[:-1] + (b"0" if tail_hash[-1:] != b"0" else b"1")
        lines[-1] = lines[-1].replace(tail_hash, replacement, 1)
        damaged = b"".join(lines)
        self.assertNotEqual(damaged, original)
        self.assertEqual(len(damaged), len(original), "retain the size-keyed fold cache entry")
        path.write_bytes(damaged)
        before = self._historical_ledger_bytes()
        with self.assertRaises((LedgerIntegrityError, GovernanceError)):
            plan_convergence_module.resolve_converged_plan_observation(
                plan_id="plan-1", revision_id="rev-1",
                expected_content_hash=fixture["revised_hash"], base_dir=self.tools_dir,
            )
        self.assertEqual(self._historical_ledger_bytes(), before)

    def test_historical_observation_refuses_corrupt_suffix_after_convergence(self) -> None:
        fixture = self._historical_observation_fixture()
        path = events_path(self.tools_dir)
        path.write_bytes(path.read_bytes() + b'{"truncated_suffix":')
        before = self._historical_ledger_bytes()
        with self.assertRaises((LedgerIntegrityError, GovernanceError)):
            plan_convergence_module.resolve_converged_plan_observation(
                plan_id="plan-1", revision_id="rev-1",
                expected_content_hash=fixture["revised_hash"], base_dir=self.tools_dir,
            )
        self.assertEqual(self._historical_ledger_bytes(), before)

    def test_historical_observation_refuses_invalid_transition_in_verified_suffix(self) -> None:
        fixture = self._historical_observation_fixture()
        # The declared fixture writer makes a valid chain. The event is still
        # illegal: IMPLEMENTATION_REQUESTED cannot jump directly to MERGED.
        append_declared_fixture(
            events_path(self.tools_dir),
            {
                "schema_version": 1, "event_id": "evt-invalid-merge-suffix",
                "event_type": "implementation_merged", "plan_id": "plan-1",
                "recorded_at": self.deadline(0),
                "idempotency_key": content_hash({"fixture": "invalid-merge-suffix"}),
                "payload": {
                    "merge_sha": "f" * 40, "merged_at": self.deadline(0),
                    "idempotency_key_hash": content_hash({"fixture": "invalid-merge"}),
                },
            },
            expected_surface="plan_convergence_events",
        )
        before = self._historical_ledger_bytes()
        with self.assertRaisesRegex(GovernanceError, "invalid_transition"):
            plan_convergence_module.resolve_converged_plan_observation(
                plan_id="plan-1", revision_id="rev-1",
                expected_content_hash=fixture["revised_hash"], base_dir=self.tools_dir,
            )
        self.assertEqual(self._historical_ledger_bytes(), before)

    def test_historical_observation_refuses_evaluation_without_reviewed_prefix(self) -> None:
        started = self.start()
        expected_hash = started["event"]["payload"]["content_hash"]
        # A schema-valid, hash-chained terminal-state claim cannot substitute
        # for the evaluation producer's CRITIQUED/CROSS_REVIEWED precondition.
        append_declared_fixture(
            events_path(self.tools_dir),
            {
                "schema_version": 1, "event_id": "evt-unreviewed-convergence",
                "event_type": "plan_evaluated", "plan_id": "plan-1",
                "recorded_at": self.deadline(0),
                "idempotency_key": content_hash({"fixture": "unreviewed-convergence"}),
                "payload": {
                    "round_number": 1, "terminal_state": "CONVERGED",
                    "risks_rollup_summary": {}, "gate_decisions": [],
                    "reason_codes": ["fixture-forged-convergence"],
                },
            },
            expected_surface="plan_convergence_events",
        )
        before = self._historical_ledger_bytes()
        with self.assertRaises(GovernanceError):
            plan_convergence_module.resolve_converged_plan_observation(
                plan_id="plan-1", revision_id="rev-0",
                expected_content_hash=expected_hash, base_dir=self.tools_dir,
            )
        self.assertEqual(self._historical_ledger_bytes(), before)

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
        # Production-shaped: the tier claim staging refuses to invent and the
        # canonical suite in the spelling plan_synthesizer emits. A fixture
        # declaring a command no operator registered was seeding a plan the
        # plan contract now refuses to converge.
        return {
            "schema_version": 1,
            "title": "ARIA Plan Convergence",
            "summary": "Plan convergence.",
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "key_changes": ["add ledger"],
            "validation_commands": [{"cmd": "nx affected --target=test"}],
            "evidence_refs": ["docs/aria/SPEC.md"],
            "architectural_tier": 2,
        }

    def structured_revision(self, revision_id: str, **overrides):
        """A revision whose content IS a plan body — the shape that can converge."""
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        body = {**self.plan(), **overrides}
        return record_revision(
            plan_id="plan-1",
            revision={
                "revision_id": revision_id,
                "round": state["current_round"],
                "content_hash": content_hash(body),
                "parent_revision_hash": state["latest_revision"]["content_hash"],
                "content": json.dumps(body, sort_keys=True),
                "addresses_review_risk_ids": [],
            },
            base_dir=self.tools_dir,
        )

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


    def test_native_spine_regression_requests_same_plan_correction_before_convergence(self) -> None:
        import subprocess
        from aria_kernel import agent_invocations as invocation_owner
        from aria_kernel.architecture_spine_gate import take_baseline, take_postcheck
        from aria_kernel.governance_reader import read_governance_rows
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.plan_round_controller import advance_plan_rounds
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import _git, make_local_git_repo

        source_path = "libs/event-contracts/src/ordinary-events.ts"
        schema_path = "libs/event-contracts/src/schemas/alpha_event.json"
        source = self.root / source_path
        schema = self.root / schema_path
        schema.parent.mkdir(parents=True)
        source.write_text(
            "interface BaseEvent { eventId: string; }\n"
            "export interface AlphaEvent extends BaseEvent {}\n", encoding="utf-8",
        )
        schema.write_text('{"type":"object"}\n', encoding="utf-8")
        (self.root / ".gitignore").write_text("aria-debts/\n", encoding="utf-8")
        selected_root = Path(__file__).resolve().parents[2]
        agent_path = ".claude/agents/aria-primary-planner.md"
        declared_agent = (selected_root / agent_path).read_bytes()
        (self.root / agent_path).write_bytes(declared_agent)
        self.assertEqual(make_local_git_repo(self.root.parent, name=self.root.name, initial_commit=False), self.root)
        _git(["add", "."], cwd=self.root)
        _git(["commit", "-q", "-m", "fixture: event schema before regression"], cwd=self.root)
        ensure_tools_binding(self.tools_dir, workspace_root=self.root)
        set_profile("strict", operator_approval_ref="test:native-spine-round", base_dir=self.tools_dir)
        plan_id = "plan-1"
        body = {
            "schema_version": 1, "title": "Preserve the actual event schema contract",
            "summary": "A normal source comparison must inform the next plan decision.",
            "affected_surfaces": [{"paths": [source_path, schema_path]}],
            "key_changes": ["Preserve the declared event and its schema relationship."],
            "validation_commands": [], "evidence_refs": [source_path + ":2"],
        }
        started = start_plan(plan_id=plan_id, initial_revision_id="rev-0",
                             plan_content=body, base_dir=self.tools_dir)
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        self.assertEqual(plan_status(plan_id=plan_id, base_dir=self.tools_dir)["state"], "CRITIQUED")
        before_plan = (self.tools_dir / "plans/events.jsonl").read_bytes()
        baseline = take_baseline(plan_id=plan_id, cycle_id="cyc-native-repair-baseline",
                                 workspace_root=self.root, base_dir=self.tools_dir)
        self.assertEqual(baseline["invariant_measurements"]["event_contracts"]["measurements"]["missing_schema_identities"], [])
        schema.unlink()
        _git(["add", schema_path], cwd=self.root)
        _git(["commit", "-q", "-m", "fixture: remove one required schema"], cwd=self.root)
        current_sha = _git(["rev-parse", "HEAD"], cwd=self.root).stdout.strip()
        self.assertEqual(subprocess.check_output(["git", "status", "--porcelain"], cwd=self.root), b"")
        measured = take_postcheck(plan_id=plan_id, cycle_id="cyc-native-repair-regression",
                                  workspace_root=self.root, base_dir=self.tools_dir)
        identity = source_path + "::AlphaEvent"
        self.assertEqual(measured["regression_count"], 1)
        self.assertEqual(measured["baseline_hash"], baseline["baseline_hash"])
        self.assertEqual(measured["postcheck_measurements"]["event_contracts"]["source"], "static:_check_event_contracts")
        self.assertEqual(measured["postcheck_measurements"]["event_contracts"]["measurements"]["missing_schema_identities"], [identity])
        spine_rows = [row for row in read_governance_rows(self.tools_dir / "governance.jsonl", base_dir=self.tools_dir)
                      if row.get("kind", "").startswith("architecture_spine_")
                      and row.get("details", {}).get("plan_id") == plan_id]
        self.assertEqual([row["kind"] for row in spine_rows], ["architecture_spine_baseline", "architecture_spine_regression"])
        self.assertEqual(spine_rows[-1]["details"], measured)
        self.assertEqual((self.tools_dir / "plans/events.jsonl").read_bytes(), before_plan)
        outcome = advance_plan_rounds(plan_id=plan_id, base_dir=self.tools_dir,
                                      workspace_root=self.root, max_rounds=5)
        # First expected RED: the actual measured failure currently leaves
        # this risk-free native plan eligible for terminal convergence.
        self.assertEqual(outcome["status"], "primary_revision_requested", outcome)
        self.assertEqual(plan_status(plan_id=plan_id, base_dir=self.tools_dir)["state"], "CRITIQUED")
        self.assertEqual((self.tools_dir / "plans/events.jsonl").read_bytes(), before_plan)
        native_requests = load_declared_jsonl(self.tools_dir / "agent-invocations/requests.jsonl",
                                              expected_surface="agent_invocation_requests")
        self.assertEqual(len(native_requests), 1)
        request = native_requests[0]
        self.assertEqual((request["role"], request["convergence_id"], request["round_number"]), ("primary_plan", plan_id, 2))
        self.assertEqual(request["target_sha"], current_sha)
        self.assertEqual(request["plan_revision_hash"], started["event"]["payload"]["content_hash"])
        native = invocation_owner.verify_invocation_context_binding(
            request_id=request["request_id"], context_hash=request["context_hash"],
            prompt_hash=request["prompt_hash"], base_dir=self.tools_dir,
        )
        self.assertEqual(native["prompt"]["prompt_text"], invocation_owner.render_invocation_prompt(request))
        proposed = json.loads(request["suggested_prompt"])
        # Proposed additive field in the existing controller's JSON prompt;
        # its facts must come from the same actual native observation.
        obligation = proposed["architecture_spine"]
        self.assertEqual(obligation["baseline_hash"], baseline["baseline_hash"])
        self.assertEqual(obligation["postcheck_ledger_hash"], spine_rows[-1]["ledger_hash"])
        self.assertEqual(obligation["regressions"], [row for row in measured["drifts"] if row["direction"] == "regression"])
        self.assertEqual(proposed["plan_id"], plan_id)
        self.assertEqual(proposed["latest_revision"]["content_hash"], request["plan_revision_hash"])
        before_requests = (self.tools_dir / "agent-invocations/requests.jsonl").read_bytes()
        again = advance_plan_rounds(plan_id=plan_id, base_dir=self.tools_dir,
                                    workspace_root=self.root, max_rounds=5)
        self.assertEqual(again["status"], "primary_revision_requested")
        self.assertEqual((self.tools_dir / "agent-invocations/requests.jsonl").read_bytes(), before_requests)
        self.assertEqual((self.tools_dir / "plans/events.jsonl").read_bytes(), before_plan)

    def _native_spine_evaluation_fixture(self, *, risks=None):
        from aria_kernel.architecture_spine_gate import take_baseline
        source = self.root / "libs/event-contracts/src/ordinary-events.ts"
        schema = self.root / "libs/event-contracts/src/schemas/alpha_event.json"
        schema.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("interface BaseEvent { eventId: string; }\nexport interface AlphaEvent extends BaseEvent {}\n", encoding="utf-8")
        schema.write_text('{"type":"object"}\n', encoding="utf-8")
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [] if risks is None else risks)
        baseline = take_baseline(plan_id="plan-1", cycle_id="cyc-evaluation-baseline",
                                 workspace_root=self.root, base_dir=self.tools_dir)
        self.assertEqual(baseline["invariant_measurements"]["event_contracts"]["measurements"]["missing_schema_identities"], [])
        return schema, baseline

    def test_native_baseline_without_postcheck_is_unavailable(self):
        self._native_spine_evaluation_fixture()
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        payload = result["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("architecture_spine_unavailable:postcheck_missing", payload["reason_codes"])
        gate = next(item for item in payload["gate_decisions"] if item["gate"] == "architecture_spine")
        self.assertEqual(gate["status"], "unavailable")
        self.assertIsNone(gate["postcheck_ledger_hash"])
        self.assertNotIn("regressions", gate)
        self.assertFalse((self.tools_dir / "agent-invocations/requests.jsonl").exists())

    def test_native_replaced_spine_anchor_cannot_be_converged(self):
        from aria_kernel.architecture_spine_gate import take_baseline, take_postcheck
        schema, baseline = self._native_spine_evaluation_fixture()
        schema.unlink()
        failed = take_postcheck(plan_id="plan-1", cycle_id="cyc-evaluation-failed",
                               workspace_root=self.root, base_dir=self.tools_dir)
        self.assertEqual(failed["regression_count"], 1)
        replacement = take_baseline(plan_id="plan-1", cycle_id="cyc-explicit-replacement",
                                    workspace_root=self.root, base_dir=self.tools_dir)
        self.assertNotEqual(replacement["baseline_hash"], baseline["baseline_hash"])
        before = (self.tools_dir / "governance.jsonl").read_bytes()
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(result["event"]["payload"]["terminal_state"], "HUMAN_REQUIRED")
        self.assertIn("architecture_spine_unavailable:baseline_anchor_unavailable", result["event"]["payload"]["reason_codes"])
        self.assertEqual((self.tools_dir / "governance.jsonl").read_bytes(), before)
        self.assertFalse((self.tools_dir / "agent-invocations/requests.jsonl").exists())

    def test_native_spine_cap_and_critical_review_keep_human_refusal(self):
        from aria_kernel.architecture_spine_gate import take_postcheck
        original_tools = self.tools_dir
        try:
            for case, cap, risks, expected in (
                ("cap", 1, [], "max_rounds_reached"),
                ("critical", 5, [self.risk("security", "CRITICAL")], "critical_risks_present"),
            ):
                with self.subTest(case=case):
                    self.tools_dir = original_tools.parent / ("native-refusal-" + case)
                    schema, _baseline = self._native_spine_evaluation_fixture(risks=risks)
                    schema.unlink()
                    failed = take_postcheck(plan_id="plan-1", cycle_id="cyc-native-" + case,
                                           workspace_root=self.root, base_dir=self.tools_dir)
                    self.assertEqual(failed["regression_count"], 1)
                    result = evaluate_plan(plan_id="plan-1", round_number=1, max_rounds=cap,
                                           base_dir=self.tools_dir)
                    self.assertEqual(result["event"]["payload"]["terminal_state"], "HUMAN_REQUIRED")
                    self.assertIn(expected, result["event"]["payload"]["reason_codes"])
                    self.assertIn("architecture_spine_regression", result["event"]["payload"]["reason_codes"])
                    self.assertFalse((self.tools_dir / "agent-invocations/requests.jsonl").exists())
        finally:
            self.tools_dir = original_tools

    def test_native_legal_revision_retains_obligation_until_clean_postcheck(self):
        from aria_kernel.architecture_spine_gate import take_postcheck
        from aria_kernel.governance_reader import read_governance_rows
        schema, baseline = self._native_spine_evaluation_fixture()
        original_plan_hash = plan_status(plan_id="plan-1", base_dir=self.tools_dir)["latest_revision"]["content_hash"]
        schema.unlink()
        failed = take_postcheck(plan_id="plan-1", cycle_id="cyc-native-revision-failed",
                               workspace_root=self.root, base_dir=self.tools_dir)
        self.assertEqual(failed["regression_count"], 1)
        first = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(first["status"], "next_round_required")
        revision = self.structured_revision(
            "rev-1", summary="Restore the existing event schema and validate the same obligation.",
        )
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        self.assertEqual(state["state"], "REVISED")
        self.assertEqual(revision["event"]["payload"]["parent_revision_hash"], original_plan_hash)
        self.assertEqual(state["latest_revision"]["revision_id"], revision["event"]["payload"]["revision_id"])
        self.request_round(2, "farm-expert")
        self.critique("farm-expert", [])
        second = evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools_dir)
        self.assertEqual(second["status"], "next_round_required")
        self.assertEqual(second["architecture_spine"], first["architecture_spine"])
        schema.write_text('{"type":"object"}\n', encoding="utf-8")
        repaired = take_postcheck(plan_id="plan-1", cycle_id="cyc-native-revision-repaired",
                                  workspace_root=self.root, base_dir=self.tools_dir)
        self.assertEqual(repaired["regression_count"], 0)
        self.assertEqual(repaired["baseline_hash"], baseline["baseline_hash"])
        evaluated = evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools_dir)
        self.assertEqual(evaluated["event"]["payload"]["terminal_state"], "CONVERGED")
        gate = next(item for item in evaluated["event"]["payload"]["gate_decisions"] if item["gate"] == "architecture_spine")
        rows = [row for row in read_governance_rows(self.tools_dir / "governance.jsonl", base_dir=self.tools_dir)
                if row.get("kind", "").startswith("architecture_spine_")]
        self.assertEqual([row["kind"] for row in rows], ["architecture_spine_baseline", "architecture_spine_regression", "architecture_spine_postcheck"])
        self.assertEqual(gate["postcheck_ledger_hash"], rows[-1]["ledger_hash"])
        self.assertEqual(gate["status"], "clean")
        self.assertEqual(gate["regressions"], [])
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["latest_revision"]["revision_id"], "rev-1")

    def test_native_other_plan_comparison_does_not_enroll_this_plan(self):
        from aria_kernel.architecture_spine_gate import take_baseline, take_postcheck
        source = self.root / "libs/event-contracts/src/ordinary-events.ts"
        schema = self.root / "libs/event-contracts/src/schemas/alpha_event.json"
        schema.parent.mkdir(parents=True)
        source.write_text("interface BaseEvent { eventId: string; }\nexport interface AlphaEvent extends BaseEvent {}\n")
        schema.write_text('{"type":"object"}\n')
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        take_baseline(plan_id="other-plan", cycle_id="cyc-other-baseline", workspace_root=self.root, base_dir=self.tools_dir)
        schema.unlink()
        failed = take_postcheck(plan_id="other-plan", cycle_id="cyc-other-regression", workspace_root=self.root, base_dir=self.tools_dir)
        self.assertEqual(failed["regression_count"], 1)
        result = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(result["event"]["payload"]["terminal_state"], "CONVERGED")
        self.assertNotIn("architecture_spine", {item["gate"] for item in result["event"]["payload"]["gate_decisions"]})

    def test_native_drainer_carries_same_spine_observation_to_primary_request(self) -> None:
        import subprocess
        from aria_kernel import agent_invocations as invocation_owner
        from aria_kernel.architecture_spine_gate import take_baseline, take_postcheck
        from aria_kernel.governance_reader import read_governance_rows
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.plan_round_controller import advance_plan_rounds
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import _git, make_local_git_repo

        source_path = "libs/event-contracts/src/ordinary-events.ts"
        schema_path = "libs/event-contracts/src/schemas/alpha_event.json"
        source = self.root / source_path
        schema = self.root / schema_path
        schema.parent.mkdir(parents=True)
        source.write_text(
            "interface BaseEvent { eventId: string; }\n"
            "export interface AlphaEvent extends BaseEvent {}\n", encoding="utf-8",
        )
        schema.write_text('{"type":"object"}\n', encoding="utf-8")
        (self.root / ".gitignore").write_text("aria-debts/\n", encoding="utf-8")
        selected_root = Path(__file__).resolve().parents[2]
        agent_path = ".claude/agents/aria-primary-planner.md"
        declared_agent = (selected_root / agent_path).read_bytes()
        (self.root / agent_path).write_bytes(declared_agent)
        self.assertEqual(make_local_git_repo(self.root.parent, name=self.root.name, initial_commit=False), self.root)
        _git(["add", "."], cwd=self.root)
        _git(["commit", "-q", "-m", "fixture: event schema before regression"], cwd=self.root)
        ensure_tools_binding(self.tools_dir, workspace_root=self.root)
        set_profile("strict", operator_approval_ref="test:native-spine-round", base_dir=self.tools_dir)
        plan_id = "plan-1"
        body = {
            "schema_version": 1, "title": "Preserve the actual event schema contract",
            "summary": "A normal source comparison must inform the next plan decision.",
            "affected_surfaces": [{"paths": [source_path, schema_path]}],
            "key_changes": ["Preserve the declared event and its schema relationship."],
            "validation_commands": [], "evidence_refs": [source_path + ":2"],
        }
        started = start_plan(plan_id=plan_id, initial_revision_id="rev-0",
                             plan_content=body, base_dir=self.tools_dir)
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        self.assertEqual(plan_status(plan_id=plan_id, base_dir=self.tools_dir)["state"], "CRITIQUED")
        before_plan = (self.tools_dir / "plans/events.jsonl").read_bytes()
        baseline = take_baseline(plan_id=plan_id, cycle_id="cyc-native-repair-baseline",
                                 workspace_root=self.root, base_dir=self.tools_dir)
        self.assertEqual(baseline["invariant_measurements"]["event_contracts"]["measurements"]["missing_schema_identities"], [])
        schema.unlink()
        _git(["add", schema_path], cwd=self.root)
        _git(["commit", "-q", "-m", "fixture: remove one required schema"], cwd=self.root)
        current_sha = _git(["rev-parse", "HEAD"], cwd=self.root).stdout.strip()
        self.assertEqual(subprocess.check_output(["git", "status", "--porcelain"], cwd=self.root), b"")
        measured = take_postcheck(plan_id=plan_id, cycle_id="cyc-native-repair-regression",
                                  workspace_root=self.root, base_dir=self.tools_dir)
        identity = source_path + "::AlphaEvent"
        self.assertEqual(measured["regression_count"], 1)
        self.assertEqual(measured["baseline_hash"], baseline["baseline_hash"])
        self.assertEqual(measured["postcheck_measurements"]["event_contracts"]["source"], "static:_check_event_contracts")
        self.assertEqual(measured["postcheck_measurements"]["event_contracts"]["measurements"]["missing_schema_identities"], [identity])
        spine_rows = [row for row in read_governance_rows(self.tools_dir / "governance.jsonl", base_dir=self.tools_dir)
                      if row.get("kind", "").startswith("architecture_spine_")
                      and row.get("details", {}).get("plan_id") == plan_id]
        self.assertEqual([row["kind"] for row in spine_rows], ["architecture_spine_baseline", "architecture_spine_regression"])
        self.assertEqual(spine_rows[-1]["details"], measured)
        self.assertEqual((self.tools_dir / "plans/events.jsonl").read_bytes(), before_plan)
        from aria_kernel.convergence_drainer import run_convergence_drainer
        arguments = dict(cycle_id="cyc-native-spine-drain", base_dir=self.tools_dir,
                         workspace_root=self.root, plan_id=plan_id, plan_seed=body,
                         must_satisfy=[{"id": "preserve-event", "description": "Preserve the actual event contract."}],
                         evidence_refs=[source_path + ":2"], allowed_scope=[source_path, schema_path], max_rounds=5)
        outcome = run_convergence_drainer(**arguments)
        self.assertEqual(outcome["arbiter_verdict"], "in_progress", outcome)
        self.assertEqual(plan_status(plan_id=plan_id, base_dir=self.tools_dir)["state"], "CRITIQUED")
        requests = load_declared_jsonl(self.tools_dir / "agent-invocations/requests.jsonl",
                                      expected_surface="agent_invocation_requests")
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual((request["role"], request["round_number"], request["target_sha"]), ("primary_plan", 2, current_sha))
        obligations = [item for item in request["must_satisfy"] if item.get("kind") == "architecture_spine_regression"]
        self.assertEqual(len(obligations), 1)
        marker = "Resolve the native comparison obligation: "
        self.assertTrue(obligations[0]["description"].startswith(marker))
        captured = json.loads(obligations[0]["description"][len(marker):])
        self.assertEqual(captured["postcheck_ledger_hash"], spine_rows[-1]["ledger_hash"])
        self.assertEqual(captured["baseline_hash"], baseline["baseline_hash"])
        self.assertEqual(captured["regressions"], [item for item in measured["drifts"] if item["direction"] == "regression"])
        native = invocation_owner.verify_invocation_context_binding(
            request_id=request["request_id"], context_hash=request["context_hash"],
            prompt_hash=request["prompt_hash"], base_dir=self.tools_dir)
        self.assertIn(spine_rows[-1]["ledger_hash"], native["prompt"]["prompt_text"])
        request_bytes = (self.tools_dir / "agent-invocations/requests.jsonl").read_bytes()
        again = run_convergence_drainer(**{**arguments, "cycle_id": "cyc-native-spine-drain-again"})
        self.assertEqual(again["arbiter_verdict"], "in_progress")
        self.assertTrue(again["resumed_from_persistence"])
        self.assertEqual((self.tools_dir / "agent-invocations/requests.jsonl").read_bytes(), request_bytes)
        self.assertEqual((self.tools_dir / "plans/events.jsonl").read_bytes(), before_plan)

    # ------------------------------------------------------------------
    # The plan contract at submission and at the CONVERGED gate.
    #
    # Trial ten (2026-09-12, plan flow-85199a4b5051d7b27f16): the first plan
    # the native chain drove to CONVERGED could not be staged — no
    # architectural_tier, and a plan-authored `npx nx run shell:test` no
    # operator had declared. Nothing before staging had asked for either.
    # ------------------------------------------------------------------

    def _challenger_with(self, **overrides):
        state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
        plan = {**self.plan(), "title": "Challenger Plan", **overrides}
        for key in [key for key, value in overrides.items() if value is None]:
            plan.pop(key)
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

    def test_submission_refuses_a_challenger_without_an_architectural_tier(self):
        self.start()
        before = len(load_jsonl(events_path(self.tools_dir)))
        with self.assertRaisesRegex(GovernanceError, "plan_architectural_tier_missing"):
            self._challenger_with(architectural_tier=None)
        self.assertEqual(len(load_jsonl(events_path(self.tools_dir))), before)

    def test_submission_refuses_a_tier_outside_the_change_ledger_vocabulary(self):
        self.start()
        with self.assertRaisesRegex(GovernanceError, "plan_architectural_tier_invalid:5"):
            self._challenger_with(architectural_tier=5)

    def test_submission_refuses_an_undeclared_validation_command_by_name(self):
        self.start()
        with self.assertRaisesRegex(
            GovernanceError, "plan_validation_command_not_declared:npx nx run shell:test",
        ):
            self._challenger_with(validation_commands=[{"cmd": "npx nx run shell:test"}])

    def test_submission_accepts_tier_two_with_canonical_and_recipe_commands(self):
        from aria_kernel.experiment import register_recipe

        register_recipe(
            recipe_id="kernel-unit-suite",
            command="python3 -m unittest discover aria-kernel -p '*test*.py'",
            timeout_ms=1_500_000, deterministic=True, base_dir=self.tools_dir,
        )
        self.start()
        submitted = self._challenger_with(
            architectural_tier=2,
            validation_commands=[
                {"cmd": "npx nx affected --target=lint"},
                {"cmd": "nx affected --target=test"},
                {"recipe_id": "kernel-unit-suite"},
                # A registered recipe may also be declared by its exact command.
                {"cmd": "python3 -m unittest discover aria-kernel -p '*test*.py'"},
            ],
        )
        self.assertTrue(submitted["event_appended"])
        self.assertEqual(plan_status(plan_id="plan-1", base_dir=self.tools_dir)["state"], "CHALLENGER_DRAFTED")

    def test_a_structured_revision_is_judged_by_the_plan_contract(self):
        # The primary's round-2+ body is the one that converges; before this
        # it was never validated as a plan at all (only `content` non-empty).
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [self.risk("schema", "MEDIUM")])
        with self.assertRaisesRegex(GovernanceError, "plan_architectural_tier_missing"):
            body = self.plan()
            body.pop("architectural_tier")
            state = plan_status(plan_id="plan-1", base_dir=self.tools_dir)
            record_revision(
                plan_id="plan-1",
                revision={
                    "revision_id": "rev-1", "round": state["current_round"],
                    "content_hash": content_hash(body),
                    "parent_revision_hash": state["latest_revision"]["content_hash"],
                    "content": json.dumps(body, sort_keys=True), "addresses_review_risk_ids": [],
                },
                base_dir=self.tools_dir,
            )
        with self.assertRaisesRegex(GovernanceError, "plan content missing required field"):
            record_revision(
                plan_id="plan-1",
                revision={
                    "revision_id": "rev-1", "round": 1,
                    "content_hash": content_hash({"title": "not a plan"}),
                    "parent_revision_hash": plan_status(plan_id="plan-1", base_dir=self.tools_dir)["latest_revision"]["content_hash"],
                    "content": json.dumps({"title": "not a plan"}), "addresses_review_risk_ids": [],
                },
                base_dir=self.tools_dir,
            )
        self.assertTrue(self.structured_revision("rev-1", summary="revised")["event_appended"])

    def test_a_historical_tierless_plan_started_still_folds(self):
        # The fold re-validates every recorded plan_started; the contract
        # binds the COMMAND path only, so recorded history keeps replaying.
        from aria_kernel.plan_convergence import _idempotency_key

        legacy = {**self.plan(), "validation_commands": [{"cmd": "python3 -m unittest discover"}]}
        legacy.pop("architectural_tier")
        append_declared_fixture(
            events_path(self.tools_dir),
            {
                "schema_version": 1, "event_id": "evt-legacy-1", "event_type": "plan_started",
                "plan_id": "plan-1", "recorded_at": "2026-05-01T00:00:00+00:00",
                "idempotency_key": _idempotency_key("plan-1", "start", legacy),
                "payload": {"plan_content": legacy, "content_hash": content_hash(legacy),
                            "initial_revision_id": "rev-0"},
            },
            expected_surface="plan_convergence_events",
        )
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools_dir)
        self.assertEqual(state["state"], "DRAFT")
        self.assertEqual(state["plan_started"]["plan_content"], legacy)

    def test_evaluate_plan_records_the_plan_contract_gate_row(self):
        # A kernel seed carries no tier: round one cannot converge on it, and
        # the gate row names why; the primary's structured revision with the
        # claim converges, and the row records that it passed.
        seed = self.plan()
        seed.pop("architectural_tier")
        seed["validation_commands"] = [{"cmd": "npx nx run shell:test"}]
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=seed, base_dir=self.tools_dir)
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        first = evaluate_plan(plan_id="plan-1", round_number=1, base_dir=self.tools_dir)
        self.assertEqual(first["status"], "next_round_required")
        self.assertIn("plan_contract_incomplete", first["reason_codes"])
        gate = next(item for item in first["gate_decisions"] if item["gate"] == "plan_contract_complete")
        self.assertFalse(gate["passed"])
        self.assertEqual(
            [reason.split(":", 1)[0] for reason in gate["reasons"]],
            ["plan_architectural_tier_missing", "plan_validation_command_not_declared"],
        )
        self.assertTrue(self.structured_revision("rev-1", summary="the primary claims tier 2")["event_appended"])
        self.request_round(2, "farm-expert")
        self.critique("farm-expert", [])
        second = evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools_dir)
        self.assertEqual(second["event"]["payload"]["terminal_state"], "CONVERGED")
        recorded = next(item for item in second["event"]["payload"]["gate_decisions"] if item["gate"] == "plan_contract_complete")
        self.assertEqual(recorded, {"gate": "plan_contract_complete", "passed": True, "reasons": []})

    def test_a_prose_revision_cannot_converge_because_no_body_can_be_staged(self):
        self.start()
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [self.risk("schema", "MEDIUM")])
        self.revision("rev-1", "round one revision in prose")
        self.request_round(2, "farm-expert")
        self.critique("farm-expert", [])
        result = evaluate_plan(plan_id="plan-1", round_number=2, base_dir=self.tools_dir)
        self.assertEqual(result["status"], "next_round_required")
        gate = next(item for item in result["gate_decisions"] if item["gate"] == "plan_contract_complete")
        self.assertEqual(gate["reasons"], ["plan_body_unavailable:plan_body_unavailable_for_revision"])

    def test_the_gate_at_the_round_cap_escalates_to_human_required(self):
        seed = self.plan()
        seed.pop("architectural_tier")
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=seed, base_dir=self.tools_dir)
        self.request_round(1, "farm-expert")
        self.critique("farm-expert", [])
        result = evaluate_plan(plan_id="plan-1", round_number=1, max_rounds=1, base_dir=self.tools_dir)
        payload = result["event"]["payload"]
        self.assertEqual(payload["terminal_state"], "HUMAN_REQUIRED")
        self.assertEqual(sorted(payload["reason_codes"]), ["max_rounds_reached", "plan_contract_incomplete"])


if __name__ == "__main__":
    unittest.main()
