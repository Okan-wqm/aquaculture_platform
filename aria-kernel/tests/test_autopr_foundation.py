from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import (
    amplify_proposal,
    approve_proposal,
    check_budget,
    compare_validation_groups,
    generate_task_candidates,
    gate_apply_action,
    open_pr_for_action,
    plan_apply_worktree,
    plan_impact,
    record_proposal,
    record_budget_usage,
    verify_integrity,
    run_validation_commands,
)
from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS
from aria_kernel.proposal import proposal_packet_from_task, record_proposal_from_amplification
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_health import runs_path
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import (
    append_declared_fixture,
    seed_validation_provenance,
)


# The product file the fixture proposal touches. One constant so the seeded
# commit, the proposal's evidence and the action's declared changed_files
# cannot drift. The pre-PR-open hard-fail perimeter compares the declaration
# against READONLY_PATHS and scans the base..branch diff, so a fixture that
# names a kernel path — or names a path no commit ever wrote — describes a PR
# that could not legally be opened.
CHANGED_FILE = "apps/farm-service/src/pond/pond-stocking.service.ts"


class AutoPrFoundationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        # Plan 020 Phase 1.B — pr_open is strict-only under the runtime
        # profile gate. AutoPR foundation exercises the full pipeline
        # including open_pr_for_action, so the test setUp opts into strict
        # via an explicit operator_approval_ref. Strict permits a strict
        # superset of standard's actions, so non-PR test methods stay green.
        set_profile(
            "strict",
            operator_approval_ref="test:plan-020-phase-1.B:autopr-foundation",
            base_dir=self.tools_dir,
            set_by="test-fixture",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_budget_gate_records_usage_and_blocks_over_cap(self):
        decision = check_budget(action="proposal_amplification", estimated_usd=0.5, base_dir=self.tools_dir)
        self.assertTrue(decision["allowed"])
        row = record_budget_usage(
            action="proposal_amplification",
            provider="external",
            model="fixture",
            input_tokens=100,
            output_tokens=50,
            estimated_usd=0.5,
            base_dir=self.tools_dir,
        )
        self.assertEqual(row["estimated_usd"], 0.5)
        blocked = check_budget(action="proposal_amplification", estimated_usd=10.0, base_dir=self.tools_dir)
        self.assertFalse(blocked["allowed"])
        self.assertIn("per-action cap exceeded", blocked["reasons"])
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])

    def test_task_candidates_rank_pressure_and_shadow_summaries(self):
        pressure_dir = self.tools_dir / "pressure"
        pressure_dir.mkdir(parents=True)
        (pressure_dir / "cycle-1.json").write_text(
            json.dumps(
                {
                    "pressures": [
                        {
                            "pressure_id": "pressure:migration-surface-repeat:repetition",
                            "score": 84.185,
                            "reason": "repository has repeated TypeORM migration surfaces",
                            "recommended_action": "continue TypeORM schema drift checks",
                            "evidence": ["apps/*/src/database/migrations/*.ts"],
                            "candidate_tools": ["typeorm-entity-schema-adapter"],
                            "source": "migration_surface_repeat",
                            "severity": "medium",
                            "blocked_by": [],
                        },
                    ],
                },
            ),
            encoding="utf-8",
        )
        append_declared_fixture(
            runs_path(self.tools_dir),
            {
                "schema_version": 1,
                "run_id": "run-shadow",
                "tool_id": "tenant-scoping-adapter",
                "cycle_id": "cycle-1",
                "status": "ok",
                "read_paths": ["apps/farm-service/src/app.module.ts"],
                "emitted_findings": [],
                "runner": {"raw_findings_count": 3},
            },
            expected_surface="runs",
        )
        payload = generate_task_candidates(cycle_id="cycle-1", base_dir=self.tools_dir)
        self.assertEqual(payload["task_count"], 2)
        self.assertEqual(payload["tasks"][0]["source"], "pressure")
        self.assertEqual(payload["tasks"][1]["source_authority"], "shadow_draft")

    def test_llm_amplification_rejects_uncited_evidence(self):
        task = {
            "task_id": "task-1",
            "source_authority": "deterministic_pressure",
            "title": "Fix drift",
            "problem": "Drift exists",
            "risk_class": "runtime",
            "evidence_refs": ["src/app.ts"],
            "validation_commands": ["npm run test"],
            "blocked_by": [],
        }
        packet = proposal_packet_from_task(task)
        good = {
            "title": "Fix drift",
            "problem": "Drift exists",
            "summary": "Grounded summary",
            "proposed_change": "Adjust the checked code path",
            "evidence_refs": ["src/app.ts"],
            "validation_commands": ["npm run test"],
        }
        amplification = amplify_proposal(packet=packet, response=good, estimated_usd=0.0, base_dir=self.tools_dir)
        proposal = record_proposal_from_amplification(
            task=task,
            amplification=amplification,
            kind="architecture",
            base_dir=self.tools_dir,
        )
        self.assertEqual(proposal["status"], "ready_for_operator")
        bad = dict(good)
        bad["evidence_refs"] = ["src/other.ts"]
        with self.assertRaises(GovernanceError):
            amplify_proposal(packet=packet, response=bad, estimated_usd=0.0, base_dir=self.tools_dir)

    def test_impact_planner_selects_enterprise_validation_scope(self):
        docs = plan_impact(
            changed_files=["docs/aria/SPEC.md"],
            action_class="documentation_update",
            base_dir=self.tools_dir,
        )
        self.assertEqual(docs["risk_class"], "docs_only")
        runtime = plan_impact(
            changed_files=["apps/auth-service/src/auth.service.ts"],
            action_class="code_behavior_change",
            base_dir=self.tools_dir,
        )
        self.assertEqual(runtime["risk_class"], "auth_tenant_data")
        self.assertIn("npm run invariants:full", runtime["validation_commands"])

    def test_approved_proposal_can_plan_worktree_and_pr_dry_run(self):
        self._init_git_workspace()
        proposal = record_proposal(
            kind="architecture",
            title="Fixture proposal",
            problem="Fixture problem",
            evidence=[CHANGED_FILE],
            validation_command=CANONICAL_VALIDATION_COMMANDS[0],
            # The canonical suite, sourced from the perimeter's own constant so
            # the fixture cannot drift from what test_gate_canonical_suite
            # requires. Each command is its own entry — one string mentioning
            # all three does not count (ORPHAN-CRITICAL-461).
            validation_commands=list(CANONICAL_VALIDATION_COMMANDS),
            source_authority="deterministic_pressure",
            risk_class="runtime",
            status="ready_for_operator",
            base_dir=self.tools_dir,
        )
        approved = approve_proposal(
            proposal_id=proposal["proposal_id"],
            operator_approval_ref="operator:test",
            base_dir=self.tools_dir,
        )
        self.assertEqual(approved["status"], "approved_for_apply")
        action = plan_apply_worktree(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.root,
            base_dir=self.tools_dir,
            dry_run=True,
        )
        self.assertEqual(action["status"], "planned")
        # Plan 023 v3 §P-3 — open_pr_for_action below fails hard when
        # `git rev-parse <branch>` fails, and the pre-PR-open perimeter
        # reads `git diff base_sha..branch` from action.worktree_path.
        # plan_apply_worktree(dry_run=True) plans both without creating
        # either, so the action described a branch that does not resolve
        # and a worktree that does not exist. Build them here at the
        # planned path, carrying one commit that edits the declared
        # CHANGED_FILE, so the declaration and the diff describe one
        # change; a branch left pointing at base yields an empty diff,
        # which is a PR with no content. `aria-worktrees/` is gitignored
        # by _init_git_workspace, so workspace_root stays clean for
        # run_validation_commands' clean-tree check.
        worktree_path = Path(action["worktree_path"])
        subprocess.run(
            [
                "git", "worktree", "add", "-q",
                "-b", action["branch"], str(worktree_path), action["base_sha"],
            ],
            cwd=self.root, check=True, capture_output=True,
        )
        (worktree_path / CHANGED_FILE).write_text(
            "export const STOCKING_DENSITY_MAX_PER_M3 = 35;\n", encoding="utf-8",
        )
        subprocess.run(["git", "add", "."], cwd=worktree_path, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "fixture change"],
            cwd=worktree_path, check=True, capture_output=True,
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
            runner_identity="ci-executor:autopr",
            validation_plan_id="baseline",
            base_dir=self.tools_dir,
        )
        candidate = run_validation_commands(
            commands=["python3 -m unittest --help"],
            workspace_root=self.root,
            change_id=change_id,
            commit_sha=commit_sha,
            runner_identity="ci-executor:autopr",
            validation_plan_id=proposal["proposal_id"],
            base_dir=self.tools_dir,
        )
        comparison = compare_validation_groups(
            baseline_ref=baseline["ledger_hash"],
            worktree_ref=candidate["ledger_hash"],
            base_dir=self.tools_dir,
        )
        # Plan 022 §H-1 — gate_apply_action requires diff content; pass
        # an empty diff string so the suppression scan runs (empty input
        # yields zero matches) without triggering the new fail-closed
        # branch that fires when diff_text is None and the action does
        # not carry branch+base_sha.
        gate_apply_action(
            proposal_id=proposal["proposal_id"],
            validation_comparison_ref=comparison["ledger_hash"],
            base_dir=self.tools_dir,
            diff_text="--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-old\n+new\n",
        )
        pr = open_pr_for_action(
            proposal_id=proposal["proposal_id"],
            workspace_root=self.root,
            base_dir=self.tools_dir,
            dry_run=True,
        )
        self.assertEqual(pr["event"], "pr_dry_run")
        self.assertIn("## Validation", pr["body"])

    def _init_git_workspace(self):
        source = self.root / CHANGED_FILE
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("export const STOCKING_DENSITY_MAX_PER_M3 = 40;\n", encoding="utf-8")
        # plan_apply_worktree plans its worktree under workspace_root, so the
        # directory has to be ignored for the tree to stay clean — the same
        # thing the real repository's .gitignore does for its worktree roots.
        (self.root / ".gitignore").write_text("aria-worktrees/\n", encoding="utf-8")
        subprocess.run(["git", "init"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "aria@example.invalid"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "ARIA"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-m", "fixture"], cwd=self.root, check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
