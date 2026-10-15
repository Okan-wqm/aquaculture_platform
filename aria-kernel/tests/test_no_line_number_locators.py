"""ARIA-LOW-496 — kernel and executor prose cites code by symbol, never by line number.

A line locator in a comment or docstring (``(line ~964)``, ``line 1841``,
``cycle.py:397``) goes stale on the first unrelated edit above it and then
points a reader at the wrong code with full confidence: the census found
52 of them across 32 files, many already wrong. Symbols survive edits and
fail loudly when renamed. This scan keeps new locators out.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_ROOTS = (_REPO / "aria-kernel" / "aria_kernel", _REPO / "tools" / "aria-poc")
# The three spellings: "(line N)" / "(lines N-M)", a bare "line(s) N" of two or
# more digits, and "<module>.py:N".
_LOCATOR = re.compile(r"\(lines? ~?\d+(?:\s*-\s*\d+)?\)|\blines? ~?\d{2,}|\b[A-Za-z_][\w]*\.py:\d+")


class NoLineNumberLocators(unittest.TestCase):
    def test_no_module_carries_a_line_locator(self) -> None:
        hits: list[str] = []
        for root in _ROOTS:
            for path in sorted(root.rglob("*.py")):
                if "__pycache__" in path.parts or ".mimosa" in path.parts:
                    continue
                for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                    if _LOCATOR.search(line):
                        hits.append(f"{path.relative_to(_REPO).as_posix()}:{number}")
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
