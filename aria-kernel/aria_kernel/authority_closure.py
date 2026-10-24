"""What the code that judges ARIA executes: the closure of the derived
authority set (PLAN-v2 B1, ARIA-HIGH-767; corrective round 2, root R2).

WHY. The set is closed under what its deciders EXECUTE, so that a change to
a file a rail runs is a change to the rail. Round 1 followed module-level
imports only, but the rails import their decision inputs inside function
bodies (``self_revert`` reads ``own_pr_ci.load_post_merge_reds`` when it
looks for post-merge reds, ``change_outcome`` reads ``experiment`` and
``finding``, ``implementation_safety`` reads ``containment_probe`` and
``operator_request_signature``), and members run files that are never
imported (``implementation_safety.VALIDATION_OBSERVATION_CHILD`` is launched
as a script and loads ``digest.py`` by file; ``claude_settings`` runs
``hook_client.py`` by path). A one-file change to such a callee disarmed a
rail and the realized diff accepted it.

WHAT. :func:`import_closure` walks, transitively from the seeds,

* every import statement of a walked file, function bodies included (an
  import inside a function runs whenever the rail calls it), resolved the
  way the interpreter resolves it: a relative import inside the file's own
  package, an absolute one at the suite's import roots in order
  (``suite_import_roots.SUITE_PYTHONPATH_ROOTS``) — so ``aria_kernel.*``
  and the repository's own ``tools.shared`` are followed, and a name found
  at no root (the standard library, site-packages) is not repository code;
* every file a walked file names by its file name: a string literal, or
  the literal part of an f-string, that names a file under the walked file's
  own directory, there or below it (``Path(__file__).with_name("digest.py")``,
  ``("aria_kernel", "hook_client.py")``, ``f"{_KERNEL}tools_binding.py"``,
  and ``parent / "data" / DEFAULT_FILENAME`` with
  ``DEFAULT_FILENAME = "genesis_policy_default.json"``). A program launched
  or loaded by path is named that way, and so is the decision data a rail
  reads by path (genesis_policy's package-default layer decides the
  circuit breaker's threshold; implementation_safety's sandbox ``hosts``
  file decides what the sandbox resolves). The rule reads the owner's own
  literal, so no copy of a name lives here. A data file is a member as
  itself and is not walked. A literal that names a file only as evidence is
  counted too: the rule over-approximates and never under-approximates. A
  file at the repository root is in no package, so it names files beside it
  only.

A seed runs with the package ``__init__`` files on its path below its import
root.

A PYTHON FILE NAMED BY FILE NAME (``ExecutionClosure.programs``) may run as a
program launched by path, and a script's own directory leads ``sys.path``
(B1 round 4, R2): a module there is imported in place of whatever bears its
name. So such a file's absolute imports are resolved at its own directory
first, and the authority set (``self_improvement``) holds the
standard-library names at that directory as members, so a ``json.py`` added
beside the program is a change to the program. The closure cannot tell a
launch from a mention, nor see the launcher's flags, so every such file is
modelled this way, isolated or not; the kernel's real by-path programs are
launched isolated (``-P``/``-I``), which their launchers own and the tests
pin.

The ONE exemption is the Board runner's candidate entries. The runner
(``tools/aria-acceptance/harness.py``) declares, by name, the functions that
run the CANDIDATE under exam — ARIA's own cycle and reactions — rather than
the scorer (``BOARD_CANDIDATE_ENTRIES`` in that file). Their bodies are not
walked: a candidate is what the Board judges, not part of the judge. The
declaration lives in the runner, which is itself a member, so a change cannot
widen it. There is no other exemption and no excluded edge.

NOT MODELLED (stated, not hidden): a module launched by NAME
(``python3 -m aria_kernel.<x>``) or imported through a computed string
(``importlib.import_module(name)``) is not an edge. In today's kernel the
modules that do either (``harness_parity``, ``security/prerequisites``, the
CLI) are not reached from a seed, and ``token_broker`` launches only itself.
"""
from __future__ import annotations

import ast
import functools
import os
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from .suite_import_roots import SUITE_PYTHONPATH_ROOTS
from .tool_registry import GovernanceError

# The Board's exam runner (PLAN-v2 Faz 6) and the module constant in it that
# names its candidate entries.
BOARD_TOOLS_RELPATH = "tools/aria-acceptance"
BOARD_RUNNER_RELPATH = f"{BOARD_TOOLS_RELPATH}/harness.py"
BOARD_CANDIDATE_ENTRIES_NAME = "BOARD_CANDIDATE_ENTRIES"


def board_candidate_entries(tree: ast.Module, *, where: str) -> frozenset[str]:
    """The runner's declared candidate entries: the literal tuple bound to
    ``BOARD_CANDIDATE_ENTRIES``, each a top-level function of the runner.
    A runner that declares none has none; a name that is not one of its
    functions is refused, so a stale declaration cannot exempt a body."""
    declared: tuple[str, ...] = ()
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == BOARD_CANDIDATE_ENTRIES_NAME for target in node.targets):
            value = ast.literal_eval(node.value)
            if not isinstance(value, tuple) or not all(isinstance(name, str) for name in value):
                raise GovernanceError(f"authority_closure_candidate_entries_not_a_name_tuple:{where}")
            declared = value
    functions = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    unknown = sorted(set(declared) - functions)
    if unknown:
        raise GovernanceError(f"authority_closure_candidate_entry_unknown:{where}:{','.join(unknown)}")
    return frozenset(declared)


# An import statement as plain data: (level, module, imported names). An
# `import a.b` is (0, None, ("a.b",)).
_ImportRow = tuple[int, str | None, tuple[str, ...]]


@functools.lru_cache(maxsize=None)
def _executed_references(source: str, *, where: str) -> tuple[tuple[_ImportRow, ...], tuple[str, ...]]:
    """Every import statement and every string literal in the module, at any
    depth (a function body runs when it is called), except inside the Board
    runner's declared candidate entries. Keyed by the source text, so a tree
    derived again reads each unchanged file once per process."""
    tree = ast.parse(source, filename=where)
    skipped = board_candidate_entries(tree, where=where) if where == BOARD_RUNNER_RELPATH else frozenset()
    imports: list[_ImportRow] = []
    literals: list[str] = []
    pending: list[ast.AST] = [node for node in tree.body
                              if not (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in skipped)]
    while pending:
        node = pending.pop()
        kind = type(node)
        if kind is ast.Import:
            imports.append((0, None, tuple(alias.name for alias in node.names)))
        elif kind is ast.ImportFrom:
            imports.append((node.level, node.module, tuple(alias.name for alias in node.names)))
        elif kind is ast.Constant:
            if isinstance(node.value, str):
                literals.append(node.value)
        elif kind is not ast.Name:
            # A Name holds nothing but its context; every other node's
            # children are walked (its expression context excepted).
            for name in node._fields:
                value = getattr(node, name, None)
                if isinstance(value, list):
                    pending.extend(item for item in value if isinstance(item, ast.AST))
                elif isinstance(value, ast.AST) and name != "ctx":
                    pending.append(value)
    return tuple(imports), tuple(literals)


def _module_level_bindings(tree: ast.Module) -> set[str]:
    """The names a module binds in its own namespace when it is imported."""
    names: set[str] = set()
    pending: list[ast.AST] = [tree]
    while pending:
        node = pending.pop()
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(child.name)
            elif isinstance(child, (ast.Import, ast.ImportFrom)):
                names.update((alias.asname or alias.name).split(".")[0] for alias in child.names)
            elif isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                names.add(child.id)
            elif not isinstance(child, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                pending.append(child)
    return names


def _refuse_dynamic_package_attribute(root: Path, package: str, name: str) -> None:
    """Refuse an import of `name` from a package whose `__getattr__` would
    resolve it (PEP 562): the modules that hook loads are not in the source,
    so the closure could not say what the import runs. aria_kernel's own
    `__getattr__` re-exports names for callers outside the kernel; kernel
    code imports the module that defines a name."""
    init = root / package / "__init__.py"
    bindings = _module_level_bindings(ast.parse(init.read_text(encoding="utf-8"), filename=str(init)))
    if "__getattr__" in bindings and name not in bindings:
        raise GovernanceError(f"authority_closure_dynamic_import:{package}/__init__.py:{name}")


def _module_files(root: Path, package_dir: str, parts: list[str]) -> list[str]:
    """The files importing `parts` from the directory `package_dir` runs
    (repo-relative): every package `__init__.py` on the way, then the module.
    A later part that is neither a package nor a module is a name the last
    package binds."""
    files: list[str] = []
    current = package_dir
    for depth, part in enumerate(parts):
        relative = f"{current}/{part}" if current else part
        if (root / relative / "__init__.py").is_file():
            files.append(f"{relative}/__init__.py")
            current = relative
            continue
        if (root / f"{relative}.py").is_file():
            files.append(f"{relative}.py")
        elif depth > 0:
            _refuse_dynamic_package_attribute(root, current, part)
        break
    return files


def _absolute_import_files(root: Path, parts: list[str]) -> list[str]:
    """What `import <parts>` runs: the first import root holding the
    top-level name decides (the interpreter's order); a name at no root is
    not repository code."""
    for import_root in SUITE_PYTHONPATH_ROOTS:
        top = f"{import_root}/{parts[0]}" if import_root else parts[0]
        if (root / top / "__init__.py").is_file() or (root / f"{top}.py").is_file():
            return _module_files(root, import_root, parts)
    return []


class _FilesUnder:
    """The files under each directory of one tree, by file name, read once
    per closure (a tree derived again may differ). The repository root is in
    no package: the files directly in it only."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._by_directory: dict[str, dict[str, list[str]]] = {}

    def named(self, directory: str, literal: str) -> list[str]:
        """The files under `directory` that `literal` names: the path
        relative to the directory is `literal`, or ends with `/<literal>`."""
        segments = literal.split("/")
        if any(segment in ("", ".", "..") for segment in segments):
            return []
        by_name = self._by_directory.get(directory)
        if by_name is None:
            by_name = self._by_directory[directory] = self._index(directory)
        head = f"{directory}/" if directory else ""
        return [path for path in by_name.get(segments[-1], ())
                if path == f"{head}{literal}" or path.endswith(f"/{literal}")]

    def _index(self, directory: str) -> dict[str, list[str]]:
        by_name: dict[str, list[str]] = {}
        base = self._root / directory
        if not directory:
            names = [(entry.name, entry.name) for entry in os.scandir(base) if entry.is_file(follow_symlinks=False)]
        else:
            names = [(name, f"{os.path.relpath(walked, self._root).replace(os.sep, '/')}/{name}")
                     for walked, _dirs, files in os.walk(base) for name in files]
        for name, path in names:
            by_name.setdefault(name, []).append(path)
        return by_name


def _executed_files(root: Path, relative: str, *, as_program: bool,
                    files_under: _FilesUnder) -> tuple[set[str], set[str]]:
    """Repository files the file at `relative` executes or reads by name:
    what its import statements load, and the files it names by file name
    (``(imported, named)``). Run as a program (named by file name), its
    absolute imports resolve at its own directory first."""
    imports, literals = _executed_references((root / relative).read_text(encoding="utf-8"), where=relative)
    directory = relative.rpartition("/")[0]
    found: set[str] = set()

    def absolute(parts: list[str]) -> list[str]:
        own = (_module_files(root, directory, parts) if as_program and directory
               and ((root / directory / parts[0] / "__init__.py").is_file()
                    or (root / directory / f"{parts[0]}.py").is_file()) else [])
        return own or _absolute_import_files(root, parts)

    for level, module, names in imports:
        if module is None and level == 0:
            for name in names:
                found.update(absolute(name.split(".")))
        elif level == 0:
            for name in names:
                found.update(absolute(module.split(".") + [name]))
        else:
            package = directory.split("/") if directory else []
            if level - 1 > len(package):
                continue
            base = "/".join(package[:len(package) - (level - 1)])
            parts = module.split(".") if module else []
            for name in names:
                found.update(_module_files(root, base, parts + [name]))
    named = {path for value in literals for path in files_under.named(directory, value)}
    return found, named


def _seed_package_inits(root: Path, seed: str) -> list[str]:
    """The package `__init__.py` files on a seed's path below the first
    import root that holds it: importing the seed runs them."""
    for import_root in SUITE_PYTHONPATH_ROOTS:
        prefix = f"{import_root}/" if import_root else ""
        if seed.startswith(prefix):
            parts = seed[len(prefix):].split("/")[:-1]
            return [f"{prefix}{'/'.join(parts[:depth])}/__init__.py" for depth in range(1, len(parts) + 1)
                    if (root / prefix / "/".join(parts[:depth]) / "__init__.py").is_file()]
    return []


@dataclass(frozen=True)
class ExecutionClosure:
    """What the seeds execute (module docstring), repo-relative and sorted.

    ``files``: every repository file the seeds execute or read by name, the
    seeds included; ``programs``: the Python files among them that a walked
    file names by file name, each of which may run with its own directory
    first on ``sys.path``."""

    files: tuple[str, ...]
    programs: tuple[str, ...]


def import_closure(root: Path, seeds: Iterable[str]) -> ExecutionClosure:
    """Every repository file the seeds execute, computed from the tree at
    `root`: transitively over every import statement and every file named by
    file name (module docstring). A Python file is walked; a data file is
    not.

    The package `__init__` is lazy (PEP 562), so its imports are what the
    source says (`_refuse_dynamic_package_attribute`).
    """
    files_under = _FilesUnder(root)
    pending: set[tuple[str, bool]] = set()
    for seed in seeds:
        pending.add((seed, False))
        pending.update((init, False) for init in _seed_package_inits(root, seed))
    walked: set[tuple[str, bool]] = set()
    files: set[str] = set()
    programs: set[str] = set()
    while pending:
        item = pending.pop()
        if item in walked:
            continue
        walked.add(item)
        relative, as_program = item
        files.add(relative)
        if not relative.endswith(".py"):
            continue
        imported, named = _executed_files(root, relative, as_program=as_program, files_under=files_under)
        programs.update(path for path in named if path.endswith(".py"))
        pending |= {(path, False) for path in imported} | {(path, path.endswith(".py")) for path in named}
        pending -= walked
    return ExecutionClosure(files=tuple(sorted(files)), programs=tuple(sorted(programs)))


__all__ = ["BOARD_CANDIDATE_ENTRIES_NAME", "BOARD_RUNNER_RELPATH", "BOARD_TOOLS_RELPATH",
           "ExecutionClosure", "board_candidate_entries", "import_closure"]
