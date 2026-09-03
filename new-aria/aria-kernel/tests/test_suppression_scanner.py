"""Tests for the Plan 016 Faz D3 diff-content suppression scanner."""
from __future__ import annotations

import unittest

from aria_kernel.suppression_scanner import (
    parse_unified_diff,
    scan_diff_added_lines,
    scan_unified_diff_text,
)


def _change(path: str, *added_lines: tuple[int, str]) -> dict:
    return {"path": path, "added_lines": list(added_lines)}


class TestSkipDetectorTests(unittest.TestCase):
    def test_jest_describe_skip_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.spec.ts", (10, "describe.skip('flaky', () => {"))]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "test_skip")
        self.assertEqual(matches[0].file, "apps/foo.spec.ts")

    def test_xit_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.spec.ts", (5, "xit('broken', () => { ... });"))]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "test_skip")

    def test_junit_disabled_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("Module.java", (3, "@Disabled"))]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "test_skip")

    def test_normal_test_definition_not_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.spec.ts", (10, "describe('happy path', () => {"))]
        )
        self.assertEqual(matches, [])


class CIMaskingDetectorTests(unittest.TestCase):
    def test_continue_on_error_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change(".github/workflows/ci.yml", (12, "  continue-on-error: true"))]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "ci_masking")

    def test_workflow_disable_comment_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change(".github/workflows/ci.yml", (1, "# disabled-workflow"))]
        )
        self.assertEqual(len(matches), 1)


class TSMaskingDetectorTests(unittest.TestCase):
    def test_ts_ignore_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.ts", (12, "// @ts-ignore"))]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "ts_masking")

    def test_as_any_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.ts", (12, "const x = value as any;"))]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "ts_masking")

    def test_as_unknown_as_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[
                _change("apps/foo.ts", (12, "const x = value as unknown as Foo;"))
            ]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "ts_masking")

    def test_legitimate_record_string_any_not_caught(self) -> None:
        # Narrow-typed `Record<string, any>` is annoying but not a suppression.
        # Our detector deliberately catches it (broad) — false-positive cheaper
        # than missing real suppressions. So this test asserts the broad catch
        # IS the intended behavior.
        matches = scan_diff_added_lines(
            file_changes=[
                _change("apps/foo.ts", (12, "const x: Record<string, any> = {};"))
            ]
        )
        # Detector matches `as any` only; bare `: Record<string, any>` does NOT
        # get caught because we only flag the cast keyword.
        self.assertEqual(matches, [])

    def test_eslint_disable_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.ts", (12, "// eslint-disable-next-line"))]
        )
        self.assertEqual(len(matches), 1)


class RuntimeMaskingDetectorTests(unittest.TestCase):
    def test_python_except_pass_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.py", (12, "    except Exception: pass"))]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "runtime_masking")

    def test_empty_ts_catch_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.ts", (12, "    } catch (e) {}"))]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "runtime_masking")

    def test_promise_swallow_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[_change("apps/foo.ts", (12, "promise.catch((e) => {})"))]
        )
        self.assertEqual(len(matches), 1)

    def test_real_error_handling_not_caught(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[
                _change("apps/foo.ts", (12, "    } catch (e) { logger.error(e); }"))
            ]
        )
        self.assertEqual(matches, [])


class ARIASuppressionHonorTests(unittest.TestCase):
    def test_modifying_aria_suppressions_flagged(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[
                _change("aria-tools/suppressions.json", (1, '{"new": "rule"}'))
            ]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "aria_suppression_honor")

    def test_modifying_other_aria_suppression_file_flagged(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[
                _change(
                    "aria-tools/per-tool-suppression.json", (1, '{"new": "rule"}')
                )
            ]
        )
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].category, "aria_suppression_honor")


class UnifiedDiffParserTests(unittest.TestCase):
    def test_parses_simple_unified_diff(self) -> None:
        diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ b/apps/foo.ts\n"
            "@@ -10,3 +10,5 @@\n"
            " const x = 1;\n"
            "+// @ts-ignore\n"
            "+const y = (x as any) + 1;\n"
            " const z = 2;\n"
        )
        changes = parse_unified_diff(diff)
        self.assertEqual(len(changes), 1)
        self.assertEqual(changes[0]["path"], "apps/foo.ts")
        added = changes[0]["added_lines"]
        self.assertEqual(len(added), 2)
        self.assertEqual(added[0][1], "// @ts-ignore")
        self.assertEqual(added[1][1], "const y = (x as any) + 1;")

    def test_scan_unified_diff_text_combines_two_categories(self) -> None:
        diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ b/apps/foo.ts\n"
            "@@ -10,2 +10,4 @@\n"
            "+// @ts-ignore\n"
            "+xit('broken', () => {});\n"
        )
        matches = scan_unified_diff_text(diff)
        self.assertEqual(len(matches), 2)
        categories = sorted({m.category for m in matches})
        self.assertEqual(categories, ["test_skip", "ts_masking"])

    def test_dev_null_target_skipped(self) -> None:
        # File deletion (target /dev/null) should not contribute added lines.
        diff = (
            "diff --git a/apps/foo.ts b/apps/foo.ts\n"
            "--- a/apps/foo.ts\n"
            "+++ /dev/null\n"
            "@@ -1,3 +0,0 @@\n"
            "-const x = 1;\n"
            "-const y = 2;\n"
            "-const z = 3;\n"
        )
        changes = parse_unified_diff(diff)
        self.assertEqual(changes, [])


class MultiCategoryAggregationTests(unittest.TestCase):
    def test_each_match_carries_full_context(self) -> None:
        matches = scan_diff_added_lines(
            file_changes=[
                _change(
                    "apps/foo.ts",
                    (10, "// @ts-ignore"),
                    (11, "const x = value as any;"),
                ),
                _change("apps/bar.spec.ts", (5, "xit('broken', () => {});")),
            ]
        )
        # 3 matches across 2 files.
        self.assertEqual(len(matches), 3)
        files = {m.file for m in matches}
        self.assertEqual(files, {"apps/foo.ts", "apps/bar.spec.ts"})


if __name__ == "__main__":
    unittest.main()
