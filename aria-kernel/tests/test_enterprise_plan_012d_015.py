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
    open_pr_for_action,
    plan_apply_worktree,
    plan_pr_lifecycle,
    plan_pr_split,
    prepare_agent_pr_lane,
    record_cycle_metrics,
    record_proposal,
    record_run,
    register_tool,
    run_validation_commands,
    verify_integrity,
)
from aria_kernel.agent_genesis import approve_agent_pr, evaluate_genesis_sandbox
from aria_kernel.fixture_runner import fixture_runs_path, tool_manifest_hash
from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import get_tool
from tests._helpers.declared_fixtures import (
    append_declared_fixture,
    seed_validation_provenance,
)
from aria_kernel.tool_registry import GovernanceError


# The product file the synthetic proposal touches. One constant so the branch
# commit, the proposal's evidence and the action's declared changed_files
# cannot drift: the pre-PR-open hard-fail perimeter compares the declaration
# against READONLY_PATHS, so a fixture naming an aria-kernel/ path (or nothing
# at all) is refused before it ever reaches the validation-gate behaviour this
# test pins.
CHANGED_FILE = "apps/farm-service/src/feed/feed-schedule.service.ts"
CHANGED_FILE_CONTENT = "export const FEED_INTERVAL_MS = 3600000;\n"


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
            set_by="operator",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_validation_gate_is_required_before_pr_open(self):
        proposal = record_proposal(
            kind="test_gap",
            title="Add focused regression test",
            problem="A validated task needs a gated worktree lane",
            evidence=[CHANGED_FILE],
            validation_command="python3 -m unittest --help",
            # plan_apply_worktree copies validation_scope.commands onto the
            # action as validation_commands, which is what the perimeter's
            # test_gate_canonical_suite reads. Sourced from the perimeter's
            # own constant so the fixture cannot drift from what it requires;
            # each command is its own entry, because a single string
            # mentioning all three does not count (ORPHAN-CRITICAL-461).
            validation_commands=list(CANONICAL_VALIDATION_COMMANDS),
            base_dir=self.tools_dir,
        )
        approve_proposal(
            proposal_id=proposal["proposal_id"],
            operator_approval_ref="approval:012d",
            base_dir=self.tools_dir,
        )
        action = plan_apply_worktree(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        # Plan 023 v3 §P-3 — open_pr_for_action below now fails hard
        # when `git rev-parse <branch>` fails. The dry_run plan didn't
        # actually create the branch; create it manually so rev-parse
        # resolves. It carries a commit touching CHANGED_FILE rather than
        # pointing at a bare HEAD, so the branch actually contains the
        # change the action declares and `git diff <base_sha>..<branch>`
        # is a real diff. The test's intent is to exercise the
        # validation-gate prerequisite + open_pr lifecycle, not the
        # branch-creation plumbing.
        subprocess.run(
            ["git", "checkout", "-q", "-b", action["branch"]],
            cwd=self.root, check=True, capture_output=True,
        )
        changed = self.root / CHANGED_FILE
        changed.parent.mkdir(parents=True, exist_ok=True)
        changed.write_text(CHANGED_FILE_CONTENT, encoding="utf-8")
        subprocess.run(
            ["git", "add", CHANGED_FILE],
            cwd=self.root, check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", "feed schedule interval"],
            cwd=self.root, check=True, capture_output=True,
        )
        with self.assertRaises(GovernanceError):
            open_pr_for_action(
                proposal_id=proposal["proposal_id"],
                workspace_root=self.root,
                base_dir=self.tools_dir,
                dry_run=True,
            )

        # E21-a — a validation run must bind to a real change and a
        # resolvable commit; the fixture emits the chain it will cite.
        change_id, commit_sha = seed_validation_provenance(
            workspace_root=self.root, base_dir=self.tools_dir,
        )
        baseline = run_validation_commands(
            commands=["python3 -m unittest --help"],
            workspace_root=self.root,
            change_id=change_id,
            commit_sha=commit_sha,
            runner_identity="ci-executor:plan-012d",
            validation_plan_id="baseline",
            base_dir=self.tools_dir,
        )
        candidate = run_validation_commands(
            commands=["python3 -m unittest --help"],
            workspace_root=self.root,
            change_id=change_id,
            commit_sha=commit_sha,
            runner_identity="ci-executor:plan-012d",
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

        # Plan 022 §H-1 — pass the diff explicitly so the suppression scan
        # runs without triggering the diff-required fail-closed branch. It
        # is the branch's own diff, so the content scanned here is the
        # content the declared changed_files names.
        gated = gate_apply_action(
            proposal_id=proposal["proposal_id"],
            validation_comparison_ref=comparison["ledger_hash"],
            base_dir=self.tools_dir,
            diff_text=(
                f"--- /dev/null\n+++ b/{CHANGED_FILE}\n"
                f"@@ -0,0 +1 @@\n+{CHANGED_FILE_CONTENT}"
            ),
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

    # E14-b (ORPHAN-697) — codegen/executor lane dismantled; see 012.py note.
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
        append_declared_fixture(
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
            expected_surface="agent_eval_fixture_runs",
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
        # JJ-2a (ORPHAN-HIGH-732) REWROTE this fixture. The five runs above
        # carry an INLINE `operator_feedback_refs` blob, and that used to be
        # enough to clear the judged-precision gate — a verdict with no
        # source, no judge, no fingerprint and no author qualified an adapter
        # for ACTIVE. Nothing in production writes that field
        # (`tool_runner` emits `operator_feedback_refs: []` on every run), so
        # the only thing it ever qualified was a fixture. The gate now reads
        # the FEEDBACK LEDGER, where provenance lives, exactly like every
        # other ground-truth reader; the ledger row below is what the inline
        # blob was pretending to be.
        from aria_kernel.feedback_store import record_operator_feedback

        record_operator_feedback(
            tool_id="demo-adapter",
            run_id="run-0",
            finding_id="F-demo-1",
            verdict="true_positive",
            severity="medium",
            note="operator confirmed",
            source_type="human",
            judgment_group_id="judge:demo-adapter:F-demo-1",
            finding_fingerprint="fp-demo-1",
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
        append_declared_fixture(
            drafts_dir / "drafts.jsonl",
            draft,
            expected_surface="agent_genesis_drafts",
        )
        # Plan 022 §H-4 — synthetic fixture_results without execution
        # provenance require synthetic_test_mode=True opt-in.
        evaluate_genesis_sandbox(
            draft_id="draft-aria-demo",
            fixture_results=[{"status": "pass"}, {"status": "pass"}, {"status": "pass"}],
            base_dir=self.tools_dir,
            synthetic_test_mode=True,
        )
        # Plan 026R §E.2 — synthetic-mode sandbox requires override.
        approve_agent_pr(
            draft_id="draft-aria-demo",
            operator_approval_ref="approval:genesis",
            base_dir=self.tools_dir,
            operator_synthetic_override=True,
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
