#!/usr/bin/env python3
"""Static dependency graph of the ARIA kernel suite: which test modules a change can reach.

WHY THIS EXISTS. The pre-push selector (scripts/ci/aria-suite-changed.mjs) picked every
test module whose TEXT contained a changed module's basename. ``ledger`` is spelled in
330 of the kernel's ~700 test files, so a push that touched docs and a few kernel modules
ran 4,454 tests in 6,357 s on 2026-10-02, and a module that matched nothing fell back to
the whole suite. This module answers the same question from the source's structure, not
its spelling.

WHY PYTHON, NOT THE .mjs. Python's own parser is the only exact reader of Python imports:
parenthesised multi-line imports, imports inside functions, relative imports, and the
import-shaped text fixtures carry inside string literals all come out right with ``ast``
and wrong with a regex over source text. Nothing is executed. python3 is already a hard
dependency of the hook, since the suite it gates is Python.

EDGES (a node is an importable module under aria-kernel/ or tools/aria-poc/):
  import     ``import a.b``, ``from a import b`` (absolute or relative), a literal
             ``import_module("a.b")``, and a dotted ``"aria_kernel.x"`` string such as a
             ``mock.patch`` target. ``from aria_kernel import NAME`` also names the module
             that binds NAME first in ``_EXPORT_MODULES``, the table aria_kernel/__init__.py
             re-exports from at import time.
  reference  a path-like string literal, or a pathlib ``/`` chain of literals, naming a
             changed file: a run of two or more of its path components
             (``".github" / "workflows"``, ``"tools/aria-adapters"``), or its bare file
             name when no other tracked file has that name. A wildcard component ends the
             literal run, so ``"aria-kernel/**"`` names no file. A run that ends at a
             directory counts only for a directory of data, not of Python source.

TIERS (the selector's budget spends them in this order):
  0 changed   a changed test module
  1 owner     tests/test_<stem>.py of a changed module; a test_<stem>_*.py module, in any
              test directory, that imports it (the module's own test family: ledger.py has
              no test_ledger.py, its tests are test_ledger_atomic_append.py and six more);
              or a changed surface's declared contract test (SURFACE_CONTRACTS)
  2 direct    imports a changed module, or references a changed file
  3 indirect  imports a direct module (one intermediate); nothing deeper is selected

COST. Parsing ~1,200 modules takes seconds on a loaded host, so per-file facts are cached
by content digest (``--cache``, a file under .git/, never committed). A hit returns exactly
what a parse would; the helper's own digest keys the cache, so editing this file empties it.

Input (stdin, JSON): {"changed": [repo paths], "tracked": [repo paths]}.
Output (stdout, JSON): the selection, ordered by (tier, path).
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import sys
from collections import defaultdict
from collections.abc import Iterable, Iterator
from fnmatch import fnmatchcase
from typing import Any

SCHEMA = "aria-import-graph/v1"
CACHE_SCHEMA = "aria-import-graph-cache/v1"
KERNEL_ROOT = "aria-kernel"
KERNEL_PACKAGE = "aria_kernel"
# Import roots in PYTHONPATH order: aria-suite-run.sh exports aria-kernel first, and the
# tests that drive the executors put tools/aria-poc on sys.path themselves.
SOURCE_ROOTS = (KERNEL_ROOT, "tools/aria-poc")
# unittest's `discover -p` and pyproject's python_files share this pattern.
TEST_PATTERN = "*test*.py"
SKIP_DIRS = frozenset({"__pycache__", "node_modules"})
EXPORT_TABLE = "_EXPORT_MODULES"
PATH_CALLS = frozenset({"Path", "PurePath", "PurePosixPath", "joinpath", "join"})
TIER_NAMES = ("changed", "owner", "direct", "indirect")
CHANGED, OWNER, DIRECT, INDIRECT = range(4)

# A surface whose contract is one kernel test that no import reaches. ARIA-HIGH-098: an
# adapters-only change must meet the adapter registry contract before merge, and on the
# push it runs first, ahead of anything that merely reads the directory.
SURFACE_CONTRACTS = (
    ("tools/aria-adapters/", "aria-kernel/tests/test_adapter_fixture_evidence_contract.py"),
)

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


def extract(source: str, path: str, name: str, is_package: bool) -> Facts:
    """Everything the graph needs from one module, independent of every other module."""
    tree = ast.parse(source, filename=path)
    package = name.split(".") if is_package else name.split(".")[:-1]
    imports: set[tuple[str, ...]] = set()
    refs: set[tuple[str, ...]] = set()
    tests = 0
    for sub in ast.walk(tree):
        kind = type(sub)
        if kind is ast.Import:
            imports.update(("name", a.name) for a in sub.names)
        elif kind is ast.ImportFrom:
            if sub.level:
                if sub.level - 1 > len(package):
                    continue
                base_parts = package[: len(package) - (sub.level - 1)]
                base = ".".join(base_parts + ([sub.module] if sub.module else []))
            else:
                base = sub.module or ""
            if base:
                imports.add(("name", base))
                imports.update(("from", base, a.name) for a in sub.names if a.name != "*")
        elif kind is ast.Call:
            func = sub.func
            called = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if called == "import_module" and sub.args:
                first = sub.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    imports.add(("name", first.value))
            elif called in PATH_CALLS:
                refs.update(chain_runs(sub.args))
        elif kind is ast.BinOp and isinstance(sub.op, ast.Div):
            refs.update(chain_runs(flatten_div(sub)))
        elif kind is ast.Constant and isinstance(sub.value, str):
            text = sub.value
            if not text or any(ch.isspace() for ch in text):
                continue  # prose, not a path or a dotted name
            if "/" not in text and text.split(".")[0] == KERNEL_PACKAGE and "." in text:
                imports.add(("dotted", text))
                continue
            parts = path_parts(text)
            if len(parts) >= 2 or (len(parts) == 1 and "." in parts[0].strip(".")):
                refs.add(parts)
        elif kind in (ast.FunctionDef, ast.AsyncFunctionDef) and sub.name.startswith("test"):
            tests += 1
    return {
        "imports": sorted(list(item) for item in imports),
        "refs": sorted(list(ref) for ref in refs),
        "tests": tests,
        "bindings": module_bindings(tree),
        "exports": export_table(tree),
    }


class Graph:
    def __init__(self, repo: str, cache_path: str | None) -> None:
        self.paths: dict[str, str] = {}  # path -> dotted name
        self.by_name: dict[str, str] = {}
        self.is_test: dict[str, bool] = {}
        self.facts: dict[str, Facts] = {}
        self.unparsed: list[str] = []
        self.unresolved: list[dict[str, str]] = []
        self._load(repo, cache_path)
        self.top_level = {name.split(".")[0] for name in self.by_name}
        self.importers: dict[str, set[str]] = defaultdict(set)
        self.refs: dict[tuple[str, ...], set[str]] = defaultdict(set)
        for path, facts in self.facts.items():
            for imported in self._resolve(path, facts):
                if imported != self.paths[path]:
                    self.importers[imported].add(path)
            for ref in facts["refs"]:
                self.refs[tuple(ref)].add(path)

    def _load(self, repo: str, cache_path: str | None) -> None:
        with open(__file__, "rb") as handle:
            extractor = hashlib.sha1(handle.read()).hexdigest()
        cache: dict[str, Any] = {}
        if cache_path and os.path.exists(cache_path):
            try:
                with open(cache_path, encoding="utf-8") as handle:
                    stored = json.load(handle)
                if stored.get("schema") == CACHE_SCHEMA and stored.get("extractor") == extractor:
                    cache = stored["files"]
            except (OSError, ValueError, KeyError, AttributeError):
                cache = {}  # a torn or foreign cache costs a re-parse, never a wrong answer
        fresh: dict[str, Any] = {}
        for root in SOURCE_ROOTS:
            for path in iter_sources(repo, root):
                name = module_name(path)
                if not name or name in self.by_name:
                    continue  # first root wins, as on sys.path
                with open(os.path.join(repo, path), "rb") as handle:
                    data = handle.read()
                digest = hashlib.sha1(data).hexdigest()
                hit = cache.get(path)
                is_package = path.endswith("/__init__.py")
                if hit and hit.get("sha") == digest:
                    facts = hit["facts"]
                else:
                    try:
                        facts = extract(data.decode("utf-8"), path, name, is_package)
                    except (SyntaxError, UnicodeDecodeError, ValueError):
                        facts = None
                fresh[path] = {"sha": digest, "facts": facts}
                if facts is None:
                    self.unparsed.append(path)
                    continue
                basename = path.rsplit("/", 1)[-1]
                self.paths[path] = name
                self.by_name[name] = path
                self.facts[path] = facts
                self.is_test[path] = (
                    root == KERNEL_ROOT
                    and name.split(".")[0] != KERNEL_PACKAGE
                    and fnmatchcase(basename, TEST_PATTERN)
                )
        if cache_path and fresh != cache:
            payload = {"schema": CACHE_SCHEMA, "extractor": extractor, "files": fresh}
            pending = f"{cache_path}.{os.getpid()}.tmp"
            with open(pending, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, separators=(",", ":"))
            os.replace(pending, cache_path)

    def _deepest(self, dotted: str) -> str | None:
        parts = dotted.split(".")
        for end in range(len(parts), 0, -1):
            candidate = ".".join(parts[:end])
            if candidate in self.by_name:
                return candidate
        return None

    def _resolve(self, path: str, facts: Facts) -> set[str]:
        names: set[str] = set()
        for item in facts["imports"]:
            kind, dotted = item[0], item[1]
            if dotted.split(".")[0] not in self.top_level:
                continue
            if kind == "name":
                names.add(dotted)
            elif kind == "dotted":
                deepest = self._deepest(dotted)
                if deepest:
                    names.update({dotted, deepest})
            else:
                member = f"{dotted}.{item[2]}"
                names.add(member)
                if member not in self.by_name and dotted in self.by_name:
                    source = self._reexport(path, dotted, item[2])
                    if source:
                        names.add(source)
        return names

    def _reexport(self, importer: str, package: str, attr: str) -> str | None:
        """The module ``from package import attr`` really reaches through an export table."""
        facts = self.facts[self.by_name[package]]
        if not facts["exports"] or attr in facts["bindings"]:
            return None
        for export in facts["exports"]:
            source = f"{package}.{export}"
            if source in self.by_name and attr in self.facts[self.by_name[source]]["bindings"]:
                return source
        self.unresolved.append({"module": importer, "import": f"{package}.{attr}"})
        return None

    def referencers(
        self, target: tuple[str, ...], unique_basename: bool, source_dirs: set[str]
    ) -> set[str]:
        """Nodes naming ``target``: its unique basename, or a run of 2+ of its components.

        A run ending at the file names it (a test reading ``aria_kernel/cli.py``). A run
        ending at a directory names the file only when that directory holds data, not
        Python source: ``".github" / "workflows"`` is a scan of workflows, while
        ``"tools" / "aria-poc"`` is a sys.path entry and ``"aria-kernel" / "aria_kernel"``
        a package scan whose relevance to one module the source cannot show — a module's
        dependents are its importers.
        """
        found: set[str] = set()
        if unique_basename:
            found |= self.refs.get(target[-1:], set())
        last = len(target)
        for start in range(last):
            for end in range(start + 2, last + 1):
                if end == last or "/".join(target[:end]) not in source_dirs:
                    found |= self.refs.get(target[start:end], set())
        return found


def select(graph: Graph, changed: list[str], tracked: list[str]) -> list[dict[str, Any]]:
    basenames: dict[str, int] = defaultdict(int)
    source_dirs: set[str] = set()
    for path in set(tracked) | set(changed):
        directory, _, basename = path.rpartition("/")
        basenames[basename] += 1
        if basename.endswith(".py"):
            source_dirs.add(directory)
    chosen: dict[str, tuple[int, str]] = {}

    def assign(path: str, tier: int, reason: str) -> None:
        if graph.is_test.get(path) and (path not in chosen or tier < chosen[path][0]):
            chosen[path] = (tier, reason)

    direct: dict[str, str] = {}
    for path in sorted(set(changed)):
        assign(path, CHANGED, "changed test module")
        name = module_name(path)
        importers = graph.importers.get(name or "", set())
        if path in graph.paths and not graph.is_test[path]:
            stem = graph.paths[path].split(".")[-1]
            assign(f"{KERNEL_ROOT}/tests/test_{stem}.py", OWNER, f"conventional test of {path}")
            # The family needs the import edge as well as the name: a file called
            # test_ledger_notes.py that never imports ledger is not ledger's test.
            family = f"test_{stem}_"
            for importer in sorted(importers):
                if importer.rsplit("/", 1)[-1].startswith(family):
                    assign(importer, OWNER, f"test family of {path} ({family}*.py, imports it)")
        for prefix, contract in SURFACE_CONTRACTS:
            if path.startswith(prefix):
                assign(contract, OWNER, f"contract test of {prefix}")
        dependents = {d: f"imports {path}" for d in importers}
        target = path_parts(path)
        for other in graph.referencers(target, basenames[target[-1]] == 1, source_dirs):
            dependents.setdefault(other, f"references {path}")
        for dependent in sorted(dependents):
            if dependent != path:
                direct.setdefault(dependent, dependents[dependent])
    for dependent, reason in sorted(direct.items()):
        assign(dependent, DIRECT, reason)
    for dependent in sorted(direct):
        for importer in sorted(graph.importers.get(graph.paths[dependent], ())):
            assign(importer, INDIRECT, f"imports {dependent}")
    return [
        {
            "path": path,
            "tier": tier,
            "tier_name": TIER_NAMES[tier],
            "reason": reason,
            "tests": graph.facts[path]["tests"],
        }
        for path, (tier, reason) in sorted(chosen.items(), key=lambda item: (item[1][0], item[0]))
    ]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--repo", default=".", help="repository root (default: cwd)")
    parser.add_argument("--cache", help="per-file facts cache (a path under .git/)")
    args = parser.parse_args(argv)
    request = json.load(sys.stdin)
    changed = sorted({str(p) for p in request["changed"]})
    tracked = [str(p) for p in request.get("tracked", [])]
    graph = Graph(args.repo, args.cache)
    json.dump(
        {
            "schema": SCHEMA,
            "test_modules": sum(1 for is_test in graph.is_test.values() if is_test),
            "selected": select(graph, changed, tracked),
            "unresolved": sorted(graph.unresolved, key=lambda u: (u["module"], u["import"])),
            "unparsed": sorted(graph.unparsed),
        },
        sys.stdout,
        indent=1,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
