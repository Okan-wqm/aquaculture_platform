from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.auto_merge import classify_changed_files, evaluate_auto_merge, merge_if_green
from aria_kernel.integrity import verify_integrity


def enabled_policy(**overrides):
    policy = {"enabled": True, "base_branch": "snowball", "merge_method": "squash"}
    policy.update(overrides)
    return policy


def pr(**overrides):
    payload = {
        "number": 42,
        "base_branch": "snowball",
        "head_sha": "abc123",
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
        "latest_head_sha": "abc123",
        "branch_protection": {"readable": True, "required_checks": ["ci/test", "ci/lint"]},
        "checks": {
            "readable": True,
            "runs": [
                {"name": "ci/test", "head_sha": "abc123", "status": "completed", "conclusion": "success"},
                {"name": "ci/lint", "head_sha": "abc123", "status": "completed", "conclusion": "success"},
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

    def test_policy_disabled_blocks_even_low_risk_green_pr(self):
        decision = evaluate_auto_merge(pr=pr(), github=github(), policy={}, base_dir=self.tools_dir)
        self.assertFalse(decision["eligible"])
        self.assertIn("policy disabled", decision["reasons"])

    def test_non_snowball_base_branch_blocks(self):
        decision = evaluate_auto_merge(
            pr=pr(base_branch="main"),
            github=github(),
            policy=enabled_policy(),
            base_dir=self.tools_dir,
        )
        self.assertFalse(decision["eligible"])
        self.assertIn("base branch must be snowball", decision["reasons"])

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
                    "runs": [{"name": "ci/test", "head_sha": "abc123", "status": "completed", "conclusion": "success"}],
                },
            ),
            github(
                checks={
                    "readable": True,
                    "runs": [
                        {"name": "ci/test", "head_sha": "abc123", "status": "completed", "conclusion": "success"},
                        {"name": "ci/lint", "head_sha": "abc123", "status": "in_progress", "conclusion": None},
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
        adapter = FakeGitHubAdapter(pr(), github(), latest_heads=["abc123", "abc123"])
        result = merge_if_green(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            cycle_id="cycle-merge",
            dry_run=False,
        )
        self.assertEqual(result["decision"], "merged")
        self.assertEqual(adapter.merge_calls, [{"number": 42, "method": "squash", "expected_head_sha": "abc123"}])
        decisions = [json.loads(line) for line in (self.tools_dir / "auto-merge-decisions.jsonl").read_text().splitlines()]
        self.assertEqual([row["decision"] for row in decisions], ["eligible", "merged"])

    def test_merge_command_not_called_when_checks_are_pending(self):
        adapter = FakeGitHubAdapter(
            pr(),
            github(
                checks={
                    "readable": True,
                    "runs": [
                        {"name": "ci/test", "head_sha": "abc123", "status": "completed", "conclusion": "success"},
                        {"name": "ci/lint", "head_sha": "abc123", "status": "queued", "conclusion": None},
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

    def test_merge_blocks_if_head_changes_after_green_evaluation(self):
        adapter = FakeGitHubAdapter(pr(), github(), latest_heads=["abc123", "def456"])
        result = merge_if_green(
            adapter=adapter,
            pr_number=42,
            policy=enabled_policy(),
            base_dir=self.tools_dir,
            dry_run=False,
        )
        self.assertEqual(result["decision"], "blocked")
        self.assertIn("PR head SHA changed after green evaluation", result["reasons"])
        self.assertEqual(adapter.merge_calls, [])


if __name__ == "__main__":
    unittest.main()
