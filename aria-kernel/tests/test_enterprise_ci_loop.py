from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import (
    inventory_workflows,
    list_ci_failures,
    produce_ci_review,
    record_agent_review_result,
    record_ci_report,
    record_remediation_proposal,
    verify_integrity,
    wait_pr_checks,
)
from aria_kernel.feedback_store import generate_judgment_sample
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


def pr_snapshot(**overrides):
    payload = {
        "number": 7,
        "base_branch": "main",
        "head_sha": "abc123",
        "changed_files": ["apps/farm-service/src/app.module.ts"],
        "reviews": [],
    }
    payload.update(overrides)
    return payload


def github_snapshot(*, check_conclusion="failure"):
    return {
        "latest_head_sha": "abc123",
        "branch_protection": {"readable": True, "required_checks": ["ci/test"]},
        "checks": {
            "readable": True,
            "runs": [
                {
                    "name": "ci/test",
                    "head_sha": "abc123",
                    "status": "completed",
                    "conclusion": check_conclusion,
                },
            ],
        },
        "reviews": {"readable": True, "items": []},
        "conversations": {"readable": True, "unresolved_count": 0},
        "workflow_runs": [
            {
                "id": 100,
                "name": "ci-full",
                "status": "completed",
                "conclusion": check_conclusion,
                "jobs": [
                    {
                        "name": "unit",
                        "status": "completed",
                        "conclusion": check_conclusion,
                        "affected_files": ["apps/farm-service/src/app.module.ts"],
                        "steps": [
                            {
                                "name": "test",
                                "conclusion": check_conclusion,
                                "log": "FAIL apps/farm-service/src/app.spec.ts expected true received false",
                                "exit_code": 1,
                            },
                        ],
                    },
                ],
            },
        ],
    }


class EnterpriseCiLoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def tearDown(self):
        self.tmp.cleanup()

    def test_workflow_inventory_classifies_required_dispatch_and_protected(self):
        workflows = self.root / ".github" / "workflows"
        workflows.mkdir(parents=True)
        (workflows / "ci-full.yml").write_text("name: ci-full\non:\n  pull_request:\n", encoding="utf-8")
        (workflows / "rule-health.yml").write_text("name: rule-health\non:\n  workflow_dispatch:\n", encoding="utf-8")
        (workflows / "deploy.yml").write_text("name: deploy\non:\n  workflow_dispatch:\njobs:\n  deploy:\n    environment: production\n", encoding="utf-8")

        inventory = inventory_workflows(workspace_root=self.root, base_dir=self.tools_dir)
        classes = {item["name"]: item["class"] for item in inventory["workflows"]}
        self.assertEqual(classes["ci-full"], "pr_required")
        self.assertEqual(classes["rule-health"], "dispatch_safe")
        self.assertEqual(classes["deploy"], "protected_side_effect")

    def test_failed_required_check_blocks_human_merge_and_records_failure(self):
        report = record_ci_report(
            pr=pr_snapshot(),
            github=github_snapshot(),
            changed_files=["apps/farm-service/src/app.module.ts"],
            base_dir=self.tools_dir,
            workspace_root=None,
        )
        self.assertNotIn("ready_state", report)
        self.assertEqual(report["failure_count"], 1)
        failure = list_ci_failures(base_dir=self.tools_dir)[-1]
        self.assertEqual(failure["root_cause_classification"], "test_contract_regression")
        self.assertEqual(failure["changed_file_overlap"], ["apps/farm-service/src/app.module.ts"])
        gate = wait_pr_checks(
            snapshot={"pr": pr_snapshot(), "github": github_snapshot()},
            base_dir=self.tools_dir,
        )
        self.assertIn("required checks not successful: ci/test", gate["blocked_by"])
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])

    def test_skipped_protected_workflow_is_human_gate_not_ready(self):
        gate = wait_pr_checks(
            snapshot={
                "pr": pr_snapshot(changed_files=["docs/aria/spec.md"]),
                "github": github_snapshot(check_conclusion="success")
                | {
                    "workflow_runs": [
                        {
                            "id": 200,
                            "name": "deploy",
                            "status": "completed",
                            "conclusion": "skipped",
                        },
                    ],
                },
                "workflow_inventory": {
                    "workflows": [
                        {
                            "name": "deploy",
                            "path": ".github/workflows/deploy.yml",
                            "class": "protected_side_effect",
                        },
                    ],
                },
            },
            base_dir=self.tools_dir,
        )
        self.assertTrue(any("protected workflow requires human gate" in item for item in gate["blocked_by"]))

    def test_agent_review_result_requires_evidence_and_rejects_suppression(self):
        record_ci_report(
            pr=pr_snapshot(),
            github=github_snapshot(),
            changed_files=["apps/farm-service/src/app.module.ts"],
            base_dir=self.tools_dir,
            workspace_root=None,
        )
        failure_id = list_ci_failures(base_dir=self.tools_dir)[-1]["ci_failure_id"]
        task = produce_ci_review(ci_failure_id=failure_id, base_dir=self.tools_dir)
        self.assertTrue(task["read_only"])
        self.assertIn("ci_failure_root_cause_review", task["task_packet"]["lane"])
        with self.assertRaises(GovernanceError):
            record_agent_review_result(
                review={
                    "ci_failure_id": failure_id,
                    "reviewer_agent": "test",
                    "repo_evidence_refs": [],
                    "workflow_evidence_refs": ["ci/failures.jsonl"],
                    "root_cause_classification": "test_contract_regression",
                    "architectural_options": ["fix contract"],
                    "risk_tradeoff": "low",
                    "validation_commands": ["python3 -m unittest --help"],
                    "compliance_statement": "read only",
                },
                base_dir=self.tools_dir,
            )
        with self.assertRaises(GovernanceError):
            record_agent_review_result(
                review={
                    "ci_failure_id": failure_id,
                    "reviewer_agent": "test",
                    "repo_evidence_refs": ["apps/farm-service/src/app.module.ts"],
                    "workflow_evidence_refs": ["ci/failures.jsonl"],
                    "root_cause_classification": "test_contract_regression",
                    "architectural_options": ["skip test to pass"],
                    "risk_tradeoff": "bad",
                    "validation_commands": ["python3 -m unittest --help"],
                    "compliance_statement": "read only",
                },
                base_dir=self.tools_dir,
            )

    def test_agent_review_can_create_operator_remediation_proposal(self):
        record_ci_report(
            pr=pr_snapshot(),
            github=github_snapshot(),
            changed_files=["apps/farm-service/src/app.module.ts"],
            base_dir=self.tools_dir,
            workspace_root=None,
        )
        failure_id = list_ci_failures(base_dir=self.tools_dir)[-1]["ci_failure_id"]
        review = record_agent_review_result(
            review={
                "ci_failure_id": failure_id,
                "reviewer_agent": "test",
                "repo_evidence_refs": ["apps/farm-service/src/app.module.ts"],
                "workflow_evidence_refs": ["ci/failures.jsonl"],
                "root_cause_classification": "test_contract_regression",
                "architectural_options": ["align module contract with expected provider graph"],
                "risk_tradeoff": "touches app bootstrap behavior",
                "validation_commands": ["python3 -m unittest --help"],
                "compliance_statement": "No patch, skip, suppression, or threshold lowering included.",
            },
            base_dir=self.tools_dir,
        )
        proposal = record_remediation_proposal(
            ci_failure_id=failure_id,
            title="Align module contract",
            problem="CI contract test failed for farm module bootstrap.",
            architectural_solution="Update the provider graph through the approved apply lane.",
            evidence_refs=["apps/farm-service/src/app.module.ts"],
            validation_commands=["python3 -m unittest --help"],
            agent_review_refs=[review["ledger_hash"]],
            base_dir=self.tools_dir,
        )
        self.assertEqual(proposal["status"], "ready_for_operator")

    def test_uncertainty_sampling_prioritizes_low_confidence_belief_evidence(self):
        memory_dir = self.tools_dir / "memory"
        memory_dir.mkdir(parents=True)
        append_declared_fixture(
            memory_dir / "beliefs.jsonl",
            {
                "schema_version": 2,
                "belief_id": "low-confidence-farm",
                "claim": "farm module contract is stable",
                "confidence": 0.2,
                "status": "needs_revalidation",
                "evidence_refs": ["apps/farm-service/**"],
            },
            expected_surface="memory_beliefs",
        )
        append_declared_fixture(
            self.tools_dir / "raw-findings.jsonl",
            {
                "schema_version": 1,
                "tool_id": "learning-adapter",
                "run_id": "run-farm",
                "cycle_id": "cycle-u",
                "finding_id": "farm",
                "finding_fingerprint": "finding:farm",
                "status": "raw",
                "finding": {"id": "farm", "rule": "r1", "path": "apps/farm-service/src/app.module.ts"},
            },
            expected_surface="raw_findings",
        )
        append_declared_fixture(
            self.tools_dir / "raw-findings.jsonl",
            {
                "schema_version": 1,
                "tool_id": "learning-adapter",
                "run_id": "run-doc",
                "cycle_id": "cycle-u",
                "finding_id": "doc",
                "finding_fingerprint": "finding:doc",
                "status": "raw",
                "finding": {"id": "doc", "rule": "r1", "path": "docs/readme.md"},
            },
            expected_surface="raw_findings",
        )
        sample = generate_judgment_sample(
            tool_id="learning-adapter",
            sample_size=1,
            strategy="stratified_by_uncertainty",
            cycle_id="cycle-u",
            base_dir=self.tools_dir,
        )
        self.assertEqual(sample["items"][0]["finding_id"], "farm")
        self.assertEqual(sample["items"][0]["uncertain_belief_ids"], ["low-confidence-farm"])

    def test_judgment_pipeline_phase_replaces_the_heartbeat_driver(self):
        # heartbeat.py is deleted (zero importers; ORPHAN-CRITICAL-613); the
        # judgment work it was supposed to drive now runs as cycle phases.
        # The intent of the old status check — "the loop's driver is
        # observable" — survives as: the phases are registered.
        from aria_kernel import cycle as cycle_mod

        names = [phase.name for phase in cycle_mod.CYCLE_PHASES]
        self.assertIn("judgment_pipeline", names)
        self.assertIn("judge_replay", names)


class TheCiObserverRecordsNoMergeDecision(unittest.TestCase):
    """ARIA-MEDIUM-423 — the CI gate reads the merge lane's evaluation, never records it.

    `auto-merge-decisions.jsonl` is the merge lane's decision ledger. The CI
    observer's snapshot carries no diff, review or conversation state
    (`ci._gh_pr_snapshot`), so every row it appended there was a `blocked`
    dry run: 185 of 185 rows on aria/state f5c5c86a1, each paired 1:1 with a
    `ci/pr-ci-gates.jsonl` row of the same PR, head and cycle.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def _decision_rows(self):
        from aria_kernel.ledger import load_declared_jsonl

        path = self.tools_dir / "auto-merge-decisions.jsonl"
        return load_declared_jsonl(path, expected_surface="auto_merge_decisions") if path.exists() else []

    def test_every_ci_producer_leaves_the_decision_ledger_untouched(self):
        # The three producers: own_pr_ci.scan_own_prs and the readiness lane's
        # `readiness record-ci-report` (both record_ci_report), and wait_pr_checks.
        record_ci_report(pr=pr_snapshot(), github=github_snapshot(), base_dir=self.tools_dir, workspace_root=None)
        wait_pr_checks(snapshot={"pr": pr_snapshot(), "github": github_snapshot()}, base_dir=self.tools_dir)

        self.assertEqual(self._decision_rows(), [])

    def test_the_gate_still_blocks_on_the_merge_lane_s_reasons(self):
        from aria_kernel.auto_merge import evaluate_auto_merge

        gate = wait_pr_checks(
            snapshot={"pr": pr_snapshot(), "github": github_snapshot(check_conclusion="success")},
            base_dir=self.tools_dir,
        )
        evaluation = evaluate_auto_merge(
            pr=pr_snapshot(), github=github_snapshot(check_conclusion="success"),
            policy={"enabled": True, "base_branch": "main", "merge_method": "squash"},
            base_dir=None, dry_run=True, workspace_root=".",  # wait_pr_checks' default checkout
        )
        # Nothing else blocks this PR, so the gate's blockers ARE the evaluation's reasons.
        self.assertEqual(gate["blocked_by"], sorted(set(evaluation["reasons"])))
        self.assertIn("diff_text missing — auto_merge_requires_diff_content", gate["blocked_by"])
        self.assertEqual(
            (gate["required_checks"], gate["check_result"], gate["enterprise_risk"]),
            (evaluation["required_checks"], evaluation["check_result"], evaluation["risk"]["enterprise_risk"]),
        )

    def test_the_decision_reads_base_dir_only_to_record_itself(self):
        # Why passing base_dir=None cannot change the gate: inside
        # evaluate_auto_merge the one read of base_dir is the decision's own
        # append. A change that makes the decision read state through it must
        # revisit the CI gate's call, and fails here first.
        import ast
        import inspect

        from aria_kernel import auto_merge

        tree = ast.parse(inspect.getsource(auto_merge))
        [function] = [node for node in tree.body
                      if isinstance(node, ast.FunctionDef) and node.name == "evaluate_auto_merge"]
        reads = [node for node in ast.walk(function)
                 if isinstance(node, ast.Name) and node.id == "base_dir" and isinstance(node.ctx, ast.Load)]
        appends = [node for node in ast.walk(function)
                   if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "_append_decision"]
        self.assertEqual(len(reads), 1)
        self.assertEqual(len(appends), 1)
        self.assertIs(appends[0].args[0], reads[0])

    def test_the_pre_merge_perimeter_counts_no_observer_row(self):
        # The capability's counts are the decision ledger's rows; an observer
        # run adds none, so on a store only the observer touched every count is 0.
        # Counted by the production streaming fold `autonomy status` reports
        # through (ARIA-MEDIUM-450 deleted the test-only `_capability_safe_counts` twin).
        from tests.test_autonomy_evidence_status import _folded_counts

        record_ci_report(pr=pr_snapshot(), github=github_snapshot(), base_dir=self.tools_dir, workspace_root=None)
        all_counts, _blockers = _folded_counts({"auto_merge_decisions": tuple(self._decision_rows())})
        counts = all_counts["pre_merge_perimeter"]
        self.assertEqual(set(counts.values()), {0})
        self.assertEqual(counts["premerge_decision_blocked"], 0)


class TheObserverClaimsNoMergeVerdict(unittest.TestCase):
    """ARIA-MEDIUM-430 — whether a PR may merge is the merge lane's verdict.

    The gate's `ready_for_human_merge` could never be true from the observer:
    its snapshot fetches no diff, reviews or threads, the cycle's job token
    cannot read branch protection, the cycle checkout lacks the PR's commits,
    and the predicate required lane L1, the lane no person is asked to merge.
    185 of 185 rows on aria/state f5c5c86a1 were `blocked`. The gate row now
    records what blocks a merge as far as the observer can see, claims no
    verdict, and names the surface that holds it.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def test_the_gate_and_report_claim_no_verdict_and_name_its_owner(self):
        from aria_kernel.ci import MERGE_VERDICT_SURFACE
        from aria_kernel.ledger import load_declared_jsonl

        report = record_ci_report(pr=pr_snapshot(), github=github_snapshot(check_conclusion="success"),
                                  base_dir=self.tools_dir, workspace_root=None)
        [gate] = load_declared_jsonl(self.tools_dir / "ci" / "pr-ci-gates.jsonl", expected_surface="ci_pr_gates")

        for claim in ("status", "ready_for_human_merge"):
            self.assertNotIn(claim, gate)
        self.assertNotIn("ready_state", report)
        self.assertEqual((gate["schema_version"], report["schema_version"]), (2, 2))
        self.assertEqual(gate["merge_verdict_surface"], MERGE_VERDICT_SURFACE)
        self.assertEqual(report["gate_ref"], gate["ledger_hash"])

    def test_the_named_owner_is_the_merge_lane_s_decision_ledger(self):
        import inspect

        from aria_kernel import auto_merge
        from aria_kernel.ci import MERGE_VERDICT_SURFACE
        from aria_kernel.state_manifest import surface_by_name

        self.assertEqual(surface_by_name(MERGE_VERDICT_SURFACE).path_pattern, "auto-merge-decisions.jsonl")
        # ... the ledger the merge lane's one decision writer appends to.
        source = inspect.getsource(auto_merge._append_decision)
        self.assertIn('"auto-merge-decisions.jsonl"', source)
        self.assertIn(f'expected_surface="{MERGE_VERDICT_SURFACE}"', source)

    def test_ci_spells_no_merge_readiness_claim(self):
        # The claim cannot come back unnoticed: no literal of it in the observer.
        import ast
        import inspect

        from aria_kernel import ci

        literals = {node.value for node in ast.walk(ast.parse(inspect.getsource(ci)))
                    if isinstance(node, ast.Constant) and isinstance(node.value, str)}
        self.assertEqual(literals & {"ready_for_human_merge", "ready_state"}, set())


if __name__ == "__main__":
    unittest.main()
