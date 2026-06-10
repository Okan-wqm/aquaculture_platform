from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import (
    approve_agent_pr,
    detect_capability_gaps,
    draft_agent_from_gap,
    evaluate_genesis_sandbox,
    generate_task_candidates,
    latest_agent_priors,
    list_calibration_recommendations,
    map_agent_priors,
    recommend_calibration,
    verify_integrity,
)
from aria_kernel.agent_genesis import list_agent_drafts
from aria_kernel.feedback_store import record_operator_feedback
from aria_kernel.ledger import append_jsonl as _append_jsonl
from aria_kernel.tool_health import runs_path
from aria_kernel.tool_registry import register_tool


def append_jsonl(path, record):
    return _append_jsonl(path, record, test_fixture=True)


class AgentGenesisFoundationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        (self.root / ".claude" / "agents").mkdir(parents=True)
        (self.root / ".claude" / "agents" / "auth-security-expert.md").write_text(
            "\n".join(
                [
                    "---",
                    "name: auth-security-expert",
                    "description: Reviews auth security boundaries.",
                    "---",
                    "",
                    "Owns `apps/auth-service/**` and `libs/backend-common/src/security/**`.",
                    "Findings include severity.",
                    "",
                ],
            ),
            encoding="utf-8",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_agent_priors_map_extracts_existing_agent_ownership(self):
        payload = map_agent_priors(workspace_root=self.root, base_dir=self.tools_dir, cycle_id="cycle-agents")
        self.assertEqual(payload["agent_count"], 1)
        agent = payload["agents"][0]
        self.assertEqual(agent["name"], "auth-security-expert")
        self.assertIn("apps/auth-service/**", agent["scope_globs"])
        self.assertEqual(latest_agent_priors(base_dir=self.tools_dir)["agent_count"], 1)

    def test_capability_gap_prefers_existing_agent_extension_when_owner_exists(self):
        map_agent_priors(workspace_root=self.root, base_dir=self.tools_dir)
        append_jsonl(
            runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "run_id": "run-shadow-auth",
                "tool_id": "security-boundary-adapter",
                "cycle_id": "cycle-gap",
                "status": "ok",
                "read_paths": ["apps/auth-service/src/auth.controller.ts"],
                "emitted_findings": [],
                "runner": {"raw_findings_count": 5},
            },
        )
        payload = detect_capability_gaps(cycle_id="cycle-gap", base_dir=self.tools_dir)
        self.assertEqual(payload["gap_count"], 1)
        gap = payload["gaps"][0]
        self.assertEqual(gap["gap_type"], "existing_agent_extension")
        self.assertEqual(gap["recommended_action"], "extend_existing_agent")
        self.assertIn("auth-security-expert", gap["related_existing_agents"])

    def test_agent_genesis_drafts_sandbox_and_approval_for_unowned_gap(self):
        map_agent_priors(workspace_root=self.root, base_dir=self.tools_dir)
        append_jsonl(
            runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "run_id": "run-shadow-new",
                "tool_id": "new-pattern-adapter",
                "cycle_id": "cycle-new-gap",
                "status": "ok",
                "read_paths": ["libs/new-pattern/src/check.ts", "libs/new-pattern/src/other.ts", "libs/new-pattern/src/third.ts"],
                "emitted_findings": [],
                "runner": {"raw_findings_count": 8},
            },
        )
        gap = detect_capability_gaps(cycle_id="cycle-new-gap", base_dir=self.tools_dir)["gaps"][0]
        self.assertEqual(gap["recommended_action"], "draft_new_aria_agent")
        draft = draft_agent_from_gap(gap_id=gap["gap_id"], base_dir=self.tools_dir)
        self.assertEqual(draft["status"], "draft_shadow")
        self.assertTrue(draft["target_path"].startswith(".claude/agents/aria-"))
        self.assertTrue(Path(draft["draft_path"]).exists())
        self.assertEqual(len(draft["draft"]["validation_fixtures"]), 3)

        # Plan 022 §H-4 — synthetic fixture_results (without execution
        # provenance) are forbidden in default mode. This test exercises
        # the genesis flow with synthetic input so opt into
        # synthetic_test_mode=True; real-execution provenance is
        # exercised by test_agent_genesis_h4_real_exec.py.
        sandbox = evaluate_genesis_sandbox(
            draft_id=draft["draft_id"],
            fixture_results=[
                {"name": "true-positive", "status": "pass"},
                {"name": "false-positive-guard", "status": "pass"},
                {"name": "scope-violation-guard", "status": "pass"},
            ],
            base_dir=self.tools_dir,
            synthetic_test_mode=True,
        )
        self.assertEqual(sandbox["decision"], "pass")
        # Plan 026R §E.2 — synthetic-sandbox approve_agent_pr now
        # requires operator_synthetic_override=True; this test
        # exercises the synthetic-fixture happy path.
        approved = approve_agent_pr(
            draft_id=draft["draft_id"],
            operator_approval_ref="operator:test",
            base_dir=self.tools_dir,
            operator_synthetic_override=True,
        )
        self.assertEqual(approved["status"], "approved_for_agent_pr")
        self.assertEqual(list_agent_drafts(base_dir=self.tools_dir)[-1]["blocked_by"], [])

    def test_capability_gaps_become_task_candidates(self):
        append_jsonl(
            runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "run_id": "run-shadow-task",
                "tool_id": "task-gap-adapter",
                "cycle_id": "cycle-task-gap",
                "status": "ok",
                "read_paths": ["libs/task-gap/src/a.ts", "libs/task-gap/src/b.ts", "libs/task-gap/src/c.ts"],
                "emitted_findings": [],
                "runner": {"raw_findings_count": 4},
            },
        )
        detect_capability_gaps(cycle_id="cycle-task-gap", base_dir=self.tools_dir)
        tasks = generate_task_candidates(cycle_id="cycle-task-gap", base_dir=self.tools_dir)["tasks"]
        self.assertTrue(any(task["source_authority"] == "capability_gap" for task in tasks))

    def test_calibration_recommends_tool_review_from_feedback_and_metrics(self):
        register_tool(
            {
                "tool_id": "calibrated-tool",
                "kind": "adapter",
                "version": "1.0.0",
                "status": "SHADOW",
                "declared_scope": ["libs/**/*.ts"],
                "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
                "fixture_set": "fixtures/calibrated-tool",
                "health_thresholds": {"max_cost_units": 10},
                "allowed_read_globs": ["libs/**/*.ts"],
                "forbidden_read_globs": [],
                "claim_types": ["architecture"],
                "owner": "platform",
                "runner": {
                    "type": "subprocess",
                    "argv": ["python3", "-m", "unittest", "--help"],
                    "cwd": ".",
                    "timeout_ms": 1000,
                    "stdin_json": False,
                },
                "schema_version": 1,
            },
            base_dir=self.tools_dir,
        )
        append_jsonl(
            runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "run_id": "run-budget",
                "tool_id": "calibrated-tool",
                "cycle_id": "cycle-calibration",
                "status": "ok",
                "cost_units": 20,
                "evidence_validation": {"valid": True},
                "operator_feedback_refs": [],
                "runner": {"raw_findings_count": 0},
            },
        )
        record_operator_feedback(
            tool_id="capability_gap",
            run_id="run-1",
            finding_id="finding-1",
            verdict="true_positive",
            severity="medium",
            note="valid",
            base_dir=self.tools_dir,
        )
        record_operator_feedback(
            tool_id="capability_gap",
            run_id="run-2",
            finding_id="finding-2",
            verdict="true_positive",
            severity="medium",
            note="valid",
            base_dir=self.tools_dir,
        )
        payload = recommend_calibration(cycle_id="cycle-calibration", base_dir=self.tools_dir)
        self.assertTrue(payload["tool_recommendations"])
        self.assertTrue(payload["pressure_weight_recommendations"])
        self.assertEqual(list_calibration_recommendations(base_dir=self.tools_dir)[-1]["status"], "recommendation_only")
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])


if __name__ == "__main__":
    unittest.main()
