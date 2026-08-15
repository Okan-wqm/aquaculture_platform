from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import approve_proposal, record_proposal
from aria_kernel.ci import record_agent_review_result
from aria_kernel.executor import (
    apply_executor_packet,
    executor_status,
    record_executor_packet,
    register_executor,
    retry_pr,
    review_executor_diff,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import (
    append_declared_fixture,
    seed_validation_provenance,
)


class ExecutorLaneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        (self.root / "src").mkdir()
        (self.root / "src/app.ts").write_text("export const value = 1;\n", encoding="utf-8")
        subprocess.run(["git", "init"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "aria@example.invalid"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "ARIA"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.root, check=True, capture_output=True)
        subprocess.run(["git", "checkout", "-b", "aria/executor-fixture"], cwd=self.root, check=True, capture_output=True)
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        # E21-a — applying a packet records validation runs, and a run
        # must bind to a real change. The commit_sha is NOT seeded here:
        # apply_executor_packet reads it from the candidate worktree HEAD.
        self.change_id, _ = seed_validation_provenance(
            workspace_root=self.root,
            base_dir=self.tools_dir,
            plan_id="plan-executor-lane",
            finding_id="F-executor-lane",
            affected_files=["src/app.ts"],
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _apply(self, packet_id: str, **kwargs):
        return apply_executor_packet(
            packet_id=packet_id,
            workspace_root=self.root,
            change_id=self.change_id,
            runner_identity="ci-executor:executor-lane",
            change_author_identity="agent:planner-lane",
            base_dir=self.tools_dir,
            **kwargs,
        )

    def test_unregistered_executor_and_shadow_executor_cannot_apply(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        with self.assertRaises(GovernanceError):
            record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)

        register_executor(self._executor(status="SHADOW"), base_dir=self.tools_dir)
        packet = record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)
        with self.assertRaises(GovernanceError):
            self._apply(packet["packet_id"], execute=False)

    def test_packet_validation_commands_must_be_proposal_bound(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        register_executor(self._executor(), base_dir=self.tools_dir)
        payload = self._packet(proposal["proposal_id"], failure["ci_failure_id"])
        payload["validation_commands"] = ["npm run fake-green"]
        with self.assertRaises(GovernanceError):
            record_executor_packet(payload, base_dir=self.tools_dir)

    def test_server_derived_critical_severity_requires_two_registered_reviewers(self):
        proposal = self._approved_proposal(title="Fix tenant isolation", problem="tenant boundary failed")
        failure = self._ci_failure(log_excerpt="tenant isolation expected predicate")
        register_executor(self._executor(), base_dir=self.tools_dir)
        register_executor(self._executor(source_agent="reviewer-a", can_review=True), base_dir=self.tools_dir)
        register_executor(self._executor(source_agent="reviewer-b", can_review=True), base_dir=self.tools_dir)
        packet = record_executor_packet(
            self._packet(proposal["proposal_id"], failure["ci_failure_id"], declared_severity="low"),
            base_dir=self.tools_dir,
        )
        self.assertEqual(packet["effective_severity"], "critical")
        self.assertEqual(packet["review_required_count"], 2)
        blocked = self._apply(packet["packet_id"])
        self.assertEqual(blocked["status"], "blocked")
        self.assertIn("diff_review_required", blocked["blocked_by"])

        review_executor_diff(
            packet_id=packet["packet_id"],
            reviewer="reviewer-a",
            verdict="approved",
            evidence_refs=["src/app.ts"],
            base_dir=self.tools_dir,
        )
        still_blocked = self._apply(packet["packet_id"])
        self.assertIn("diff_review_required", still_blocked["blocked_by"])

        review_executor_diff(
            packet_id=packet["packet_id"],
            reviewer="reviewer-b",
            verdict="approved",
            evidence_refs=["src/app.ts"],
            base_dir=self.tools_dir,
        )
        planned = self._apply(packet["packet_id"])
        self.assertEqual(planned["status"], "planned")

    def test_reviewer_must_be_registered(self):
        proposal = self._approved_proposal(title="Fix tenant isolation", problem="tenant boundary failed")
        failure = self._ci_failure(log_excerpt="tenant isolation expected predicate")
        register_executor(self._executor(), base_dir=self.tools_dir)
        packet = record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)
        with self.assertRaises(GovernanceError):
            review_executor_diff(
                packet_id=packet["packet_id"],
                reviewer="unknown-reviewer",
                verdict="approved",
                evidence_refs=["src/app.ts"],
                base_dir=self.tools_dir,
            )

    def test_prompt_full_is_ledgered_when_large(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        register_executor(self._executor(), base_dir=self.tools_dir)
        payload = self._packet(proposal["proposal_id"], failure["ci_failure_id"])
        payload["prompt_full"] = "x" * 5000
        packet = record_executor_packet(payload, base_dir=self.tools_dir)
        self.assertTrue(packet["prompt_full_ref"])
        prompts = load_jsonl(self.tools_dir / "executor" / "prompts.jsonl")
        self.assertEqual(len(prompts), 1)

    def test_scope_suppression_migration_and_lock_guards(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        register_executor(self._executor(), base_dir=self.tools_dir)
        bad = self._packet(proposal["proposal_id"], failure["ci_failure_id"])
        bad["unified_diff"] = bad["unified_diff"].replace("src/app.ts", "src/other.ts")
        blocked = record_executor_packet(bad, base_dir=self.tools_dir)
        self.assertIn("changed_files_do_not_match_unified_diff", blocked["blocked_by"])

        suppression = self._packet(proposal["proposal_id"], failure["ci_failure_id"])
        suppression["rationale"] = "continue-on-error to get green"
        blocked = record_executor_packet(suppression, base_dir=self.tools_dir)
        self.assertIn("suppression_policy_violation", blocked["blocked_by"])

        migration = self._packet(proposal["proposal_id"], failure["ci_failure_id"])
        migration["changed_files"] = ["apps/farm-service/src/database/migrations/1-Migration.ts"]
        migration["intended_files"] = migration["changed_files"]
        migration["allowed_globs"] = ["apps/**"]
        migration["unified_diff"] = "\n".join(
            [
                "diff --git a/apps/farm-service/src/database/migrations/1-Migration.ts b/apps/farm-service/src/database/migrations/1-Migration.ts",
                "--- a/apps/farm-service/src/database/migrations/1-Migration.ts",
                "+++ b/apps/farm-service/src/database/migrations/1-Migration.ts",
                "@@ -1 +1 @@",
                "-old",
                "+new",
            ],
        )
        blocked = record_executor_packet(migration, base_dir=self.tools_dir)
        self.assertIn("migration_requires_dedicated_lane", blocked["blocked_by"])

        packet = record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)
        self.assertEqual(packet["status"], "ready_for_apply")
        with self.assertRaises(GovernanceError):
            record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)

    def test_execute_apply_validates_and_retry_caps_apply(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        register_executor(self._executor(), base_dir=self.tools_dir)
        packet = record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)
        application = self._apply(packet["packet_id"], execute=True)
        self.assertEqual(application["status"], "ready_for_retry")
        for _ in range(2):
            retry_pr(packet_id=packet["packet_id"], pr_number=10, workspace_root=self.root, base_dir=self.tools_dir)
        with self.assertRaises(GovernanceError):
            retry_pr(packet_id=packet["packet_id"], pr_number=10, workspace_root=self.root, base_dir=self.tools_dir)

    def test_absolute_pr_retry_cap_blocks_even_when_family_is_new(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        register_executor(self._executor(), base_dir=self.tools_dir)
        packet = record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)
        application = self._apply(packet["packet_id"], execute=True)
        self.assertEqual(application["status"], "ready_for_retry")
        for index in range(4):
            append_declared_fixture(
                self.tools_dir / "executor" / "retries.jsonl",
                {
                    "schema_version": 1,
                    "packet_id": f"old-{index}",
                    "proposal_id": proposal["proposal_id"],
                    "pr_number": 20,
                    "root_failure_family": f"other-{index}",
                    "status": "planned",
                },
                expected_surface="executor_retries",
            )
        with self.assertRaises(GovernanceError):
            retry_pr(packet_id=packet["packet_id"], pr_number=20, workspace_root=self.root, base_dir=self.tools_dir)

    def test_operator_takeover_blocks_next_auto_retry(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        register_executor(self._executor(), base_dir=self.tools_dir)
        packet = record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)
        application = self._apply(packet["packet_id"], execute=True)
        self.assertEqual(application["status"], "ready_for_retry")
        previous_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()
        append_declared_fixture(
            self.tools_dir / "executor" / "retries.jsonl",
            {
                "schema_version": 1,
                "packet_id": packet["packet_id"],
                "proposal_id": proposal["proposal_id"],
                "pr_number": 21,
                "root_failure_family": "family-old",
                "status": "retried",
                "commit_sha": previous_head,
            },
            expected_surface="executor_retries",
        )
        subprocess.run(["git", "add", "src/app.ts"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-m", "manual fix"], cwd=self.root, check=True, capture_output=True)
        with self.assertRaises(GovernanceError):
            retry_pr(packet_id=packet["packet_id"], pr_number=21, workspace_root=self.root, base_dir=self.tools_dir)

    def test_non_aria_branch_retry_is_rejected(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure()
        register_executor(self._executor(), base_dir=self.tools_dir)
        packet = record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)
        application = self._apply(packet["packet_id"], execute=True)
        self.assertEqual(application["status"], "ready_for_retry")
        subprocess.run(["git", "checkout", "-b", "manual-branch"], cwd=self.root, check=True, capture_output=True)
        with self.assertRaises(GovernanceError):
            retry_pr(packet_id=packet["packet_id"], pr_number=11, workspace_root=self.root, base_dir=self.tools_dir)

    def test_flaky_suspect_blocks_apply(self):
        proposal = self._approved_proposal()
        failure = self._ci_failure(fingerprint="failure:flaky")
        for index in range(2):
            self._ci_failure(fingerprint="failure:flaky", ci_failure_id=f"ci-failure-flaky-{index}", cycle_id=f"cycle-{index + 2}")
        register_executor(self._executor(), base_dir=self.tools_dir)
        packet = record_executor_packet(self._packet(proposal["proposal_id"], failure["ci_failure_id"]), base_dir=self.tools_dir)
        blocked = self._apply(packet["packet_id"], execute=True)
        self.assertEqual(blocked["status"], "blocked")
        self.assertIn("flaky_suspect_requires_review", blocked["blocked_by"])

    def test_agent_review_still_rejects_diff_payload(self):
        with self.assertRaises(GovernanceError):
            record_agent_review_result(
                review={
                    "ci_failure_id": "ci-failure-1",
                    "reviewer_agent": "reviewer",
                    "repo_evidence_refs": ["src/app.ts"],
                    "workflow_evidence_refs": ["ci/failures.jsonl"],
                    "root_cause_classification": "code_regression",
                    "architectural_options": ["```diff\n--- a/src/app.ts\n+++ b/src/app.ts\n```"],
                    "risk_tradeoff": "none",
                    "validation_commands": ["python3 -m unittest --help"],
                    "compliance_statement": "read only",
                },
                base_dir=self.tools_dir,
            )

    def test_status_lists_executor_ledgers(self):
        register_executor(self._executor(), base_dir=self.tools_dir)
        status = executor_status(base_dir=self.tools_dir)
        self.assertEqual(status["registry"][0]["source_agent"], "codex-executor")

    def _executor(self, *, source_agent="codex-executor", status="ACTIVE", can_review=False):
        return {
            "source_agent": source_agent,
            "owner": "aria",
            "status": status,
            "allowed_globs": ["src/**", "apps/**"],
            "forbidden_globs": [],
            "max_files_per_packet": 5,
            "requires_diff_review_for": [],
            "can_review": can_review,
        }

    def _approved_proposal(self, *, title="Fix app value", problem="value regression"):
        proposal = record_proposal(
            kind="architecture",
            title=title,
            problem=problem,
            evidence=["src/app.ts"],
            validation_command="python3 -m unittest --help",
            validation_commands=["python3 -m unittest --help"],
            source_authority="ci_agent_review",
            status="ready_for_operator",
            base_dir=self.tools_dir,
        )
        return approve_proposal(
            proposal_id=proposal["proposal_id"],
            operator_approval_ref="operator:test",
            base_dir=self.tools_dir,
        )

    def _ci_failure(
        self,
        *,
        ci_failure_id="ci-failure-1",
        fingerprint="failure:one",
        cycle_id="cycle-1",
        log_excerpt="expected value received old",
    ):
        row = {
            "schema_version": 1,
            "recorded_at": "2026-05-04T00:00:00+00:00",
            "cycle_id": cycle_id,
            "pr_number": 10,
            "ci_failure_id": ci_failure_id,
            "failure_fingerprint": fingerprint,
            "workflow": "ci-full",
            "job": "unit",
            "step": "test",
            "root_cause_classification": "code_regression",
            "log_excerpt": log_excerpt,
            "affected_files": ["src/app.ts"],
            "changed_file_overlap": ["src/app.ts"],
            "test_names": ["src/app.spec.ts"],
        }
        return append_declared_fixture(
            self.tools_dir / "ci" / "failures.jsonl",
            row,
            expected_surface="ci_failures",
        )

    def _packet(self, proposal_id, ci_failure_id, *, declared_severity=None):
        packet = {
            "proposal_id": proposal_id,
            "ci_failure_ids": [ci_failure_id],
            "root_failure_family": "family-1",
            "source_agent": "codex-executor",
            "model": "fixture",
            "prompt_hash": "sha256:prompt",
            "prompt_excerpt": "fix the value",
            "repo_evidence_refs": ["src/app.ts"],
            "workflow_evidence_refs": ["ci/failures.jsonl"],
            "intended_files": ["src/app.ts"],
            "allowed_globs": ["src/**"],
            "changed_files": ["src/app.ts"],
            "unified_diff": "\n".join(
                [
                    "diff --git a/src/app.ts b/src/app.ts",
                    "--- a/src/app.ts",
                    "+++ b/src/app.ts",
                    "@@ -1 +1 @@",
                    "-export const value = 1;",
                    "+export const value = 2;",
                    "",
                ],
            ),
            "rationale": "Update the fixture value.",
            "risk_notes": "Small code change.",
        }
        if declared_severity:
            packet["severity"] = declared_severity
        return packet


if __name__ == "__main__":
    unittest.main()
