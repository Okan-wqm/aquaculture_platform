"""Which string literals can actually reach an argument, statically.

WHY THIS EXISTS. `control_reachability` asks *"is this control called"* and
answers it by looking for the control's NAME in production source. That works
because a function name is a unique token. It does not work for the other half
of the same defect class, where the dormant thing is a **member of a closed
string set** — a lifecycle state, an event type, a request role. Those members
are ordinary words. `"ACTIVE"`, `"implementation"` and `"verification"` occur
all over the kernel in text that mints nothing.

Two cheaper rules were measured against this repository first, and both were
rejected on evidence rather than on taste:

* *"the literal appears in a module that calls the writer"* — too generous.
  `cli.py` mints agent requests AND contains every string in the vocabulary,
  so `role="verification"` scored as minted on the strength of
  ``add_subparser(sub, "verification")``, a subcommand name. A gate that
  certifies a dead role is worse than no gate.
* *"the literal appears in the same function as the writer call"* — too
  strict. It misses `CROSS_REVIEW_ROLE = ("aria-cross-reviewer",
  "cross_review")` unpacked one line above the mint, and it misses
  `_ensure_planner_request(role="challenger_plan")` where the literal is at
  the caller and the mint is one frame down. It reported 16 of 22 roles dead
  when most were plainly wired. A gate that cries wolf gets waived away.

So the question has to be asked properly: **can this literal reach that
argument.** This module answers it by walking backwards from the argument
expression through the bindings that produced it — assignment, tuple unpack,
loop target, subscript, conditional, and one hop across a call boundary into
the caller's literal.

WHAT `None` MEANS, and why it is not a failure. Resolution returns ``None``
for an expression whose value is not statically knowable — ``args.role`` from
an argparse namespace, a value read from a dict, an f-string. ``None`` is
*"this callsite proves nothing about any member"*, NOT *"this callsite is
broken"*. That distinction is what keeps the generic CLI passthrough
(`cli.py` mints whatever ``--role`` was typed) from silently vouching for
every role in the vocabulary — which is precisely how a role with no
programmatic minter stays invisible.

The walk is depth-budgeted. Unbounded interprocedural resolution over 250
modules is both slow and — through recursion — non-terminating; two hops is
what the measured callsites need, and a third hop bought nothing.
"""

from __future__ import annotations

import ast
from pathlib import Path

from .control_reachability import production_sources

# Two hops covers every measured shape: literal -> local name -> argument,
# and caller literal -> callee parameter -> argument. Raising it did not
# resolve one additional member in this repository, and each hop multiplies
# the callsite fan-out.
MAX_HOPS = 2


class ProductionIndex:
    """Parsed production Python, plus the lookups the walk needs.

    Built once per gate run: the resolver is called once per writer callsite
    per surface, and re-parsing 250 modules for each would make the gate slow
    enough that people stop running it.
    """

    def __init__(self, repo_root: str | Path) -> None:
        self.repo_root = Path(repo_root)
        self.modules: dict[Path, ast.Module] = {}
        for path in production_sources(repo_root):
            try:
                self.modules[path] = ast.parse(path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError):
                continue
        self._parents: dict[Path, dict[ast.AST, ast.AST]] = {}
        for path, tree in self.modules.items():
            parents: dict[ast.AST, ast.AST] = {}
            for node in ast.walk(tree):
                for child in ast.iter_child_nodes(node):
                    parents[child] = node
            self._parents[path] = parents
        self._call_index: dict[str, list[tuple[Path, ast.Call]]] | None = None

    def enclosing_functions(self, path: Path, node: ast.AST) -> tuple[ast.AST, ...]:
        """The chain of functions containing ``node``, innermost first.

        The chain and not just the innermost frame, because the kernel's
        dispatcher factories are closures: ``select_judge(role=...)`` validates
        the role and returns a ``_judge_fn`` that mints with it. Stopping at
        ``_judge_fn`` loses the binding entirely and reports two live judge
        roles as dead.
        """
        chain: list[ast.AST] = []
        parents = self._parents.get(path, {})
        current = parents.get(node)
        while current is not None:
            if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
                chain.append(current)
            current = parents.get(current)
        return tuple(chain)

    def calls_to(self, function_name: str) -> list[tuple[Path, ast.Call]]:
        """Every production call whose callee is spelled ``function_name``.

        Matches by name, not by resolved symbol: the kernel imports its own
        helpers directly (``from .x import y``) and calls them bare, so the
        name IS the binding in practice. An unrelated same-named function
        would widen the evidence, never narrow it — this walk can only make
        a member look MORE reachable, and a member that is genuinely dead has
        no callsite of any spelling.
        """
        if self._call_index is None:
            # Built once. The walk is interprocedural, so an un-indexed
            # lookup re-scans 250 modules per resolved name and turns a
            # sub-second gate into a 90-second one nobody runs locally.
            index: dict[str, list[tuple[Path, ast.Call]]] = {}
            for path, tree in self.modules.items():
                for node in ast.walk(tree):
                    if not isinstance(node, ast.Call):
                        continue
                    func = node.func
                    name = (
                        func.id
                        if isinstance(func, ast.Name)
                        else func.attr if isinstance(func, ast.Attribute) else None
                    )
                    if name:
                        index.setdefault(name, []).append((path, node))
            self._call_index = index
        return self._call_index.get(function_name, [])


def argument_for(call: ast.Call, *, field: str, position: int | None = None) -> ast.AST | None:
    """The expression bound to ``field`` at this callsite, keyword or positional."""
    for keyword in call.keywords:
        if keyword.arg == field:
            return keyword.value
    if position is not None and position < len(call.args):
        argument = call.args[position]
        if not isinstance(argument, ast.Starred):
            return argument
    return None


def _sequence_elements(node: ast.AST) -> list[ast.AST] | None:
    if isinstance(node, (ast.Tuple, ast.List)):
        return list(node.elts)
    return None


def _parameter_index(function: ast.AST, name: str) -> tuple[bool, int | None]:
    """Is ``name`` a parameter of ``function``, and at which positional slot."""
    if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return (False, None)
    positional = list(function.args.posonlyargs) + list(function.args.args)
    for index, arg in enumerate(positional):
        if arg.arg == name:
            return (True, index)
    for arg in function.args.kwonlyargs:
        if arg.arg == name:
            return (True, None)
    return (False, None)


_OPAQUE_SCOPE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)


def _scope_statements(container: ast.AST) -> list[ast.AST]:
    """Nodes belonging to this frame, not to a nested one.

    ``ast.walk`` cannot express this: it is breadth-first over every
    descendant, so skipping a nested ``def`` still visits its body. That leak
    is not cosmetic — it let one helper's local ``role`` vouch for a sibling
    helper's mint, and the evidence line then pointed at the wrong function.
    """
    body = (
        list(container.body)
        if isinstance(container, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef))
        else []
    )
    collected: list[ast.AST] = []
    queue: list[ast.AST] = list(body)
    while queue:
        node = queue.pop()
        if isinstance(node, _OPAQUE_SCOPE_NODES):
            continue
        collected.append(node)
        queue.extend(ast.iter_child_nodes(node))
    return collected


class _Resolver:
    """One backwards walk. Instances are cheap; the index is not."""

    def __init__(self, index: ProductionIndex) -> None:
        self.index = index
        self._scope_cache: dict[int, list[ast.AST]] = {}

    def _statements(self, container: ast.AST) -> list[ast.AST]:
        key = id(container)
        if key not in self._scope_cache:
            self._scope_cache[key] = _scope_statements(container)
        return self._scope_cache[key]

    def resolve(
        self,
        node: ast.AST | None,
        *,
        path: Path,
        scopes: tuple[ast.AST, ...],
        hops: int,
        seen: frozenset[int] = frozenset(),
    ) -> frozenset[str] | None:
        """Literals this expression may hold, or None when not statically knowable."""
        if node is None or id(node) in seen:
            return None
        seen = seen | {id(node)}

        if isinstance(node, ast.Constant):
            return frozenset({node.value}) if isinstance(node.value, str) else None

        if isinstance(node, ast.IfExp):
            # Both arms are mintable, so both count; one opaque arm still
            # proves the other rather than poisoning the pair.
            known = [
                branch
                for branch in (
                    self.resolve(node.body, path=path, scopes=scopes, hops=hops, seen=seen),
                    self.resolve(node.orelse, path=path, scopes=scopes, hops=hops, seen=seen),
                )
                if branch is not None
            ]
            return frozenset().union(*known) if known else None

        if isinstance(node, ast.Subscript):
            elements = self._elements_of(node.value, path=path, scopes=scopes)
            index = node.slice
            if elements is None or not isinstance(index, ast.Constant):
                return None
            if not isinstance(index.value, int) or index.value >= len(elements):
                return None
            return self.resolve(elements[index.value], path=path, scopes=scopes, hops=hops, seen=seen)

        if isinstance(node, ast.Name):
            return self._resolve_name(node.id, path=path, scopes=scopes, hops=hops, seen=seen)

        # Attribute (``args.role``), Call, JoinedStr, BinOp, dict lookup: not
        # statically knowable, and saying so plainly is the whole point.
        return None

    def _resolve_name(
        self, name: str, *, path: Path, scopes: tuple[ast.AST, ...], hops: int, seen: frozenset[int]
    ) -> frozenset[str] | None:
        resolved: set[str] = set()
        found = False

        for binding in self._bindings(name, path=path, scopes=scopes):
            values = self.resolve(binding, path=path, scopes=scopes, hops=hops, seen=seen)
            if values is not None:
                resolved |= values
                found = True

        # A parameter of ANY enclosing frame: the innermost function is often
        # a closure over the frame that declared and validated the value.
        for scope in scopes:
            is_parameter, position = _parameter_index(scope, name)
            if not is_parameter:
                continue
            guarded = self._guard_literals(name, scope=scope)
            if guarded:
                resolved |= guarded
                found = True
            if hops > 0:
                incoming = self._caller_literals(
                    name, position=position, scope=scope, hops=hops, seen=seen
                )
                if incoming is not None:
                    resolved |= incoming
                    found = True
            break

        return frozenset(resolved) if found else None

    def _elements_of(
        self, node: ast.AST, *, path: Path, scopes: tuple[ast.AST, ...]
    ) -> list[ast.AST] | None:
        direct = _sequence_elements(node)
        if direct is not None:
            return direct
        if isinstance(node, ast.Name):
            for binding in self._bindings(node.id, path=path, scopes=scopes):
                elements = _sequence_elements(binding)
                if elements is not None:
                    return elements
        return None

    def _bindings(self, name: str, *, path: Path, scopes: tuple[ast.AST, ...]) -> list[ast.AST]:
        """Every expression bound to ``name``, innermost frame outward.

        Covers plain assignment, annotated assignment, tuple unpack
        (``target_agent, role = CROSS_REVIEW_ROLE``) and loop targets
        (``for state, evidence in steps``) — the shapes the kernel actually
        uses to carry a member from its declaration to its writer.
        """
        results: list[ast.AST] = []
        module = self.index.modules.get(path)
        containers: list[ast.AST] = [*scopes]
        if module is not None:
            containers.append(module)
        for container in containers:
            for node in self._statements(container):
                if isinstance(node, ast.Assign):
                    for target in node.targets:
                        results.extend(self._binding_for_target(target, name, node.value))
                elif isinstance(node, ast.AnnAssign) and node.value is not None:
                    results.extend(self._binding_for_target(node.target, name, node.value))
                elif isinstance(node, (ast.For, ast.AsyncFor)):
                    results.extend(
                        self._binding_for_iteration(node.target, name, node.iter, path=path)
                    )
                elif isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
                    # A comprehension binds its target exactly as a `for`
                    # statement does, and the kernel uses one for the SANDBOX
                    # promotion pair: `record_transition(to_state=to_state)
                    # for to_state in ("REAL_SANDBOX", "SHADOW")`. Treating
                    # only the statement form reported both rungs unclimbable
                    # while the code plainly climbs them.
                    for generator in node.generators:
                        results.extend(
                            self._binding_for_iteration(
                                generator.target, name, generator.iter, path=path
                            )
                        )
        return results

    def _binding_for_target(self, target: ast.AST, name: str, value: ast.AST) -> list[ast.AST]:
        if isinstance(target, ast.Name):
            return [value] if target.id == name else []
        elements = _sequence_elements(target)
        if elements is None:
            return []
        for index, element in enumerate(elements):
            if isinstance(element, ast.Name) and element.id == name:
                slots = _sequence_elements(value)
                if slots is not None and index < len(slots):
                    return [slots[index]]
                # ``target_agent, role = CROSS_REVIEW_ROLE`` — hand the slot to
                # the Subscript arm, which resolves the named tuple constant.
                return [ast.Subscript(value=value, slice=ast.Constant(value=index), ctx=ast.Load())]
        return []

    def _binding_for_iteration(
        self, target: ast.AST, name: str, iterable: ast.AST, *, path: Path
    ) -> list[ast.AST]:
        """``for <target> in <iterable>`` binds each element to the target."""
        elements = self._iterable_elements(iterable, path=path)
        if elements is None:
            return []
        if isinstance(target, ast.Name):
            return elements if target.id == name else []
        slots = _sequence_elements(target)
        if slots is None:
            return []
        for index, slot in enumerate(slots):
            if isinstance(slot, ast.Name) and slot.id == name:
                bound: list[ast.AST] = []
                for element in elements:
                    inner = _sequence_elements(element)
                    if inner is not None and index < len(inner):
                        bound.append(inner[index])
                return bound
        return []

    def _iterable_elements(self, iterable: ast.AST, *, path: Path) -> list[ast.AST] | None:
        elements = _sequence_elements(iterable)
        if elements is not None:
            return elements
        # ``for state, evidence in steps[start_index:]`` — the slice narrows
        # WHICH members a given run emits, never which are emittable, so the
        # whole sequence is the right answer to a reachability question.
        if isinstance(iterable, ast.Subscript):
            iterable = iterable.value
        if isinstance(iterable, ast.Name):
            return self._sequence_bound_to(iterable.id, path=path)
        return None

    def _sequence_bound_to(self, name: str, *, path: Path) -> list[ast.AST] | None:
        """A list/tuple literal assigned to ``name`` anywhere in THIS module.

        Module-local by design: resolving a sequence name across module
        boundaries would let an unrelated ``steps`` in another file supply the
        members, which is how a provenance rule decays into a coincidence rule.
        """
        tree = self.index.modules.get(path)
        if tree is None:
            return None
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                targets: list[ast.AST] = list(node.targets)
            elif isinstance(node, ast.AnnAssign):
                targets = [node.target]
            else:
                continue
            if not any(isinstance(t, ast.Name) and t.id == name for t in targets):
                continue
            elements = _sequence_elements(node.value) if node.value is not None else None
            if elements is not None:
                return elements
        return None

    def _guard_literals(self, name: str, *, scope: ast.AST) -> set[str]:
        """Literals a parameter is compared against inside its own function.

        ``select_judge`` refuses any role outside ``("evidence_judgment",
        "adversarial_judgment")`` and then mints with that parameter: the
        guard IS the closed set of values that can reach the writer, and
        reading it is how a factory-shaped minter stays visible here.
        """
        literals: set[str] = set()
        for node in ast.walk(scope):
            if not isinstance(node, ast.Compare) or not isinstance(node.left, ast.Name):
                continue
            if node.left.id != name:
                continue
            for operator, comparator in zip(node.ops, node.comparators):
                if not isinstance(operator, (ast.In, ast.NotIn, ast.Eq, ast.NotEq)):
                    continue
                if isinstance(comparator, ast.Constant) and isinstance(comparator.value, str):
                    literals.add(comparator.value)
                    continue
                literals |= self._literal_collection(comparator)
        return literals

    def _literal_collection(self, node: ast.AST) -> set[str]:
        """String literals in a collection expression, following one name.

        ``select_drafter`` guards with ``if role not in DRAFTER_ROLES``, and
        DRAFTER_ROLES is a `frozenset({...})` declared in `agent_surface`.
        Reading only inline literals saw `primary_authoring` (compared
        directly one frame down) and missed `challenger_authoring`, reporting
        half of a symmetric pair as dormant — the exact false alarm that
        teaches people to waive a gate.
        """
        if isinstance(node, ast.Call) and node.args:
            # frozenset({...}) / set([...]) / tuple([...])
            callee = node.func
            wrapper = callee.id if isinstance(callee, ast.Name) else None
            if wrapper in ("frozenset", "set", "tuple", "list"):
                return self._literal_collection(node.args[0])
            return set()
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            return {
                element.value
                for element in node.elts
                if isinstance(element, ast.Constant) and isinstance(element.value, str)
            }
        if isinstance(node, ast.Name):
            binding = self._unique_module_level_binding(node.id)
            return self._literal_collection(binding) if binding is not None else set()
        return set()

    def _unique_module_level_binding(self, name: str) -> ast.AST | None:
        """A module-level assignment to ``name``, only if exactly one exists.

        Uniqueness is the safety rail. Resolving a guard constant across
        module boundaries is necessary — the closed sets live in
        `agent_surface` and are imported — but a name bound in two places
        would let an unrelated constant widen a guard, which is how a
        provenance walk starts certifying things that are not true.
        """
        found: list[ast.AST] = []
        for tree in self.index.modules.values():
            for node in tree.body:
                targets: list[ast.AST] = []
                if isinstance(node, ast.Assign):
                    targets = list(node.targets)
                elif isinstance(node, ast.AnnAssign) and node.value is not None:
                    targets = [node.target]
                if any(isinstance(t, ast.Name) and t.id == name for t in targets):
                    found.append(node.value)
        return found[0] if len(found) == 1 else None

    def _caller_literals(
        self, name: str, *, position: int | None, scope: ast.AST, hops: int, seen: frozenset[int]
    ) -> frozenset[str] | None:
        """One hop up: what callers pass for this parameter.

        ``plan_round_controller.advance_plan_round`` names the roles and
        ``_ensure_planner_request`` mints them. Without this hop the mint is
        invisible and both planner roles read as dead.
        """
        resolved: set[str] = set()
        found = False
        for caller_path, call in self.index.calls_to(scope.name):
            argument = argument_for(call, field=name, position=position)
            if argument is None:
                continue
            caller_scopes = self.index.enclosing_functions(caller_path, call)
            values = self.resolve(
                argument, path=caller_path, scopes=caller_scopes, hops=hops - 1, seen=seen
            )
            if values is not None:
                resolved |= values
                found = True
        return frozenset(resolved) if found else None


def literals_reaching(
    index: ProductionIndex, *, function_name: str, field: str, position: int | None = None
) -> dict[str, list[str]]:
    """Members that can reach ``field`` of ``function_name``, with evidence.

    Returns ``{literal: ["path:line", ...]}``. A callsite whose argument does
    not resolve contributes nothing — see the module docstring on why that is
    the honest answer rather than a failure.
    """
    resolver = _Resolver(index)
    evidence: dict[str, list[str]] = {}
    for path, call in index.calls_to(function_name):
        argument = argument_for(call, field=field, position=position)
        if argument is None:
            continue
        scopes = index.enclosing_functions(path, call)
        values = resolver.resolve(argument, path=path, scopes=scopes, hops=MAX_HOPS)
        if not values:
            continue
        location = f"{path.relative_to(index.repo_root).as_posix()}:{call.lineno}"
        for value in values:
            evidence.setdefault(value, []).append(location)
    return evidence


__all__ = [
    "MAX_HOPS",
    "ProductionIndex",
    "argument_for",
    "literals_reaching",
]
