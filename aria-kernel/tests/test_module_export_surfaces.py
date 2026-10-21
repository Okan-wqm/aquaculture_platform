"""A registered kernel module's ``__all__`` names exactly its public
top-level definitions (ARIA-LOW-475).

``__all__`` is the module's declared interface: it is what a reader, a
``from module import *`` and an API audit take the module to offer. Each
module registered here had grown public functions that production code
imports by name while ``__all__`` still listed only the original handful, so
the declared surface and the real one disagreed silently. One helper and one
subTest per module, so registering another module is a one-line change.
"""
from __future__ import annotations

import ast
import importlib
import unittest
from pathlib import Path
from types import ModuleType

_REGISTERED_MODULES = (
    "aria_kernel.autonomy_ladder",
    "aria_kernel.calibrated_intelligence",
    "aria_kernel.own_pr_ci",
)


def _public_definitions(module: ModuleType) -> set[str]:
    """Names the module itself defines at top level without a leading ``_``.

    Read from the source rather than ``dir(module)`` so imported helpers are
    not mistaken for the module's own surface.
    """
    tree = ast.parse(Path(str(module.__file__)).read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return {name for name in names if not name.startswith("_")}


class ModuleExportSurfaces(unittest.TestCase):
    def test_all_names_exactly_the_public_definitions(self) -> None:
        for dotted in _REGISTERED_MODULES:
            with self.subTest(module=dotted):
                module = importlib.import_module(dotted)
                declared = list(module.__all__)
                self.assertEqual(len(declared), len(set(declared)), "duplicate in __all__")
                public = _public_definitions(module)
                self.assertEqual(
                    set(declared), public,
                    f"missing from __all__: {sorted(public - set(declared))}; "
                    f"not defined: {sorted(set(declared) - public)}",
                )


class EveryDeclaredExportResolves(unittest.TestCase):
    """ARIA-LOW-504 — no kernel module declares a name it does not define.

    ``circuit_breaker.__all__`` kept ``assert_within_breaker`` after the
    function was deleted (ORPHAN-HIGH-573), so ``from
    aria_kernel.circuit_breaker import *`` raised ``AttributeError``. The
    registered-module test above only covers the modules it names; this one
    walks every module of the package and performs the star import itself,
    which is exactly what ``__all__`` promises (a package may list a
    submodule, and the star import loads it).
    """

    def test_a_star_import_of_every_kernel_module_succeeds(self) -> None:
        import pkgutil

        import aria_kernel

        failures: dict[str, str] = {}
        modules = [aria_kernel.__name__] + [
            info.name for info in pkgutil.walk_packages(aria_kernel.__path__, f"{aria_kernel.__name__}.")
        ]
        for dotted in modules:
            module = importlib.import_module(dotted)
            if not hasattr(module, "__all__"):
                continue
            try:
                exec(f"from {dotted} import *", {})  # noqa: S102 - the statement under test
            except (AttributeError, ImportError) as exc:
                failures[dotted] = str(exc)
        self.assertGreater(len(modules), 100, "the walk found too few kernel modules to mean anything")
        self.assertEqual(failures, {})


if __name__ == "__main__":
    unittest.main()
