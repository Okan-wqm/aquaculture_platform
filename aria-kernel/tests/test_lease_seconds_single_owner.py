"""ARIA-HIGH-460 — the default claim lease has one owner.

``agent_invocations.DEFAULT_LEASE_SECONDS`` is the Plan 016 lease every
dispatch lane claims under. Five modules once restated it and three call
signatures hard-coded 1800, so a change to the lease would have silently
left some lanes on the old value — and the executor timeout derived from
the lease (``agent_invocations.executor_timeout_seconds``) would then sit
outside the lease it is meant to fit inside.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

_KERNEL_DIR = Path(__file__).resolve().parents[1] / "aria_kernel"
_OWNER = "agent_invocations.py"


def _modules() -> list[tuple[str, ast.Module]]:
    return [
        (path.relative_to(_KERNEL_DIR).as_posix(), ast.parse(path.read_text(encoding="utf-8")))
        for path in sorted(_KERNEL_DIR.rglob("*.py"))
    ]


class LeaseSecondsSingleOwnerTests(unittest.TestCase):
    def test_default_lease_seconds_is_assigned_only_by_its_owner(self) -> None:
        owners: list[str] = []
        for rel, tree in _modules():
            for node in tree.body:
                targets: list[ast.expr] = []
                if isinstance(node, ast.Assign):
                    targets = list(node.targets)
                elif isinstance(node, ast.AnnAssign):
                    targets = [node.target]
                if any(isinstance(t, ast.Name) and t.id == "DEFAULT_LEASE_SECONDS" for t in targets):
                    owners.append(rel)
        self.assertEqual(owners, [_OWNER])

    def test_no_signature_or_cli_flag_hard_codes_a_lease(self) -> None:
        literals: list[str] = []
        for rel, tree in _modules():
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    args = node.args
                    positional = [*args.posonlyargs, *args.args]
                    pairs = list(zip(positional[len(positional) - len(args.defaults):], args.defaults))
                    pairs += [(a, d) for a, d in zip(args.kwonlyargs, args.kw_defaults) if d is not None]
                    for arg, default in pairs:
                        if (
                            arg.arg == "lease_seconds"
                            and isinstance(default, ast.Constant)
                            and isinstance(default.value, int)
                        ):
                            literals.append(f"{rel}:{node.name}")
                elif (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "add_argument"
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value == "--lease-seconds"
                ):
                    for kw in node.keywords:
                        if (
                            kw.arg == "default"
                            and isinstance(kw.value, ast.Constant)
                            and isinstance(kw.value.value, int)
                        ):
                            literals.append(f"{rel}:--lease-seconds")
        self.assertEqual(literals, [])


if __name__ == "__main__":
    unittest.main()
