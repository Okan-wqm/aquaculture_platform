"""Plan 026R §A.2 — AST invariants for the §A.1 atomic primitive.

2 tests:

* Hot-path consumers (``cycle.py``, ``reflection.py``) consume the runs
  ledger and other hash-chained ledgers via ``load_jsonl_verified``,
  not plain ``load_jsonl``. AST scan asserts the strict primitive is
  imported and used in the migrated callsites.
* ``_append_jsonl_unlocked`` is only invoked from a function body that
  also opens ``with_exclusive_lock(path)`` for the same ledger path. AST
  scan over ``aria-kernel/aria_kernel/*.py``.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

ARIA_KERNEL = Path(__file__).resolve().parent.parent / "aria_kernel"


def _module_source(name: str) -> str:
    return (ARIA_KERNEL / name).read_text(encoding="utf-8")


def _module_ast(name: str) -> ast.Module:
    return ast.parse(_module_source(name))


def _functions_calling(module: ast.Module, name: str) -> list[ast.FunctionDef]:
    """Return function nodes in ``module`` whose body contains a call to
    ``name`` (resolved against ``ast.Call.func``)."""
    out: list[ast.FunctionDef] = []
    for func in ast.walk(module):
        if not isinstance(func, ast.FunctionDef):
            continue
        for call in ast.walk(func):
            if isinstance(call, ast.Call):
                f = call.func
                if isinstance(f, ast.Name) and f.id == name:
                    out.append(func)
                    break
                if isinstance(f, ast.Attribute) and f.attr == name:
                    out.append(func)
                    break
    return out


def _is_lock_context_expr(expr: ast.AST) -> bool:
    if isinstance(expr, ast.Call):
        f = expr.func
        if isinstance(f, ast.Name) and f.id == "with_exclusive_lock":
            return True
        if isinstance(f, ast.Attribute) and f.attr == "with_exclusive_lock":
            return True
    return False


def _opens_lock_context(func: ast.FunctionDef) -> bool:
    """True if ``func`` opens a ``with with_exclusive_lock(...)`` block."""
    for node in ast.walk(func):
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if _is_lock_context_expr(item.context_expr):
                    return True
    return False


def _parent_map(module: ast.Module) -> dict[int, ast.AST]:
    parents: dict[int, ast.AST] = {}
    for parent in ast.walk(module):
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent
    return parents


def _enclosing_function(parents: dict[int, ast.AST], node: ast.AST) -> ast.FunctionDef | None:
    cursor: ast.AST = node
    while id(cursor) in parents:
        parent = parents[id(cursor)]
        if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return parent  # type: ignore[return-value]
        cursor = parent
    return None


def _is_call_inside_lock(parents: dict[int, ast.AST], call: ast.AST) -> bool:
    cursor: ast.AST = call
    while id(cursor) in parents:
        parent = parents[id(cursor)]
        if isinstance(parent, (ast.With, ast.AsyncWith)):
            for item in parent.items:
                if _is_lock_context_expr(item.context_expr):
                    return True
        cursor = parent
    return False


def _call_sites(module: ast.Module, target_name: str) -> list[ast.Call]:
    out: list[ast.Call] = []
    for node in ast.walk(module):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name) and f.id == target_name:
                out.append(node)
            elif isinstance(f, ast.Attribute) and f.attr == target_name:
                out.append(node)
    return out


class HotPathVerifiedReadInvariantTests(unittest.TestCase):
    """Hot-path consumers use load_jsonl_verified, not load_jsonl, on the
    ledgers explicitly migrated in §A.2 (runs.jsonl,
    auto-merge-decisions.jsonl, memory/beliefs.jsonl)."""

    def test_cycle_runs_path_loader_uses_strict_primitive(self) -> None:
        """v2 runtime contract: the runs summary iterates the per-cycle index.

        ASSERTED STRUCTURALLY, and the reason is that the previous spelling
        was `assertIn("for run in read_runs_for_cycle(base_dir=root, "
        "cycle_uid=cycle_id)", src)` — a verbatim source line, including the
        local variable names at the callsite. RC-1 moved the loop into a
        phase runner and renamed `root` to `context.base_dir`; the property
        was untouched and the assertion still failed. Worse in the other
        direction: the same literal would keep passing if someone added a
        SECOND loop that scanned runs.jsonl directly, because the pinned line
        would still be present. Matching the AST asserts the property; matching
        the text asserted a formatting choice.
        """
        module = _module_ast("cycle.py")
        iterators = [
            node.iter for node in ast.walk(module)
            if isinstance(node, (ast.For, ast.AsyncFor))
        ]
        indexed = [
            it for it in iterators
            if isinstance(it, ast.Call)
            and isinstance(it.func, ast.Name)
            and it.func.id == "read_runs_for_cycle"
        ]
        self.assertTrue(
            indexed,
            "cycle.py no longer iterates read_runs_for_cycle; the runs summary "
            "must consume the per-cycle index, not scan the ledger",
        )
        for call in indexed:
            kwargs = {kw.arg for kw in call.keywords}
            self.assertIn("base_dir", kwargs)
            self.assertIn("cycle_uid", kwargs)
        direct_scans = [
            call for call in _call_sites(module, "load_jsonl")
            if any(
                isinstance(arg, ast.Call)
                and isinstance(arg.func, ast.Name)
                and arg.func.id == "runs_path"
                for arg in call.args
            )
        ]
        self.assertEqual(
            direct_scans, [],
            "cycle.py must not reintroduce a direct load_jsonl(runs_path(...)) scan",
        )

    def test_reflection_hot_path_loaders_use_strict_primitive(self) -> None:
        src = _module_source("reflection.py")
        self.assertIn("load_jsonl_verified", src)
        # All 3 migrated ledgers must be loaded via load_jsonl_verified.
        self.assertIn("load_jsonl_verified(runs_path(base_dir))", src)
        self.assertIn(
            'load_jsonl_verified(root / "auto-merge-decisions.jsonl")', src,
        )
        self.assertIn(
            'load_jsonl_verified(root / "memory" / "beliefs.jsonl")', src,
        )


class UnlockedHelperOnlyInsideLockInvariantTests(unittest.TestCase):
    """``_append_jsonl_unlocked`` callers MUST be inside a
    ``with_exclusive_lock`` block — directly or transitively.

    Two acceptance rules, in order:

    1. **Direct lock.** The function that calls ``_append_jsonl_unlocked``
       opens ``with with_exclusive_lock(...)`` somewhere in its own body
       (the §A.1 public ``append_jsonl`` / ``rewrite_jsonl`` pattern).
    2. **Transitive lock.** If the function does NOT open the lock itself
       (private helpers such as ``_persist_rejection`` whose architectural
       contract is "caller holds the lock"), then EVERY callsite of that
       helper across the kernel must be lexically inside a
       ``with with_exclusive_lock(...)`` block. The AST scan walks the
       parent chain from each callsite up to a ``with`` whose context
       expression is ``with_exclusive_lock(...)``.

    The second rule keeps tier-3 detection power without forcing private
    helpers to redundantly open the lock their caller already owns
    (which would be incorrect: ``fcntl.flock`` is non-reentrant on POSIX
    so a redundant acquire deadlocks the holder).
    """

    def _load_modules(self) -> dict[str, ast.Module]:
        modules: dict[str, ast.Module] = {}
        for module_path in ARIA_KERNEL.glob("*.py"):
            if module_path.name == "__init__.py":
                continue
            modules[module_path.name] = ast.parse(
                module_path.read_text(encoding="utf-8")
            )
        return modules

    def test_every_unlocked_caller_opens_lock_directly_or_transitively(self) -> None:
        modules = self._load_modules()
        offenders: list[str] = []

        for module_name, module in modules.items():
            for func in _functions_calling(module, "_append_jsonl_unlocked"):
                # Rule 1 — direct lock in the function body.
                if _opens_lock_context(func):
                    continue
                # Rule 2 — transitive: every callsite of `func` across
                # the kernel must be inside a `with_exclusive_lock` block.
                # If `func` has zero external callers, the helper is dead
                # code and we treat it as an offender (no transitive cover).
                callsite_found = False
                all_locked = True
                for caller_module_name, caller_module in modules.items():
                    parents = _parent_map(caller_module)
                    for call in _call_sites(caller_module, func.name):
                        enclosing = _enclosing_function(parents, call)
                        if enclosing is func:
                            # Recursive self-call doesn't count toward
                            # transitive cover.
                            continue
                        callsite_found = True
                        if not _is_call_inside_lock(parents, call):
                            all_locked = False
                            offenders.append(
                                f"{caller_module_name}:{call.lineno} "
                                f"(in {enclosing.name if enclosing else '<module>'}) "
                                f"-> {func.name} (transitively unlocked)"
                            )
                if not callsite_found:
                    offenders.append(
                        f"{module_name}:{func.lineno} "
                        f"(in {func.name}) "
                        f"-> _append_jsonl_unlocked (no direct lock, "
                        f"no external callsites — dead code)"
                    )

        self.assertEqual(
            offenders,
            [],
            "Every caller of _append_jsonl_unlocked must be inside a "
            "`with with_exclusive_lock(...)` block, either directly or "
            "via every callsite of a private helper. Offenders:\n  "
            + "\n  ".join(offenders),
        )


if __name__ == "__main__":
    unittest.main()
