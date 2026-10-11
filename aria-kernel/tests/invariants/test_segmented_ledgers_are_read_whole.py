"""ARIA-HIGH-440 — a segmented ledger is read through its one reader, never by its segment-0 path.

Since 5cf8e0f61 (2026-10-02, ARIA-HIGH-275) the agent-invocation request and prompt ledgers
roll over into monthly segments (``ledger.SEGMENTED_LEDGERS``): the original file is frozen
segment 0, and every new row lands in ``<family dir>/<YYYY-MM>[-k].jsonl``. ``load_segments``
is the one reader of the whole family. The plan-stall rule read
``agent-invocations/requests.jsonl`` with ``load_jsonl``; it found no request for any plan
started since, the stall cause read ``no_request``, and the provider-outage pause never
applied (a plan waiting through an outage was abandoned at 72 h of wall time). On
origin/aria/state 75b6e407a the October segment held 434 rows and segment 0 none of them.

This pin fails a production module that hands a segmented family's segment-0 path to a plain
reader. A path is recognised by the string literals that build it, followed through the
names the reading function binds (an assignment, a loop or comprehension target, a
module-level table) and through a same-module helper that returns it. A reader that decides
on ``SEGMENTED_LEDGERS`` (it reads the family through ``load_segments`` and only the other
surfaces plainly) is the aware shape and passes. Naming the path for anything else — a
transaction's lock anchor, a surface declaration — is not a read.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path, PurePosixPath

from aria_kernel.ledger import SEGMENTED_LEDGERS
from aria_kernel.state_manifest import surface_by_name

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCANNED = ("aria-kernel/aria_kernel", "tools/aria-poc", "tools/aria")
# The segment machinery itself reads segment 0 as one file of the chain.
_OWNER = "aria-kernel/aria_kernel/ledger.py"
_PLAIN_READERS = frozenset({
    "load_jsonl", "load_declared_jsonl", "load_jsonl_verified", "load_jsonl_verified_text", "read_jsonl",
    "verify_jsonl", "read_text", "read_bytes", "open",
})


def segment_zero_paths() -> list[PurePosixPath]:
    return [PurePosixPath(surface_by_name(family).path_pattern) for family in SEGMENTED_LEDGERS]


def _names_segment_zero(constants: set[str]) -> bool:
    for path in segment_zero_paths():
        if str(path) in constants or (path.name in constants and str(path.parent) in constants):
            return True
        if path.name in constants and any(c.rstrip("/").endswith(str(path.parent)) for c in constants):
            return True
    return False


class _Module:
    def __init__(self, tree: ast.AST) -> None:
        self.tree = tree
        self.parent: dict[ast.AST, ast.AST] = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                self.parent[child] = node
        self.returns: dict[str, list[ast.AST]] = {}
        # Per scope (a function, a comprehension, the module): name -> the expressions it may hold.
        self.bound: dict[ast.AST, dict[str, list[ast.AST]]] = {}
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.returns[node.name] = [r.value for r in ast.walk(node)
                                           if isinstance(r, ast.Return) and r.value is not None]
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Module)):
                table: dict[str, list[ast.AST]] = {}
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Assign):
                        pairs = [(target, inner.value) for target in inner.targets]
                    elif isinstance(inner, (ast.For, ast.comprehension)):
                        pairs = [(inner.target, inner.iter)]
                    else:
                        continue
                    for target, value in pairs:
                        for name in ast.walk(target):
                            if isinstance(name, ast.Name):
                                table.setdefault(name.id, []).append(value)
                self.bound[node] = table
        self._memo: dict[int, frozenset[str]] = {}

    def scopes(self, node: ast.AST) -> list[ast.AST]:
        out = []
        while node in self.parent:
            node = self.parent[node]
            out.append(node)
        return out

    def constants(self, expr: ast.AST, depth: int = 0) -> frozenset[str]:
        """The string literals ``expr`` is built from, through the names and helpers it uses."""
        key = id(expr)
        if key in self._memo:
            return self._memo[key]
        self._memo[key] = frozenset()  # a self-referencing binding resolves to nothing more
        out: set[str] = set()
        scopes = [scope for scope in self.scopes(expr) if scope in self.bound]
        for node in ast.walk(expr):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                out.add(node.value)
            elif depth < 4 and isinstance(node, ast.Name):
                for scope in scopes:
                    for bound in self.bound[scope].get(node.id, []):
                        out |= self.constants(bound, depth + 1)
            elif depth < 4 and isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                for returned in self.returns.get(node.func.id, []):
                    out |= self.constants(returned, depth + 1)
        self._memo[key] = frozenset(out)
        return self._memo[key]

    def decides_on_the_registry(self, node: ast.AST) -> bool:
        return any(isinstance(scope, (ast.If, ast.IfExp)) and any(
            isinstance(n, ast.Name) and n.id == "SEGMENTED_LEDGERS" for n in ast.walk(scope.test))
            for scope in self.scopes(node))


def offenders_in(relative: str, source: str) -> list[str]:
    """Each plain read of a segmented family's segment-0 path in ``source``."""
    if not any(path.name in source for path in segment_zero_paths()):
        return []
    module = _Module(ast.parse(source))
    out = []
    for node in ast.walk(module.tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
        if name not in _PLAIN_READERS:
            continue
        # `path.read_text()` / `path.open()` read their receiver; a loader and `open(path)` their first argument.
        if isinstance(func, ast.Attribute) and (name in ("read_text", "read_bytes") or (name == "open" and not node.args)):
            subject: ast.AST | None = func.value
        else:
            subject = node.args[0] if node.args else None
        if subject is None or module.decides_on_the_registry(node):
            continue
        if _names_segment_zero(module.constants(subject)):
            out.append(f"{relative}:{node.lineno}")
    return out


def _offenders() -> list[str]:
    out = []
    for root in _SCANNED:
        for path in sorted((_REPO_ROOT / root).rglob("*.py")):
            relative = path.relative_to(_REPO_ROOT).as_posix()
            if "/tests/" not in relative and relative != _OWNER:
                out += offenders_in(relative, path.read_text(encoding="utf-8"))
    return out


class SegmentedLedgersAreReadWhole(unittest.TestCase):
    def test_no_production_module_reads_a_segment_zero_path_plainly(self) -> None:
        self.assertEqual(_offenders(), [])

    def test_the_registry_is_what_the_pin_reads(self) -> None:
        self.assertEqual(sorted(str(p) for p in segment_zero_paths()),
                         ["agent-invocations/prompts.jsonl", "agent-invocations/requests.jsonl"])


class ThePinRecognisesTheShapes(unittest.TestCase):
    """The checker against the shapes it exists for, so a green pin is not a blind one."""

    def flagged(self, source: str) -> bool:
        return bool(offenders_in("m.py", source))

    def test_the_stall_rules_comprehension_is_caught(self) -> None:  # the HEAD shape of ARIA-HIGH-440
        self.assertTrue(self.flagged(
            "def f(root):\n"
            "    return [load_jsonl(root / 'agent-invocations' / name) for name in ('requests.jsonl', 'claims.jsonl')]\n"))

    def test_a_bound_path_and_a_path_method_are_caught(self) -> None:
        self.assertTrue(self.flagged(
            "def f(root):\n    p = root / 'agent-invocations/prompts.jsonl'\n    return load_declared_jsonl(p, expected_surface='x')\n"))
        self.assertTrue(self.flagged(
            "def f(root):\n    return (root / 'agent-invocations' / 'requests.jsonl').read_text()\n"))

    def test_a_helper_that_returns_the_path_is_caught(self) -> None:
        self.assertTrue(self.flagged(
            "def _p(root):\n    return root / 'agent-invocations' / 'prompts.jsonl'\n"
            "def f(root):\n    return load_jsonl(_p(root))\n"))

    def test_the_aware_shapes_pass(self) -> None:
        self.assertFalse(self.flagged(
            "def f(root):\n    return load_segments(root, 'agent_invocation_requests')\n"))
        self.assertFalse(self.flagged(  # a lock anchor is not a read
            "def f(root):\n    p = root / 'agent-invocations' / 'requests.jsonl'\n"
            "    with state_transaction([p]) as t:\n        return t.load_segments(root, 'agent_invocation_requests')\n"))
        self.assertFalse(self.flagged(  # a reader that decides on the registry
            "SOURCES = (('agent-invocations/requests.jsonl', 'agent_invocation_requests'),)\n"
            "def f(root):\n    for rel, surface in SOURCES:\n"
            "        if surface in SEGMENTED_LEDGERS:\n            rows = load_segments(root, surface)\n"
            "        else:\n            rows = load_declared_jsonl(root / rel, expected_surface=surface)\n"))
        self.assertFalse(self.flagged(  # an unsegmented ledger of the same directory
            "def f(root):\n    return load_jsonl(root / 'agent-invocations' / 'claims.jsonl')\n"))


if __name__ == "__main__":
    unittest.main()
