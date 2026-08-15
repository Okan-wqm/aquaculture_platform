from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import (
    approve_proposal,
    compare_performance_baseline,
    fetch_research_source,
    generate_fitness_report,
    generate_recommendation_candidate,
    plan_apply_worktree,
    plan_downstream_impact,
    plan_impact,
    record_performance_baseline,
    record_proposal,
    request_kernel_change,
    run_validation_commands,
    verify_integrity,
)
from aria_kernel.tool_health import runs_path
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import (
    append_declared_fixture,
    seed_validation_provenance,
)
from tests._helpers.git_fixtures import make_local_git_repo


class EnterpriseRoadmapFoundationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # E21-a — a validation run must name a resolvable commit, so the
        # fixture workspace is a real repository rather than a bare dir.
        self.root = make_local_git_repo(Path(self.tmp.name), name="workspace")
        self.tools_dir = Path(self.tmp.name) / "aria-tools"

    def tearDown(self):
        self.tmp.cleanup()

    def test_validation_engine_runs_allowlisted_commands_and_rejects_shell_syntax(self):
        change_id, commit_sha = seed_validation_provenance(
            workspace_root=self.root, base_dir=self.tools_dir,
        )
        provenance = dict(
            change_id=change_id,
            commit_sha=commit_sha,
            runner_identity="ci-executor:roadmap",
        )
        plan = run_validation_commands(
            commands=["python3 -m unittest --help"],
            workspace_root=self.root,
            base_dir=self.tools_dir,
            cycle_id="cycle-validation",
            **provenance,
        )
        self.assertEqual(plan["status"], "ok")
        with self.assertRaises(GovernanceError):
            run_validation_commands(
                commands=["python3 -m unittest --help; echo unsafe"],
                workspace_root=self.root,
                base_dir=self.tools_dir,
                **provenance,
            )
        with self.assertRaises(GovernanceError):
            run_validation_commands(
                commands=["npm run dev"],
                workspace_root=self.root,
                base_dir=self.tools_dir,
                **provenance,
            )
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])

    def test_impact_graph_finds_downstream_consumers_and_updates_validation_scope(self):
        (self.root / "apps/api/src").mkdir(parents=True)
        (self.root / "libs/domain/src").mkdir(parents=True)
        (self.root / "apps/api/src/app.ts").write_text(
            "import { domain } from 'libs/domain/src/domain';\nexport const app = domain;\n",
            encoding="utf-8",
        )
        (self.root / "libs/domain/src/domain.ts").write_text("export const domain = true;\n", encoding="utf-8")

        graph = plan_downstream_impact(
            changed_files=["libs/domain/src/domain.ts"],
            workspace_root=self.root,
            base_dir=self.tools_dir,
            cycle_id="cycle-impact",
        )
        self.assertEqual(graph["changed_projects"], ["domain"])
        self.assertEqual(graph["downstream_projects"], ["api"])
        self.assertEqual(graph["validation_scope"], "downstream")

        impact = plan_impact(
            changed_files=["libs/domain/src/domain.ts"],
            action_class="code_behavior_change",
            workspace_root=self.root,
            base_dir=self.tools_dir,
        )
        self.assertEqual(impact["risk_class"], "runtime")
        self.assertIn("npx nx run-many --target=test --projects=api,domain", impact["validation_commands"])

    def test_research_fetch_sanitizes_and_records_hashed_content(self):
        row = fetch_research_source(
            url="https://example.com/security",
            source_tier="official",
            title="Fixture",
            content_override="<html><script>bad()</script><body>Use version 2. Security fixed.</body></html>",
            base_dir=self.tools_dir,
        )
        self.assertNotIn("bad()", row["sanitized_text"])
        self.assertTrue(row["content_hash"].startswith("sha256:"))
        self.assertEqual(row["source_tier"], "official")

    def test_performance_baseline_compare_detects_missing_and_regression(self):
        missing = compare_performance_baseline(
            metric="api.p99_ms",
            current_value=120,
            base_dir=self.tools_dir,
        )
        self.assertEqual(missing["status"], "missing_baseline")
        record_performance_baseline(
            metric="api.p99_ms",
            value=100,
            unit="ms",
            source="fixture",
            base_dir=self.tools_dir,
        )
        regression = compare_performance_baseline(
            metric="api.p99_ms",
            current_value=120,
            max_regression_pct=5,
            base_dir=self.tools_dir,
        )
        self.assertEqual(regression["status"], "regression")

    def test_fitness_report_is_separate_from_recommendation_evidence_gate(self):
        append_declared_fixture(
            runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "run_id": "event-run",
                "tool_id": "event-contracts-adapter",
                "cycle_id": "cycle-fitness",
                "status": "ok",
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )
        report = generate_fitness_report(cycle_id="cycle-fitness", base_dir=self.tools_dir)
        self.assertIn("event_contracts", report["dimensions"])
        self.assertFalse(report["recommendation_ready"])

        blocked = generate_recommendation_candidate(
            cycle_id="cycle-fitness",
            title="Upgrade fixture dependency",
            evidence_refs=["package.json"],
            validation_refs=[],
            research_refs=["sha256:source"],
            impact_graph_refs=["sha256:impact"],
            repo_value="CVE exposure",
            base_dir=self.tools_dir,
        )
        self.assertEqual(blocked["status"], "blocked")

    def test_kernel_self_change_requires_dedicated_lane_and_never_auto_merge(self):
        proposal = record_proposal(
            kind="self_change",
            title="Change kernel",
            problem="Kernel needs a fixture change",
            evidence=["aria-kernel/aria_kernel/cli.py"],
            validation_command="PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'",
            status="ready_for_operator",
            base_dir=self.tools_dir,
        )
        approve_proposal(
            proposal_id=proposal["proposal_id"],
            operator_approval_ref="operator:test",
            base_dir=self.tools_dir,
        )
        with self.assertRaises(GovernanceError):
            plan_apply_worktree(proposal_id=proposal["proposal_id"], workspace_root=self.root, base_dir=self.tools_dir)

        request = request_kernel_change(
            changed_files=["aria-kernel/aria_kernel/cli.py"],
            operator_approval_ref="operator:test",
            validation_refs=["python-suite", "adapter-tests", "integrity-verify", "shadow-cycle", "validation-engine-self-test"],
            full_shadow_cycle_ref="cycle:test",
            rollback_plan="revert the kernel PR",
            base_dir=self.tools_dir,
        )
        self.assertEqual(request["decision"], "authorized_for_pr_only")
        self.assertFalse(request["auto_merge_allowed"])


if __name__ == "__main__":
    unittest.main()
