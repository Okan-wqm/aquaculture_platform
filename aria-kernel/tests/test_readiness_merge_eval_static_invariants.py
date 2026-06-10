from __future__ import annotations

import ast
import unittest
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[2]

PRODUCTION_ROOTS = (
    REPO_ROOT / "aria-kernel" / "aria_kernel",
    REPO_ROOT / "tools" / "aria-poc",
)

ALLOWED_GH_PR_MERGE_LOCATION = (
    "aria-kernel/aria_kernel/merge_authority.py",
    "execute_gh_squash_merge",
)
ALLOWED_ADAPTER_MERGE_CALL_LOCATION = (
    "aria-kernel/aria_kernel/merge_authority.py",
    "merge_if_authorized",
)


def _production_python_files() -> Iterable[Path]:
    for root in PRODUCTION_ROOTS:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.py")):
            rel = path.relative_to(REPO_ROOT).as_posix()
            if "__pycache__" in path.parts:
                continue
            if path.name.startswith("test_") or "/invariants/" in rel:
                continue
            yield path


def _parse(path: Path) -> ast.AST:
    return ast.parse(path.read_text(encoding="utf-8"), filename=path.as_posix())


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _call_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def _literal_command_tokens(node: ast.AST, names: dict[str, list[str]] | None = None) -> list[str]:
    names = names or {}
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value.split()
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            else:
                parts.append("{expr}")
        return "".join(parts).split()
    if isinstance(node, ast.Name):
        return names.get(node.id, [])
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _literal_command_tokens(node.left, names)
        right = _literal_command_tokens(node.right, names)
        return [*left, *right] if left and right else []
    if isinstance(node, (ast.List, ast.Tuple)):
        tokens: list[str] = []
        for element in node.elts:
            if isinstance(element, ast.Constant) and isinstance(element.value, str):
                tokens.append(element.value)
            elif isinstance(element, ast.JoinedStr):
                joined = " ".join(_literal_command_tokens(element, names))
                tokens.append(joined)
            else:
                return []
        return tokens
    return []


def _is_direct_gh_merge_command(tokens: list[str]) -> bool:
    if len(tokens) >= 3 and tokens[0] == "gh" and tokens[1] == "pr" and tokens[2] == "merge":
        return True
    if len(tokens) >= 3 and tokens[0] == "gh" and tokens[1] == "api":
        return any("/pulls/" in token and token.endswith("/merge") for token in tokens)
    return False


class _StaticVisitor(ast.NodeVisitor):
    def __init__(self, rel_path: str) -> None:
        self.rel_path = rel_path
        self.scope: list[str] = []
        self.literal_names: dict[str, list[str]] = {}
        self.subprocess_aliases: set[str] = {"subprocess"}
        self.process_function_aliases: set[str] = {"run", "call", "check_call", "check_output", "Popen"}
        self.direct_merge_commands: list[str] = []
        self.adapter_merge_calls: list[str] = []
        self.test_helper_imports: list[str] = []

    def _scope_name(self) -> str:
        return ".".join(self.scope)

    def _location(self, node: ast.AST) -> str:
        return f"{self.rel_path}:{getattr(node, 'lineno', '?')}:{self._scope_name()}"

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if _is_test_helper_import(alias.name):
                self.test_helper_imports.append(f"{self._location(node)} imports {alias.name}")
            if alias.name == "subprocess":
                self.subprocess_aliases.add(alias.asname or alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        names = [alias.name for alias in node.names]
        candidates = [module, *[f"{module}.{name}" if module else name for name in names]]
        for candidate in candidates:
            if _is_test_helper_import(candidate):
                self.test_helper_imports.append(f"{self._location(node)} imports {candidate}")
        if module == "subprocess":
            for alias in node.names:
                self.process_function_aliases.add(alias.asname or alias.name)
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        tokens = _literal_command_tokens(node.value, self.literal_names)
        if tokens:
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self.literal_names[target.id] = tokens
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        name = _call_name(node.func)
        if _is_getattr_merge_pr_call(node):
            self.adapter_merge_calls.append(self._location(node))
        if name.endswith(".merge_pr") or name == "merge_pr":
            if (self.rel_path, self._scope_name()) != ALLOWED_ADAPTER_MERGE_CALL_LOCATION:
                self.adapter_merge_calls.append(self._location(node))

        is_process_call = name in self.process_function_aliases
        if "." in name:
            prefix, _, attr = name.partition(".")
            is_process_call = prefix in self.subprocess_aliases and attr in {"run", "call", "check_call", "check_output", "Popen"}
        command_node = node.args[0] if node.args else None
        for keyword in node.keywords:
            if keyword.arg == "args":
                command_node = keyword.value
        if is_process_call and command_node is not None:
            tokens = _literal_command_tokens(command_node, self.literal_names)
            if _is_direct_gh_merge_command(tokens):
                if (self.rel_path, self._scope_name()) != ALLOWED_GH_PR_MERGE_LOCATION:
                    self.direct_merge_commands.append(self._location(node))
        self.generic_visit(node)


def _is_getattr_merge_pr_call(node: ast.Call) -> bool:
    func = node.func
    return (
        isinstance(func, ast.Call)
        and isinstance(func.func, ast.Name)
        and func.func.id == "getattr"
        and len(func.args) >= 2
        and isinstance(func.args[1], ast.Constant)
        and func.args[1].value == "merge_pr"
    )


def _is_test_helper_import(module: str) -> bool:
    if not module:
        return False
    normalized = module.replace("/", ".").replace("-", "_")
    return (
        normalized == "tests"
        or normalized.startswith("tests.")
        or normalized.startswith("aria_kernel.tests")
        or ".tests._helpers" in normalized
        or normalized.endswith(".tests._helpers")
    )


class ReadinessMergeEvalStaticInvariantTests(unittest.TestCase):
    def _scan(self) -> list[_StaticVisitor]:
        visitors: list[_StaticVisitor] = []
        for path in _production_python_files():
            rel_path = path.relative_to(REPO_ROOT).as_posix()
            visitor = _StaticVisitor(rel_path)
            visitor.visit(_parse(path))
            visitors.append(visitor)
        return visitors

    def test_merge_side_effects_stay_behind_merge_authority(self) -> None:
        """Static direct-merge guard.

        Production code may evaluate PRs through auto_merge, but real
        merge side effects must route through merge_authority.
        """
        direct_shell_merges: list[str] = []
        direct_adapter_merges: list[str] = []
        for visitor in self._scan():
            direct_shell_merges.extend(visitor.direct_merge_commands)
            direct_adapter_merges.extend(visitor.adapter_merge_calls)

        self.assertEqual(
            direct_shell_merges,
            [],
            "direct gh merge commands outside GhCliGitHubAdapter.merge_pr: "
            + ", ".join(direct_shell_merges),
        )
        self.assertEqual(
            direct_adapter_merges,
            [],
            "direct adapter.merge_pr calls outside merge_authority: "
            + ", ".join(direct_adapter_merges),
        )

    def test_production_code_does_not_import_test_helpers(self) -> None:
        helper_imports: list[str] = []
        for visitor in self._scan():
            helper_imports.extend(visitor.test_helper_imports)
        self.assertEqual(
            helper_imports,
            [],
            "production imports from tests/_helpers are forbidden: "
            + ", ".join(helper_imports),
        )

    def test_static_scanner_catches_direct_merge_poison_shapes(self) -> None:
        poison = """
import subprocess as sp
from subprocess import run as sprun

def one():
    cmd = ["gh", "pr"] + ["merge", "1"]
    sp.run(cmd)

def two():
    sprun(args=["gh", "api", f"/repos/o/r/pulls/{1}/merge"])

def three(adapter):
    getattr(adapter, "merge_pr")(1)
"""
        tree = ast.parse(poison)
        visitor = _StaticVisitor("aria-kernel/aria_kernel/poison.py")
        visitor.visit(tree)
        self.assertGreaterEqual(len(visitor.direct_merge_commands), 2)
        self.assertEqual(len(visitor.adapter_merge_calls), 1)


if __name__ == "__main__":
    unittest.main()
