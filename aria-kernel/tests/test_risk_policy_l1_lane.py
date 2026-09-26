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

ARIA-CRITICAL-215 (plan 037) — L1 still held the repository's CI gate suites
and contract inputs (``**/*.spec.ts`` reached ``e2e/tests/integration``,
``tests/**`` and ``**/test_*.py`` reached ``tools/lint-gates`` and
``tools/shared/invariants``, ``docs/**`` reached the OpenAPI contracts), so an
unreviewed ARIA merge could weaken the gate that judges it. L1 is now an
explicit allowlist that the L3 exclusion list outranks;
``test_risk_policy_ci_gate_paths.py`` derives the gate set from the workflows.

These tests pin the lane table, the single glob semantics, the CODEOWNERS
override and the single low-risk answer.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import auto_merge, risk_policy
from aria_kernel.risk_policy import classify_change, classify_path, codeowners_globs


def _lane(path: str) -> str:
    return classify_change([path]).lane


class L1LaneTableTests(unittest.TestCase):
    def test_behaviour_neutral_paths_are_l1(self) -> None:
        for path in (
            "docs/runbooks/x.md",
            "docs/guides/scada.md",
            "apps/farm-service/src/batch/__tests__/batch.spec.ts",
            "apps/farm-service/src/batch/batch.service.spec.ts",
            "libs/backend-common/src/guards/x.spec.ts",
            "web/modules/farm-module/src/__tests__/x.test.tsx",
        ):
            with self.subTest(path=path):
                self.assertEqual(_lane(path), "L1")

    def test_l1_is_the_explicit_allowlist(self) -> None:
        # ARIA-CRITICAL-215 — the unreviewed lane is a short list of trees
        # the operator admitted (plan 037, 2026-09-26): prose under docs/
        # and the unit-test trees of apps/, libs/ and web/. Widening it is a
        # policy change this test makes visible.
        self.assertEqual(
            risk_policy.load_risk_policy()["lanes"]["L1"]["globs"],
            [
                "docs/**/*.md",
                "apps/**/__tests__/**",
                "libs/**/__tests__/**",
                "web/**/__tests__/**",
                "apps/**/src/**/*.spec.ts",
                "libs/**/src/**/*.spec.ts",
                "web/**/src/**/*.spec.ts",
            ],
        )

    def test_the_source_beside_a_unit_test_stays_supervised(self) -> None:
        for path in (
            "apps/farm-service/src/batch/batch.service.ts",
            "web/modules/farm-module/src/x.tsx",
        ):
            with self.subTest(path=path):
                self.assertEqual(_lane(path), "L2")

    def test_ci_gate_suites_and_contract_inputs_are_never_l1(self) -> None:
        # ARIA-CRITICAL-215 — the review's evidence: suites a required check
        # executes, and files it reads as expected values.
        for path in (
            "e2e/tests/integration/nats-invariants.spec.ts",
            "e2e/tests/integration/schema-invariants.spec.ts",
            "tests/e2e/foo.spec.ts",
            "tools/lint-gates/x.spec.ts",
            "tools/shared/invariants/test_x.py",
            "tools/aria-adapters/doc-staleness-adapter.test.ts",
            "tools/aria-adapters/fixtures/doc-staleness/cases/a.json",
            "docs/api/openapi/farm-service.yaml",
            "docs/api/farm-service-errors.md",
            "docs/plans/x/README.md",
            "docs/adr/045-x.md",
            "apps/farm-service/src/__tests__/invariants/x.spec.ts",
            "apps/farm-service/src/batch/__tests__/integration/x.integration.spec.ts",
            "apps/auth-service/src/x.postgres.spec.ts",
            "apps/farm-service/src/regulatory/__tests__/contract/x.spec.ts",
            "apps/admin-api-service/src/__tests__/contract-validation.spec.ts",
            "libs/migration-harness/src/__tests__/x.spec.ts",
            "package-lock.json",
            "web/apps/aquamobil/package-lock.json",
            "Cargo.lock",
            "apps/farm-service/CLAUDE.md",
        ):
            with self.subTest(path=path):
                self.assertNotEqual(_lane(path), "L1")

    def test_data_files_under_docs_are_not_l1(self) -> None:
        # Only prose is admitted; a schema, a collection or a manifest under
        # docs/ is what a gate reads as expected values.
        for path in ("docs/release/x.schema.json", "docs/api/postman/collection.json", "docs/x.yml"):
            with self.subTest(path=path):
                self.assertNotEqual(_lane(path), "L1")

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

    def test_the_exclusions_hold_without_codeowners(self) -> None:
        # ARIA-CRITICAL-215 — the policy file keeps every excluded path out
        # of L1 on its own; CODEOWNERS is a second reason, so an owner line
        # removed in review cannot widen the unreviewed lane.
        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "CODEOWNERS"
            empty.write_text("", encoding="utf-8")
            with patch.object(risk_policy, "CODEOWNERS_PATH", empty):
                for path in (
                    "e2e/tests/integration/nats-invariants.spec.ts",
                    "tools/lint-gates/x.spec.ts",
                    "tools/shared/invariants/test_x.py",
                    "tests/invariants/x.spec.ts",
                    "apps/farm-service/src/__tests__/invariants/x.spec.ts",
                    "tests/e2e/foo.spec.ts",
                    "docs/api/openapi/farm-service.yaml",
                    "docs/aria/x.md",
                    "docs/reviews/x.md",
                    "docs/plans/x.md",
                    "docs/adr/x.md",
                    "CLAUDE.md",
                    "apps/farm-service/CLAUDE.md",
                    ".claude/agents/x.md",
                    ".github/workflows/x.yml",
                    "package-lock.json",
                    "e2e/package-lock.json",
                    "Cargo.lock",
                ):
                    with self.subTest(path=path):
                        self.assertEqual(classify_path(path), "L3")


class SingleLowRiskAnswerTests(unittest.TestCase):
    def test_auto_merge_has_no_private_l1_list(self) -> None:
        self.assertNotIn("allowed_low_risk_globs", auto_merge.DEFAULT_POLICY)

    def test_auto_merge_low_risk_equals_policy_l1(self) -> None:
        for path in (
            "docs/runbooks/x.md",
            "apps/farm-service/src/x.spec.ts",
            ".claude/agents/x.md",
            "aria-kernel/tests/test_x.py",
            "README.md",
            "e2e/tests/integration/nats-invariants.spec.ts",
        ):
            with self.subTest(path=path):
                verdict = auto_merge.classify_changed_files([path])
                self.assertEqual(verdict["risk_class"] == "low", classify_path(path) == "L1")

    def test_matchers_are_one_implementation(self) -> None:
        from aria_kernel import canonical_path

        self.assertIs(risk_policy.matches_repo_glob, canonical_path.matches_repo_glob)
        self.assertIs(auto_merge.matches_repo_glob, canonical_path.matches_repo_glob)


if __name__ == "__main__":
    unittest.main()
