"""ARIA-HIGH-187 — the L1 lane is the lane ARIA may merge unreviewed.

Pre-fix:
* ``risk-policy.json`` put ``aria-kernel/tests/**`` (the invariant suite) and
  ``tools/aria-adapters/*.tool.json`` (adapter argv) in L1;
* both classifiers matched with ``fnmatch``, whose ``*`` crosses ``/`` — so
  ``*.md`` put ``.claude/agents/*.md`` in L1 — and whose ``**/.env*`` never
  matched a root ``.env``;
* ``auto_merge`` carried its own copy of the L1 list, a second answer that
  could drift from the policy file;
* nothing stopped a CODEOWNERS path from being L1, i.e. merged without its
  owner.

These tests pin the lane table, the single glob semantics, the CODEOWNERS
override and the single low-risk answer.
"""
from __future__ import annotations

import unittest

from aria_kernel import auto_merge, risk_policy
from aria_kernel.risk_policy import classify_change, classify_path, codeowners_globs


def _lane(path: str) -> str:
    return classify_change([path]).lane


class L1LaneTableTests(unittest.TestCase):
    def test_behaviour_neutral_paths_are_l1(self) -> None:
        for path in (
            "docs/runbooks/x.md",
            "docs/guides/scada.md",
            "tools/aria-adapters/fixtures/doc-staleness/cases/a.json",
            "tools/aria-adapters/doc-staleness-adapter.test.ts",
            "tests/e2e/foo.spec.ts",
        ):
            with self.subTest(path=path):
                self.assertEqual(_lane(path), "L1")

    def test_tests_inside_runtime_source_trees_stay_supervised(self) -> None:
        # Narrow lane by decision (plan 034): a spec file under a runtime
        # src/ tree shares that tree's build and stays L2 (supervised).
        for path in (
            "apps/farm-service/src/batch/__tests__/batch.spec.ts",
            "web/modules/farm-module/src/x.test.tsx",
        ):
            with self.subTest(path=path):
                self.assertEqual(_lane(path), "L2")

    def test_agent_contracts_and_root_docs_are_never_l1(self) -> None:
        for path in (".claude/agents/x.md", ".claude/skills/y/SKILL.md", "CLAUDE.md", "README.md"):
            with self.subTest(path=path):
                self.assertNotEqual(_lane(path), "L1")

    def test_aria_audit_trail_and_kernel_tests_are_never_l1(self) -> None:
        for path in (
            "docs/aria/x.md",
            "docs/reviews/claude/2026-09-25-x.md",
            "docs/reviews/_registry/findings.jsonl",
            "aria-kernel/tests/test_x.py",
            "tests/invariants/a.spec.ts",
            "tools/aria-adapters/doc-staleness-adapter.tool.json",
            "tools/aria-poc/test_poc.py",
        ):
            with self.subTest(path=path):
                self.assertNotEqual(_lane(path), "L1")

    def test_docs_aria_is_l3(self) -> None:
        self.assertEqual(_lane("docs/aria/x.md"), "L3")

    def test_root_and_nested_env_files_are_blocked(self) -> None:
        for path in (".env", ".env.prod", "apps/x/.env.local"):
            with self.subTest(path=path):
                verdict = classify_change([path])
                self.assertEqual(verdict.lane, "blocked")
                self.assertIn("risk_blocked_path", verdict.reason_codes)

    def test_secret_directories_are_blocked(self) -> None:
        for path in ("apps/secrets/x.ts", "docs/credentials/y.md"):
            with self.subTest(path=path):
                self.assertEqual(_lane(path), "blocked")

    def test_mixed_l1_and_l2_diff_is_not_l1(self) -> None:
        verdict = classify_change(["docs/runbooks/x.md", "apps/farm-service/src/x.ts"])
        self.assertFalse(verdict.valid)
        self.assertIn("risk_mixed_lanes", verdict.reason_codes)

    def test_traversal_is_refused_not_classified(self) -> None:
        verdict = classify_change(["../docs/x.md"])
        self.assertEqual(verdict.lane, "blocked")
        self.assertIn("risk_path_invalid", verdict.reason_codes)


class CodeownersOverrideTests(unittest.TestCase):
    def test_every_codeowners_path_is_owner_review_lane(self) -> None:
        for path in ("docs/adr/045-x.md", "docs/plans/x/README.md", "package.json", "apps/farm-service/package.json"):
            with self.subTest(path=path):
                verdict = classify_change([path])
                self.assertEqual(verdict.lane, "L3")
                self.assertIn("risk_codeowners_path", verdict.reason_codes)

    def test_codeowners_patterns_follow_github_semantics(self) -> None:
        globs = codeowners_globs()
        # `aria-kernel/` (no leading slash) owns an aria-kernel directory at
        # any depth, the root one included.
        self.assertIn("**/aria-kernel/**", globs)
        # An inner slash anchors at the root.
        self.assertIn("docs/aria/**", globs)
        # A pattern without a slash matches at any depth.
        self.assertIn("**/package.json", globs)
        # A directory wildcard does not cross segments.
        self.assertIn("apps/*/src/migrations/**", globs)

    def test_no_l1_glob_can_match_an_owned_path(self) -> None:
        self.assertEqual(classify_path("tests/invariants/x.spec.ts"), "L3")
        self.assertEqual(classify_path("docs/adr/x.md"), "L3")


class SingleLowRiskAnswerTests(unittest.TestCase):
    def test_auto_merge_has_no_private_l1_list(self) -> None:
        self.assertNotIn("allowed_low_risk_globs", auto_merge.DEFAULT_POLICY)

    def test_auto_merge_low_risk_equals_policy_l1(self) -> None:
        for path in ("docs/runbooks/x.md", ".claude/agents/x.md", "aria-kernel/tests/test_x.py", "README.md"):
            with self.subTest(path=path):
                verdict = auto_merge.classify_changed_files([path])
                self.assertEqual(verdict["risk_class"] == "low", classify_path(path) == "L1")

    def test_matchers_are_one_implementation(self) -> None:
        from aria_kernel import canonical_path

        self.assertIs(risk_policy.matches_repo_glob, canonical_path.matches_repo_glob)
        self.assertIs(auto_merge.matches_repo_glob, canonical_path.matches_repo_glob)


if __name__ == "__main__":
    unittest.main()
