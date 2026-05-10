"""Plan 022 §C-7 / §C-8 — scope-glob bug coverage.

Pre-fix bugs that this suite enforces against regression:

* ``DEFAULT_FORBIDDEN_READ_GLOBS`` blanket-forbade ``.claude/**``,
  ``aria-tools/**``, etc., overriding any tool's ``allowed_read_globs``
  opt-in.  Now split into ``HARD_FORBIDDEN_READ_GLOBS`` (non-overridable)
  and ``DEFAULT_DENY_READ_GLOBS`` (default-deny lifted by an explicit
  allow entry).
* ``find_scope_violations`` checked forbidden BEFORE allowed; explicit
  allow could not rescue a default-forbidden path.  Now allow can lift
  default-deny but not hard-forbidden, and per-tool forbidden still
  trumps allow.
* ``matches_glob`` was ``fnmatch`` only — no brace expansion
  (``*.{yml,yaml}`` always False) and no real recursive ``**`` (a path
  with two ``**`` segments like ``apps/**/outbox/**/*.ts`` against
  ``apps/farm-service/src/outbox/x.ts`` always False).  Now both work.
"""

from __future__ import annotations

import inspect
import unittest

from aria_kernel.tool_health import (
    DEFAULT_DENY_READ_GLOBS,
    DEFAULT_FORBIDDEN_READ_GLOBS,
    HARD_FORBIDDEN_READ_GLOBS,
    find_scope_violations,
    matches_glob,
)


class BraceExpansionTests(unittest.TestCase):
    """Verify ``{a,b,c}`` patterns expand into N alternative matches."""

    def test_brace_expansion_yml_yaml(self) -> None:
        # Both branches of the alternation match.
        self.assertTrue(
            matches_glob(".github/workflows/x.yml", ".github/workflows/*.{yml,yaml}"),
        )
        self.assertTrue(
            matches_glob(".github/workflows/x.yaml", ".github/workflows/*.{yml,yaml}"),
        )
        # A non-listed extension does not match.
        self.assertFalse(
            matches_glob(".github/workflows/x.json", ".github/workflows/*.{yml,yaml}"),
        )

    def test_brace_expansion_nested(self) -> None:
        # `a.{b,c}.{d,e}` yields 4 combinations: a.b.d, a.b.e, a.c.d, a.c.e
        for first in ("b", "c"):
            for second in ("d", "e"):
                self.assertTrue(
                    matches_glob(f"a.{first}.{second}", "a.{b,c}.{d,e}"),
                    msg=f"expected match for a.{first}.{second}",
                )
        # A combination outside the cross-product does not match.
        self.assertFalse(matches_glob("a.x.d", "a.{b,c}.{d,e}"))
        self.assertFalse(matches_glob("a.b.x", "a.{b,c}.{d,e}"))

    def test_brace_expansion_three_branches(self) -> None:
        # Three-way alternation in a single group.
        self.assertTrue(matches_glob("foo.py", "foo.{py,ts,go}"))
        self.assertTrue(matches_glob("foo.ts", "foo.{py,ts,go}"))
        self.assertTrue(matches_glob("foo.go", "foo.{py,ts,go}"))
        self.assertFalse(matches_glob("foo.rs", "foo.{py,ts,go}"))


class DoubleStarStarTests(unittest.TestCase):
    """Verify ``**`` matches multiple path segments and zero-folds."""

    def test_double_starstar_matches_deep_path(self) -> None:
        # Two `**` segments in one pattern, both folding to multi-segment.
        violations = find_scope_violations(
            {"allowed_read_globs": ["apps/**/outbox/**/*.ts"]},
            ["apps/farm-service/src/outbox/x.outbox.ts"],
        )
        self.assertEqual(violations, [])

    def test_double_starstar_zero_segment(self) -> None:
        # Both `**` zero-fold: `apps/**/outbox/**/*.ts` matches `apps/outbox/x.ts`.
        self.assertTrue(
            matches_glob("apps/outbox/x.ts", "apps/**/outbox/**/*.ts"),
        )
        # First `**` zero-folds, second multi-folds.
        self.assertTrue(
            matches_glob("apps/outbox/sub/x.ts", "apps/**/outbox/**/*.ts"),
        )
        # First multi-folds, second zero-folds.
        self.assertTrue(
            matches_glob("apps/farm-service/src/outbox/x.ts", "apps/**/outbox/**/*.ts"),
        )

    def test_leading_starstar(self) -> None:
        # `**/b` matches both `b` (zero-fold) and `a/x/b` (multi-fold).
        self.assertTrue(matches_glob("b", "**/b"))
        self.assertTrue(matches_glob("a/x/b", "**/b"))
        # Should NOT match `b/x` because the trailing literal is a file.
        self.assertFalse(matches_glob("b/x", "**/b"))

    def test_trailing_starstar(self) -> None:
        # `a/**` matches `a` (zero-fold) and `a/x/y` (multi-fold).
        self.assertTrue(matches_glob("a", "a/**"))
        self.assertTrue(matches_glob("a/x", "a/**"))
        self.assertTrue(matches_glob("a/x/y", "a/**"))
        self.assertFalse(matches_glob("b/x", "a/**"))


class FiveTierEvaluationTests(unittest.TestCase):
    """Verify the 5-tier evaluation order in ``find_scope_violations``."""

    def test_explicit_allow_overrides_default_deny(self) -> None:
        # Pre-fix this returned a violation because the blanket forbidden
        # tuple was checked first.
        violations = find_scope_violations(
            {"allowed_read_globs": [".claude/agents/**/*.md"]},
            [".claude/agents/x.md"],
        )
        self.assertEqual(violations, [])

    def test_hard_forbidden_never_overridable(self) -> None:
        # Even with an explicit allow on `.git/**`, the path is rejected.
        violations = find_scope_violations(
            {"allowed_read_globs": [".git/**"]},
            [".git/HEAD"],
        )
        self.assertEqual(violations, [".git/HEAD"])

    def test_hard_forbidden_secrets(self) -> None:
        violations = find_scope_violations(
            {"allowed_read_globs": ["secrets/**", ".env"]},
            ["secrets/keys.pem", ".env"],
        )
        self.assertEqual(sorted(violations), sorted(["secrets/keys.pem", ".env"]))

    def test_per_tool_forbidden_blocks_explicit_allow(self) -> None:
        # Per-tool forbidden takes precedence over allow.
        violations = find_scope_violations(
            {
                "allowed_read_globs": ["foo/**"],
                "forbidden_read_globs": ["foo/private/**"],
            },
            ["foo/private/x.ts", "foo/public/x.ts"],
        )
        self.assertEqual(violations, ["foo/private/x.ts"])

    def test_no_allow_list_legacy_path(self) -> None:
        # No declared allow list = no scope check (legacy compatibility),
        # provided the path is not in any forbidden tier.
        violations = find_scope_violations({}, ["random/path.ts"])
        self.assertEqual(violations, [])

    def test_no_allow_list_default_deny_still_blocks(self) -> None:
        # Even with no allow list, the default-deny tier still blocks
        # paths matching the soft deny patterns.
        violations = find_scope_violations({}, [".claude/agents/x.md"])
        self.assertEqual(violations, [".claude/agents/x.md"])

    def test_no_allow_list_hard_forbidden_blocks(self) -> None:
        # Hard-forbidden tier always applies, even with no declared scope.
        violations = find_scope_violations({}, [".git/HEAD", "secrets/x.pem"])
        self.assertEqual(sorted(violations), sorted([".git/HEAD", "secrets/x.pem"]))

    def test_explicit_allow_strict_mode(self) -> None:
        # Once `allowed_read_globs` is non-empty, the tool opts into strict
        # mode: paths that do not match any allow pattern are violations.
        violations = find_scope_violations(
            {"allowed_read_globs": ["docs/**"]},
            ["docs/spec.md", "src/main.py"],
        )
        self.assertEqual(violations, ["src/main.py"])


class BackwardsCompatTests(unittest.TestCase):
    """Verify the existing simple-pattern behaviour is preserved."""

    def test_simple_extension_pattern(self) -> None:
        self.assertTrue(matches_glob("foo/bar.ts", "foo/*.ts"))
        self.assertFalse(matches_glob("foo/bar.js", "foo/*.ts"))

    def test_simple_recursive_pattern(self) -> None:
        # Pre-fix: `apps/farm-service/**` worked via fnmatch — must still work.
        self.assertTrue(matches_glob("apps/farm-service/src/x.ts", "apps/farm-service/**"))
        self.assertFalse(matches_glob("apps/sensor-service/src/x.ts", "apps/farm-service/**"))

    def test_default_forbidden_alias_still_exported(self) -> None:
        # External importers (none in-repo per grep, but defensive) may
        # still depend on the pre-fix tuple.  Equivalent to the union.
        expected_set = set(HARD_FORBIDDEN_READ_GLOBS) | set(DEFAULT_DENY_READ_GLOBS)
        self.assertEqual(set(DEFAULT_FORBIDDEN_READ_GLOBS), expected_set)
        # Tuple ordering: hard tier first, then default-deny tier.
        self.assertEqual(
            DEFAULT_FORBIDDEN_READ_GLOBS,
            HARD_FORBIDDEN_READ_GLOBS + DEFAULT_DENY_READ_GLOBS,
        )

    def test_signature_unchanged(self) -> None:
        # find_scope_violations(tool, read_paths) — same signature as pre-fix
        # so existing call sites in evidence_validator.py and tool_runner.py
        # continue to work without modification.
        sig = inspect.signature(find_scope_violations)
        params = list(sig.parameters)
        self.assertEqual(params, ["tool", "read_paths"])

    def test_question_mark_glob(self) -> None:
        # `?` matches one non-slash character (rare but valid glob).
        self.assertTrue(matches_glob("a/b.tx", "a/b.??"))
        self.assertFalse(matches_glob("a/b.txt", "a/b.??"))

    def test_normalize_path_in_violations(self) -> None:
        # Backslashes and `./` prefixes are normalized before matching,
        # so a Windows-style or relative-path entry matches the same way.
        violations = find_scope_violations(
            {"allowed_read_globs": ["docs/**"]},
            ["./docs/spec.md", "docs\\guide.md"],
        )
        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
