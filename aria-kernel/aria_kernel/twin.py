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

import ast as _ast
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .genesis_policy import source_qualification_policy
from .git_probe import refuse_shallow_checkout
from .impact_graph import _project_for_path, _project_graph, build_service_analysis_order
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .snapshot import (
    _ScopedSourceBudget, _read_scoped_source_bytes, _read_scoped_working_file,
    _read_scoped_membership, _scoped_input_digest, _sha256,
)

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
    discovery: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Full build of the twin map from the repository at HEAD.

    Refuses a shallow checkout (``GovernanceError`` naming
    ``SHALLOW_CHECKOUT_REFUSAL``) at the entry, before any layer is read: a
    partial clone cannot say what recurred, and a build refused here costs
    nothing. ``refresh_twin_map`` refuses at its own entry the same way, so
    both publishers share one contract. A workspace whose history cannot be
    read at all (not a repository, unborn, no git) is refused next, as
    ``HISTORY_UNAVAILABLE``, before the parse layers run.
    """
    root = _existing_root(workspace_root)
    _refuse_shallow_checkout(root)
    # History first: it is one `git log`, and it is the layer that can be
    # refused (HISTORY_UNAVAILABLE), so a workspace with no readable history
    # is turned away before the parse layers spend anything on it.
    history = _history_layers(root, history_limit=history_limit)
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
    if discovery is not None:
        twin["self_features"] = _self_feature_projection(
            root, discovery, qualification_deadline_seconds=_qualification_deadline_seconds(root),
        )
    _write_map(ensure_tools_dir(base_dir), twin)
    return twin


def refresh_twin_map(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    nx_graph_file: str | Path | None = None,
    history_limit: int = HISTORY_COMMIT_LIMIT,
    discovery: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Incremental refresh: re-parse only what changed since ``indexed_sha``.

    Falls back to a full build — and says so in ``refresh`` — when there is no
    prior map or its anchor commit is unknown to this clone. The project graph
    is re-read only when a changed file can alter it (project files or the
    tsconfig alias SSoT); test↔source edges are recomputed for changed tests,
    or for all tests when source membership changes their resolution.
    Churn/co-change absorb exactly the commits in
    ``indexed_sha..HEAD``.

    Refuses a shallow checkout (``GovernanceError`` naming
    ``SHALLOW_CHECKOUT_REFUSAL``) before reading or writing anything: a
    partial clone cannot say what recurred.
    """
    root = _existing_root(workspace_root)
    # Refused at the entry, before the anchor test: on a shallow checkout the
    # prior anchor is unknown as a matter of course (its history was cut), so
    # the test below would route every refresh into a full rebuild, which
    # refuses at its own entry; refusing here as well covers the noop path,
    # so no refresh on a partial clone can certify the map as current.
    _refuse_shallow_checkout(root)
    tools = ensure_tools_dir(base_dir)
    prior = read_twin_map(base_dir=tools)
    head = _head_sha(root)
    if prior is None or not _commit_known(root, str(prior.get("indexed_sha") or "")):
        twin = build_twin_map(
            workspace_root=root, base_dir=tools, nx_graph_file=nx_graph_file, history_limit=history_limit,
            discovery=discovery,
        )
        twin["refresh"] = {"mode": "full", "reason": "no_prior_map" if prior is None else "unknown_anchor"}
        _write_map(tools, twin)
        return twin
    anchor = str(prior["indexed_sha"])
    if anchor == head:
        prior["refresh"] = {"mode": "noop", "changed_files": 0}
        if discovery is not None:
            # HEAD alone cannot qualify a working-tree observation. The
            # captured pilot view is independent of the history refresh.
            prior["self_features"] = _self_feature_projection(
                root, discovery, qualification_deadline_seconds=_qualification_deadline_seconds(root),
            )
            _write_map(tools, prior)
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
    reparsed_tests = len(changed_tests)
    if _source_membership_changed(root, anchor, head):
        # A new/deleted source can change an unchanged test's import or
        # filename-convention resolution. Prior resolved edges cannot name
        # all those dependencies (including previously unresolved imports).
        # Rebuild this association layer through its existing extractor.
        # This is cycle scan work, not bounded per-request qualification.
        test_files = _iter_test_files(root)
        tested_by = _tested_by_edges(root, test_files)
        reparsed_tests = len(test_files)
    elif changed_tests:
        changed_test_set = set(changed_tests)
        # Replace surviving changed tests' associations as well as removing
        # deleted tests; unioning with their old imports leaves stale edges.
        for source_rel in list(tested_by):
            tested_by[source_rel] = [
                t for t in tested_by[source_rel]
                if t not in changed_test_set and (root / t).exists()
            ]
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
        "refresh": {"mode": "incremental", "changed_files": len(changed), "reparsed_tests": reparsed_tests},
    }
    if discovery is not None:
        twin["self_features"] = _self_feature_projection(
            root, discovery, qualification_deadline_seconds=_qualification_deadline_seconds(root),
        )
    _write_map(tools, twin)
    return twin


def _qualification_deadline_seconds(workspace_root: str | Path | None) -> float:
    """The scoped-read allowance is policy, never a literal in this module.

    ARIA-MEDIUM-082: ``genesis_policy.source_qualification_policy`` is the
    one authority (default file + ``<workspace>/aria-config/genesis_policy.json``
    override), so an operator on a loaded host — or a fixture that needs an
    ample allowance — widens it through the same seam the runtime reads.
    ``None`` (no workspace bound at mint) resolves to the shipped default.
    """
    return source_qualification_policy(workspace_root)["deadline_seconds"]


def _pilot_input_roles() -> dict[str, list[str]]:
    """Named scope of this two-feature extractor, not another feature registry."""
    modules = (
        "runtime_artifacts", "knowledge_graph", "cycle_phases/memory", "cli", "autonomy_orchestrator",
        "reflection_inputs", "reflection", "report", "snapshot", "discovery", "twin", "convergence_drainer",
        "convergent_planning_bridge", "cross_review_bridge", "plan_convergence", "runtime_profile",
        "agent_surface", "agent_network", "capability_gap", "state_manifest", "tool_registry", "agent_invocations",
    )
    tests = ("test_runtime_artifacts", "test_autonomy_orchestrator", "test_learned_context_and_intent",
             "test_twin_map", "test_phase2_fates_snapshot", "test_prompt_render_versioning", "test_convergence_resumable_step")
    return {
        "source": sorted(f"aria-kernel/aria_kernel/{name}.py" for name in modules),
        "test": sorted(f"aria-kernel/tests/{name}.py" for name in tests),
        "config": ["aria-kernel/pyproject.toml"], "dependency": ["aria-kernel/pyproject.toml"],
    }


def _static_pilot_callers(module: str, symbol: str, trees: dict[str, Any], budget: _ScopedSourceBudget) -> list[dict[str, Any]]:
    callers = []
    for path, tree in trees.items():
        aliases = set()
        for node in _ast.walk(tree):
            if budget.expired():
                return callers
            if isinstance(node, _ast.ImportFrom) and node.module in (module, "aria_kernel." + module):
                aliases.update(alias.asname or alias.name for alias in node.names if alias.name == symbol)
        if not aliases:
            continue
        stack = [(tree, "<module>")]
        while stack and len(callers) < 8:
            if budget.expired():
                return callers
            node, owner = stack.pop()
            if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                owner = node.name
            if isinstance(node, _ast.Call) and isinstance(node.func, _ast.Name) and node.func.id in aliases:
                callers.append({"path": path, "symbol": owner, "line": node.lineno,
                                "evidence_ref": f"{path}:{node.lineno}", "method": "static_import_and_call"})
            stack.extend((child, owner) for child in _ast.iter_child_nodes(node))
    return sorted(callers, key=lambda item: (item["path"], item["line"]))


def _pilot_test_refs(module: str, trees: dict[str, Any], observed: dict[str, Any]) -> list[dict[str, Any]]:
    if module == "runtime_artifacts":
        named = [("test_autonomy_orchestrator", "AutonomyOrchestratorTests", name) for name in (
            "test_pending_memory_reaches_real_operator_summary",
            "test_pending_memory_reaches_persisted_reflection_and_daily_report",
            "test_memory_projection_survives_persisted_reflection_to_local_anchor",
        )]
    else:
        named = [("test_learned_context_and_intent", "ConventionsForPathsTest", "test_only_related_confident_conventions_surface"),
                 ("test_learned_context_and_intent", "EstablishedKnowledgeAtMintTest", "test_beliefs_and_conventions_land_in_the_envelope_and_the_prompt"),
                 ("test_learned_context_and_intent", "EstablishedKnowledgeAtMintTest", "test_explicit_tools_root_excludes_checkout_shadow_knowledge")]
    refs = []
    for test_module, cls, method in named:
        path = f"aria-kernel/tests/{test_module}.py"
        tree = trees.get(path)
        if tree is None:
            continue
        for node in tree.body:
            if isinstance(node, _ast.ClassDef) and node.name == cls:
                definition = next((item for item in node.body if isinstance(item, _ast.FunctionDef) and item.name == method), None)
                if definition is not None:
                    refs.append({"test_id": f"tests/{test_module}.py::{cls}::{method}", "path": path,
                                 "content_hash": observed[path]["content_hash"], "evidence_ref": f"{path}:{definition.lineno}"})
    return refs


def _self_feature_projection(
    root: Path, discovery: dict[str, Any], *, qualification_deadline_seconds: float,
) -> dict[str, Any]:
    """Two source observations from the existing discovery, never execution proof.

    The whole discovery/history/project scans belong to cycle maintenance.
    Only the pilot byte reads share this scoped allowance; a later mint must
    independently qualify its applicable source view before using these facts.
    ``qualification_deadline_seconds`` is required, not defaulted: the caller
    resolves it from policy (``_qualification_deadline_seconds``), so no path
    through this module can fall back to a literal.
    """
    started = utc_now()
    budget = _ScopedSourceBudget(deadline_seconds=qualification_deadline_seconds)
    snapshot = discovery.get("snapshot") or {}
    proof = discovery.get("completion_proof") or {}
    pilots = ("runtime_artifacts.autonomy_output_summary", "knowledge_graph.conventions_for_paths")
    roles = _pilot_input_roles()
    scope = sorted(set(path for paths in roles.values() for path in paths))
    # This consumes the already materialized cycle result, not another
    # filesystem/Git enumeration or a per-request FATES reload.
    fates = {row["path"]: row for row in discovery.get("fates", []) if row.get("path") in scope}
    features = {}
    observed_by_path, bytes_by_path = {}, {}
    owner_paths = [f"aria-kernel/aria_kernel/{key.split('.')[0]}.py" for key in pilots]
    for path in owner_paths + [path for path in scope if path not in owner_paths]:
        observed_by_path[path], data = _read_scoped_source_bytes(
            root, fates.get(path, {"path": path}), snapshot_mode=snapshot.get("snapshot_mode"),
            base_commit_sha=snapshot.get("base_commit_sha"), budget=budget,
        )
        if data is not None:
            bytes_by_path[path] = data
    trees = {}
    for key in pilots:
        module, symbol = key.split(".")
        relative = f"aria-kernel/aria_kernel/{module}.py"
        observed, data = observed_by_path[relative], bytes_by_path.get(relative)
        feature = {
            "owner": {"path": relative, "symbol": symbol, "content_hash": observed.get("content_hash")},
            "implemented": {"status": "unknown", "reason": observed["reason"]},
            "reachable": {"status": "unknown", "reason": "caller_scope_not_observed"},
            "configured": {"status": "unknown", "reason": "effective_configuration_uncaptured"},
            "demonstrated": {"status": "unknown", "reason": "applicable_execution_proof_unavailable"},
            "runtime": {"status": "unknown", "reason": "dated_runtime_observation_unavailable"},
        }
        if data is not None and not budget.expired():
            definition = None
            try:
                tree = _ast.parse(data, filename=relative)
                trees[relative] = tree
                definition = next((node for node in tree.body if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef))
                                   and node.name == symbol), None)
                if definition is None:
                    feature["implemented"]["reason"] = "selected_symbol_not_observed"
                else:
                    feature["owner"]["line"] = definition.lineno
                    feature["implemented"] = {"status": "available", "reason": "selected_source_definition",
                                              "evidence_refs": [f"{relative}:{definition.lineno}"]}
            except (SyntaxError, ValueError, RecursionError):
                feature["implemented"] = {"status": "unknown", "reason": "source_parse_unavailable"}
            if definition is not None and not budget.expired():
                # Optional display extraction cannot turn a known definition
                # into an inconsistent available/parse-failed observation.
                feature["inputs"] = [arg.arg for arg in (*definition.args.posonlyargs, *definition.args.args,
                                                        *definition.args.kwonlyargs)]
                try:
                    feature["purpose"] = {"kind": "source_inferred", "text": (_ast.get_docstring(definition) or "")[:600]}
                    feature["output"] = {"kind": "source_annotation", "status": "available" if definition.returns else "unknown",
                                         "reason": "selected_source_annotation" if definition.returns else "annotation_absent",
                                         "text": _ast.unparse(definition.returns)[:300] if definition.returns else None}
                except (ValueError, RecursionError):
                    feature["output"] = {"kind": "source_annotation", "status": "unknown",
                                         "reason": "source_display_unavailable", "text": None}
            if budget.expired():
                feature["implemented"] = {"status": "unknown", "reason": "qualification_deadline"}
        features[key] = feature
    # Only the named direct callers and named test modules need additional
    # ASTs. Other declared source dependencies are byte observations; dynamic
    # closure and execution remain explicitly unknown.
    for path in ("aria-kernel/aria_kernel/cli.py", "aria-kernel/aria_kernel/agent_invocations.py", *roles["test"]):
        if budget.expired():
            break
        if path not in bytes_by_path:
            continue
        try:
            trees[path] = _ast.parse(bytes_by_path[path], filename=path)
        except (SyntaxError, ValueError, RecursionError):
            continue
    caller_trees = {path: tree for path, tree in trees.items() if path in (
        "aria-kernel/aria_kernel/cli.py", "aria-kernel/aria_kernel/agent_invocations.py",
    )}
    for key, feature in features.items():
        module, symbol = key.split(".")
        feature["callers"] = _static_pilot_callers(module, symbol, caller_trees, budget)
        if feature["callers"] and not budget.expired():
            feature["reachable"] = {"status": "available", "reason": "static_call_observed"}
        feature["tests"] = {"method": "named_behavioral_test_scope_not_execution",
                            "refs": _pilot_test_refs(module, trees, observed_by_path)}
        feature["configuration_refs"] = roles["config"]
        feature["dependency_refs"] = roles["source"] + roles["dependency"]
        feature["state_refs"] = ["aria-kernel/aria_kernel/state_manifest.py", "aria-kernel/aria_kernel/tool_registry.py"]
    availability = {name: {"status": "unknown", "reason": "not_observed"} for name in (
        "repo_identity", "source", "test_selection", "test_content", "config", "dependency",
        "runner_environment", "selection_closure", "configuration_closure",
    )}
    digests = {}
    for role, dimension in (("source", "source"), ("test", "test_content"), ("config", "config"), ("dependency", "dependency")):
        digests[dimension + "_digest"] = _scoped_input_digest([observed_by_path[path] for path in roles[role]])
        availability[dimension] = {"status": "available" if digests[dimension + "_digest"] is not None else "unknown",
                                   "reason": "named_file_scope_only"}
    availability["dependency"] = {"status": "unknown", "reason": "installed_dependency_closure_uncaptured"}
    binding = {
        "schema_version": 1, "repo_identity": None, "snapshot_mode": snapshot.get("snapshot_mode"),
        "scope_paths": scope, **digests,
        "test_selection_digest": None, "runner_environment_digest": None, "source_stability": "unknown",
        "capture_started_at": started, "capture_completed_at": utc_now(), "availability": availability,
    }
    for field in ("base_commit_sha", "snapshot_hash", "repo_state_id"):
        binding[field] = snapshot.get(field)
        availability[field] = {"status": "available" if binding[field] is not None else "unknown",
                               "reason": "existing_discovery_observation"}
    membership_scopes = ["aria-kernel/aria_kernel", "aria-kernel/tests", "aria-kernel/pyproject.toml"]
    members = sorted(row["path"] for row in discovery.get("fates", []) if any(
        row["path"] == prefix or row["path"].startswith(prefix + "/") for prefix in membership_scopes))
    membership = {"scopes": membership_scopes, "paths": members[:4096],
                  "status": "available" if len(members) < 4096 else "unknown",
                  "reason": "existing_discovery_membership" if len(members) < 4096 else "membership_scope_limit"}
    if budget.expired():
        for feature in features.values():
            for dimension in ("implemented", "reachable"):
                feature[dimension] = {"status": "unknown", "reason": "qualification_deadline"}
    return {
        "schema_version": 1, "extractor": "twin.self_features.python_ast.v2", "source_root": root.as_posix(),
        "discovery": {"cycle_id": proof.get("cycle_id"), "complete": proof.get("complete")},
        "input_binding": binding, "features": features,
        "coverage": {"status": "partial", "reason": "named_pilot_scope_only", "scope_paths": scope,
                     "static_hops": 1, "dynamic_closure": "unknown"},
        "input_roles": roles, "selected_fates": [fates.get(path, {"path": path, "fate": "unknown"}) for path in scope],
        "membership": membership,
        "work": {"paths_attempted": budget.paths_attempted,
                 "known_source_bytes": budget.source_bytes_read,
                 "transport_bytes_reserved_including_source": budget.transport_bytes_reserved,
                 "remaining_byte_allowance": budget.remaining_bytes,
                 # The allowance this observation ran under, so a reader of
                 # "qualification_deadline" sees the budget, not just the verdict.
                 "qualification_deadline_seconds": qualification_deadline_seconds,
                 "discovery_fates_previously_materialized": len(discovery.get("fates", []))},
    }


def _qualified_twin_context(
    *, base_dir: Path, files: list[str], workspace_root: str | Path | None,
    cycle_id: str | None, target_sha: str | None,
) -> dict[str, Any] | None:
    """Bounded local qualification of an existing index; never refresh at mint."""
    qualification_deadline_seconds = _qualification_deadline_seconds(workspace_root)
    budget = _ScopedSourceBudget(deadline_seconds=qualification_deadline_seconds)
    observation, data, projection_bytes = _read_scoped_working_file(
        base_dir, TWIN_MAP_RELPATH, byte_budget=2 * 1024 * 1024,
        deadline_monotonic=budget.deadline_monotonic,
    )
    context: dict[str, Any] = {}
    inventory: dict[str, Any] = {}

    def qualified(status: str, reason: str, changed_paths: list[str] | None = None,
                  details: dict[str, Any] | None = None) -> dict[str, Any]:
        view = {key: inventory[key] for key in ("input_binding", "discovery", "coverage") if key in inventory}
        view.update(qualification={"status": status, "reason": reason}, qualification_cycle_id=cycle_id,
                    features=inventory.get("features", {}) if status == "available" else {},
                    historical_feature_keys=sorted(inventory.get("features", {})),
                    changed_paths=changed_paths or [], qualification_details=details or {})
        view["work"] = {"projection_bytes_read": projection_bytes, "paths_attempted": budget.paths_attempted,
                        "known_source_bytes": budget.source_bytes_read,
                        "transport_bytes_reserved_including_source": budget.transport_bytes_reserved,
                        "known_emitted_membership_records": budget.known_membership_records,
                        "remaining_membership_record_allowance": budget.remaining_membership_records,
                        "qualification_deadline_seconds": qualification_deadline_seconds}
        return {**context, "self_features": view}

    if data is None:
        return qualified("unknown", observation["reason"]) if workspace_root is not None else None
    try:
        twin = json.loads(data)
        if not isinstance(twin, dict):
            return qualified("unknown", "projection_shape_unavailable") if workspace_root is not None else None
        if budget.expired():
            return qualified("unknown", "qualification_deadline")
        context = twin_context_for_files(twin, files[:256])
        if workspace_root is None:
            return context
        candidate = twin.get("self_features")
        if not isinstance(candidate, dict):
            return qualified("unknown", "legacy_projection_has_no_source_binding")
        inventory = candidate
        if inventory.get("extractor") != "twin.self_features.python_ast.v2":
            return qualified("unknown", "extractor_changed_or_unavailable")
        root = Path(workspace_root).resolve()
        if inventory.get("source_root") != root.as_posix():
            return qualified("unknown", "explicit_source_root_mismatch")
        binding = inventory.get("input_binding") or {}
        mode, commit = binding.get("snapshot_mode"), binding.get("base_commit_sha")
        if mode == "committed" and (not target_sha or target_sha != commit):
            return qualified("unknown", "target_revision_changed_or_unavailable")
        membership = inventory.get("membership") or {}
        if membership.get("status") != "available":
            return qualified("unknown", "scoped_membership_changed_or_unavailable", details={
                "membership": {key: membership.get(key) for key in ("status", "reason")}})
        current_membership = _read_scoped_membership(
            root, membership["scopes"], snapshot_mode=mode, base_commit_sha=commit, budget=budget,
        )
        if current_membership["status"] != "available" or current_membership["paths"] != membership.get("paths"):
            return qualified("unknown", "scoped_membership_changed_or_unavailable", details={
                "membership": {key: current_membership[key] for key in ("status", "reason")}})
        fates = inventory.get("selected_fates")
        if not isinstance(fates, list) or not fates or len(fates) > 256:
            return qualified("unknown", "selected_source_scope_unavailable")
        changed = []
        unavailable = []
        for fate in fates:
            observed, _data = _read_scoped_source_bytes(
                root, fate, snapshot_mode=mode, base_commit_sha=commit, budget=budget,
            )
            if observed["status"] != "available":
                changed.append(fate.get("path"))
                unavailable.append({key: observed[key] for key in ("path", "status", "reason")})
        if budget.expired():
            return qualified("unknown", "qualification_deadline", changed, {"unavailable_sources": unavailable})
        if changed:
            return qualified("unknown", "scoped_content_changed_or_unavailable", changed, {"unavailable_sources": unavailable})
        return qualified("available", "selected_local_source_view_reobserved")
    except (OSError, RuntimeError, ValueError, TypeError, KeyError, RecursionError):
        return qualified("unknown", "projection_or_source_unavailable") if workspace_root is not None else None


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
    """Churn + co-change over the last ``history_limit`` commits at HEAD.

    Both layers are RECURRENCE counts (``CHURN_MIN_COUNT`` /
    ``CO_CHANGE_MIN_COUNT``), so they need the commits to be there to recur
    in. Two ways the commits can be missing, and neither is published as a
    map:

    - A shallow checkout hands ``git log`` one commit, the thresholds are
      never reached, and the layers come back ``churn={}`` /
      ``co_change=[]`` — indistinguishable from a repository whose files
      genuinely never recur. That is exactly what the nightly lane
      published as a healthy map until 2026-09-12 (actions/checkout
      defaulted to depth 1). Both publishers (``build_twin_map``,
      ``refresh_twin_map``) refuse that clone at their entry, before
      reaching here.
    - ``git log`` fails outright — a workspace that is not a repository, an
      unborn one, no git binary. This function used to swallow that and
      return the same empty layers with ``commit_count=0``, and the build
      went on to publish them under ``indexed_sha ''``: a map that looked
      healthy and described nothing. It is refused by name instead
      (``HISTORY_UNAVAILABLE``); the cycle's ``twin_refresh`` phase is
      ``record_and_continue``, so the refusal lands as the phase's outcome
      row and the prior map stays untouched.
    """
    args = ["log", "--name-only", "--pretty=format:%H", f"-n{history_limit}"]
    try:
        output = _git(root, *args)
    except (subprocess.CalledProcessError, OSError) as exc:
        detail = exc.stderr.strip() if isinstance(exc, subprocess.CalledProcessError) else str(exc)
        raise GovernanceError(
            f"{HISTORY_UNAVAILABLE}: git log failed in {root} ({detail}); the "
            "churn and co-change layers are derived from history and a map "
            "without them must not be published"
        ) from exc
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


# The reasons a consumer (cycle outcome row, operator log) sees when the twin
# refuses to publish. Named once each so the refusal is grep-able end to end;
# the shallow case is the history-unavailable case with its cause known.
HISTORY_UNAVAILABLE = "twin_history_unavailable"
SHALLOW_CHECKOUT_REFUSAL = "twin_history_unavailable_shallow"


def _refuse_shallow_checkout(root: Path) -> None:
    """Refuse to derive history from a checkout that holds part of it.

    The probe is ``git_probe.is_shallow_checkout`` — shared with the
    executor's anchor gate, so the two history readers cannot disagree about
    one clone. Every ARIA lane checks the code repository out with
    ``fetch-depth: 0`` (pinned by
    ``tests/invariants/test_kernel_lanes_check_out_full_history``), so in
    production this never fires. It exists for the case the lane invariant
    cannot reach — an operator clone, a re-shallowed persistent workspace —
    where the alternative is a map that looks healthy and says nothing. A
    workspace that is not a repository is not shallow; its ``git log`` fails
    and ``_history_layers`` refuses it as ``HISTORY_UNAVAILABLE``.
    """
    refuse_shallow_checkout(
        root,
        reason=SHALLOW_CHECKOUT_REFUSAL,
        needs="the churn and co-change layers need the full history and a "
              "map without them must not be published",
    )


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


def _source_membership_changed(root: Path, base: str, head: str) -> bool:
    # Resolve renames as deletion+addition regardless of repository config.
    # The extractor permits exact-file imports, so any non-test path can
    # alter resolution; an extension-only filter would miss that contract.
    paths = _git(root, "diff", "--name-only", "--no-renames", "--diff-filter=AD", "-z", f"{base}..{head}")
    return any(path and not _is_test_file(path) for path in paths.split("\0"))


def _rev_list(root: Path, rev_range: str) -> list[str]:
    try:
        output = _git(root, "rev-list", rev_range)
    except subprocess.CalledProcessError:
        return []
    return [line for line in output.splitlines() if line.strip()]


# --- Intent layer (Plan "ARIA Sinir Sistemi" FAZ 4b) ---------------------
#
# WHY: this repository's commit bodies are why-rich by convention (CLAUDE.md
# mandates "body explaining WHY"), so the cheapest honest answer to "why is
# this code the way it is" is the recent history of the exact files an agent
# is about to touch. The layer is deterministic and git-derived: computed
# once at envelope MINT time, sealed under the prompt hash, never
# recomputed at claim.

INTENT_COMMITS_PER_FILE = 3
INTENT_MAX_FILES = 8

# The reference shapes that carry intent in this repo's commit messages:
# ADR ids, ADR/plan/review doc paths, and finding ids like FARM-HIGH-083.
_INTENT_REF_RE = re.compile(
    r"(ADR-\d{3}|docs/(?:adr|plans|reviews)/[\w./#-]+|[A-Z][A-Z0-9]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d+)"
)


def intent_context_for_files(
    workspace_root: str | Path,
    files: list[str],
    *,
    per_file_commits: int = INTENT_COMMITS_PER_FILE,
    max_files: int = INTENT_MAX_FILES,
) -> dict[str, Any] | None:
    """WHAT: per file, the last K commits' subject + first WHY line + the
    ADR/plan/finding references those messages carry.

    Returns None — not an empty scaffold — when nothing has history, for the
    same reason ``twin_context_for_files`` does: "these files have no
    recorded intent" is a stronger claim than "no intent layer was attached".
    Never raises: a file outside git, an unborn repo, or a git failure costs
    that entry, not the caller.
    """
    root = Path(workspace_root)
    unique = list(dict.fromkeys(
        f.replace("\\", "/").removeprefix("./").strip() for f in files if f and f.strip()
    ))[: max(0, int(max_files))]
    entries: list[dict[str, Any]] = []
    for rel in unique:
        try:
            output = _git(
                root,
                "log",
                "-n",
                str(max(1, int(per_file_commits))),
                "--format=%H%x1f%s%x1f%b%x1e",
                "--",
                rel,
            )
        except (subprocess.CalledProcessError, OSError):
            continue
        commits: list[dict[str, Any]] = []
        for record in output.split("\x1e"):
            parts = record.strip("\n").split("\x1f")
            if len(parts) != 3 or not parts[0].strip():
                continue
            sha, subject, body = parts[0].strip(), parts[1].strip(), parts[2]
            why = next(
                (line.strip() for line in body.splitlines() if line.strip()), ""
            )
            refs = sorted(set(_INTENT_REF_RE.findall(f"{subject}\n{body}")))
            commit: dict[str, Any] = {"sha": sha[:12], "subject": subject}
            if why:
                commit["why"] = why
            if refs:
                commit["refs"] = refs
            commits.append(commit)
        if commits:
            entries.append({"file": rel, "commits": commits})
    if not entries:
        return None
    return {"source": "git-log", "head_sha": _head_sha(root), "files": entries}


__all__ = [
    "HISTORY_UNAVAILABLE",
    "SHALLOW_CHECKOUT_REFUSAL",
    "TWIN_MAP_RELPATH",
    "build_twin_map",
    "intent_context_for_files",
    "read_twin_map",
    "refresh_twin_map",
    "twin_context_for_files",
    "twin_status",
]
