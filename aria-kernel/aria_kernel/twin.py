"""Twin-lite — the repository map ARIA reads instead of rescanning the repo.

PLAN Wave 3 (Revision 2 scope). The operator's request is literal: ARIA should
work from a map of the repository — for token saving and for understanding —
the way Graphify-class tools do, without importing one. Twin-lite is the
deliberately bounded version: four deterministic layers, no symbol-level CALLS
edges (deep twin is Wave 10, conditional on a consumer proving need).

    1. project dependency — reused from ``impact_graph`` (the SSoT for the
       project graph; a second scanner is how two graphs disagree)
    2. test↔source — TESTED_BY edges from path convention + import scan
    3. churn — per-file commit counts over a bounded history window
    4. co-change — file pairs that ship together (CO_CHANGES_WITH)

The map is DERIVED data: every byte is recomputable from the repo at
``indexed_sha``. It is therefore an index-class surface (``twin/map.json``,
rewrite_fsync), not an event ledger — event-sourcing a projection would give
it a history it does not own.

Incremental discipline: ``refresh_twin_map`` re-parses only what changed
between ``indexed_sha`` and HEAD, and the acceptance bar (PLAN §43 test 9) is
that incremental == clean rebuild on the same commit. ``build`` and
``refresh`` share every layer function, so the equivalence is structural for
the layers recomputed from the full tree, and the test pins the composed
result.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .impact_graph import _project_for_path, _project_graph, build_service_analysis_order
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

TWIN_MAP_RELPATH = "twin/map.json"
TWIN_SCHEMA_VERSION = 1

# Churn/co-change window. Bounded so the map's cost is bounded; the window is
# a signal-quality constant, not a completeness claim (the map records it).
HISTORY_COMMIT_LIMIT = 400
# A commit touching more files than this is a bulk move/reformat/generated
# sweep, not change evidence — for EITHER history layer. Measured on the live
# repo: with bulk commits counted, 10,806 files recur and the kernel's own
# modules rank ~10,500th; with 17 bulk commits excluded, 256 files recur and
# the same modules sit in the top quartile. Counting sweeps buries the signal
# the map exists to surface.
HISTORY_MAX_FILES_PER_COMMIT = 50
CO_CHANGE_MIN_COUNT = 2
CO_CHANGE_MAX_PAIRS = 2000
# Churn keeps every file that recurred (count >= 2) up to a wide bound.
# A top-N-by-count cap was measured wrong on the live repo: 1000 files sit
# at count >= 4 there, so the cutoff landed at 13 and silently dropped the
# kernel files the map exists to describe. One-off touches are noise;
# recurrence is the signal; the wide bound only guards pathological repos.
CHURN_MIN_COUNT = 2
CHURN_MAX_FILES = 10000

_TEST_SUFFIXES = (".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx")
_RELATIVE_IMPORT_RE = re.compile(r"""from\s+['"](\.[^'"]+)['"]""")
_KERNEL_IMPORT_RE = re.compile(r"^\s*from\s+aria_kernel\.(\w+)\s+import|^\s*from\s+aria_kernel\s+import\s+([\w, ]+)", re.M)


def build_twin_map(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    nx_graph_file: str | Path | None = None,
    history_limit: int = HISTORY_COMMIT_LIMIT,
) -> dict[str, Any]:
    """Full build of the twin map from the repository at HEAD."""
    root = _existing_root(workspace_root)
    graph = _project_graph(root=root, nx_graph_file=Path(nx_graph_file) if nx_graph_file else None)
    order = build_service_analysis_order(graph)
    layer_of = {entry["project"]: entry["layer"] for entry in order["order"]}
    dependents_of = {entry["project"]: entry["dependents"] for entry in order["order"]}
    projects = {
        name: {
            "root": meta["root"],
            "depends_on": graph["dependencies"].get(name, []),
            "dependents": dependents_of.get(name, []),
            "layer": layer_of.get(name),
        }
        for name, meta in graph["projects"].items()
    }
    tested_by = _tested_by_edges(root, _iter_test_files(root))
    history = _history_layers(root, history_limit=history_limit)
    twin = {
        "schema_version": TWIN_SCHEMA_VERSION,
        "generated_at": utc_now(),
        "indexed_sha": _head_sha(root),
        "graph_source": graph["graph_source"],
        "history_limit": history_limit,
        "projects": projects,
        "tested_by": tested_by,
        "churn": history["churn"],
        "co_change": history["co_change"],
        "stats": {
            "project_count": len(projects),
            "tested_by_edges": sum(len(v) for v in tested_by.values()),
            "churn_files": len(history["churn"]),
            "co_change_pairs": len(history["co_change"]),
            "history_commits": history["commit_count"],
        },
    }
    _write_map(ensure_tools_dir(base_dir), twin)
    return twin


def refresh_twin_map(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    nx_graph_file: str | Path | None = None,
    history_limit: int = HISTORY_COMMIT_LIMIT,
) -> dict[str, Any]:
    """Incremental refresh: re-parse only what changed since ``indexed_sha``.

    Falls back to a full build — and says so in ``refresh`` — when there is no
    prior map or its anchor commit is unknown to this clone. The project graph
    is re-read only when a changed file can alter it (project files or the
    tsconfig alias SSoT); test↔source edges are recomputed for changed test
    files only; churn/co-change absorb exactly the commits in
    ``indexed_sha..HEAD``.
    """
    root = _existing_root(workspace_root)
    tools = ensure_tools_dir(base_dir)
    prior = read_twin_map(base_dir=tools)
    head = _head_sha(root)
    if prior is None or not _commit_known(root, str(prior.get("indexed_sha") or "")):
        twin = build_twin_map(
            workspace_root=root, base_dir=tools, nx_graph_file=nx_graph_file, history_limit=history_limit
        )
        twin["refresh"] = {"mode": "full", "reason": "no_prior_map" if prior is None else "unknown_anchor"}
        _write_map(tools, twin)
        return twin
    anchor = str(prior["indexed_sha"])
    if anchor == head:
        prior["refresh"] = {"mode": "noop", "changed_files": 0}
        return prior

    changed = _changed_files(root, anchor, head)
    # The project graph's inputs: project layout + imports + tsconfig aliases.
    # Any changed source file can add/remove an import edge, so the graph is
    # rebuilt whenever code changed — the graph scan is cached-cheap relative
    # to history replay, and a stale dependency edge poisons every consumer.
    graph_dirty = any(p.endswith((".ts", ".tsx")) or p == "tsconfig.base.json" or p.endswith("project.json") for p in changed)
    if graph_dirty:
        graph = _project_graph(root=root, nx_graph_file=Path(nx_graph_file) if nx_graph_file else None)
        order = build_service_analysis_order(graph)
        layer_of = {entry["project"]: entry["layer"] for entry in order["order"]}
        dependents_of = {entry["project"]: entry["dependents"] for entry in order["order"]}
        projects = {
            name: {
                "root": meta["root"],
                "depends_on": graph["dependencies"].get(name, []),
                "dependents": dependents_of.get(name, []),
                "layer": layer_of.get(name),
            }
            for name, meta in graph["projects"].items()
        }
        graph_source = graph["graph_source"]
    else:
        projects = prior["projects"]
        graph_source = prior["graph_source"]

    tested_by = dict(prior.get("tested_by") or {})
    changed_tests = [p for p in changed if _is_test_file(p)]
    if changed_tests:
        # Deleted test files leave their edges; re-derive from survivors only.
        for source_rel in list(tested_by):
            tested_by[source_rel] = [t for t in tested_by[source_rel] if (root / t).exists()]
            if not tested_by[source_rel]:
                del tested_by[source_rel]
        fresh = _tested_by_edges(root, [root / p for p in changed_tests if (root / p).exists()])
        for source_rel, tests in fresh.items():
            merged = set(tested_by.get(source_rel, [])) | set(tests)
            tested_by[source_rel] = sorted(merged)

    # History layers are recomputed WHOLE, by the same function build uses.
    # The map's definition is "the last N commits at indexed_sha": a moving
    # window. Accumulating deltas onto the stored projection is a different
    # definition — old commits never fall out, and sub-threshold co-change
    # counts are lost at the filter, so incremental drifts from rebuild (the
    # equivalence test caught exactly that). One `git log` costs nothing next
    # to the parse layers, which is where incrementality actually pays.
    history = _history_layers(root, history_limit=history_limit)

    twin = {
        "schema_version": TWIN_SCHEMA_VERSION,
        "generated_at": utc_now(),
        "indexed_sha": head,
        "graph_source": graph_source,
        "history_limit": history_limit,
        "projects": projects,
        "tested_by": tested_by,
        "churn": history["churn"],
        "co_change": history["co_change"],
        "stats": {
            "project_count": len(projects),
            "tested_by_edges": sum(len(v) for v in tested_by.values()),
            "churn_files": len(history["churn"]),
            "co_change_pairs": len(history["co_change"]),
            "history_commits": history["commit_count"],
        },
        "refresh": {"mode": "incremental", "changed_files": len(changed), "reparsed_tests": len(changed_tests)},
    }
    _write_map(tools, twin)
    return twin


def read_twin_map(*, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    path = ensure_tools_dir(base_dir) / TWIN_MAP_RELPATH
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def twin_status(*, workspace_root: str | Path, base_dir: str | Path | None = None) -> dict[str, Any]:
    root = _existing_root(workspace_root)
    twin = read_twin_map(base_dir=base_dir)
    head = _head_sha(root)
    if twin is None:
        return {"present": False, "fresh": False, "head_sha": head}
    behind = 0
    if twin.get("indexed_sha") != head and _commit_known(root, str(twin.get("indexed_sha") or "")):
        behind = len(_rev_list(root, f"{twin['indexed_sha']}..{head}"))
    return {
        "present": True,
        "fresh": twin.get("indexed_sha") == head,
        "indexed_sha": twin.get("indexed_sha"),
        "head_sha": head,
        "commits_behind": behind,
        "stats": twin.get("stats", {}),
    }


def twin_context_for_files(twin: dict[str, Any], files: list[str]) -> dict[str, Any]:
    """The token-saving read: a compact context slice for a set of files.

    Pure function over the map — no repo scan. For each input file: its
    project, that project's upstream/downstream, the tests that cover it, its
    churn, and its strongest co-change partners. This is what an agent loads
    INSTEAD of walking directories.
    """
    projects = twin.get("projects") or {}
    project_meta = {name: {"root": meta["root"]} for name, meta in projects.items()}
    tested_by = twin.get("tested_by") or {}
    churn = twin.get("churn") or {}
    pair_index: dict[str, list[tuple[str, int]]] = {}
    for a, b, count in twin.get("co_change") or []:
        pair_index.setdefault(a, []).append((b, int(count)))
        pair_index.setdefault(b, []).append((a, int(count)))

    entries = []
    impacted_projects: set[str] = set()
    for raw in files:
        rel = raw.replace("\\", "/").removeprefix("./")
        project = _project_for_path(rel, project_meta)
        if project:
            impacted_projects.add(project)
            impacted_projects.update(projects.get(project, {}).get("dependents", []))
        partners = sorted(pair_index.get(rel, []), key=lambda item: (-item[1], item[0]))[:5]
        entries.append(
            {
                "file": rel,
                "project": project,
                "tests": tested_by.get(rel, []),
                "churn_commits": int(churn.get(rel, 0)),
                "co_changes_with": [{"file": f, "count": c} for f, c in partners],
            }
        )
    return {
        "schema_version": TWIN_SCHEMA_VERSION,
        "indexed_sha": twin.get("indexed_sha"),
        "files": entries,
        "impacted_projects": sorted(
            {
                p: {
                    "layer": projects.get(p, {}).get("layer"),
                    "depends_on": projects.get(p, {}).get("depends_on", []),
                    "dependents": projects.get(p, {}).get("dependents", []),
                }
                for p in impacted_projects
            }.items()
        ),
    }


# --- layer builders -------------------------------------------------------


def _iter_test_files(root: Path) -> list[Path]:
    tests: list[Path] = []
    for pattern in ("*.spec.ts", "*.spec.tsx", "*.test.ts", "*.test.tsx"):
        tests.extend(root.rglob(pattern))
    tests.extend((root / "aria-kernel" / "tests").glob("test_*.py"))
    return sorted(
        p
        for p in tests
        if not any(part in ("node_modules", "dist", "build", "coverage", ".git") for part in p.parts)
    )


def _is_test_file(rel: str) -> bool:
    if rel.endswith(_TEST_SUFFIXES):
        return True
    return rel.startswith("aria-kernel/tests/test_") and rel.endswith(".py")


def _tested_by_edges(root: Path, test_files: list[Path]) -> dict[str, list[str]]:
    """source-file → [test-file] edges, from convention + relative imports.

    Deterministic and over-approximating on purpose: a test that imports a
    source file covers it; a test named ``foo.spec.ts`` beside ``foo.ts``
    covers it. Over-coverage costs an extra test run; under-coverage hides a
    regression — the asymmetry picks the direction.
    """
    edges: dict[str, set[str]] = {}
    for test in test_files:
        try:
            test_rel = test.relative_to(root).as_posix()
        except ValueError:
            continue
        # Convention: strip the test suffix, look for the sibling source.
        for suffix in _TEST_SUFFIXES:
            if test.name.endswith(suffix):
                stem = test.name.removesuffix(suffix)
                for ext in (".ts", ".tsx"):
                    for candidate in (test.parent / f"{stem}{ext}", test.parent.parent / f"{stem}{ext}"):
                        if candidate.exists():
                            edges.setdefault(candidate.relative_to(root).as_posix(), set()).add(test_rel)
        # Imports: relative specifiers resolved against the test's directory.
        if test.suffix in (".ts", ".tsx"):
            try:
                content = test.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for match in _RELATIVE_IMPORT_RE.finditer(content):
                target = (test.parent / match.group(1)).resolve()
                for ext in ("", ".ts", ".tsx", "/index.ts", "/index.tsx"):
                    candidate = Path(str(target) + ext)
                    if candidate.is_file():
                        try:
                            source_rel = candidate.relative_to(root).as_posix()
                        except ValueError:
                            break
                        if not _is_test_file(source_rel):
                            edges.setdefault(source_rel, set()).add(test_rel)
                        break
        # Python: the kernel's own tests. Convention (test_<stem>.py →
        # aria_kernel/<stem>.py) + `from aria_kernel.<module> import` scan —
        # without this branch every tested_by edge is TypeScript and the map
        # is blind to the kernel it serves (measured: 3806 edges, 0 python).
        if test.suffix == ".py" and test.name.startswith("test_"):
            stem = test.name.removeprefix("test_").removesuffix(".py")
            conventional = root / "aria-kernel" / "aria_kernel" / f"{stem}.py"
            if conventional.is_file():
                edges.setdefault(conventional.relative_to(root).as_posix(), set()).add(test_rel)
            try:
                content = test.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for match in _KERNEL_IMPORT_RE.finditer(content):
                modules = [match.group(1)] if match.group(1) else [
                    name.strip() for name in (match.group(2) or "").split(",")
                ]
                for module in modules:
                    candidate = root / "aria-kernel" / "aria_kernel" / f"{module}.py"
                    if module and candidate.is_file():
                        edges.setdefault(candidate.relative_to(root).as_posix(), set()).add(test_rel)
    return {source: sorted(tests) for source, tests in sorted(edges.items())}


def _history_layers(root: Path, *, history_limit: int) -> dict[str, Any]:
    args = ["log", "--name-only", "--pretty=format:%H", f"-n{history_limit}"]
    try:
        output = _git(root, *args)
    except subprocess.CalledProcessError:
        return {"churn": {}, "co_change": [], "commit_count": 0}
    churn: dict[str, int] = {}
    pair_counts: dict[tuple[str, str], int] = {}
    commit_count = 0
    current: list[str] = []

    def flush() -> None:
        nonlocal commit_count
        if not current:
            return
        commit_count += 1
        if len(current) > HISTORY_MAX_FILES_PER_COMMIT:
            current.clear()
            return
        for file in current:
            churn[file] = churn.get(file, 0) + 1
        ordered = sorted(set(current))
        for i, a in enumerate(ordered):
            for b in ordered[i + 1 :]:
                pair_counts[(a, b)] = pair_counts.get((a, b), 0) + 1
        current.clear()

    for line in output.splitlines():
        line = line.strip()
        if re.fullmatch(r"[0-9a-f]{40}", line):
            flush()
        elif line:
            current.append(line)
    flush()
    return {"churn": _cap_churn(churn), "co_change": _cap_pairs(pair_counts), "commit_count": commit_count}


def _cap_churn(churn: dict[str, int]) -> dict[str, int]:
    recurring = [(f, c) for f, c in churn.items() if c >= CHURN_MIN_COUNT]
    recurring.sort(key=lambda item: (-item[1], item[0]))
    return {file: int(count) for file, count in recurring[:CHURN_MAX_FILES]}


def _cap_pairs(pair_counts: dict[tuple[str, str], int]) -> list[list[Any]]:
    strong = [(a, b, int(c)) for (a, b), c in pair_counts.items() if c >= CO_CHANGE_MIN_COUNT]
    strong.sort(key=lambda item: (-item[2], item[0], item[1]))
    return [[a, b, c] for a, b, c in strong[:CO_CHANGE_MAX_PAIRS]]


# --- plumbing -------------------------------------------------------------


def _existing_root(workspace_root: str | Path) -> Path:
    root = Path(workspace_root).resolve()
    if not root.exists():
        raise GovernanceError(f"workspace root does not exist: {workspace_root}")
    return root


def _write_map(tools_root: Path, twin: dict[str, Any]) -> None:
    path = tools_root / TWIN_MAP_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(twin, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def _git(root: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=True
    ).stdout


def _head_sha(root: Path) -> str:
    try:
        return _git(root, "rev-parse", "HEAD").strip()
    except subprocess.CalledProcessError:
        return ""


def _commit_known(root: Path, sha: str) -> bool:
    if not re.fullmatch(r"[0-9a-f]{7,64}", sha or ""):
        return False
    try:
        _git(root, "cat-file", "-e", f"{sha}^{{commit}}")
        return True
    except subprocess.CalledProcessError:
        return False


def _changed_files(root: Path, base: str, head: str) -> list[str]:
    output = _git(root, "diff", "--name-only", f"{base}..{head}")
    return sorted({line.strip() for line in output.splitlines() if line.strip()})


def _rev_list(root: Path, rev_range: str) -> list[str]:
    try:
        output = _git(root, "rev-list", rev_range)
    except subprocess.CalledProcessError:
        return []
    return [line for line in output.splitlines() if line.strip()]


__all__ = [
    "TWIN_MAP_RELPATH",
    "build_twin_map",
    "read_twin_map",
    "refresh_twin_map",
    "twin_context_for_files",
    "twin_status",
]
