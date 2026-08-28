"""ORPHAN-CRITICAL-479 — no unbound name may reach an executor's runtime path.

Why this exists
===============
A commit on this branch introduced `MODEL_FALLBACK_TIER.get(model, ...)` into
`worker_executor.main()`, where `model` is bound ONLY as a parameter of a nested
`_dispatch_attempt(model, effort)` defined above it. That is a NameError on the
only real worker-dispatch path, and the full suite passed 2905/2905 both before
and after the fix, because nothing exercises that callsite.

That is precisely the defect class this branch exists to close — a control
written, reviewed and shipped with no production coverage — reproduced by the
remediation itself. A fix without a detector just schedules the next instance,
so this test resolves every loaded name in the executor modules against the
scopes that could bind it and fails on any that cannot be bound.

It is deliberately a STATIC check. Executing these paths needs a lease, a
worktree, a Claude session and an artifact round-trip; a static resolver costs
nothing and catches the whole class rather than one instance.
"""
from __future__ import annotations

import ast
import builtins
import unittest
from pathlib import Path

POC = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
TARGETS = ("worker_executor.py", "ci_executor.py", "claude_runtime.py")

# ORPHAN-HIGH-765 — the detector's SCOPE was the defect, not the detector.
#
# This file's own docstring says "a fix without a detector just schedules the
# next instance". It was right, and then the class recurred in the one place
# the detector was not looking: `cycle.py:1151` loaded `ensure_tools_dir`
# while the module imported the similarly-named `ensure_tools_binding`, so the
# `product_fitness` phase raised NameError on every scheduled night and killed
# the cycle — with 4,500+ tests green, because nothing exercises that phase.
#
# The kernel is now scanned in full rather than by a hand-listed tuple: a
# curated list is the same failure one level up, and the file added tomorrow
# would be outside it by default. Scanning everything means a NEW module is
# covered on the day it lands, which is the only version of this check that
# does not decay.
KERNEL = Path(__file__).resolve().parents[1] / "aria_kernel"
_BUILTINS = frozenset(dir(builtins))


def _module_bindings(tree: ast.Module) -> set[str]:
    """Names bound at module level: imports, assignments, defs, classes."""
    out: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names:
                out.add((a.asname or a.name).split(".")[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
        elif isinstance(node, ast.Assign):
            for tgt in node.targets:
                out.update(_bound_by(tgt))
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            out.update(_bound_by(node.target))
        elif isinstance(node, (ast.Try, ast.If, ast.With)):
            # Conditional/也 guarded module-level imports are common here.
            for sub in ast.walk(node):
                if isinstance(sub, (ast.Import, ast.ImportFrom)):
                    for a in sub.names:
                        out.add((a.asname or a.name).split(".")[0])
                elif isinstance(sub, ast.Assign):
                    for tgt in sub.targets:
                        out.update(_bound_by(tgt))
                elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    out.add(sub.name)
    return out


def _bound_by(node: ast.AST) -> set[str]:
    out: set[str] = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and isinstance(sub.ctx, (ast.Store, ast.Del)):
            out.add(sub.id)
    return out


def _walk_own_scope(fn: ast.AST):
    """Yield every node in THIS function's own scope.

    Stops at nested function/class boundaries — those are separate scopes,
    checked with their own visible set. Yields the boundary node itself so a
    caller can record its NAME without descending into its body.

    Two bugs were written here before this worked, both caught by reintroducing
    the NameError this file exists to detect:
      1. ast.walk pulled a NESTED function's parameters into the enclosing
         scope, so `_dispatch_attempt(model, effort)` made `model` look bound in
         `main()`.
      2. The recursion inspected each node's CHILDREN but never the node itself,
         so a function-local `from x import y` statement bound nothing.
    """
    def rec(node: ast.AST):
        for child in ast.iter_child_nodes(node):
            yield child
            # ORPHAN-HIGH-765 — `lambda` is a scope too, and leaving it out is
            # what made the widened scan look like 129 defects. `sort(key=lambda
            # item: ...)` binds `item` ONLY inside the lambda; descending into
            # the body while reading parameters from the enclosing function
            # reports every lambda argument in the codebase as unbound. The
            # lambda is yielded (so a caller may inspect it) and not entered.
            if isinstance(
                child,
                (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda),
            ):
                continue
            yield from rec(child)

    body = getattr(fn, "body", [])
    # A Lambda's body is a single EXPRESSION, not a statement list. Iterating it
    # walks the expression's fields instead of its nodes and raises on the first
    # tuple — which is how this extension announced its own bug.
    if isinstance(body, ast.AST):
        body = [body]
    for stmt in body:
        yield stmt
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        yield from rec(stmt)


def _scope_bindings(fn: ast.AST) -> set[str]:
    """Every name THIS function's own scope binds."""
    out: set[str] = set()
    args = getattr(fn, "args", None)
    if args is not None:
        for a in (*args.posonlyargs, *args.args, *args.kwonlyargs):
            out.add(a.arg)
        if args.vararg:
            out.add(args.vararg.arg)
        if args.kwarg:
            out.add(args.kwarg.arg)
    for node in _walk_own_scope(fn):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            out.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names:
                out.add((a.asname or a.name).split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            out.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            out.update(node.names)
    return out


def _loads_in_own_scope(fn: ast.AST) -> list[ast.Name]:
    return [
        n for n in _walk_own_scope(fn)
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)
    ]


class ExecutorUnboundNameTests(unittest.TestCase):

    def test_no_loaded_name_is_unbindable(self) -> None:
        offenders: list[str] = []
        scanned = [(name, POC / name) for name in TARGETS]
        scanned += [
            (f"aria_kernel/{p.name}", p) for p in sorted(KERNEL.glob("*.py"))
        ]
        # A floor, not a count: if a refactor moves the kernel elsewhere this
        # loop would silently scan three files and pass, which is exactly the
        # shape of vacuous green this check exists to refuse.
        self.assertGreater(
            len(scanned), 50, "the kernel scan collapsed; this check is measuring nothing",
        )
        for name, path in scanned:
            tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
            module_names = _module_bindings(tree) | _BUILTINS | {"__name__", "__file__", "__doc__"}

            def walk(node: ast.AST, enclosing: set[str]) -> None:
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, ast.Lambda):
                        # Its own scope: parameters bind inside it, and the
                        # enclosing visible set still applies to closures.
                        lam = _scope_bindings(child)
                        for sub in _loads_in_own_scope(child):
                            if sub.id not in (enclosing | lam):
                                offenders.append(
                                    f"{name}:{sub.lineno} `{sub.id}` "
                                    f"loaded in a lambda but bound nowhere reachable"
                                )
                        continue
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        own = _scope_bindings(child)
                        visible = enclosing | own
                        for sub in _loads_in_own_scope(child):
                            if sub.id not in visible:
                                    offenders.append(
                                        f"{name}:{sub.lineno} `{sub.id}` "
                                        f"loaded in {child.name}() but bound nowhere reachable"
                                    )
                        walk(child, visible)
                    elif isinstance(child, ast.ClassDef):
                        walk(child, enclosing | _scope_bindings(child))
                    else:
                        walk(child, enclosing)

            walk(tree, module_names)
        self.assertEqual(
            offenders, [],
            "unbound name(s) on an executor runtime path:\n  " + "\n  ".join(offenders),
        )


if __name__ == "__main__":
    unittest.main()
