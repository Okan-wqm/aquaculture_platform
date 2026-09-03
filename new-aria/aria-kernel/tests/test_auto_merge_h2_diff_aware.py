"""Plan 022 H-2 — auto-merge content-aware classification + diff fail-closed.

Pre-Plan-022 evaluate_auto_merge classified PR risk via path globs only
(classify_changed_files). Suppression patterns (as any, // @ts-ignore,
.skip, runtime swallow) hidden in low-risk paths (apps/**/*.ts)
sailed through auto-merge.

Fix:
1. evaluate_auto_merge accepts diff_text kwarg; falls back to pr.diff_text.
2. None diff -> reasons += 'auto_merge_requires_diff_content'; eligible=False.
3. Diff content scanned via suppression_scanner; any hit demotes risk
   to 'unknown' AND adds an explicit 'diff carries N suppression
   pattern(s)' reason.
"""
from __future__ import annotations

import unittest

from aria_kernel.auto_merge import evaluate_auto_merge


_LOW_RISK_PATH = "docs/notes.md"  # in allowed_low_risk_globs (docs/**)
_TEST_LOW_RISK_PATH = "apps/x/foo.test.ts"  # in **/*.test.ts allowlist


def _base_pr_payload(**extras) -> dict:
    payload = {
        "number": 42,
        "base_branch": "main",
        "head_sha": "abc1234",
        "changed_files": [_LOW_RISK_PATH],
    }
    payload.update(extras)
    return payload


def _enabled_policy() -> dict:
    return {"enabled": True}


def _base_github_payload(**extras) -> dict:
    payload = {
        "latest_head_sha": "abc1234",
        "branch_protection": {"readable": True, "required_checks": ["ci-affected"]},
        "checks": {
            "readable": True,
            "runs": [{"name": "ci-affected", "status": "completed", "conclusion": "success"}],
        },
        "reviews": {"readable": True, "items": []},
        "conversations": {"readable": True, "unresolved_count": 0},
    }
    payload.update(extras)
    return payload


class AutoMergeContentScanTests(unittest.TestCase):
    def test_low_risk_path_with_clean_diff_eligible(self) -> None:
        decision = evaluate_auto_merge(
            pr=_base_pr_payload(),
            github=_base_github_payload(),
            policy=_enabled_policy(),
            diff_text="--- a/docs/notes.md\n+++ b/docs/notes.md\n+New paragraph\n",
        )
        self.assertTrue(decision["eligible"], decision["reasons"])

    def test_low_risk_path_with_ts_ignore_demoted_to_unknown(self) -> None:
        decision = evaluate_auto_merge(
            pr=_base_pr_payload(changed_files=[_TEST_LOW_RISK_PATH]),
            github=_base_github_payload(),
            policy=_enabled_policy(),
            diff_text=(
                "--- a/apps/x/foo.test.ts\n"
                "+++ b/apps/x/foo.test.ts\n"
                "+// @ts-ignore — silenced\n"
                "+const value: any = 1;\n"
            ),
        )
        self.assertFalse(decision["eligible"])
        self.assertIn("unknown", decision["risk"]["risk_class"])
        self.assertGreaterEqual(len(decision["risk"]["suppression_hits"]), 1)
        self.assertTrue(any("suppression pattern" in r for r in decision["reasons"]))

    def test_diff_text_none_fails_closed(self) -> None:
        # Plan 022 H-2 — auto-merge requires diff content. Pre-fix this
        # would have proceeded on path-class only.
        decision = evaluate_auto_merge(
            pr=_base_pr_payload(),
            github=_base_github_payload(),
            policy=_enabled_policy(),
            diff_text=None,
        )
        self.assertFalse(decision["eligible"])
        self.assertTrue(any("auto_merge_requires_diff_content" in r for r in decision["reasons"]))

    def test_pr_payload_carries_diff_text_used_as_fallback(self) -> None:
        # When the PR payload itself carries diff_text, it's used as
        # fallback when the kwarg is None. Plan 023 v3 §P-6 added a
        # structural unified-diff check (`+++ b/` header required); the
        # fixture diff now carries a real header so the integrity gate
        # passes through to the suppression-scan + path-class layers.
        decision = evaluate_auto_merge(
            pr=_base_pr_payload(diff_text=(
                "diff --git a/apps/x.ts b/apps/x.ts\n"
                "--- a/apps/x.ts\n"
                "+++ b/apps/x.ts\n"
                "@@ -1 +1 @@\n"
                "+const x = 1;\n"
            )),
            github=_base_github_payload(),
            policy=_enabled_policy(),
            diff_text=None,
        )
        # diff is clean -> eligible.
        self.assertTrue(decision["eligible"], decision["reasons"])


if __name__ == "__main__":
    unittest.main()
