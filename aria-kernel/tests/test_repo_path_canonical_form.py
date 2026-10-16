"""ARIA-MEDIUM-224 — one canonical repo-path form and GitHub's CODEOWNERS semantics.

Each case below is the review's reproducer; each failed before the fix.

* ``normalize_repo_relpath`` kept ``''`` and ``.`` segments (``docs//x.md``,
  ``docs/./x.md`` came back unchanged, a spelling no glob is written for),
  ``strip()``-ed whitespace that is part of a POSIX name, and rewrote a
  backslash — a legal POSIX name character — into a separator, so the
  classifier judged a different path than the one the change holds.
* ``codeowners_globs`` matched a directory pattern written without a
  trailing slash (``docs/aria``) as a file, so nothing under it was owned.
* ``is_self_output_ref`` compared raw text, so ``src/../aria-tools/x`` and
  ``.//aria-tools/x`` were not recognised as ARIA's own output.
* the policy validator admitted ``codeowners_lane: "L2"``.

ARIA-CRITICAL-215 — brace expansion has one public owner,
``expand_repo_glob``: the glob matcher and the L1 entry validator read the
same alternatives, so the validator judges exactly what the matcher matches.
"""
from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import canonical_path
from aria_kernel.canonical_path import (
    expand_repo_glob,
    matches_repo_glob,
    normalize_repo_relpath,
    resolve_repo_relpath,
)
from aria_kernel.evidence_trust import is_self_output_ref
from aria_kernel.risk_policy import (
    classify_change,
    codeowners_globs,
    codeowners_last_match,
    codeowners_rules,
    load_risk_policy,
)
from aria_kernel.tool_registry import GovernanceError


class NormalizeRepoRelpathTests(unittest.TestCase):
    def test_empty_and_dot_segments_are_refused(self) -> None:
        for raw in ("docs//x.md", "docs/./x.md", "docs/x.md/", "docs/.", "a/./"):
            with self.subTest(raw=raw), self.assertRaises(GovernanceError):
                normalize_repo_relpath(raw)

    def test_traversal_and_absolute_stay_refused(self) -> None:
        for raw in ("../x", "docs/../x", "/etc/passwd", "C:/x", "", "./"):
            with self.subTest(raw=raw), self.assertRaises(GovernanceError):
                normalize_repo_relpath(raw)

    def test_a_leading_dot_slash_prefix_is_still_removed(self) -> None:
        self.assertEqual(normalize_repo_relpath("./docs/x.md"), "docs/x.md")
        self.assertEqual(normalize_repo_relpath(".github/x.yml"), ".github/x.yml")

    def test_whitespace_is_part_of_the_name(self) -> None:
        self.assertEqual(normalize_repo_relpath(" docs/x.md"), " docs/x.md")
        self.assertEqual(normalize_repo_relpath("docs/x.md "), "docs/x.md ")

    def test_a_backslash_is_refused_not_rewritten(self) -> None:
        # `docs\x.md` is one root-level file on POSIX; rewriting it to
        # `docs/x.md` classified a file the change does not hold.
        for raw in ("docs\\x.md", "\\\\server\\share\\x", ".github\\workflows\\x.yml"):
            with self.subTest(raw=raw), self.assertRaises(GovernanceError):
                normalize_repo_relpath(raw)

    def test_a_control_character_is_refused(self) -> None:
        # ARIA-CRITICAL-215 (fix round) — `git diff -z` returns a name with a
        # newline verbatim. The glob matcher read it differently in `*` and
        # `**` and admitted a trailing newline after a literal suffix, so
        # `.../a\nb.test.ts` under a blocked tree was L1. No glob is written
        # for such a name: it is refused, as a backslash is.
        for raw in (
            "apps/billing-service/src/__tests__/a\nb.test.ts",
            "docs/x.md\n",
            "docs/\tx.md",
            "docs/\rx.md",
            "docs/x\x00.md",
            "docs/x\x1f.md",
            "docs/x\x7f.md",
        ):
            with self.subTest(raw=raw), self.assertRaisesRegex(GovernanceError, "repo_relpath_control_char"):
                normalize_repo_relpath(raw)

    def test_the_classifier_refuses_a_name_with_a_control_character(self) -> None:
        # Each was a valid L1 change: the first two inside trees L1 must
        # never reach (blocked billing-service; L3 integration suite), the
        # third a migration TypeORM's `[0-9]*.ts` glob loads.
        for path in (
            "apps/billing-service/src/__tests__/a\nb.test.ts",
            "apps/farm-service/src/__tests__/integration/a\nb.test.ts",
            "apps/ai-service/src/database/migrations/1900000000000-Evil\n.spec.ts",
            "apps/farm-service/src/__tests__/__mocks__/bcrypt.spec.ts\n",
        ):
            with self.subTest(path=path):
                verdict = classify_change([("A", path)])
                self.assertFalse(verdict.valid)
                self.assertEqual(verdict.lane, "blocked")
                self.assertEqual(verdict.reason_codes, ("risk_path_invalid",))

    def test_the_classifier_refuses_the_non_canonical_spelling(self) -> None:
        verdict = classify_change(["docs/./runbooks/x.md"])
        self.assertEqual(verdict.lane, "blocked")
        self.assertIn("risk_path_invalid", verdict.reason_codes)

    def test_a_whitespace_only_name_is_classified_not_dropped(self) -> None:
        verdict = classify_change(["docs/runbooks/x.md", " "])
        self.assertFalse(verdict.valid)
        self.assertIn(" ", verdict.changed_files)


class ResolveRepoRelpathTests(unittest.TestCase):
    def test_dot_empty_and_parent_segments_resolve_lexically(self) -> None:
        self.assertEqual(resolve_repo_relpath("src/../aria-tools/x"), "aria-tools/x")
        self.assertEqual(resolve_repo_relpath(".//aria-tools/x"), "aria-tools/x")
        self.assertEqual(resolve_repo_relpath("a/b/./../c"), "a/c")

    def test_escaping_the_root_is_refused(self) -> None:
        for raw in ("../x", "a/../../x", "/x", "", ".", "a/..", "a\\b"):
            with self.subTest(raw=raw), self.assertRaises(GovernanceError):
                resolve_repo_relpath(raw)


class ExpandRepoGlobTests(unittest.TestCase):
    def test_sequential_groups_give_their_cross_product(self) -> None:
        self.assertEqual(
            expand_repo_glob("a.{b,c}.{d,e}"),
            ("a.b.d", "a.b.e", "a.c.d", "a.c.e"),
        )

    def test_a_nested_group_stays_literal_for_the_caller_to_refuse(self) -> None:
        # Only the outermost group is expanded; the leftover braces are kept,
        # so the L1 validator sees them and refuses the entry.
        self.assertEqual(
            expand_repo_glob("apps/**/*.{spec.ts,{x,y}}"),
            ("apps/**/*.spec.ts", "apps/**/*.{x,y}"),
        )

    def test_a_pattern_without_braces_is_itself(self) -> None:
        self.assertEqual(expand_repo_glob("docs/**/*.md"), ("docs/**/*.md",))

    def test_the_pattern_is_read_in_its_lexical_repo_form(self) -> None:
        self.assertEqual(expand_repo_glob("./docs/*.{md,txt}"), ("docs/*.md", "docs/*.txt"))

    def test_every_wildcard_reads_a_newline_as_a_name_character(self) -> None:
        # ARIA-CRITICAL-215 (fix round) — `**` compiled to `.` without
        # DOTALL while `*` and `?` matched a newline, so a deny glob ending
        # in `/**` missed a name the allow glob `*.test.ts` matched.
        self.assertTrue(matches_repo_glob("apps/billing-service/a\nb.ts", "apps/billing-service/**"))
        self.assertTrue(matches_repo_glob("a/x\ny/b", "a/**/b"))
        self.assertTrue(matches_repo_glob("x\ny/b", "**/b"))

    def test_a_literal_suffix_ends_the_path(self) -> None:
        # `$` also matched before a trailing newline, so `*.spec.ts` matched
        # `a.spec.ts\n`: the L1 validator's "every match ends in the suffix"
        # did not hold for the matcher it reasons about.
        self.assertFalse(matches_repo_glob("x/a.spec.ts\n", "x/*.spec.ts"))
        self.assertFalse(matches_repo_glob("docs/x.md\n", "docs/**/*.md"))
        self.assertFalse(matches_repo_glob(".env\n", ".env"))

    def test_the_matcher_matches_through_the_public_expander(self) -> None:
        # One owner of brace semantics: replacing the expander changes what
        # the matcher matches, so no private copy can diverge from it.
        with patch.object(canonical_path, "expand_repo_glob", return_value=("x/y.md",)):
            self.assertTrue(matches_repo_glob("x/y.md", "unrelated/{a,b}"))


class SelfOutputRefTests(unittest.TestCase):
    def test_self_output_is_recognised_through_the_canonical_path(self) -> None:
        for ref in ("src/../aria-tools/x", ".//aria-tools/x", "aria-tools/x:12", "./aria-findings/F-1.json"):
            with self.subTest(ref=ref):
                self.assertTrue(is_self_output_ref(ref))

    def test_repository_paths_and_escapes_are_not_self_output(self) -> None:
        for ref in ("docs/runbooks/x.md", "aria-tools-not/x", "aria-tools/../docs/x.md", "../aria-tools/x"):
            with self.subTest(ref=ref):
                self.assertFalse(is_self_output_ref(ref))


class CodeownersSemanticsTests(unittest.TestCase):
    def _codeowners(self, text: str) -> Path:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "CODEOWNERS"
        path.write_text(text, encoding="utf-8")
        return path

    def _owned(self, source: Path, path: str) -> bool:
        return codeowners_last_match(path, source=source) is not None

    def test_a_directory_without_a_trailing_slash_owns_its_contents(self) -> None:
        source = self._codeowners("docs/aria @okan\n")
        self.assertTrue(self._owned(source, "docs/aria/x.md"))
        self.assertTrue(self._owned(source, "docs/aria/policy/risk-policy.json"))
        self.assertTrue(self._owned(source, "docs/aria"))
        self.assertFalse(self._owned(source, "docs/arias/x.md"))

    def test_a_trailing_slash_directory_owns_its_contents(self) -> None:
        source = self._codeowners("docs/adr/ @okan\n")
        self.assertTrue(self._owned(source, "docs/adr/045-x.md"))

    def test_a_pattern_without_a_slash_matches_at_any_depth(self) -> None:
        source = self._codeowners("CLAUDE.md @okan\nlogs @okan\n")
        self.assertTrue(self._owned(source, "CLAUDE.md"))
        self.assertTrue(self._owned(source, "apps/farm-service/CLAUDE.md"))
        self.assertTrue(self._owned(source, "apps/x/logs/today.txt"))

    def test_a_leading_slash_anchors_the_pattern(self) -> None:
        source = self._codeowners("/CLAUDE.md @okan\n/build/ @okan\n")
        self.assertTrue(self._owned(source, "CLAUDE.md"))
        self.assertFalse(self._owned(source, "apps/farm-service/CLAUDE.md"))
        self.assertTrue(self._owned(source, "build/x.js"))
        self.assertFalse(self._owned(source, "apps/build/x.js"))

    def test_an_inner_slash_anchors_the_pattern(self) -> None:
        source = self._codeowners("docs/plans @okan\n")
        self.assertFalse(self._owned(source, "apps/docs/plans/x.md"))

    def test_the_last_match_wins(self) -> None:
        source = self._codeowners("docs/ @docs-team\ndocs/aria/ @okan\n")
        self.assertEqual(codeowners_last_match("docs/aria/x.md", source=source).owners, ("@okan",))
        self.assertEqual(codeowners_last_match("docs/runbooks/x.md", source=source).owners, ("@docs-team",))

    def test_an_ownerless_last_match_is_still_owned(self) -> None:
        # GitHub reads a pattern with no owners as "no owner". The classifier
        # keeps it owned: forgetting an owner must never open the
        # unreviewed lane.
        source = self._codeowners("docs/aria/ @okan\ndocs/aria/generated/\n")
        match = codeowners_last_match("docs/aria/generated/x.md", source=source)
        self.assertIsNotNone(match)
        self.assertEqual(match.owners, ())

    def test_the_repository_file_parses_into_rules(self) -> None:
        rules = codeowners_rules()
        self.assertTrue(rules)
        self.assertIn("docs/aria/**", codeowners_globs())
        self.assertIn("**/aria-kernel/**", codeowners_globs())


class CodeownersLaneValidatorTests(unittest.TestCase):
    def test_only_l3_is_accepted(self) -> None:
        policy = copy.deepcopy(load_risk_policy())
        for lane in ("L1", "L2", "blocked", None):
            policy["codeowners_lane"] = lane
            with self.subTest(lane=lane), self.assertRaises(GovernanceError):
                load_risk_policy(policy)
        policy["codeowners_lane"] = "L3"
        self.assertEqual(load_risk_policy(policy)["codeowners_lane"], "L3")


if __name__ == "__main__":
    unittest.main()
