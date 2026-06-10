from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge import classify_changed_files, evaluate_auto_merge, merge_if_green
from aria_kernel.merge_authority import merge_pr_if_ready
from aria_kernel.integrity import verify_integrity

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
        "base_branch": "main",
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
        record_validation_run(
            change_id=change_id,
            cmd="nx affected --target=test",
            exit_code=0,
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

        readiness_claim_id = f"ready-{pr_number}"
        cas = {
            "state": "fresh",
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "lease_id": f"lease-{pr_number}",
            "epoch": 1,
            "expires_at": "2999-06-02T00:00:00Z",
        }
        record_remote_cas_proof(cas, base_dir=self.tools_dir)
        branch = {
            "schema_version": 1,
            "valid": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "snapshot_hash": DIGEST,
            "source_ledger_hash": DIGEST,
            "required_checks": ["ci/test", "ci/lint"],
        }
        record_branch_protection_proof(branch, base_dir=self.tools_dir)
        rollback = {
            "validated": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "rollback_proof_id": f"rollback-{pr_number}",
            "source_ledger_hash": DIGEST,
            "artifact_hash": DIGEST,
        }
        retention = {
            "validated": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "retention_proof_id": f"retention-{pr_number}",
            "source_ledger_hash": DIGEST,
            "artifact_hash": DIGEST,
            "retention_days": 365,
        }
        workflow_run = {
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "workflow_run_id": 123,
            "conclusion": "success",
            "source_ledger_hash": DIGEST,
        }
        artifact = {
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "artifact_path": "evidence-bundle.json",
            "artifact_hash": DIGEST,
            "source_ledger_hash": DIGEST,
        }
        dlp = {
            "valid": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "dlp_proof_id": f"dlp-{pr_number}",
            "artifact_hash": DIGEST,
        }
        token = {
            "valid": True,
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "token_proof_id": f"token-{pr_number}",
            "artifact_hash": DIGEST,
        }
        record_rollback_proof(rollback, base_dir=self.tools_dir)
        record_retention_proof(retention, base_dir=self.tools_dir)
        record_workflow_run_proof(workflow_run, base_dir=self.tools_dir)
        record_artifact_proof(artifact, base_dir=self.tools_dir)
        record_dlp_proof(dlp, base_dir=self.tools_dir)
        record_token_proof(token, base_dir=self.tools_dir)
        claim = {
            "readiness_claim_id": readiness_claim_id,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_sha": head_sha,
            "evidence_bundle": {"path": "evidence-bundle.json", "sha256": DIGEST},
            "workflow_run_ids": [123],
            "artifact_hashes": {"evidence-bundle.json": DIGEST},
            "remote_cas_proof": cas,
            "rollback_proof": rollback,
            "retention_proof": retention,
            "waiver_ledger": {"open_expired_waivers": [], "source_ledger_hash": DIGEST},
            "branch_protection_proof": branch,
            "dlp_proof": dlp,
            "token_proof": token,
        }
        record_enterprise_readiness_claim(claim, base_dir=self.tools_dir)
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

    def test_merge_if_green_uses_squash_and_records_merged(self):
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


if __name__ == "__main__":
    unittest.main()
