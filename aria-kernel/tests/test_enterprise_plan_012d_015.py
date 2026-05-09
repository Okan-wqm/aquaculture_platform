from __future__ import annotations

import tempfile
import subprocess
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel import (
    approve_proposal,
    compare_validation_groups,
    evaluate_validation_gate,
    gate_apply_action,
    generate_adapter_calibration_report,
    generate_observability_dashboard,
    list_generated_diff_packets,
    open_pr_for_action,
    plan_apply_worktree,
    plan_pr_lifecycle,
    plan_pr_split,
    prepare_agent_pr_lane,
    record_code_change_plan,
    record_cycle_metrics,
    record_generated_diff_packet,
    record_proposal,
    record_run,
    register_tool,
    run_validation_commands,
    verify_integrity,
)
from aria_kernel.agent_genesis import approve_agent_pr, evaluate_genesis_sandbox
from aria_kernel.ledger import append_jsonl
from aria_kernel.fixture_runner import fixture_runs_path, tool_manifest_hash
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import get_tool
from aria_kernel.tool_registry import GovernanceError


class EnterprisePlan012DTo015Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        subprocess.run(["git", "init"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "aria@example.invalid"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "ARIA"], cwd=self.root, check=True)
        (self.root / "README.md").write_text("fixture\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.root, check=True, capture_output=True)
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        # Plan 020 Phase 1.B — Enterprise 012D->015 exercises the full
        # apply_action -> validation gate -> open_pr_for_action pipeline,
        # including the assertion that PR open without a validation gate
        # raises. The runtime profile gate would otherwise short-circuit
        # the test by raising profile_violation FIRST. Setting strict
        # preserves the original assertion target (missing validation gate).
        set_profile(
            "strict",
            operator_approval_ref="test:plan-020-phase-1.B:enterprise-012d",
            base_dir=self.tools_dir,
            set_by="test-fixture",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_validation_gate_is_required_before_pr_open(self):
        proposal = record_proposal(
            kind="test_gap",
            title="Add focused regression test",
            problem="A validated task needs a gated worktree lane",
            evidence=["apps/api/src/app.ts"],
            validation_command="python3 -m unittest --help",
            base_dir=self.tools_dir,
        )
        approve_proposal(
            proposal_id=proposal["proposal_id"],
            operator_approval_ref="approval:012d",
            base_dir=self.tools_dir,
        )
        plan_apply_worktree(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        with self.assertRaises(GovernanceError):
            open_pr_for_action(
                proposal_id=proposal["proposal_id"],
                workspace_root=self.root,
                base_dir=self.tools_dir,
                dry_run=True,
            )

        baseline = run_validation_commands(
            commands=["python3 -m unittest --help"],
            workspace_root=self.root,
            validation_plan_id="baseline",
            base_dir=self.tools_dir,
        )
        candidate = run_validation_commands(
            commands=["python3 -m unittest --help"],
            workspace_root=self.root,
            validation_plan_id=proposal["proposal_id"],
            base_dir=self.tools_dir,
        )
        comparison = compare_validation_groups(
            baseline_ref=baseline["ledger_hash"],
            worktree_ref=candidate["ledger_hash"],
            base_dir=self.tools_dir,
        )
        validation_gate = evaluate_validation_gate(
            comparison_ref=comparison["ledger_hash"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(validation_gate["status"], "ready_for_pr")

        # Plan 022 §H-1 — pass empty diff so suppression scan runs
        # without triggering the diff-required fail-closed branch.
        gated = gate_apply_action(
            proposal_id=proposal["proposal_id"],
            validation_comparison_ref=comparison["ledger_hash"],
            base_dir=self.tools_dir,
            diff_text="",
        )
        self.assertEqual(gated["status"], "ready_for_pr")
        pr = open_pr_for_action(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.root,
            base_dir=self.tools_dir,
            dry_run=True,
        )
        self.assertEqual(pr["event"], "pr_dry_run")
        self.assertIn("Validation Evidence", pr["body"])

    def test_generated_diff_packet_is_limited_to_code_change_plan_scope(self):
        plan = record_code_change_plan(
            proposal_id="proposal-scope",
            worktree_path=self.root.as_posix(),
            intended_files=["apps/api/src/app.ts"],
            allowed_globs=["apps/api/**"],
            pre_hashes={"apps/api/src/app.ts": "sha256:before"},
            post_hashes={"apps/api/src/app.ts": "sha256:after"},
            validation_refs=["validation:ok"],
            base_dir=self.tools_dir,
        )
        diff = "\n".join(
            [
                "diff --git a/apps/api/src/app.ts b/apps/api/src/app.ts",
                "--- a/apps/api/src/app.ts",
                "+++ b/apps/api/src/app.ts",
                "@@ -1 +1 @@",
                "-old",
                "+new",
            ],
        )
        packet = record_generated_diff_packet(
            code_change_plan_id=plan["code_change_plan_id"],
            unified_diff=diff,
            changed_files=["apps/api/src/app.ts"],
            rationale="Apply only the approved file change.",
            validation_commands=["python3 -m unittest --help"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(packet["status"], "ready_for_candidate_worktree")
        self.assertEqual(list_generated_diff_packets(base_dir=self.tools_dir)[-1]["generated_diff_packet_id"], packet["generated_diff_packet_id"])

        blocked = record_generated_diff_packet(
            code_change_plan_id=plan["code_change_plan_id"],
            unified_diff=diff.replace("apps/api/src/app.ts", "apps/billing-service/src/app.ts"),
            changed_files=["apps/billing-service/src/app.ts"],
            rationale="This should be blocked by intended scope.",
            validation_commands=["python3 -m unittest --help"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(blocked["status"], "blocked")
        self.assertIn("outside_code_change_plan:apps/billing-service/src/app.ts", blocked["blocked_by"])

    def test_adapter_calibration_report_marks_active_ready_only_after_gates(self):
        register_tool(
            {
                "schema_version": 1,
                "tool_id": "demo-adapter",
                "kind": "adapter",
                "version": "1.0.0",
                "status": "SHADOW",
                "declared_scope": "demo",
                "output_schema": {"required": ["findings", "observations", "read_paths"]},
                "fixture_set": "fixtures/demo",
                "health_thresholds": {"precision_min": 0.85},
                "allowed_read_globs": ["apps/api/**"],
                "forbidden_read_globs": [],
                "claim_types": ["demo"],
                "owner": "aria",
                "runner": {
                    "type": "subprocess",
                    "argv": ["python3", "-m", "unittest", "--help"],
                    "cwd": ".",
                    "timeout_ms": 1000,
                    "stdin_json": False,
                },
            },
            base_dir=self.tools_dir,
        )
        append_jsonl(
            fixture_runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "tool_id": "demo-adapter",
                "tool_version": "1.0.0",
                "tool_manifest_hash": tool_manifest_hash(get_tool("demo-adapter", base_dir=self.tools_dir)),
                "passed": True,
                "fixture_baseline_passed": True,
                "semantic_fixture_passed": True,
            },
        )
        for index in range(5):
            record_run(
                {
                    "schema_version": 1,
                    "run_id": f"run-{index}",
                    "tool_id": "demo-adapter",
                    "cycle_id": f"cycle-{index}",
                    "status": "ok",
                    "input_hash": "sha256:input",
                    "output_hash": "sha256:output",
                    "read_paths": ["apps/api/src/app.ts"],
                    "emitted_observations": [],
                    "emitted_findings": [],
                    "evidence_validation": {"valid": True},
                    "operator_feedback_refs": [{"kind": "true_positive", "severity": "medium"}],
                    "duration_ms": 1,
                    "cost_units": 0,
                    "runner": {"raw_findings_count": 0},
                },
                base_dir=self.tools_dir,
            )
        report = generate_adapter_calibration_report(
            tool_ids=["demo-adapter"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(report["status"], "active_ready")
        self.assertEqual(report["active_ready_count"], 1)

    def test_agent_genesis_pr_lane_blocks_existing_target(self):
        drafts_dir = self.tools_dir / "agent-genesis"
        drafts_dir.mkdir(parents=True)
        draft = {
            "schema_version": 1,
            "recorded_at": "2026-05-04T00:00:00+00:00",
            "gap_id": "gap-1",
            "draft_id": "draft-aria-demo",
            "status": "draft_shadow",
            "draft": {
                "name": "aria-demo",
                "purpose": "Demo",
                "scope_globs": ["apps/api/**"],
                "forbidden_globs": ["secrets/**"],
                "evidence_contract": "cite repo paths",
                "output_schema": {"required": ["findings", "read_paths"]},
                "validation_fixtures": [{"name": "a", "expected": "pass"}, {"name": "b", "expected": "pass"}, {"name": "c", "expected": "pass"}],
                "related_existing_agents": [],
            },
            "target_path": ".claude/agents/aria-demo.md",
        }
        append_jsonl(drafts_dir / "drafts.jsonl", draft)
        # Plan 022 §H-4 — synthetic fixture_results without execution
        # provenance require synthetic_test_mode=True opt-in.
        evaluate_genesis_sandbox(
            draft_id="draft-aria-demo",
            fixture_results=[{"status": "pass"}, {"status": "pass"}, {"status": "pass"}],
            base_dir=self.tools_dir,
            synthetic_test_mode=True,
        )
        approve_agent_pr(
            draft_id="draft-aria-demo",
            operator_approval_ref="approval:genesis",
            base_dir=self.tools_dir,
        )
        lane = prepare_agent_pr_lane(
            draft_id="draft-aria-demo",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(lane["status"], "ready_for_pr")

        target = self.root / ".claude" / "agents" / "aria-demo.md"
        target.parent.mkdir(parents=True)
        target.write_text("existing", encoding="utf-8")
        blocked = prepare_agent_pr_lane(
            draft_id="draft-aria-demo",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(blocked["status"], "blocked")
        self.assertIn("target_agent_already_exists", blocked["blocked_by"])

    def test_observability_and_pr_lifecycle_reports_are_recorded(self):
        first = record_cycle_metrics(
            cycle_id="cycle-1",
            phase_durations_ms={"discovery": 10, "validation": 20},
            artifact_count=3,
            status="ok",
            cost_units=1.5,
            base_dir=self.tools_dir,
        )
        second = record_cycle_metrics(
            cycle_id="cycle-2",
            phase_durations_ms={"discovery": 11, "validation": 30},
            artifact_count=4,
            status="partial",
            cost_units=2.0,
            base_dir=self.tools_dir,
        )
        dashboard = generate_observability_dashboard(
            cycle_id="cycle-2",
            base_dir=self.tools_dir,
        )
        self.assertEqual(first["total_duration_ms"], 30)
        self.assertEqual(second["total_duration_ms"], 41)
        self.assertEqual(dashboard["trend"]["duration_delta_ms"], 11)

        old = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        very_old = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
        lifecycle = plan_pr_lifecycle(
            open_prs=[
                {"number": 10, "updated_at": old, "title": "stale"},
                {"number": 11, "updated_at": very_old, "title": "close"},
            ],
            base_dir=self.tools_dir,
        )
        actions = {item["pr_number"]: item["action"] for item in lifecycle["actions"]}
        self.assertEqual(actions[10], "recommend_stale_comment")
        self.assertEqual(actions[11], "recommend_close")

        proposal = record_proposal(
            kind="test_gap",
            title="Split large change",
            problem="Large scope requires multiple PRs",
            evidence=["apps/api/src/app.ts"],
            validation_command="python3 -m unittest --help",
            base_dir=self.tools_dir,
        )
        split = plan_pr_split(
            proposal_id=proposal["proposal_id"],
            changed_files=["apps/api/src/a.ts", "apps/farm-service/src/b.ts"],
            max_files_per_pr=1,
            base_dir=self.tools_dir,
        )
        self.assertTrue(split["split_required"])
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])


if __name__ == "__main__":
    unittest.main()
