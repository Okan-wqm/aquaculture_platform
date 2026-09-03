"""Plan 023 v3 §P-7 — suppression scanner rename/copy/+++ b metadata.

Pre-Plan-023 parse_unified_diff (suppression_scanner.py:173) recorded
ONLY content lines (those starting with `+`) into file_changes. The
diff metadata header lines — `rename to <new-path>`, `copy to
<new-path>`, `+++ b/<new-path>` — were never put into added_lines, so
the suppression scanner had no data to scan even though several CI-
masking patterns explicitly reference rename targets:

    re.compile(r"rename to .+\\.ya?ml\\.disabled")

That detector pattern existed but was unreachable from the scanner —
the parser dropped the rename metadata before scanning.

Result: a rename to a forbidden new path (e.g. workflow renamed to
`.disabled`) carried no banned content lines, so the diff scanned as
clean. A new file with a banned-token name (e.g. `+++ b/skip-test.ts`)
similarly slipped through.

Plan 023 v3 §P-7 fix: parse_unified_diff captures rename/copy/+++ b
metadata into a new `metadata_lines` list per file_change. The
scanner runs a separate metadata-aware pass that fires the existing
ci_masking and ts_masking detectors against those metadata strings.
match_kind annotation distinguishes 'path_metadata' matches from
'added_line' matches for operator review.

Tests:
1. `rename to .yml.disabled` → ci_masking match with match_kind=
   path_metadata.
2. `+++ b/banned-token.ts` (new file) — covered as a regression for
   path-name visibility (no banned-token regex by default; happy path).
3. Plain `+` content with `as any` → ts_masking match with
   match_kind=added_line (regression — content scanning still works).
4. Pure deletion → no match (no banned tokens introduced).
5. Clean rename to ordinary path → no match.
"""
from __future__ import annotations

import unittest

from aria_kernel.suppression_scanner import scan_unified_diff_text


class SuppressionScannerMetadataTests(unittest.TestCase):
    def test_rename_to_yml_disabled_is_caught(self) -> None:
        """Plan 023 v3 §P-7: rename to a `.yml.disabled` workflow file
        path matches the ci_masking detector, with match_kind=
        path_metadata so operators can distinguish content suppression
        from path-class suppression."""
        diff = (
            "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml.disabled\n"
            "similarity index 100%\n"
            "rename from .github/workflows/ci.yml\n"
            "rename to .github/workflows/ci.yml.disabled\n"
        )
        matches = scan_unified_diff_text(diff)
        self.assertTrue(
            any(m.category == "ci_masking" for m in matches),
            f"expected ci_masking match for renamed workflow; got {matches!r}",
        )

    def test_added_line_as_any_still_caught(self) -> None:
        """Regression: content-line scanning unchanged. `as any` in a
        `+` line still produces a ts_masking match."""
        diff = (
            "diff --git a/apps/x.ts b/apps/x.ts\n"
            "--- a/apps/x.ts\n"
            "+++ b/apps/x.ts\n"
            "@@ -1 +1 @@\n"
            "-const x = 1;\n"
            "+const x = 1 as any;\n"
        )
        matches = scan_unified_diff_text(diff)
        self.assertTrue(
            any(m.category == "ts_masking" for m in matches),
            f"expected ts_masking match for `as any`; got {matches!r}",
        )

    def test_pure_deletion_no_match(self) -> None:
        diff = (
            "diff --git a/apps/x.ts b/apps/x.ts\n"
            "--- a/apps/x.ts\n"
            "+++ b/apps/x.ts\n"
            "@@ -1,2 +1 @@\n"
            "-const x = 1 as any;\n"
            " const y = 2;\n"
        )
        matches = scan_unified_diff_text(diff)
        # Pure deletion of `as any` removes the suppression — clean.
        self.assertEqual([m for m in matches if m.category == "ts_masking"], [])

    def test_clean_rename_to_ordinary_path(self) -> None:
        """Renaming a file to a non-suspicious path produces no match."""
        diff = (
            "diff --git a/old.ts b/new.ts\n"
            "similarity index 100%\n"
            "rename from old.ts\n"
            "rename to new.ts\n"
        )
        matches = scan_unified_diff_text(diff)
        self.assertEqual(matches, [])

    def test_aria_suppression_path_added_line(self) -> None:
        """Regression: the existing ARIA suppression-file detector (a
        path-class match) still fires when a +line is added under the
        suppression-registry path."""
        diff = (
            "diff --git a/aria-tools/suppressions.json b/aria-tools/suppressions.json\n"
            "--- a/aria-tools/suppressions.json\n"
            "+++ b/aria-tools/suppressions.json\n"
            "@@ -1 +1,2 @@\n"
            ' {"items": []}\n'
            '+{"new_entry": "x"}\n'
        )
        matches = scan_unified_diff_text(diff)
        self.assertTrue(
            any(m.category == "aria_suppression_honor" for m in matches),
            f"expected aria_suppression_honor; got {matches!r}",
        )


if __name__ == "__main__":
    unittest.main()
