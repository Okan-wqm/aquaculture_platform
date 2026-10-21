"""ARIA-LOW-600 — a test module runs the same tests however it is invoked.

`python3 aria-kernel/tests/<module>.py` executes the module top to bottom.
When the ``if __name__ == "__main__":`` guard is not the module's LAST
top-level statement, ``unittest.main()`` runs (and exits) before the
definitions below the guard exist, so those tests silently never run:
``test_watchdog_freeze.py`` dropped 6 of its 20 tests this way, and 21 other
modules carried a class or function after the guard. Discovery
(`python3 -m unittest`, pytest) imports the module whole and is not
affected, which is why nothing noticed.

The invariant reads every Python module under ``aria-kernel/tests`` with the
standard ``ast`` parser and fails, by path and line, on any whose
``__main__`` guard is followed by another top-level statement.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent


def _is_main_guard(node: ast.stmt) -> bool:
    """``if __name__ == "__main__":`` (either operand order)."""
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    compare = node.test
    if len(compare.ops) != 1 or not isinstance(compare.ops[0], ast.Eq):
        return False
    operands = [compare.left, *compare.comparators]
    names = [operand for operand in operands if isinstance(operand, ast.Name) and operand.id == "__name__"]
    mains = [
        operand
        for operand in operands
        if isinstance(operand, ast.Constant) and operand.value == "__main__"
    ]
    return len(names) == 1 and len(mains) == 1


def statements_after_main_guard(source: str) -> list[int]:
    """1-based line of every main guard that is not the last top-level statement."""
    body = ast.parse(source).body
    return [
        node.lineno
        for index, node in enumerate(body)
        if _is_main_guard(node) and index != len(body) - 1
    ]


class MainGuardIsLastTests(unittest.TestCase):
    def test_no_test_module_defines_anything_after_its_main_guard(self) -> None:
        offenders = [
            f"{path.relative_to(_TESTS_DIR.parent).as_posix()}:{line}"
            for path in sorted(_TESTS_DIR.rglob("*.py"))
            for line in statements_after_main_guard(path.read_text(encoding="utf-8"))
        ]
        self.assertEqual(
            offenders,
            [],
            "a top-level statement follows the `if __name__ == \"__main__\":` guard, so running "
            "the file as a script exits before it exists; move the guard to the end of the module",
        )

    def test_the_reader_finds_a_guard_followed_by_a_definition(self) -> None:
        late = 'import unittest\nif __name__ == "__main__":\n    unittest.main()\n\nclass Late:\n    pass\n'
        self.assertEqual(statements_after_main_guard(late), [2])
        reversed_operands = 'if "__main__" == __name__:\n    pass\nx = 1\n'
        self.assertEqual(statements_after_main_guard(reversed_operands), [1])

    def test_the_reader_accepts_a_guard_at_the_end(self) -> None:
        last = 'class Early:\n    pass\n\nif __name__ == "__main__":\n    unittest.main()\n'
        self.assertEqual(statements_after_main_guard(last), [])
        self.assertEqual(statements_after_main_guard("x = 1\n"), [])
        # Another `if` on __name__ is not the main guard.
        self.assertEqual(statements_after_main_guard('if __name__ != "__main__":\n    pass\nx = 1\n'), [])


if __name__ == "__main__":
    unittest.main()
