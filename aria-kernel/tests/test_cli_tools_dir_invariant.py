"""Plan 024 v3 followup §F (ORPHAN-MEDIUM-058) — invariant test for
the --tools-dir architectural barrier.

After Implementer-A's fix, every subcommand registration MUST go
through the add_subparser factory which threads parents=[_TOOLS_-
DIR_PARENT]. A future maintainer who slips in a raw `<sub>.add_-
parser(...)` call OR a raw `<parser>.add_argument("--tools-dir",
...)` call breaks the structural barrier; this test catches it
at PR time.

Architectural tier: T1 (make-it-impossible) for runtime, T3 (make-
it-detectable) for source-level regressions. The factory funnels
every subparser through parents=[_TOOLS_DIR_PARENT] so the runtime
cannot register a parser without --tools-dir; the AST scan in this
file catches a future maintainer who imports argparse directly and
sidesteps the funnel before the regression reaches a release.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

CLI_PATH = Path(__file__).resolve().parent.parent / "aria_kernel" / "cli.py"


class CliToolsDirInvariantTests(unittest.TestCase):
    """AST-based barrier scan. String-grep variants are fragile (a
    one-line comment containing the literal would falsely trip);
    AST is exact."""

    def setUp(self) -> None:
        self.source = CLI_PATH.read_text(encoding="utf-8")
        self.tree = ast.parse(self.source, filename=str(CLI_PATH))
        # Map from id(node) -> enclosing FunctionDef.name. Built once
        # so test methods don't pay O(N^2) walking cost per Call node.
        self._fn_by_node_id: dict[int, str] = {}
        for fn in ast.walk(self.tree):
            if isinstance(fn, ast.FunctionDef):
                for child in ast.walk(fn):
                    self._fn_by_node_id[id(child)] = fn.name

    def test_no_raw_add_parser_calls(self) -> None:
        """Plan 024 §F invariant: every subcommand registration must
        go through the add_subparser factory. Raw .add_parser(...)
        calls bypass the parents=[_TOOLS_DIR_PARENT] mechanism and
        re-introduce the flag-position inconsistency this fix
        closes.

        The single allowed callsite is the body of add_subparser
        itself (it must call sub_action.add_parser internally — it
        is the funnel)."""
        violations: list[str] = []
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr == "add_parser":
                    enclosing = self._fn_by_node_id.get(id(node))
                    if enclosing == "add_subparser":
                        # The factory itself must call add_parser
                        # internally; this is the single allowed
                        # callsite.
                        continue
                    violations.append(
                        f"line {node.lineno}: raw .add_parser() — "
                        f"must use add_subparser(sub_action, name, ...) factory"
                    )
        self.assertEqual(
            violations,
            [],
            "Plan 024 §F barrier breached:\n" + "\n".join(violations),
        )

    def test_no_raw_tools_dir_argument(self) -> None:
        """Plan 024 §F invariant: --tools-dir is declared exactly
        once on _TOOLS_DIR_PARENT. Any other parser.add_argument(
        "--tools-dir", ...) call collides with parents= and breaks
        the structural barrier (argparse raises ArgumentError on
        duplicate flag registration; the resulting failure mode is
        latent until the offending subcommand is invoked)."""
        violations: list[str] = []
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr != "add_argument":
                    continue
                if not node.args:
                    continue
                arg0 = node.args[0]
                if not isinstance(arg0, ast.Constant):
                    continue
                if arg0.value != "--tools-dir":
                    continue
                if not self._is_on_tools_dir_parent(node):
                    violations.append(
                        f"line {node.lineno}: --tools-dir declared outside "
                        f"_TOOLS_DIR_PARENT"
                    )
        self.assertEqual(
            violations,
            [],
            "Plan 024 §F single-declaration barrier breached:\n"
            + "\n".join(violations),
        )

    def test_add_tools_arg_helper_is_deleted(self) -> None:
        """Plan 024 §F invariant: the legacy add_tools_arg(parser)
        helper was the workaround the parents= mechanism replaces.
        If it reappears, callers may drift back to per-callsite
        registration and the architectural barrier rots from the
        inside. AST scan: no module-level FunctionDef named
        add_tools_arg may exist."""
        violations: list[str] = []
        for node in self.tree.body:
            if isinstance(node, ast.FunctionDef) and node.name == "add_tools_arg":
                violations.append(
                    f"line {node.lineno}: add_tools_arg helper "
                    f"reintroduced — Plan 024 §F replaces it with "
                    f"parents=[_TOOLS_DIR_PARENT]"
                )
        self.assertEqual(
            violations,
            [],
            "Plan 024 §F helper-deletion barrier breached:\n"
            + "\n".join(violations),
        )

    def test_tools_dir_parent_is_module_level_and_unique(self) -> None:
        """Plan 024 §F invariant: _TOOLS_DIR_PARENT must be a single
        module-level binding. A duplicate or function-scope binding
        would either shadow the parent or scatter the declaration
        site — both regress the single-declaration property."""
        bindings: list[int] = []
        for node in self.tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "_TOOLS_DIR_PARENT":
                        bindings.append(node.lineno)
        self.assertEqual(
            len(bindings),
            1,
            f"Plan 024 §F: expected exactly one module-level "
            f"_TOOLS_DIR_PARENT binding, got {len(bindings)} "
            f"at lines {bindings}",
        )

    def _is_on_tools_dir_parent(self, node: ast.Call) -> bool:
        """The single allowed --tools-dir add_argument is on
        _TOOLS_DIR_PARENT. Detect by attribute access shape:
        _TOOLS_DIR_PARENT.add_argument(...)."""
        if not isinstance(node.func, ast.Attribute):
            return False
        if not isinstance(node.func.value, ast.Name):
            return False
        return node.func.value.id == "_TOOLS_DIR_PARENT"


if __name__ == "__main__":
    unittest.main()
