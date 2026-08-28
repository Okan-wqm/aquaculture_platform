from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aria_kernel.auto_merge import classify_changed_files, evaluate_auto_merge, merge_if_green
from aria_kernel.auto_merge_runners import resolve_readiness_claim_id_from_claims
from aria_kernel.integrity import verify_integrity
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.ledger_refs import ledger_ref_for_row
from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.tool_registry import ensure_tools_dir

HEAD_SHA = "a" * 40
DRIFT_HEAD_SHA = "b" * 40
DIGEST = "sha256:" + "c" * 64


def enabled_policy(**overrides):
    policy = {"enabled": True, "base_branch": "main", "merge_method": "squash"}
    policy.update(overrides)
    return policy


def pr(**overrides):
    payload = {
        "number": 42,
        "repository": "example/aqua",
        "base_branch": "main",
        "head_ref": "feature/docs",
        "head_sha": "abc1234",
        "changed_files": ["docs/aria/plans/008-auto-merge.md"],
        "reviews": [],
        # Plan 022 §H-2 — evaluate_auto_merge requires diff_text. The
        # default fixture supplies a clean docs-only patch so existing
        # tests stay green without invasive surgery; tests that target
        # a specific suppression or empty-diff scenario override.
        "diff_text": (
            "--- a/docs/aria/plans/008-auto-merge.md\n"
            "+++ b/docs/aria/plans/008-auto-merge.md\n"
            "@@ -1 +1,2 @@\n"
            " existing line\n"
            "+New paragraph added by Plan 022 H-2 fixture.\n"
        ),
    }
    payload.update(overrides)
    return payload


def github(**overrides):
    payload = {
        "latest_head_sha": "abc1234",
        "branch_protection": {"readable": True, "required_checks": ["ci/test", "ci/lint"]},
        "checks": {
            "readable": True,
            "runs": [
                {"name": "ci/test", "head_sha": "abc1234", "status": "completed", "conclusion": "success"},
                {"name": "ci/lint", "head_sha": "abc1234", "status": "completed", "conclusion": "success"},
            ],
        },
        "reviews": {"readable": True, "items": []},
        "conversations": {"readable": True, "unresolved_count": 0},
    }
    payload.update(overrides)
    return payload


class FakeGitHubAdapter:
    def __init__(self, pr_payload, github_payload, *, latest_heads=None, fail_merge=False):
        self.pr_payload = pr_payload
        self.github_payload = github_payload
        self.latest_heads = list(latest_heads or [github_payload.get("latest_head_sha", pr_payload.get("head_sha"))])
        self.fail_merge = fail_merge
        self.merge_calls = []

    def get_open_issues(self, *, labels):
        # ORPHAN-MEDIUM-562 — merge_pr_if_ready asks the watchdog alarm before
        # merging and fails closed on an unreadable answer, so a fake that
        # cannot answer would refuse every merge in this file.
        _ = labels
        return {"readable": True, "issues": []}

    def get_pr(self, number):
        self.pr_payload["number"] = number
        return dict(self.pr_payload)

    def get_latest_head_sha(self, number):
        _ = number
        if len(self.latest_heads) > 1:
            return self.latest_heads.pop(0)
        return self.latest_heads[0]

    def get_required_checks(self, base_branch):
        _ = base_branch
        return self.github_payload["branch_protection"]

    def get_checks(self, head_sha):
        _ = head_sha
        return self.github_payload["checks"]

    def get_reviews(self, number):
        _ = number
        return self.github_payload["reviews"]

    def get_unresolved_conversation_count(self, number):
        _ = number
        return self.github_payload["conversations"]

    def merge_pr(self, number, *, method, expected_head_sha):
        if self.fail_merge:
            raise RuntimeError("merge failed")
        call = {"number": number, "method": method, "expected_head_sha": expected_head_sha}
        self.merge_calls.append(call)
        return {"merged": True, **call}


class AutoMergeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_passing_triple_gate(self, *, pr_number: int, head_sha: str) -> None:
        """Plan 026R §D.4 — stage a passing change_committed +
        change_validated + validation_runs chain so the triple-gate
        passes. Used by merge_if_green tests that want to exercise
        downstream behavior past the triple-gate."""
        from aria_kernel.auto_merge import record_pr_lifecycle
        from aria_kernel.change_ledger import (
            emit_change_committed,
            emit_change_planned,
            emit_change_validated,
        )
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.validation_runs_ledger import record_validation_run

        set_profile("strict", operator_approval_ref="t", base_dir=self.tools_dir)
        planned = emit_change_planned(
            plan_id=f"plan-auto-{pr_number}",
            finding_id=f"F-auto-{pr_number}",
            intended_affected_files=["docs/x.md"],
            intended_validation_refs=["nx test"],
            architectural_tier=1,
            base_dir=self.tools_dir,
        )
        change_id = planned["change_id"]
        emit_change_committed(
            change_id=change_id,
            commit_sha=head_sha,
            actual_affected_files=["docs/x.md"],
            base_dir=self.tools_dir,
        )
        log_path = Path(self.tmp.name) / f"log-{pr_number}.txt"
        log_path.write_text("ok\n", encoding="utf-8")
        # ORPHAN-717 Gate 4 — passing chains carry the hygiene battery.
        for battery_cmd in (
            "npm run format:check",
            "npm run type-check",
            "nx affected --target=test",
        ):
            record_validation_run(
                change_id=change_id,
                cmd=battery_cmd,
                exit_code=0,
                duration_ms=1_500,
                log_path=str(log_path),
                commit_sha=head_sha,
                runner_identity="ci-executor:test-auto",
                change_author_identity="agent:planner-auto",
                started_at="2026-05-11T13:00:00+00:00",
                completed_at="2026-05-11T13:01:00+00:00",
                base_dir=self.tools_dir,
            )
        emit_change_validated(
            change_id=change_id,
            validation_run_refs=[{
                "cmd": "nx affected --target=test",
                "exit_code": 0,
                "log_path": str(log_path),
                "ran_at": "2026-05-11T13:00:00+00:00",
            }],
            base_dir=self.tools_dir,
            validation_mode="historical_attestation",
            enforce_validation_matrix=False,
        )
        record_pr_lifecycle(
            {"number": pr_number, "head_sha": head_sha,
             "change_id": change_id, "base_branch": "main"},
            event="opened", base_dir=self.tools_dir,
        )

    def _seed_readiness_claim(self, *, pr_number: int, head_sha: str, target_ref: str = "main") -> str:
        from aria_kernel.enterprise_readiness import (
            READINESS_SCHEMA,
            record_artifact_proof,
            record_branch_protection_proof,
            record_dlp_proof,
            record_enterprise_readiness_claim,
            record_remote_cas_proof,
            record_retention_proof,
            record_rollback_proof,
            record_token_proof,
            record_workflow_run_proof,
        )
        from aria_kernel.autonomy_unlock import record_acceptance_event
        from aria_kernel.rollback_bundle import record_rollback_bundle, record_rollback_simulation
        from aria_kernel.runner_attestation import record_runner_attestation

        readiness_claim_id = f"ready-{pr_number}"
        repo = "example/aqua"
        head_ref = "feature/docs"
        required_checks = ["sens-enterprise-summary", "merge-gate", "aria-merge-authority"]
        common = {
            "repo": repo,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "readiness_claim_id": readiness_claim_id,
        }

        source_refs: dict[str, dict] = {}

        def source_ref(label: str) -> dict:
            if label not in source_refs:
                row_id = f"source-{label}"
                row = append_declared_jsonl(
                    self.tools_dir / "ci" / "source.jsonl",
                    {
                        "schema_version": 1,
                        "row_id": row_id,
                        "row_type": "ci_source",
                        "label": label,
                        "content_hash": "sha256:" + hashlib.sha256(label.encode("utf-8")).hexdigest(),
                    },
                    expected_surface="ci_source",
                    bypass_profile_gate=True,
                )
                source_refs[label] = ledger_ref_for_row(
                    surface="ci_source",
                    ledger_path="ci/source.jsonl",
                    row_id=row_id,
                    row_type="ci_source",
                    row=row,
                )
            return dict(source_refs[label])

        def write_artifact(name: str, payload: str) -> str:
            path = self.tools_dir / name
            path.write_text(payload, encoding="utf-8")
            return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()

        artifact_sha = write_artifact("evidence-bundle.json", '{"ok":true}\n')
        rollback_source = write_artifact("rollback-source.json", '{"source":true}\n')
        rollback_archive = write_artifact("rollback-archive.json", '{"archive":true}\n')
        retention_source = write_artifact("retention-source.json", '{"source":true}\n')
        retention_archive = write_artifact("retention-archive.json", '{"archive":true}\n')
        artifact_ref = {
            "schema_version": 2,
            "artifact_id": "artifact-1",
            "uri": "evidence-bundle.json",
            "sha256": artifact_sha,
            "content_type": "application/json",
            "produced_by_workflow_run_id": "123",
            "source_surface": "github_actions_artifact",
        }
        cas = {
            **common,
            "state": "fresh",
            "lease_id": f"lease-{pr_number}",
            "epoch": 1,
            "expires_at": "2999-06-02T00:00:00Z",
            "source_ledger_ref": source_ref("cas"),
        }
        record_remote_cas_proof(cas, base_dir=self.tools_dir)
        branch = {
            **common,
            "$schema": "aria/branch-protection-proof/v3",
            "valid": True,
            "snapshot_hash": artifact_sha,
            "required_checks": required_checks,
            "exact_required_checks": required_checks,
            "signed_commits_required": True,
            "reviews_required": True,
            "conversation_resolution_required": True,
            "ruleset_ids": [1],
            "bypass_actors": [],
            "force_push_disabled": True,
            "delete_branch_disabled": True,
            "source_ledger_ref": source_ref("branch"),
        }
        record_branch_protection_proof(branch, base_dir=self.tools_dir)
        rollback = {
            **common,
            "validated": True,
            "rollback_proof_id": f"rollback-{pr_number}",
            "source_uri": "rollback-source.json",
            "archive_uri": "rollback-archive.json",
            "source_sha256": rollback_source,
            "archive_sha256": rollback_archive,
            "source_ledger_ref": source_ref("rollback"),
        }
        retention = {
            **common,
            "validated": True,
            "retention_proof_id": f"retention-{pr_number}",
            "source_uri": "retention-source.json",
            "archive_uri": "retention-archive.json",
            "source_sha256": retention_source,
            "archive_sha256": retention_archive,
            "retention_days": 365,
            "source_ledger_ref": source_ref("retention"),
        }
        workflow_run = {
            **common,
            "workflow_run_id": 123,
            "conclusion": "success",
            "source_ledger_ref": source_ref("workflow"),
        }
        artifact = {
            **common,
            "artifact_id": artifact_ref["artifact_id"],
            "uri": artifact_ref["uri"],
            "sha256": artifact_ref["sha256"],
            "schema_version": artifact_ref["schema_version"],
            "content_type": artifact_ref["content_type"],
            "source_surface": artifact_ref["source_surface"],
            "produced_by_workflow_run_id": artifact_ref["produced_by_workflow_run_id"],
            "source_ledger_ref": source_ref("artifact"),
        }
        dlp = {
            **common,
            "valid": True,
            "dlp_proof_id": f"dlp-{pr_number}",
            "workflow_run_id": 123,
            "artifact_id": artifact_ref["artifact_id"],
            "artifact_sha256": artifact_ref["sha256"],
            "workflow_hash": artifact_sha,
            "contract_hash": artifact_sha,
            "network_policy": "egress-denied",
            "runtime_write_paths": ["aria-tools/tmp"],
            "scanner_results": {
                "status": "passed",
                "scanned_surfaces": ["diff", "prompt", "transcript", "logs", "artifacts"],
                "scanner_output_sha256": artifact_sha,
            },
            "source_ledger_ref": source_ref("dlp"),
        }
        token = {
            **common,
            "valid": True,
            "token_proof_id": f"token-{pr_number}",
            "workflow_run_id": 123,
            "artifact_id": artifact_ref["artifact_id"],
            "artifact_sha256": artifact_ref["sha256"],
            "workflow_hash": artifact_sha,
            "contract_hash": artifact_sha,
            "network_policy": "egress-denied",
            "runtime_write_paths": ["aria-tools/tmp"],
            "token_type": "github_app_installation_token",
            "mutation_token": "github_app_installation_token",
            "gh_token_fallback": False,
            "github_token_fallback": False,
            "pat_fallback": False,
            "source_ledger_ref": source_ref("token"),
        }
        record_rollback_proof(rollback, base_dir=self.tools_dir)
        record_retention_proof(retention, base_dir=self.tools_dir)
        record_workflow_run_proof(workflow_run, base_dir=self.tools_dir)
        record_artifact_proof(artifact, base_dir=self.tools_dir)
        record_dlp_proof(dlp, base_dir=self.tools_dir)
        record_token_proof(token, base_dir=self.tools_dir)
        claim = {
            "$schema": READINESS_SCHEMA,
            "schema_version": 2,
            "claim_row_id": f"claim-row-{readiness_claim_id}",
            "readiness_claim_id": readiness_claim_id,
            "repo": repo,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "evidence_bundle": {"path": "evidence-bundle.json", "sha256": artifact_sha},
            "workflow_run_ids": [123],
            "artifact_refs": [artifact_ref],
            "remote_cas_proof": cas,
            "rollback_proof": rollback,
            "retention_proof": retention,
            "waiver_ledger": {"open_expired_waivers": [], "source_ledger_ref": source_ref("waiver")},
            "branch_protection_proof": branch,
            "dlp_proof": dlp,
            "token_proof": token,
        }
        record_enterprise_readiness_claim(claim, base_dir=self.tools_dir)
        for index in range(30):
            record_acceptance_event(
                event_type="observe_success",
                pr_number=pr_number,
                head_sha=f"{index:040x}"[-40:],
                base_dir=self.tools_dir,
            )
        record_runner_attestation(
            {
                **common,
                "runner_id": f"runner-{pr_number}",
                "runner_group": "aria-private",
                "ephemeral_runner": True,
                "approved_runner_group": True,
                "sandbox_available": True,
                "claude_auth": "managed_claude_code_cli",
                "api_key_auth": False,
            },
            base_dir=self.tools_dir,
        )
        record_rollback_bundle(
            {
                **common,
                "rollback_bundle_id": f"bundle-{pr_number}",
                "rollback_plan_sha256": rollback_source,
            },
            base_dir=self.tools_dir,
        )
        record_rollback_simulation(
            {
                **common,
                "rollback_bundle_id": f"bundle-{pr_number}",
                "rollback_simulation_id": f"simulation-{pr_number}",
                "status": "passed",
            },
            base_dir=self.tools_dir,
        )
        return readiness_claim_id

    def test_policy_disabled_blocks_even_low_risk_green_pr(self):
        decision = evaluate_auto_merge(pr=pr(), github=github(), policy={}, base_dir=self.tools_dir)
        self.assertFalse(decision["eligible"])
        self.assertIn("policy disabled", decision["reasons"])

    def test_non_main_base_branch_blocks(self):
        decision = evaluate_auto_merge(
            pr=pr(base_branch="develop"),
            github=github(),
            policy=enabled_policy(),
            base_dir=self.tools_dir,
        )
        self.assertFalse(decision["eligible"])
        self.assertIn("base branch must be main", decision["reasons"])

    def test_classifier_allows_docs_and_tests_but_blocks_runtime_and_mixed_diffs(self):
        self.assertEqual(
            classify_changed_files(["docs/aria/SPEC.md", "aria-kernel/tests/test_auto_merge.py"])["risk_class"],
            "low",
        )
        self.assertEqual(classify_changed_files(["aria-kernel/aria_kernel/cli.py"])["risk_class"], "forbidden")
        self.assertEqual(
            classify_changed_files(["docs/aria/SPEC.md", "apps/farm-service/src/app.module.ts"])["risk_class"],
            "mixed",
        )

    def test_docs_pr_with_required_checks_success_is_eligible(self):
        decision = evaluate_auto_merge(
            pr=pr(),
            github=github(),
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            cycle_id="cycle-auto",
        )
        self.assertTrue(decision["eligible"])
        self.assertEqual(decision["decision"], "eligible")
        rows = (self.tools_dir / "auto-merge-decisions.jsonl").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(json.loads(rows[-1])["decision"], "eligible")
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])

    def test_required_checks_fail_closed_when_unreadable_empty_missing_or_pending(self):
        cases = [
            github(branch_protection={"readable": False, "required_checks": ["ci/test"]}),
            github(branch_protection={"readable": True, "required_checks": []}),
            github(checks={"readable": True, "runs": []}),
            github(
                checks={
                    "readable": True,
                    "runs": [{"name": "ci/test", "head_sha": "abc1234", "status": "completed", "conclusion": "success"}],
                },
            ),
            github(
                checks={
                    "readable": True,
                    "runs": [
                        {"name": "ci/test", "head_sha": "abc1234", "status": "completed", "conclusion": "success"},
                        {"name": "ci/lint", "head_sha": "abc1234", "status": "in_progress", "conclusion": None},
                    ],
                },
            ),
        ]
        for snapshot in cases:
            with self.subTest(snapshot=snapshot):
                self.assertFalse(
                    evaluate_auto_merge(pr=pr(), github=snapshot, policy=enabled_policy(), base_dir=self.tools_dir)[
                        "eligible"
                    ],
                )

    def test_head_sha_requested_changes_and_unresolved_conversations_block(self):
        cases = [
            github(latest_head_sha="def456"),
            github(reviews={"readable": True, "items": [{"state": "CHANGES_REQUESTED"}]}),
            github(conversations={"readable": False, "unresolved_count": None}),
            github(conversations={"readable": True, "unresolved_count": 1}),
        ]
        for snapshot in cases:
            with self.subTest(snapshot=snapshot):
                self.assertFalse(
                    evaluate_auto_merge(pr=pr(), github=snapshot, policy=enabled_policy(), base_dir=self.tools_dir)[
                        "eligible"
                    ],
                )

    # ORPHAN-HIGH-764 — merge_pr_if_ready now runs the GATE_PRE_MERGE
    # hard-fail perimeter immediately before the merge side effect. Every
    # pre-merge check binds _not_implemented by design, so these
    # merge-path tests stub the perimeter as passing: the gate's wiring and
    # its refusal semantics are pinned separately in
    # test_merge_authority_pre_merge_perimeter.py.
    @patch(
        "aria_kernel.merge_authority.run_hard_fail_checks",
        return_value=SimpleNamespace(passed=True, failures=()),
    )
    def test_merge_if_green_uses_squash_and_records_merged(self, _perimeter):
        # Plan 026R §D.4 — auto-merge now triple-gates on
        # change_committed + change_validated + verified validation_runs.
        # Seed a passing chain so the merge proceeds.
        self._seed_passing_triple_gate(pr_number=42, head_sha=HEAD_SHA)
        readiness_claim_id = self._seed_readiness_claim(pr_number=42, head_sha=HEAD_SHA)
        from aria_kernel.runtime_profile import set_profile
        set_profile("autonomous", operator_approval_ref="test:merge-authority", base_dir=self.tools_dir)
        adapter = FakeGitHubAdapter(
            pr(head_sha=HEAD_SHA),
            github(
                latest_head_sha=HEAD_SHA,
                checks={
                    "readable": True,
                    "runs": [
                        {"name": "ci/test", "head_sha": HEAD_SHA, "status": "completed", "conclusion": "success"},
                        {"name": "ci/lint", "head_sha": HEAD_SHA, "status": "completed", "conclusion": "success"},
                    ],
                },
            ),
            latest_heads=[HEAD_SHA, HEAD_SHA],
        )
        result = merge_pr_if_ready(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            cycle_id="cycle-merge",
            readiness_claim_id=readiness_claim_id,
        )
        self.assertEqual(result["decision"], "merged")
        self.assertEqual(adapter.merge_calls, [{"number": 42, "method": "squash", "expected_head_sha": HEAD_SHA}])
        decisions = [json.loads(line) for line in (self.tools_dir / "auto-merge-decisions.jsonl").read_text().splitlines()]
        self.assertEqual([row["decision"] for row in decisions], ["eligible", "merged"])

    @patch(
        "aria_kernel.merge_authority.run_hard_fail_checks",
        return_value=SimpleNamespace(passed=True, failures=()),
    )
    def test_failed_merge_does_not_record_merged_lifecycle(self, _perimeter):
        self._seed_passing_triple_gate(pr_number=42, head_sha=HEAD_SHA)
        readiness_claim_id = self._seed_readiness_claim(pr_number=42, head_sha=HEAD_SHA)
        from aria_kernel.runtime_profile import set_profile
        set_profile("autonomous", operator_approval_ref="test:merge-authority", base_dir=self.tools_dir)
        adapter = FakeGitHubAdapter(
            pr(head_sha=HEAD_SHA),
            github(
                latest_head_sha=HEAD_SHA,
                checks={
                    "readable": True,
                    "runs": [
                        {"name": "ci/test", "head_sha": HEAD_SHA, "status": "completed", "conclusion": "success"},
                        {"name": "ci/lint", "head_sha": HEAD_SHA, "status": "completed", "conclusion": "success"},
                    ],
                },
            ),
            latest_heads=[HEAD_SHA, HEAD_SHA],
            fail_merge=True,
        )
        result = merge_pr_if_ready(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            cycle_id="cycle-merge",
            readiness_claim_id=readiness_claim_id,
        )
        self.assertEqual(result["decision"], "failed")
        lifecycle_path = self.tools_dir / "pr-lifecycle.jsonl"
        lifecycle_rows = [
            json.loads(line)
            for line in lifecycle_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertNotIn("merged", [row.get("event") for row in lifecycle_rows])
        incidents = [
            json.loads(line)
            for line in (self.tools_dir / "enterprise" / "incidents.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        self.assertIn("merge_failed", [row.get("incident_event") for row in incidents])

    def test_merge_command_not_called_when_checks_are_pending(self):
        from aria_kernel.runtime_profile import set_profile
        set_profile("autonomous", operator_approval_ref="test:merge-authority", base_dir=self.tools_dir)
        readiness_claim_id = self._seed_readiness_claim(pr_number=42, head_sha=HEAD_SHA)
        adapter = FakeGitHubAdapter(
            pr(head_sha=HEAD_SHA),
            github(
                latest_head_sha=HEAD_SHA,
                checks={
                    "readable": True,
                    "runs": [
                        {"name": "ci/test", "head_sha": HEAD_SHA, "status": "completed", "conclusion": "success"},
                        {"name": "ci/lint", "head_sha": HEAD_SHA, "status": "queued", "conclusion": None},
                    ],
                },
            ),
        )
        result = merge_pr_if_ready(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            readiness_claim_id=readiness_claim_id,
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(adapter.merge_calls, [])

    def test_merge_blocks_if_head_changes_after_green_evaluation(self):
        # Plan 024 v3 §B-6 — pre-merge full re-evaluation now blocks at
        # the re-eval boundary. Plan 026R §D.4 — the auto-merge triple-
        # gate fires BEFORE re-eval; we seed a passing triple-gate so
        # the test reaches the head-SHA drift surface as intended.
        self._seed_passing_triple_gate(pr_number=42, head_sha=HEAD_SHA)
        readiness_claim_id = self._seed_readiness_claim(pr_number=42, head_sha=HEAD_SHA)
        from aria_kernel.runtime_profile import set_profile
        set_profile("autonomous", operator_approval_ref="test:merge-authority", base_dir=self.tools_dir)
        adapter = FakeGitHubAdapter(
            pr(head_sha=HEAD_SHA),
            github(
                latest_head_sha=HEAD_SHA,
                checks={
                    "readable": True,
                    "runs": [
                        {"name": "ci/test", "head_sha": HEAD_SHA, "status": "completed", "conclusion": "success"},
                        {"name": "ci/lint", "head_sha": HEAD_SHA, "status": "completed", "conclusion": "success"},
                    ],
                },
            ),
            latest_heads=[HEAD_SHA, DRIFT_HEAD_SHA],
        )
        result = merge_pr_if_ready(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            readiness_claim_id=readiness_claim_id,
        )
        self.assertEqual(result["decision"], "blocked")
        joined = " ".join(result["reasons"])
        self.assertTrue(
            "PR head SHA changed" in joined
            or "pre_merge_re_evaluation_blocked" in joined
            or "auto_merge_triple_gate_blocked" in joined,
            f"expected SHA-drift or triple-gate block reason; got {result['reasons']!r}",
        )
        self.assertEqual(adapter.merge_calls, [])

    def test_direct_real_merge_if_green_rejected_outside_authority(self):
        adapter = FakeGitHubAdapter(pr(), github(), latest_heads=["abc1234", "abc1234"])
        with self.assertRaisesRegex(Exception, "direct_real_merge_forbidden"):
            merge_if_green(
                adapter=adapter,
                pr_number=42,
                policy=enabled_policy(),
                base_dir=self.tools_dir,
                dry_run=False,
            )
        self.assertEqual(adapter.merge_calls, [])

    def test_readiness_claim_resolver_rejects_missing_live_pr_binding_fields(self):
        self._seed_readiness_claim(pr_number=42, head_sha=HEAD_SHA)

        class Adapter:
            def get_pr(self, number):
                return {"number": number}

        with self.assertRaisesRegex(Exception, "readiness_claim_pr_binding_fields_required"):
            resolve_readiness_claim_id_from_claims(Adapter(), 42, self.tools_dir)


if __name__ == "__main__":
    unittest.main()
