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
dependency of the hook, since the suite it gates is Python. The parse itself, the source
roots, module naming and the path-literal rules are ``aria_kernel.source_facts``'s: the
F0.9b ownership atlas reads the same facts, and a second parser beside this one answered
differently for the same module (review F0.9b r1-arch B1).

EDGES (a node is an importable module under aria-kernel/ or tools/aria-poc/):
  import     ``import a.b``, ``from a import b`` (absolute or relative), a literal
             ``import_module("a.b")``, and a dotted ``"aria_kernel.x"`` string such as a
             ``mock.patch`` target. ``from aria_kernel import NAME`` also names the module
             that binds NAME first in ``_EXPORT_MODULES``, the table aria_kernel/__init__.py's
             ``__getattr__`` resolves NAME from on first use (PEP 562: importing the package
             imports none of them).
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
what a parse would; the digest of this file and of ``source_facts`` keys the cache, so
editing either empties it. Only the import layer is asked for: the atlas's symbol layer
would quintuple the cache.

Input (stdin, JSON): {"changed": [repo paths], "tracked": [repo paths]}.
Output (stdout, JSON): the selection, ordered by (tier, path).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import defaultdict
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any

# The parse and its primitives have one owner in the kernel (PLAN-v2 F0.9: the ownership
# atlas reads the same facts; a second parser drifts). This script runs as plain
# ``python3`` from any cwd, so the kernel root comes from the script's own location.
FACTS_OWNER_FILE = Path(__file__).resolve().parents[2] / "aria-kernel" / "aria_kernel" / "source_facts.py"
sys.path.insert(0, str(FACTS_OWNER_FILE.parents[1]))
from aria_kernel.source_facts import (  # noqa: E402  (after the sys.path entry above)
    KERNEL_PACKAGE, KERNEL_ROOT, Facts, deepest_module, extract, iter_modules, module_name, path_parts,
)

SCHEMA = "aria-import-graph/v1"
CACHE_SCHEMA = "aria-import-graph-cache/v1"
# unittest's `discover -p` and pyproject's python_files share this pattern.
TEST_PATTERN = "*test*.py"
TIER_NAMES = ("changed", "owner", "direct", "indirect")
CHANGED, OWNER, DIRECT, INDIRECT = range(4)

# A surface whose contract is one kernel test that no import reaches. ARIA-HIGH-098: an
# adapters-only change must meet the adapter registry contract before merge, and on the
# push it runs first, ahead of anything that merely reads the directory.
SURFACE_CONTRACTS = (
    ("tools/aria-adapters/", "aria-kernel/tests/test_adapter_fixture_evidence_contract.py"),
)


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
        hasher = hashlib.sha1()
        for source in (__file__, FACTS_OWNER_FILE):  # the facts change when either does
            with open(source, "rb") as handle:
                hasher.update(handle.read())
        extractor = hasher.hexdigest()
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
        for root, path, name in iter_modules(repo):
            with open(os.path.join(repo, path), "rb") as handle:
                data = handle.read()
            digest = hashlib.sha1(data).hexdigest()
            hit = cache.get(path)
            is_package = path.endswith("/__init__.py")
            if hit and hit.get("sha") == digest:
                facts = hit["facts"]
            else:
                try:
                    facts = extract(data.decode("utf-8"), path, name, is_package, symbols=False)
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

    def _resolve(self, path: str, facts: Facts) -> set[str]:
        names: set[str] = set()
        for item in facts["imports"]:
            kind, dotted = item[0], item[1]
            if dotted.split(".")[0] not in self.top_level:
                continue
            if kind == "name":
                names.add(dotted)
            elif kind == "dotted":
                deepest = deepest_module(dotted, self.by_name)
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
