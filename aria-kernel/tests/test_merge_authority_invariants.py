from __future__ import annotations

import ast
import unittest
from pathlib import Path


KERNEL = Path(__file__).resolve().parents[1] / "aria_kernel"


class MergeAuthorityInvariants(unittest.TestCase):
    def test_real_merge_call_only_in_merge_authority(self) -> None:
        violations: list[str] = []
        for path in sorted(KERNEL.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if isinstance(func, ast.Attribute) and func.attr == "merge_pr":
                    if path.name != "merge_authority.py":
                        violations.append(f"{path.relative_to(KERNEL)}:{node.lineno}")
        self.assertEqual(violations, [], "\n".join(violations))

    def test_private_merge_authority_token_only_imported_by_authority(self) -> None:
        violations: list[str] = []
        for path in sorted(KERNEL.rglob("*.py")):
            text = path.read_text(encoding="utf-8")
            if "_REAL_MERGE_AUTHORITY" in text:
                violations.append(str(path.relative_to(KERNEL)))
        self.assertEqual(violations, [], "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
