"""Twin's symbol layer: what one Python module defines, references and reads or writes.

WHY THIS EXISTS. Twin-lite (``twin``) stopped at four layers and left
symbol-level edges to a deep twin "conditional on a consumer proving need".
The F0.9b ownership atlas (``ownership_atlas``) is that consumer: the owner,
writers, callers and liveness of a concept family are symbol facts. PLAN-v2
Faz 0.9 keeps twin, aria-import-graph and impact_graph as ARIA's graph
engines, so the parse is a twin layer and the atlas only reads it.

WHAT ONE MODULE YIELDS (deterministic, from its source text alone):
  defs       [name, line, scope] for every function and class (nested ones
             included: a method named like a family's computer is a second
             computer) and every module-level assignment target.
  refs       [line, scope, dotted] for every load of an imported name, of an
             attribute of an imported name, or of a module-level binding, as
             "<module>.<name>". Calls and callbacks alike: a phase table holds
             its runners by reference.
  calls      [line, scope, callee, surface, surface_ref, paths] for every call
             that names a declared surface (``expected_surface=``, a literal or
             a constant's dotted name) or a literal path (``root / "a" / "b"``).
  constants  module-level string constants (a surface name held in a constant).
A scope is the top-level statement a node sits in (a function, class or
assignment name, else ``<module>``), not the innermost one, so a closure inside
a phase runner still counts as that runner's reference.
"""
from __future__ import annotations

import ast
from typing import Any

# Import roots in PYTHONPATH order, as aria-import-graph reads them.
SOURCE_ROOTS = ("aria-kernel", "tools/aria-poc")
MODULE_SCOPE = "<module>"
SURFACE_KEYWORD = "expected_surface"


def module_of(path: str) -> str:
    """Dotted import name of a repo path under a source root."""
    for root in SOURCE_ROOTS:
        if path.startswith(root + "/") and path.endswith(".py"):
            parts = path[len(root) + 1 : -3].split("/")
            return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
    raise ValueError(f"twin_symbols: {path} is not under {SOURCE_ROOTS}")


def symbol_facts(source: str, *, path: str) -> dict[str, Any]:
    module = module_of(path)
    package = module.split(".") if path.endswith("/__init__.py") else module.split(".")[:-1]
    tree = ast.parse(source, filename=path)
    imports: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update({a.asname or a.name.split(".")[0]: a.name if a.asname else a.name.split(".")[0]
                            for a in node.names})
        elif isinstance(node, ast.ImportFrom):
            base = ".".join(package[: len(package) - node.level + 1] + [node.module or ""]) if node.level else node.module
            imports.update({a.asname or a.name: f"{base.strip('.')}.{a.name}" for a in node.names if a.name != "*"})
    bound = {name for stmt in tree.body for name in _top_level_names(stmt)}
    defs: list[list[Any]] = []
    constants: dict[str, str] = {}
    for stmt in tree.body:
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            for name in _top_level_names(stmt):
                defs.append([name, stmt.lineno, name])
                if isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
                    constants[name] = stmt.value.value
    refs: list[list[Any]] = []
    calls: list[list[Any]] = []

    def dotted(name: str) -> str | None:
        return imports[name] if name in imports else f"{module}.{name}" if name in bound else None

    for stmt in tree.body:
        scope = (_top_level_names(stmt) or [MODULE_SCOPE])[0]
        for node in ast.walk(stmt):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs.append([node.name, node.lineno, scope])
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and dotted(node.id):
                refs.append([node.lineno, scope, dotted(node.id)])
            elif (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                  and node.value.id in imports):
                refs.append([node.lineno, scope, f"{imports[node.value.id]}.{node.attr}"])
            if isinstance(node, ast.Call):
                callee = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", None)
                surface = surface_ref = None
                for keyword in node.keywords:
                    if keyword.arg == SURFACE_KEYWORD and isinstance(keyword.value, ast.Constant):
                        surface = keyword.value.value
                    elif keyword.arg == SURFACE_KEYWORD and isinstance(keyword.value, ast.Name):
                        surface_ref = dotted(keyword.value.id)
                operands = [*node.args, *(keyword.value for keyword in node.keywords)]
                paths = sorted({found for operand in operands for found in _literal_paths(operand)})
                if surface or surface_ref or paths:
                    calls.append([node.lineno, scope, callee, surface, surface_ref, paths])
    return {"defs": defs, "refs": refs, "calls": calls, "constants": constants}


def _top_level_names(stmt: ast.stmt) -> list[str]:
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [stmt.name]
    targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target] if isinstance(stmt, ast.AnnAssign) else []
    return [node.id for target in targets for node in ast.walk(target) if isinstance(node, ast.Name)]


def _literal_paths(expr: ast.expr) -> set[str]:
    """Relative paths spelled by literals: a ``/`` chain's string runs, or a string holding a ``/``."""
    found: set[str] = set()
    for node in ast.walk(expr):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            run: list[str] = []
            for operand in [*_div_operands(node), None]:
                if isinstance(operand, ast.Constant) and isinstance(operand.value, str):
                    run.append(operand.value.strip("/"))
                    continue
                if len(run) >= 2:
                    found.add("/".join(run))
                run = []
        elif (isinstance(node, ast.Constant) and isinstance(node.value, str) and "/" in node.value
              and not any(ch.isspace() for ch in node.value)):
            found.add(node.value.removeprefix("./"))
    return found


def _div_operands(node: ast.expr) -> list[ast.expr]:
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
        return _div_operands(node.left) + _div_operands(node.right)
    return [node]
