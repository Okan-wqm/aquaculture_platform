"""Plan ARIA-V3.1 §B3.1-CRIT-001 + §2a — shadow-import invariant.

Pre-V3.1 the kernel had 4 nested ``from .runtime_profile import
get_profile`` statements inside ``cli._main`` that each re-imported
a name already covered by the module-level import at line 105.
Python's scoping rule made the name LOCAL to the entire function
body, silently breaking 3 CLI endpoints (``profile {get,set,history}``)
+ 3 daemon paths (``scheduler worker-dispatch run``,
``agent-genesis materialize``, ``skill-genesis materialize``,
``autonomy run``) with ``UnboundLocalError``.

V3.1 §2a deletes the 4 redundant re-imports. This invariant
prevents a future contributor from reintroducing the same anti-
pattern: AST-scans ``cli.py`` and asserts no nested ``from .X
import Y`` statement re-imports a name already covered by a
module-level ``from .X import Y`` from the same module.

I-V3.1-04, I-V3.1-05 cases.
"""

from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
_CLI_PATH = _KERNEL_ROOT / "aria_kernel" / "cli.py"


def _collect_module_level_imports(tree: ast.Module) -> dict[str, set[str]]:
    """Plan ARIA-V3.1 §2a — return {module_name: {imported_name, ...}}
    for every ``from .X import Y[, Z, ...]`` at module-top level
    (i.e., body of the Module node, not nested in any FunctionDef).
    """
    module_imports: dict[str, set[str]] = {}
    for node in tree.body:
        if not isinstance(node, ast.ImportFrom):
            continue
        # Plan ARIA-V3.1 §2a — record both relative (``from .X``,
        # level=1) and absolute (``from aria_kernel.X``, level=0)
        # forms. The level=0 form is a string like
        # ``aria_kernel.runtime_profile``; level=1 form has module
        # == ``runtime_profile`` only (the leading ``.`` is encoded
        # as level=1).
        module_key = node.module or ""
        if node.level >= 1:
            # Relative import — normalise to bare module name.
            key = module_key
        else:
            # Absolute import — keep the prefix-stripped tail to
            # match the relative form. For aria_kernel.X, we strip
            # the aria_kernel prefix so it compares equal to ``.X``.
            if module_key.startswith("aria_kernel."):
                key = module_key.split(".", 1)[1]
            else:
                key = module_key
        names = {alias.name for alias in node.names}
        module_imports.setdefault(key, set()).update(names)
    return module_imports


def _collect_nested_imports(
    tree: ast.Module,
) -> list[tuple[str, str, int, str]]:
    """Plan ARIA-V3.1 §2a — return (module_name, imported_name, lineno,
    enclosing_function_name) for every ``from .X import Y[, ...]``
    nested inside a FunctionDef.
    """
    nested: list[tuple[str, str, int, str]] = []
    for fn_node in ast.walk(tree):
        if not isinstance(fn_node, ast.FunctionDef):
            continue
        for inner in ast.walk(fn_node):
            if not isinstance(inner, ast.ImportFrom):
                continue
            if inner is fn_node:
                continue
            module_key = inner.module or ""
            if inner.level >= 1:
                key = module_key
            else:
                if module_key.startswith("aria_kernel."):
                    key = module_key.split(".", 1)[1]
                else:
                    key = module_key
            for alias in inner.names:
                nested.append(
                    (key, alias.name, inner.lineno, fn_node.name)
                )
    return nested


class CliNoShadowImportAntiPattern(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cli_src = _CLI_PATH.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.cli_src)
        cls.module_imports = _collect_module_level_imports(cls.tree)
        cls.nested = _collect_nested_imports(cls.tree)

    # I-V3.1-04 — no nested re-import shadowing module-level binding.
    def test_i_v3_1_04_no_nested_reimport_shadowing_module_level(self) -> None:
        violations: list[str] = []
        for module_key, name, lineno, fn_name in self.nested:
            if module_key in self.module_imports and name in self.module_imports[module_key]:
                violations.append(
                    f"cli.py:{lineno} inside {fn_name}() — nested "
                    f"`from .{module_key} import {name}` shadows the "
                    f"module-level import (line ≤ top of module). "
                    f"Python's scoping rule makes {name!r} LOCAL to "
                    f"{fn_name}() for the entire function body, "
                    f"silently breaking earlier callsites with "
                    f"UnboundLocalError."
                )
        self.assertEqual(violations, [], msg="\n".join(violations))

    # I-V3.1-05 — runtime_profile symbols only at module level.
    def test_i_v3_1_05_runtime_profile_symbols_module_level_only(self) -> None:
        # Specific check on the runtime_profile module since it's
        # the load-bearing case (3 confirmed CLI breakages). Every
        # symbol the kernel uses from runtime_profile MUST come
        # from the module-level import only.
        runtime_profile_at_module = self.module_imports.get(
            "runtime_profile", set()
        )
        # Sanity: module-level import covers the four canonical names.
        for expected in {"PROFILES", "get_profile", "list_profile_history", "set_profile"}:
            self.assertIn(
                expected,
                runtime_profile_at_module,
                msg=(
                    f"runtime_profile module-level import missing "
                    f"{expected!r} — V3.1 invariant expects all four "
                    f"canonical symbols at module top"
                ),
            )
        # No nested runtime_profile import exists.
        nested_runtime_profile = [
            f"cli.py:{lineno} inside {fn_name}() — `from .runtime_profile import {name}`"
            for module_key, name, lineno, fn_name in self.nested
            if module_key == "runtime_profile"
        ]
        self.assertEqual(
            nested_runtime_profile,
            [],
            msg="\n".join(nested_runtime_profile),
        )


if __name__ == "__main__":
    unittest.main()
