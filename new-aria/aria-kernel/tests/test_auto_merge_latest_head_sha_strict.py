"""Plan 023 v3 §P-4 — latest_head_sha strict (no fallback).

Pre-Plan-023 auto_merge.py:174 derived latest_head_sha as:

    latest_head_sha = _first_string(github, "latest_head_sha") or head_sha

The `or head_sha` fallback meant: if the gh adapter failed to populate
github.latest_head_sha (network error, API 5xx, snapshot construction
bug), latest_head_sha was assigned the proposal's own head_sha. The
follow-up equality check (`head_sha != latest_head_sha`) then always
passed because both were the SAME value. A force-push between PR open
and auto-merge eligibility evaluation was invisible — the gate cleared
on a stale snapshot.

Plan 023 v3 §P-4 fix: remove the `or head_sha` fallback. When the
lookup returns empty, the existing `if not latest_head_sha: reasons.
append("latest PR head SHA unavailable")` check fires, and the gate
blocks. The architectural intent of latest_head_sha is "the live SHA
on github at gate-evaluation time"; conflating it with head_sha
defeats the force-push detection.

Tests:
1. latest_head_sha == head_sha → eligible (clean equality).
2. latest_head_sha != head_sha → blocked with the head-changed reason.
3. latest_head_sha is None / missing → blocked with the
   latest-PR-head-SHA-unavailable reason (was silently passing pre-fix).
"""
from __future__ import annotations

import unittest

from aria_kernel.auto_merge import evaluate_auto_merge


def _make_pr(*, head_sha: str = "abc1234567890abc1234567890abc1234567890a") -> dict:
    return {
        "number": 42,
        "base_branch": "main",
        "head_sha": head_sha,
        "changed_files": [{"path": "apps/x.ts"}],
    }


def _make_github(
    *,
    latest_head_sha: str | None,
    required_checks: list[str] | None = None,
    runs: list[dict] | None = None,
) -> dict:
    block: dict = {
        "branch_protection": {
            "readable": True,
            "required_checks": required_checks or ["ci-affected"],
        },
        "checks": {
            "readable": True,
            "runs": runs or [
                {"name": "ci-affected", "status": "completed", "conclusion": "success"},
            ],
        },
        "workflow_runs": [],
        "reviews": {"readable": True, "items": []},
        "conversations": {"readable": True, "unresolved_count": 0},
    }
    if latest_head_sha is not None:
        block["latest_head_sha"] = latest_head_sha
    return block


def _make_policy() -> dict:
    return {
        "enabled": True,
        "base_branch": "main",
        "merge_method": "squash",
        "low_risk_paths": ["apps/**/*.ts"],
        "high_risk_paths": [],
        "forbidden_paths": [],
    }


class LatestHeadShaStrictTests(unittest.TestCase):
    def test_latest_equals_head_eligible(self) -> None:
        """Baseline regression: when the lookup returns the same SHA as
        the PR's head_sha (no force-push), auto-merge proceeds."""
        head = "abc1234567890abc1234567890abc1234567890a"
        result = evaluate_auto_merge(
            pr=_make_pr(head_sha=head),
            github=_make_github(latest_head_sha=head),
            policy=_make_policy(),
            diff_text="diff --git a/apps/x.ts b/apps/x.ts\n+++ b/apps/x.ts\n+const x = 1;\n",
        )
        self.assertEqual(
            [r for r in result["reasons"] if "head SHA" in r],
            [],
            f"unexpected head-SHA reason: {result['reasons']!r}",
        )

    def test_latest_differs_from_head_blocks(self) -> None:
        """A force-push between snapshot construction and eligibility
        evaluation lands a different latest_head_sha; the gate blocks
        with an explicit reason."""
        head = "abc1234567890abc1234567890abc1234567890a"
        latest = "9999999999999999999999999999999999999999"
        result = evaluate_auto_merge(
            pr=_make_pr(head_sha=head),
            github=_make_github(latest_head_sha=latest),
            policy=_make_policy(),
            diff_text="diff --git a/apps/x.ts b/apps/x.ts\n+++ b/apps/x.ts\n+const x = 1;\n",
        )
        self.assertTrue(
            any("head SHA changed" in r for r in result["reasons"]),
            f"missing force-push reason: {result['reasons']!r}",
        )

    def test_missing_latest_head_sha_blocks(self) -> None:
        """Plan 023 v3 §P-4: lookup failure (None / missing field) must
        NOT silently fall back to head_sha. The existing
        'latest PR head SHA unavailable' reason fires; gate blocks.
        Pre-fix the `or head_sha` fallback made this case a silent
        spurious pass."""
        head = "abc1234567890abc1234567890abc1234567890a"
        result = evaluate_auto_merge(
            pr=_make_pr(head_sha=head),
            github=_make_github(latest_head_sha=None),  # missing field
            policy=_make_policy(),
            diff_text="diff --git a/apps/x.ts b/apps/x.ts\n+++ b/apps/x.ts\n+const x = 1;\n",
        )
        self.assertTrue(
            any("latest PR head SHA unavailable" in r for r in result["reasons"]),
            f"missing latest-unavailable reason: {result['reasons']!r}",
        )


if __name__ == "__main__":
    unittest.main()
