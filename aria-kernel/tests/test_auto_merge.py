from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge import classify_changed_files, evaluate_auto_merge, merge_if_green
from aria_kernel.integrity import verify_integrity


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

    def test_merge_if_green_is_evaluate_only_even_when_green(self):
        adapter = FakeGitHubAdapter(pr(), github(), latest_heads=["abc1234", "abc1234"])
        result = merge_if_green(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            cycle_id="cycle-merge",
            dry_run=False,
        )
        self.assertEqual(result["decision"], "eligible")
        self.assertTrue(result["merge_authority_required"])
        self.assertEqual(result["stage"], "auto_merge_evaluation_only")
        self.assertEqual(adapter.merge_calls, [])
        decisions = [json.loads(line) for line in (self.tools_dir / "auto-merge-decisions.jsonl").read_text().splitlines()]
        self.assertEqual([row["decision"] for row in decisions], ["eligible", "eligible"])
        self.assertTrue(all(row["decision"] != "merged" for row in decisions))

    def test_merge_command_not_called_when_checks_are_pending(self):
        adapter = FakeGitHubAdapter(
            pr(),
            github(
                checks={
                    "readable": True,
                    "runs": [
                        {"name": "ci/test", "head_sha": "abc1234", "status": "completed", "conclusion": "success"},
                        {"name": "ci/lint", "head_sha": "abc1234", "status": "queued", "conclusion": None},
                    ],
                },
            ),
        )
        result = merge_if_green(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            dry_run=False,
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertEqual(adapter.merge_calls, [])

    def test_merge_if_green_no_longer_owns_pre_merge_boundary(self):
        adapter = FakeGitHubAdapter(pr(), github(), latest_heads=["abc1234", "def456"])
        result = merge_if_green(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            dry_run=False,
        )
        self.assertEqual(result["decision"], "eligible")
        self.assertEqual(result["stage"], "auto_merge_evaluation_only")
        self.assertTrue(result["merge_authority_required"])
        self.assertEqual(adapter.merge_calls, [])


if __name__ == "__main__":
    unittest.main()
