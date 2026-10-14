"""ARIA-HIGH-470 — kernel and executor code import modules with import statements.

``__import__("hashlib")`` inline hides a dependency from readers, linters
and the import-graph checks. This AST ban keeps the calls out. It does NOT
cover function-local re-imports of a module or name already imported at the
top (``import hashlib as _x``, a second ``from .x import y``): that is a
separate class, still present at many sites, which this file does not claim.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_ROOTS = (_REPO / "aria-kernel" / "aria_kernel", _REPO / "tools" / "aria-poc")


class NoDunderImportCallTests(unittest.TestCase):
    def test_no_module_calls_dunder_import(self) -> None:
        hits: list[str] = []
        for root in _ROOTS:
            for path in sorted(root.rglob("*.py")):
                if "__pycache__" in path.parts or ".mimosa" in path.parts:
                    continue
                tree = ast.parse(path.read_text(encoding="utf-8"))
                for node in ast.walk(tree):
                    if (
                        isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Name)
                        and node.func.id == "__import__"
                    ):
                        hits.append(f"{path.relative_to(_REPO).as_posix()}:{node.lineno}")
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
