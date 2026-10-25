"""The one parse of a Python module that ARIA's import graph and ownership atlas read.

WHY THIS EXISTS. PLAN-v2 Faz 0.9 keeps aria-import-graph, twin and impact_graph
as ARIA's graph engines and adds no fourth. The pre-push selector
(``scripts/ci/aria-import-graph.py``) needs a module's imports and path
literals; the F0.9b ownership atlas (``ownership_atlas``) needs the same
module's definitions, symbol uses and ledger calls. Two parsers of one module
drift: the atlas's first parser copied the selector's roots, module naming and
path-literal rules and already answered differently for a wildcard path, an
over-deep relative import and a non-.py path (review F0.9b r1-arch B1). So this
module owns the parse and every primitive of it, and both consumers hold its
function objects (tests/test_ownership_atlas_ssot.py,
tests/invariants/test_atlas_one_owner.py ``python_source_facts``).

WHY PYTHON'S ``ast``. Python's own parser is the only exact reader of Python:
parenthesised multi-line imports, imports inside functions, relative imports and
import-shaped text inside string literals come out right with ``ast`` and wrong
with a regex over source text. Nothing is executed.

WHAT ``extract`` YIELDS for one module, from its source text alone (the
symbol layer, ``defs`` to ``constants``, only when asked for):
  imports    ``["name", dotted]`` for ``import a.b`` and a relative or absolute
             ``from`` base, ``["from", base, name]`` per imported name, a literal
             ``import_module("a.b")``, and ``["dotted", "aria_kernel.x"]`` for a
             dotted kernel string such as a ``mock.patch`` target.
  refs       path literals: a run of two or more literal components of a ``/``
             chain or a ``Path(...)`` call, or one string naming a path or a
             file. A wildcard component ends the run (``"aria-kernel/**"``).
  tests      the number of ``test*`` functions.
  bindings   names bound at import time (module level, through if/try/with).
  exports    the ``_EXPORT_MODULES`` table aria_kernel/__init__.py resolves from.
  defs       ``[name, line, scope]`` for every function and class (nested ones
             too: a method named like a family's computer is a second computer)
             and every module-level assignment target.
  uses       ``[line, scope, dotted]`` for every load of an imported name, of an
             attribute of one, or of a module binding, as ``"<module>.<name>"``.
  calls      ``[line, scope, callee, surface, surface_ref, paths]`` for every call
             naming a declared surface (``expected_surface=`` a literal, or the
             dotted name of a constant) or a path literal (``refs`` of its
             operands, the same rule).
  constants  module-level string constants (a surface name held in a constant).
A scope is the top-level statement a node sits in, not the innermost one, so a
closure inside a phase runner still counts as that runner's use.
"""
from __future__ import annotations

import ast
import os
from collections.abc import Iterable, Iterator
from typing import Any

KERNEL_ROOT = "aria-kernel"
KERNEL_PACKAGE = "aria_kernel"
# Import roots in PYTHONPATH order: aria-suite-run.sh exports aria-kernel first, and the
# tests that drive the executors put tools/aria-poc on sys.path themselves.
SOURCE_ROOTS = (KERNEL_ROOT, "tools/aria-poc")
SKIP_DIRS = frozenset({"__pycache__", "node_modules"})
EXPORT_TABLE = "_EXPORT_MODULES"
PATH_CALLS = frozenset({"Path", "PurePath", "PurePosixPath", "joinpath", "join"})
MODULE_SCOPE = "<module>"
SURFACE_KEYWORD = "expected_surface"

Facts = dict[str, Any]


def module_name(path: str) -> str | None:
    """Dotted import name of a repo path under a source root, existing or not."""
    if not path.endswith(".py"):
        return None
    for root in SOURCE_ROOTS:
        if path.startswith(root + "/"):
            parts = path[len(root) + 1 : -3].split("/")
            if parts[-1] == "__init__":
                parts = parts[:-1]
            return ".".join(parts) if parts else None
    return None


def iter_sources(repo: str, root: str) -> Iterator[str]:
    """Importable .py files: the root's own files and those inside package chains."""
    base = os.path.join(repo, root)
    for dirpath, dirnames, filenames in os.walk(base):
        rel = os.path.relpath(dirpath, base)
        if rel != "." and "__init__.py" not in filenames:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        prefix = root if rel == "." else f"{root}/{rel.replace(os.sep, '/')}"
        for name in sorted(filenames):
            if name.endswith(".py"):
                yield f"{prefix}/{name}"


def iter_modules(repo: str) -> Iterator[tuple[str, str, str]]:
    """(root, repo path, dotted name) of every importable module; the first root wins, as on sys.path."""
    seen: set[str] = set()
    for root in SOURCE_ROOTS:
        for path in iter_sources(repo, root):
            name = module_name(path)
            if name and name not in seen:
                seen.add(name)
                yield root, path, name


def deepest_module(dotted: str, modules: Iterable[str] | dict[str, Any]) -> str | None:
    """The longest prefix of ``dotted`` (itself included) that names a module in ``modules``."""
    parts = dotted.split(".")
    for end in range(len(parts), 0, -1):
        candidate = ".".join(parts[:end])
        if candidate in modules:
            return candidate
    return None


def path_parts(text: str) -> tuple[str, ...]:
    """Literal path components; a wildcard (``*.yml``, ``**``) ends the literal prefix."""
    parts: list[str] = []
    for part in text.strip().split("/"):
        if any(ch in part for ch in "*?["):
            break
        if part not in ("", ".", ".."):
            parts.append(part)
    return tuple(parts)


def chain_runs(operands: Iterable[ast.expr]) -> Iterator[tuple[str, ...]]:
    """Runs of consecutive string literals in a path expression, joined component-wise."""
    run: list[str] = []
    for operand in operands:
        if isinstance(operand, ast.Constant) and isinstance(operand.value, str):
            run.extend(path_parts(operand.value))
            continue
        if len(run) >= 2:
            yield tuple(run)
        run = []
    if len(run) >= 2:
        yield tuple(run)


def flatten_div(node: ast.expr) -> list[ast.expr]:
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        return flatten_div(node.left) + flatten_div(node.right)
    return [node]


def module_bindings(tree: ast.Module) -> list[str]:
    """Names a module binds at import time (module level, through if/try/with blocks)."""
    names: set[str] = set()

    def visit(statements: Iterable[ast.stmt]) -> None:
        for stmt in statements:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(stmt.name)
                continue
            if isinstance(stmt, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                for target in stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]:
                    names.update(n.id for n in ast.walk(target) if isinstance(n, ast.Name))
            elif isinstance(stmt, ast.Import):
                names.update(a.asname or a.name.split(".")[0] for a in stmt.names)
            elif isinstance(stmt, ast.ImportFrom):
                names.update(a.asname or a.name for a in stmt.names if a.name != "*")
            for attr in ("body", "orelse", "finalbody"):
                block = getattr(stmt, attr, None)
                if isinstance(block, list):
                    visit(block)
            for handler in getattr(stmt, "handlers", None) or []:
                visit(handler.body)

    visit(tree.body)
    return sorted(names)


def export_table(tree: ast.Module) -> list[str]:
    for stmt in tree.body:
        if (
            isinstance(stmt, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == EXPORT_TABLE for t in stmt.targets)
            and isinstance(stmt.value, (ast.Tuple, ast.List))
        ):
            return [
                e.value
                for e in stmt.value.elts
                if isinstance(e, ast.Constant) and isinstance(e.value, str)
            ]
    return []


def extract(source: str, path: str, name: str, is_package: bool, *, symbols: bool) -> Facts:
    """One module's facts, independent of every other module.

    The import layer (imports .. exports) always; the symbol layer (defs .. constants)
    with ``symbols``. The pre-push selector caches its facts for ~1,500 modules and the
    symbol layer would quintuple that cache, so it asks for the import layer alone.
    """
    tree = ast.parse(source, filename=path)
    package = name.split(".") if is_package else name.split(".")[:-1]
    imports: set[tuple[str, ...]] = set()
    aliases: dict[str, str] = {}  # local name -> the dotted name it binds
    imported: set[str] = set()  # every local name an import binds, resolved or not
    refs: set[tuple[str, ...]] = set()
    tests = 0
    for sub in ast.walk(tree):
        kind = type(sub)
        if kind is ast.Import:
            imports.update(("name", a.name) for a in sub.names)
            imported.update(a.asname or a.name.split(".")[0] for a in sub.names)
            aliases.update({a.asname or a.name.split(".")[0]: a.name if a.asname else a.name.split(".")[0]
                            for a in sub.names})
        elif kind is ast.ImportFrom:
            base = _from_base(sub, package)
            imported.update(a.asname or a.name for a in sub.names)
            if base:
                imports.add(("name", base))
                imports.update(("from", base, a.name) for a in sub.names if a.name != "*")
                aliases.update({a.asname or a.name: f"{base}.{a.name}" for a in sub.names if a.name != "*"})
        elif kind is ast.Call:
            func = sub.func
            called = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if called == "import_module" and sub.args:
                first = sub.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    imports.add(("name", first.value))
        elif kind is ast.Constant and _dotted_kernel_name(sub.value):
            imports.add(("dotted", sub.value))
        elif kind in (ast.FunctionDef, ast.AsyncFunctionDef) and sub.name.startswith("test"):
            tests += 1
        refs.update(_path_refs(sub))
    facts: Facts = {
        "imports": sorted(list(item) for item in imports),
        "refs": sorted(list(ref) for ref in refs),
        "tests": tests,
        "bindings": module_bindings(tree),
        "exports": export_table(tree),
    }
    if symbols:
        # A name an unresolvable import binds is not this module's own binding.
        facts.update(_symbol_layer(tree, name, aliases, set(facts["bindings"]) - imported))
    return facts


def _from_base(node: ast.ImportFrom, package: list[str]) -> str | None:
    """The module a ``from`` import names; None for a relative import above the top package."""
    if not node.level:
        return node.module or None
    if node.level - 1 > len(package):
        return None
    base_parts = package[: len(package) - (node.level - 1)]
    return ".".join(base_parts + ([node.module] if node.module else [])) or None


def _dotted_kernel_name(value: object) -> bool:
    return (isinstance(value, str) and bool(value) and not any(ch.isspace() for ch in value)
            and "/" not in value and value.split(".")[0] == KERNEL_PACKAGE and "." in value)


def _path_refs(node: ast.AST) -> Iterator[tuple[str, ...]]:
    """The path literals one node spells (the ``refs`` rule)."""
    if isinstance(node, ast.Call):
        called = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", None)
        if called in PATH_CALLS:
            yield from chain_runs(node.args)
    elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        yield from chain_runs(flatten_div(node))
    elif isinstance(node, ast.Constant) and isinstance(node.value, str):
        text = node.value
        if not text or any(ch.isspace() for ch in text) or _dotted_kernel_name(text):
            return  # prose, or a dotted module name, not a path
        parts = path_parts(text)
        if len(parts) >= 2 or (len(parts) == 1 and "." in parts[0].strip(".")):
            yield parts


def _symbol_layer(tree: ast.Module, module: str, aliases: dict[str, str], bound: set[str]) -> Facts:
    def dotted(local: str) -> str | None:
        return aliases[local] if local in aliases else f"{module}.{local}" if local in bound else None

    defs: list[list[Any]] = []
    constants: dict[str, str] = {}
    uses: list[list[Any]] = []
    calls: list[list[Any]] = []
    for stmt in tree.body:
        names = _statement_names(stmt)
        scope = names[0] if names else MODULE_SCOPE
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            defs.extend([target, stmt.lineno, target] for target in names)
            if isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
                constants.update((target, stmt.value.value) for target in names)
        for node in ast.walk(stmt):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs.append([node.name, node.lineno, scope])
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and dotted(node.id):
                uses.append([node.lineno, scope, dotted(node.id)])
            elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in aliases:
                uses.append([node.lineno, scope, f"{aliases[node.value.id]}.{node.attr}"])
            if isinstance(node, ast.Call):
                calls.extend(_surface_call(node, scope, dotted))
    return {"defs": defs, "uses": uses, "calls": calls, "constants": constants}


def _surface_call(node: ast.Call, scope: str, dotted: Any) -> Iterator[list[Any]]:
    callee = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", None)
    surface = surface_ref = None
    for keyword in node.keywords:
        if keyword.arg == SURFACE_KEYWORD and isinstance(keyword.value, ast.Constant):
            surface = keyword.value.value
        elif keyword.arg == SURFACE_KEYWORD and isinstance(keyword.value, ast.Name):
            surface_ref = dotted(keyword.value.id)
    operands = [*node.args, *(keyword.value for keyword in node.keywords)]
    paths = sorted({ref for operand in operands for sub in ast.walk(operand) for ref in _path_refs(sub)})
    if surface or surface_ref or paths:
        yield [node.lineno, scope, callee, surface, surface_ref, [list(p) for p in paths]]


def _statement_names(stmt: ast.stmt) -> list[str]:
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [stmt.name]
    targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target] if isinstance(stmt, ast.AnnAssign) else []
    return [node.id for target in targets for node in ast.walk(target) if isinstance(node, ast.Name)]
