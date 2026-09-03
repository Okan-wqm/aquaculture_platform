"""RC-1 — every safety control must be reachable from a production entry point.

THE DEFECT CLASS, stated once. A control is written, unit-tested, exported and
name-pinned by an invariant — and never called from production. The suite stays
green because the tests exercise the helper, not the callsite. ORPHAN-HIGH-455
found four instances in one branch; ORPHAN-CRITICAL-420 found a breaker whose
producer was its own `def`; ORPHAN-CRITICAL-498 found a whole perimeter behind a
kwarg no production caller passes. Every one was a reachability fact, and every
one was found by a human reading code.

This file makes reachability a build-time assertion instead.

WHY A QUALIFIED GRAPH AND NOT BARE NAMES. Keying the graph on bare function
names merges every same-named function in the package, which can only ADD edges
— so it can only make a control look MORE reachable than it is. For a "must be
reachable" assertion that is the unsafe direction: it would pass on a control
that is dead. So call targets are resolved to (module, function) using each
scope's own import table.

WHY FUNCTION-LEVEL IMPORTS MATTER HERE. This package imports inside function
bodies constantly (`from .circuit_breaker import record_failure` sits inside
`_run_pr_lifecycle_phase`). A resolver that only read module-level imports would
see almost no edges in this codebase and would fail everything, which is just as
useless as passing everything.

WHY AST AND NOT grep. `grep` is what reported ORPHAN-CRITICAL-428 as wired. It
cannot tell a call from a mention in a comment, and this repo's comments name
these controls constantly — including in the fix for the finding that removed
one of the edges.

WHAT THIS FILE CANNOT CATCH, and why RC-1's other half was not optional.

A conditional call is still an edge. Before the collapse, `run_enterprise_cycle`
really did call `_run_extended_phases` in the source — the call was merely
guarded by `if run_phases is not None`, and no production caller passed that
kwarg. So this graph reported the whole extended pipeline as reachable while it
never executed. ORPHAN-CRITICAL-498 was exactly that shape, which means a static
reachability invariant is structurally incapable of catching it.

That was an argument FOR the tier-1 half of RC-1 rather than a limitation to
live with: now that the phases are a declarative registry with explicit
preconditions, "is this phase in the pipeline?" is a question about DATA a test
can read directly, instead of a question about control flow static analysis has
to guess. The two halves cover different failures and neither substitutes for
the other — this file catches a control with no caller at all; the registry
catches a control whose caller is never entered.

DISPATCH THROUGH THE PHASE TABLE, and why it is read rather than skipped. The
cycle now calls its phases as `phase.runner(context)`, an attribute on a loop
variable that `_resolve` deliberately drops. Left alone, the collapse would have
made ten live controls look dead — and the first run after it did exactly that,
accusing `sweep_human_required_adjudications` of having no production path on
the very commit that put it in the table.

The answer is NOT to loosen `_resolve`. A `CyclePhase(...)` row naming a
function IS the call — the table is the pipeline, and reading it is the same
fidelity as reading a call expression, not a guess about one. So the table is
parsed as data: `_phase_table_edges` walks the `CYCLE_PHASES` assignment and
adds an edge from `run_enterprise_cycle` to each runner named in a row. Scoped
to that one module-level name, so it does not become a general "any function
mentioned in a tuple is called" rule, which would be the over-approximation this
file's docstring rejects.

The same caveat still applies, unchanged, to dispatch through a runtime-computed
table or a string lookup, which this walk does not follow.

WHAT IT DOES CATCH, demonstrated on its own first two runs. Both initial
failures were false positives produced by this resolver, not real dead controls,
and both are documented at the code that fixed them: callback indirection
(`visit_Assign`) and callable strategy objects (`visit_ClassDef`). Recording
them here rather than quietly fixing them is the point — a reachability tool
that over-reports teaches its readers to ignore it.
"""

from __future__ import annotations

import ast
import sys
import unittest
from collections import deque
from pathlib import Path

_KERNEL_ROOT = Path(__file__).resolve().parents[3]
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

_PKG = _KERNEL_ROOT / "aria_kernel"
_PKG_NAME = "aria_kernel"

# A qualified node in the call graph.
Node = tuple[str, str]  # (module stem, function name)


# Controls whose whole purpose is to stop the system doing something unsafe.
# Declared, not discovered: the set is the contract. Adding a safety control
# without adding it here is the omission this invariant cannot catch, which is
# why the list carries the finding that put each one in it.
SAFETY_CONTROLS: dict[str, str] = {
    "run_hard_fail_checks": "ORPHAN-CRITICAL-428 — the pre-PR-open perimeter",
    "observe_perimeter": "ORPHAN-CRITICAL-503 — the observe-mode perimeter",
    "record_failure": "ORPHAN-CRITICAL-420 / 485 — the failure breaker's producer",
    "sweep_human_required_adjudications": "ORPHAN-HIGH-450 / 499 — the HUMAN_REQUIRED panel",
    "assert_autonomy_unlocked": "ORPHAN-CRITICAL-419 — the autonomy unlock gate",
}

# Where production actually starts. `cli.py` is included because an
# operator-driven command IS production — ORPHAN-CRITICAL-498's correction was
# precisely that the perimeter's real caller is the CLI, and a definition of
# "production" that excluded it would report a live control as dead.
PRODUCTION_ENTRY_POINTS: tuple[Node, ...] = (
    ("cycle", "run_enterprise_cycle"),
    ("autonomy_orchestrator", "run_autonomy_orchestrator"),
    ("cli", "main"),
)


class _ScopeResolver(ast.NodeVisitor):
    """Builds, per function, the set of qualified callees it reaches.

    Import bindings are inherited down the scope chain: a module-level
    `from .x import y` is visible inside every function, and a function-level one
    is visible only within it. Modelled with a stack rather than a single dict so
    a local import cannot leak into a sibling function and manufacture an edge.
    """

    def __init__(self, module_stem: str) -> None:
        self.module_stem = module_stem
        # name -> (module stem, original name)
        self._bindings: list[dict[str, Node]] = [{}]
        self._module_aliases: list[dict[str, str]] = [{}]
        self._defined: set[str] = set()
        self.edges: dict[Node, set[Node]] = {}
        self._fn_stack: list[str] = []
        self._class_stack: list[str] = []
        # ClassName -> its method names, so a constructor call can reach __call__
        self.classes: dict[str, set[str]] = {}

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        """Qualify methods as ``Class.method`` and record the class's surface.

        SECOND CORRECTION FOUND BY RUNNING THIS FILE. After the alias fix,
        `assert_autonomy_unlocked` was still reported dead. It is not:

            cli.main -> select_auto_merge_runner -> RealAutoMergeRunner(...)
              -> runner(...)  # Protocol-typed callable, dispatched as __call__
              -> merge_authority.merge_pr_if_ready
              -> assert_autonomy_unlocked

        The indirection is a strategy OBJECT invoked as `runner(...)`. A resolver
        that only followed function names could not see it, and would have
        accused a second live gate of being dead — the same false accusation as
        the first run, one pattern deeper.
        """
        self._defined.add(node.name)
        self.classes.setdefault(node.name, set())
        self._class_stack.append(node.name)
        self._bindings.append(dict(self._bindings[-1]))
        self._module_aliases.append(dict(self._module_aliases[-1]))
        for child in node.body:
            self.visit(child)
        self._bindings.pop()
        self._module_aliases.pop()
        self._class_stack.pop()

    # --- binding collection -------------------------------------------------

    def _bind_import_from(self, node: ast.ImportFrom) -> None:
        if node.level and node.module is None:
            return
        module = (node.module or "").split(".")[-1]
        for alias in node.names:
            local = alias.asname or alias.name
            self._bindings[-1][local] = (module, alias.name)

    def _bind_import(self, node: ast.Import) -> None:
        for alias in node.names:
            stem = alias.name.split(".")[-1]
            self._module_aliases[-1][alias.asname or stem] = stem

    def visit_Import(self, node: ast.Import) -> None:
        self._bind_import(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        self._bind_import_from(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        """Follow `local = imported_function` so callback indirection keeps its edge.

        FOUND BY THIS FILE'S FIRST RUN, and the correction matters more than the
        feature. The first version reported `record_failure` as having no
        production path. It does have one:

            run_autonomy_orchestrator
              -> autonomous_planner_dispatcher (invoke_planner defaults to
                 `dispatch_one_pending_planner_request`, ASSIGNED to a local)
              -> planner_dispatch_hook.dispatch_one_pending_planner_request
              -> record_failure

        The hook is injected as a default callable rather than called by name, so
        a resolver that only followed imports lost the edge and accused a live
        control of being dead. A false accusation here is as damaging as a missed
        defect: acting on it would have meant "re-wiring" a breaker that was
        already wired.

        Scope of the rule, deliberately narrow: a single `Name = Name`
        assignment whose right-hand side already resolves to a known binding. It
        follows an explicit alias, never a guess. Conditional assignment (this
        one sits inside `if invoke_planner is None:`) still binds, because the
        default branch IS the production path.
        """
        if (
            len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Name)
        ):
            bound = self._bindings[-1].get(node.value.id)
            if bound is not None:
                self._bindings[-1][node.targets[0].id] = bound
        self.generic_visit(node)

    # --- scopes -------------------------------------------------------------

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        if self._class_stack:
            qualified = f"{self._class_stack[-1]}.{node.name}"
            self.classes.setdefault(self._class_stack[-1], set()).add(node.name)
        else:
            qualified = node.name
            self._defined.add(node.name)
        self._fn_stack.append(qualified)
        self._bindings.append(dict(self._bindings[-1]))
        self._module_aliases.append(dict(self._module_aliases[-1]))
        here: Node = (self.module_stem, qualified)
        self.edges.setdefault(here, set())
        for child in node.body:
            self.visit(child)
        self._bindings.pop()
        self._module_aliases.pop()
        self._fn_stack.pop()

    visit_FunctionDef = _visit_function  # type: ignore[assignment]
    visit_AsyncFunctionDef = _visit_function  # type: ignore[assignment]

    # --- calls --------------------------------------------------------------

    def visit_Call(self, node: ast.Call) -> None:
        target = self._resolve(node.func)
        if target is not None and self._fn_stack:
            self.edges.setdefault((self.module_stem, self._fn_stack[-1]), set()).add(target)
        self.generic_visit(node)

    def _resolve(self, func: ast.expr) -> Node | None:
        if isinstance(func, ast.Name):
            bound = self._bindings[-1].get(func.id)
            if bound is not None:
                return bound
            # An unbound bare name is either defined in this module or is a
            # builtin; assume same-module. Wrong only for builtins, which never
            # match a declared control name.
            return (self.module_stem, func.id)
        if isinstance(func, ast.Attribute):
            value = func.value
            if isinstance(value, ast.Name):
                stem = self._module_aliases[-1].get(value.id)
                if stem is not None:
                    return (stem, func.attr)
                bound = self._bindings[-1].get(value.id)
                if bound is not None:
                    # `mod.f()` where `mod` came from a from-import
                    return (bound[1], func.attr)
            # A method call on an arbitrary object: the receiver's type is not
            # statically known here, so the attribute name alone is recorded
            # against no module. Deliberately dropped rather than guessed —
            # inventing a module would be the over-approximation this file
            # exists to avoid.
            return None
        return None


# The declarative pipeline and the function that walks it. Named here rather
# than discovered, so a rename shows up as this invariant failing loudly instead
# of silently losing every edge the table carries.
_PHASE_TABLE = ("cycle", "CYCLE_PHASES")
_PHASE_TABLE_DRIVER = ("cycle", "run_enterprise_cycle")


def _phase_table_edges(tree: ast.Module, stem: str) -> set[Node]:
    """Every function named in a ``CYCLE_PHASES`` row, as a call target.

    The rows are `CyclePhase(name, stage, runner, ...)` — a bare `ast.Name`
    in a positional or keyword slot is a reference to a module-level function
    the driver will invoke. Only bare names are followed; a lambda or an
    expression is not a named target and is deliberately not guessed at.
    """
    if stem != _PHASE_TABLE[0]:
        return set()
    targets: set[Node] = set()
    for node in ast.walk(tree):
        # The table carries a type annotation, so it parses as AnnAssign, not
        # Assign. Handling only the latter is how the first draft of this
        # parser found zero rows and reported ten live controls as dead.
        if isinstance(node, ast.Assign):
            names = [t for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            names = [node.target] if isinstance(node.target, ast.Name) else []
            value = node.value
        else:
            continue
        if not any(name.id == _PHASE_TABLE[1] for name in names):
            continue
        for call in ast.walk(value):
            if not isinstance(call, ast.Call):
                continue
            operands = list(call.args) + [kw.value for kw in call.keywords]
            for operand in operands:
                if isinstance(operand, ast.Name):
                    targets.add((stem, operand.id))
    return targets


def _build_graph() -> tuple[dict[Node, set[Node]], dict[str, set[Node]]]:
    edges: dict[Node, set[Node]] = {}
    definitions: dict[str, set[Node]] = {}
    classes: dict[Node, set[str]] = {}
    table_targets: set[Node] = set()
    for path in sorted(_PKG.rglob("*.py")):
        stem = path.stem
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        resolver = _ScopeResolver(stem)
        resolver.visit(tree)
        for node, callees in resolver.edges.items():
            edges.setdefault(node, set()).update(callees)
        for name in resolver._defined:
            definitions.setdefault(name, set()).add((stem, name))
        for class_name, methods in resolver.classes.items():
            classes[(stem, class_name)] = methods
        table_targets |= _phase_table_edges(tree, stem)
    edges.setdefault(_PHASE_TABLE_DRIVER, set()).update(table_targets)

    # Constructing a callable strategy object is an intent to call it, so a
    # resolved constructor call gains an edge to that class's __call__. Scoped to
    # __call__ alone rather than to every method: it is the invocation protocol,
    # and widening it to all methods would be the loose over-approximation this
    # file's docstring rejects.
    for caller, callees in list(edges.items()):
        for target in list(callees):
            methods = classes.get(target)
            if methods and "__call__" in methods:
                edges[caller].add((target[0], f"{target[1]}.__call__"))
    return edges, definitions


def _reachable(edges: dict[Node, set[Node]], roots: tuple[Node, ...]) -> set[Node]:
    seen: set[Node] = set()
    queue: deque[Node] = deque(roots)
    while queue:
        node = queue.popleft()
        if node in seen:
            continue
        seen.add(node)
        queue.extend(edges.get(node, ()))
    return seen


class SafetyControlReachability(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.edges, cls.definitions = _build_graph()
        cls.reachable = _reachable(cls.edges, PRODUCTION_ENTRY_POINTS)

    def test_the_entry_points_exist(self) -> None:
        """A typo'd entry point would make every control look unreachable."""
        for module_stem, function in PRODUCTION_ENTRY_POINTS:
            with self.subTest(entry=f"{module_stem}.{function}"):
                self.assertIn((module_stem, function), self.definitions.get(function, set()))

    def test_every_safety_control_is_reachable_from_production(self) -> None:
        unreachable: dict[str, str] = {}
        for control, provenance in sorted(SAFETY_CONTROLS.items()):
            nodes = self.definitions.get(control, set())
            self.assertTrue(nodes, msg=f"{control} is not defined anywhere in {_PKG_NAME}")
            if not (nodes & self.reachable):
                unreachable[control] = provenance
        self.assertEqual(
            unreachable,
            {},
            msg=(
                "these safety controls have NO call path from any production entry "
                "point — written, tested, and dead:\n"
                + "\n".join(f"  {k}: {v}" for k, v in unreachable.items())
            ),
        )

    def test_the_phase_table_is_the_source_of_its_own_edges(self) -> None:
        """The table-derived edges must come from the table, not be assumed.

        If `CYCLE_PHASES` were renamed or restructured, `_phase_table_edges`
        would silently return nothing and this file would go back to
        accusing every phase runner of being dead — a failure that reads as
        a real finding. Asserting the edges exist makes the parser's own
        breakage look like what it is.
        """
        from_table = self.edges.get(_PHASE_TABLE_DRIVER, set())
        runners = {node for node in from_table if node[1].startswith("_phase_")}
        self.assertGreaterEqual(
            len(runners), 10,
            "the CYCLE_PHASES parse produced almost no phase runners — the table "
            "was probably renamed or restructured, and every control reachable "
            "only through it is about to be reported dead",
        )

    def test_the_control_set_is_not_silently_shrinking(self) -> None:
        """Removing a control from the declared set must be deliberate.

        A weakening of this invariant looks exactly like a passing build, so the
        count is pinned. Raising it is expected as controls are added; lowering it
        needs the same review as deleting a gate.
        """
        self.assertGreaterEqual(len(SAFETY_CONTROLS), 5)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
