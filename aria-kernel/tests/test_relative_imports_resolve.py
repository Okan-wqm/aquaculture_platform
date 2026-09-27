"""Every relative import in the kernel names something that exists.

ARIA-HIGH-186 moved ``snapshot.normalize_path`` into
``canonical_path.lexical_repo_path``. A function-scoped
``from .snapshot import normalize_path`` in ``change_outcome`` still named the
old home: nothing imports a function body until it runs, so module import,
lint and every test that did not reach that branch stayed green, and the
kernel's assessment path raised ImportError in CI only. This invariant
resolves every relative ``from ... import`` in ``aria_kernel`` (module level
and function scope alike) against the live package, so a rename that leaves
a caller behind fails here, by name, on every run.
"""

from __future__ import annotations

import ast
import importlib
import unittest
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1] / "aria_kernel"


def dangling_relative_imports(package_root: Path = PACKAGE_ROOT) -> list[str]:
    dangling: list[str] = []
    for source in sorted(package_root.rglob("*.py")):
        relative = source.relative_to(package_root.parent).with_suffix("")
        package_parts = list(relative.parts[:-1])
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.level == 0:
                continue
            base = package_parts[: len(package_parts) - (node.level - 1)]
            module_name = ".".join(base + ([node.module] if node.module else []))
            where = f"{relative.as_posix()}.py:{node.lineno}"
            try:
                module = importlib.import_module(module_name)
            except ImportError as exc:
                dangling.append(f"{where}: module {module_name} does not import ({exc})")
                continue
            for alias in node.names:
                if alias.name == "*" or hasattr(module, alias.name):
                    continue
                try:
                    importlib.import_module(f"{module_name}.{alias.name}")
                except ImportError:
                    dangling.append(f"{where}: {module_name} has no {alias.name}")
    return dangling


class RelativeImportsResolveTests(unittest.TestCase):
    def test_every_relative_import_names_an_existing_symbol(self) -> None:
        self.assertEqual(dangling_relative_imports(), [])

    def test_the_scan_sees_a_function_scoped_import_of_a_moved_name(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / "aria_kernel"
            package.mkdir()
            (package / "stale_caller_fixture.py").write_text(
                "def run():\n    from .canonical_path import normalize_path\n    return normalize_path\n",
                encoding="utf-8",
            )
            self.assertEqual(
                dangling_relative_imports(package),
                ["aria_kernel/stale_caller_fixture.py:2: aria_kernel.canonical_path has no normalize_path"],
            )


if __name__ == "__main__":
    unittest.main()
