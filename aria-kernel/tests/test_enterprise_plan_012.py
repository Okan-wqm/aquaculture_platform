from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import (
    compare_validation_groups,
    draft_architecture_adr,
    fetch_research_source,
    generate_architecture_options,
    generate_fitness_report,
    list_code_change_plans,
    record_architecture_evidence_pack,
    record_code_change_plan,
    record_research_policy,
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


class EnterprisePlan012Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # E21-a — a validation run must name a resolvable commit, so the
        # fixture workspace is a real repository rather than a bare dir.
        self.root = make_local_git_repo(Path(self.tmp.name), name="workspace")
        self.tools_dir = Path(self.tmp.name) / "aria-tools"

    def tearDown(self):
        self.tmp.cleanup()

    def test_validation_compare_blocks_worktree_regression(self):
        change_id, commit_sha = seed_validation_provenance(
            workspace_root=self.root, base_dir=self.tools_dir,
        )
        baseline = run_validation_commands(
            commands=["python3 -m unittest --help"],
            workspace_root=self.root,
            change_id=change_id,
            commit_sha=commit_sha,
            runner_identity="ci-executor:plan-012",
            base_dir=self.tools_dir,
            validation_plan_id="baseline",
        )
        worktree = run_validation_commands(
            commands=["python3 -m unittest missing_module_for_aria_plan_012"],
            workspace_root=self.root,
            change_id=change_id,
            commit_sha=commit_sha,
            runner_identity="ci-executor:plan-012",
            base_dir=self.tools_dir,
            validation_plan_id="worktree",
        )

        comparison = compare_validation_groups(
            baseline_ref=baseline["ledger_hash"],
            worktree_ref=worktree["ledger_hash"],
            base_dir=self.tools_dir,
        )

        self.assertEqual(comparison["regression_status"], "regression")
        self.assertEqual(comparison["blocked_by"], ["validation_regression"])

        improved = compare_validation_groups(
            baseline_ref=worktree["ledger_hash"],
            worktree_ref=baseline["ledger_hash"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(improved["regression_status"], "improved")
        self.assertEqual(improved["blocked_by"], [])

    def test_architecture_evidence_pack_and_adr_draft_require_complete_evidence(self):
        option_set = generate_architecture_options(
            technology="Redis",
            evidence_refs=[
                "apps/api/src/cache.ts",
                "apps/auth-service/src/session.ts",
                "libs/backend-common/src/cache.ts",
                "platform/libs/messaging/src/rate-limit.ts",
                "apps/farm-service/src/read-model.ts",
            ],
            root_cause="Redis calls are repeated without a repo-owned boundary",
            authoritative_refs=["https://redis.io/docs/latest/"],
            repo_prior_refs=["docs/adr/0001-cache.md"],
            base_dir=self.tools_dir,
        )
        blocked = record_architecture_evidence_pack(
            technology="Redis",
            repo_fit_refs=[],
            current_stable_refs=["research:redis-stable"],
            authoritative_refs=["research:redis-docs"],
            migration_risk="high adoption",
            repo_value="prevent cache ownership drift",
            base_dir=self.tools_dir,
        )
        self.assertEqual(blocked["status"], "blocked")

        complete = record_architecture_evidence_pack(
            technology="Redis",
            repo_fit_refs=["apps/api/src/cache.ts"],
            current_stable_refs=["research:redis-stable"],
            authoritative_refs=["research:redis-docs"],
            migration_risk="high adoption",
            repo_value="prevent cache ownership drift",
            base_dir=self.tools_dir,
        )
        adr = draft_architecture_adr(
            option_set_ref=option_set["ledger_hash"],
            evidence_pack_ref=complete["ledger_hash"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(adr["status"], "ready_for_operator")
        self.assertIn("ADR: Redis architecture decision", adr["content"])

    def test_research_policy_blocks_non_allowlisted_sources(self):
        record_research_policy(
            allowed_domains=["redis.io", "github.com"],
            base_dir=self.tools_dir,
        )
        allowed = fetch_research_source(
            url="https://redis.io/docs/latest/",
            source_tier="official",
            content_override="<html><script>x()</script><body>Use stable Redis guidance.</body></html>",
            base_dir=self.tools_dir,
        )
        self.assertEqual(allowed["source_policy"]["status"], "allowed")
        self.assertNotIn("x()", allowed["sanitized_text"])

        with self.assertRaises(GovernanceError):
            fetch_research_source(
                url="https://random.example.com/blog",
                source_tier="other",
                content_override="untrusted",
                base_dir=self.tools_dir,
            )

    def test_fitness_report_tracks_trend_and_recommends_lowest_dimension(self):
        first = generate_fitness_report(cycle_id="cycle-1", base_dir=self.tools_dir)
        self.assertEqual(first["trend"]["overall_delta"], 0.0)
        self.assertTrue(first["blocked_by"])

        append_declared_fixture(
            runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "run_id": "event-run",
                "tool_id": "event-contracts-adapter",
                "cycle_id": "cycle-2",
                "status": "ok",
                "runner": {"raw_findings_count": 0},
            },
            expected_surface="runs",
        )
        second = generate_fitness_report(cycle_id="cycle-2", base_dir=self.tools_dir)
        self.assertGreaterEqual(second["trend"]["window"], 1)
        self.assertIn("action", second["recommended_next_action"])

    def test_codegen_plan_blocks_forbidden_or_out_of_scope_files(self):
        blocked = record_code_change_plan(
            proposal_id="proposal-1",
            worktree_path="/tmp/worktree",
            intended_files=["apps/api/src/app.ts", ".github/workflows/ci.yml", "aria-kernel/aria_kernel/cli.py"],
            allowed_globs=["apps/api/**"],
            pre_hashes={
                "apps/api/src/app.ts": "sha256:before",
                ".github/workflows/ci.yml": "sha256:before",
                "aria-kernel/aria_kernel/cli.py": "sha256:before",
            },
            post_hashes={
                "apps/api/src/app.ts": "sha256:after",
                ".github/workflows/ci.yml": "sha256:after",
                "aria-kernel/aria_kernel/cli.py": "sha256:after",
            },
            validation_refs=["validation:ok"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(blocked["status"], "blocked")
        self.assertTrue(any(item.startswith("forbidden_path:") for item in blocked["blocked_by"]))
        self.assertIn(".github/**", blocked["forbidden_globs"])

        ready = record_code_change_plan(
            proposal_id="proposal-1",
            worktree_path="/tmp/worktree",
            intended_files=["apps/api/src/app.ts"],
            allowed_globs=["apps/api/**"],
            pre_hashes={"apps/api/src/app.ts": "sha256:before"},
            post_hashes={"apps/api/src/app.ts": "sha256:after"},
            validation_refs=["validation:ok"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(ready["status"], "ready_for_review")
        self.assertEqual(list_code_change_plans(base_dir=self.tools_dir)[-1]["code_change_plan_id"], ready["code_change_plan_id"])
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])


if __name__ == "__main__":
    unittest.main()
