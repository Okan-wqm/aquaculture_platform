"""ARIA-MEDIUM-467 — one reader for a PR payload's fallback fields.

Six private copies (risk_policy, auto_merge, ci, auto_merge_runners,
merge_authority, merge_lane_workspace) read ``head_sha`` / ``headRefOid`` /
``head`` and friends, and disagreed on a whitespace-only value: the
truthiness copies returned it as present, the strip copies treated it as
missing, and one returned it stripped. A blank SHA was therefore known to
one gate and unknown to the next. ``risk_policy.first_present_string`` is
the one owner now.
"""
from __future__ import annotations

import ast
import importlib
import unittest
from pathlib import Path

_KERNEL_DIR = Path(__file__).resolve().parents[1] / "aria_kernel"


class FirstPresentStringSemantics(unittest.TestCase):
    def test_present_means_non_blank_and_is_returned_stripped(self) -> None:
        from aria_kernel.risk_policy import first_present_string

        self.assertEqual(first_present_string({"head_sha": "  ", "headRefOid": "abc"}, "head_sha", "headRefOid"), "abc")
        self.assertEqual(first_present_string({"head_sha": " abc "}, "head_sha"), "abc")
        self.assertIsNone(first_present_string({"head_sha": " "}, "head_sha"))
        self.assertIsNone(first_present_string({"base": {"ref": "x"}}, "base"))


class OneOwner(unittest.TestCase):
    def test_every_reader_is_the_risk_policy_function(self) -> None:
        from aria_kernel import risk_policy

        for name in ("auto_merge", "auto_merge_runners", "ci", "merge_authority", "merge_lane_workspace"):
            with self.subTest(module=name):
                module = importlib.import_module(f"aria_kernel.{name}")
                self.assertIs(module.first_present_string, risk_policy.first_present_string)

    def test_no_private_copy_is_defined(self) -> None:
        definitions = sorted(
            (path.relative_to(_KERNEL_DIR).as_posix(), node.name)
            for path in _KERNEL_DIR.rglob("*.py")
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name in {"first_present_string", "_first_string", "_first"}
        )
        self.assertEqual(definitions, [("risk_policy.py", "first_present_string")])


if __name__ == "__main__":
    unittest.main()
