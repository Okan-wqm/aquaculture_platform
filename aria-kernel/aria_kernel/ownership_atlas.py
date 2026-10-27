"""F0.9b — the ownership atlas, generated from code (PLAN-v2 Faz 0.9).

WHY THIS EXISTS. The F0.9 atlas (80 concepts, 180 copy sites at d42f5488b) was
written by hand from four evidence-first readers and a skeptic; a hand atlas is
stale at the next merge. Here each concept family is DECLARED once (its owner,
the names its value is computed under, its ledgers, and, for a family with
copies, the plan package that folds them and the finding that tracks it) and
everything else is COMPUTED from the code through the symbol layer of the parse
aria-import-graph reads (``source_facts.extract``; no fourth graph engine, no
second parser): who writes the ledger or defines a computer, who references the
owner, and which cycle phase, CLI or workflow reaches it. ``render_atlas`` is committed at ``ATLAS_PATH`` and pinned
byte-for-byte (tests/test_ownership_atlas_ssot.py), the JUDGE-DIGEST pattern.

ONE OWNER. A family declared with an owner and no finding is single-owner
today; ``one_owner_offenders`` reports every writer or computer of it outside
the owner's module (tests/invariants/test_atlas_one_owner.py, digest.py's
pattern), so a second copy is red the commit it appears. Families with copies
are not folded here: each names the package and the registered finding that do.

PROVENANCE (F0.9p). The same parse says which ledgers' rows cite which: ``ROW_SCOPES`` declares the top-level
statement that BUILDS each ledger's row, the keys that scope writes (``source_facts`` ``keys``) that are in the citation
vocabulary of ``row_provenance`` are the row's citations, and ``provenance_offenders`` is red when a declared scope or a
written id or a learned source field is gone. Keys are read at scope granularity, as every symbol fact is.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .genesis_policy import judgment_pipeline_policy
from .row_provenance import LEARNED_KINDS, REF_FIELDS
from .state_manifest import iter_surfaces
from .source_facts import MODULE_SCOPE, deepest_module, extract, iter_modules, module_name, path_parts

ATLAS_PATH = "docs/aria/generated/OWNERSHIP-ATLAS.md"
REGEN_COMMAND = f"PYTHONPATH=aria-kernel python3 -m aria_kernel.docs_ssot ownership-atlas > {ATLAS_PATH}"
_K = "aria-kernel/aria_kernel/"
# ledger.py's public writers: a call to one carrying a family's surface or ledger path writes that ledger.
LEDGER_WRITERS = frozenset({
    "append_jsonl", "append_declared_jsonl", "append_declared_jsonl_rows",
    "rewrite_jsonl", "rewrite_declared_jsonl", "rewrite_declared_json",
})
_CLI = (f"{_K}cli.py", "main")
_WORKFLOW_SCRIPT = re.compile(r"(tools/aria-poc/[\w/]+\.py)|-m (aria_kernel(?:\.\w+)+)")


@dataclass(frozen=True)
class Family:
    subsystem: str
    owner: str | None  # "<repo path>:<symbol>"; None when no owner exists
    computers: tuple[str, ...] = ()  # names the family's value is computed under
    ledgers: tuple[tuple[str, str], ...] = ()  # (declared surface, ledger relpath)
    gate: str | None = None  # judgment_pipeline_policy key that must be true for the owner to act
    plan_package: str | None = None
    finding: str | None = None


FAMILIES: dict[str, Family] = {
    # Single owner today (contested.json refutations applied): pinned by the one-owner invariant.
    "plan_events_ledger": Family("planning-impl", f"{_K}plan_convergence.py:_append_event",
                                 ledgers=(("plan_convergence_events", "plans/events.jsonl"),)),
    "agent_performance_episodes": Family("learning-memory", f"{_K}agent_eval.py:observe_agent_performance",
                                         ledgers=(("memory_procedural", "memory/procedural.jsonl"),)),
    # F1.1: goldset and pr_tracking record through the owner, whose event kinds are a closed vocabulary.
    "learning_log": Family("learning-memory", f"{_K}memory.py:record_learning_event",
                           ledgers=(("memory_learning_events", "memory/learning-events.jsonl"),)),
    # SE-5: the lifecycle state of an entity is its replayed chain, read in one place. `_target_is_shadow` is the
    # name of the second, unverified reading that was deleted; listing it makes its return an offender.
    "lifecycle_state": Family("learning-memory", f"{_K}genesis_lifecycle.py:current_lifecycle_state",
                              ("current_lifecycle_state", "_target_is_shadow"),
                              (("genesis_lifecycle_events", "genesis-lifecycle/events.jsonl"),)),
    # SE-5: which agents may serve a role (the static pairing plus the granted per-service agents) is answered here.
    "role_agent_targets": Family("judgment", f"{_K}agent_surface.py:allowed_targets_for_role",
                                 ("allowed_targets_for_role", "resolve_seat_agent")),
    "fitness_report": Family("learning-memory", f"{_K}fitness.py:generate_fitness_report",
                             ("generate_fitness_report",), (("fitness_reports", "fitness/fitness-reports.jsonl"),)),
    # F0.9p: the one census of learned rows that name no source; the doctor's `provenance` organ is its reader.
    "row_provenance": Family("learning-memory", f"{_K}row_provenance.py:provenance_census", ("provenance_census",)),
    "calibration_gate": Family("judgment", f"{_K}genesis_policy.py:effective_calibration_gate",
                               ("effective_calibration_gate",)),
    "verbatim_quote_law": Family("judgment", f"{_K}evidence_trust.py:quote_matches_at", ("quote_matches_at",)),
    "judge_response_contract": Family("judgment", f"{_K}judgment_bridge.py:validate_judge_response",
                                      ("validate_judge_response",)),
    "dispatch_failure_classification": Family("tools-gates", "tools/aria-poc/dispatch_failure.py:classify_dispatch_failure",
                                              ("classify_dispatch_failure",)),
    # The one parse aria-import-graph and this atlas read (PLAN-v2 F0.9: no fourth graph engine).
    "python_source_facts": Family("tools-gates", f"{_K}source_facts.py:extract",
                                  ("module_name", "iter_sources", "iter_modules", "deepest_module", "path_parts",
                                   "chain_runs", "flatten_div", "module_bindings", "export_table")),
    # Dormant by design: routed every cycle, acts only with funnel_enabled (genesis_policy).
    "judgment_funnel": Family("judgment", f"{_K}judgment_funnel.py:route_judgment_sample", ("route_judgment_sample",),
                              (("judgment_funnel_routing", "judgment-funnel/routing.jsonl"),), gate="funnel_enabled"),
    # Copies today: registered, folded by the named package.
    "finding_acceptance_bar": Family("judgment", f"{_K}finding_promotion.py:promote_consensus_findings",
                                     ("promote_consensus_findings", "is_ground_truth_row"),
                                     plan_package="F2.3", finding="ARIA-HIGH-737"),
    "red_first_prover": Family("planning-impl", None, ("prove_red_first",), plan_package="F3.2", finding="ARIA-MEDIUM-744"),
    "change_outcome": Family("planning-impl", f"{_K}change_outcome.py:evaluate_change_outcomes",
                             ("evaluate_change_outcomes", "_attributed_reverts"),
                             (("change_outcome", "change-ledger/outcome.jsonl"),),
                             plan_package="F3.3", finding="ARIA-HIGH-745"),
    "merge_index": Family("planning-impl", f"{_K}merge_record.py:fold_merged_rows",
                          ("fold_merged_rows", "_merge_index", "_aria_merged_prs", "scan_merged_own_prs"),
                          plan_package="F3.4", finding="ARIA-MEDIUM-746"),
    "rule_contract": Family("judgment", f"{_K}rule_contract.py:resolve_rule_contract",
                            ("resolve_rule_contract", "_canary_contract"), plan_package="F2.4", finding="ARIA-LOW-738"),
    "seat_law": Family("judgment", f"{_K}feedback_store.py:distinct_judge_seats",
                       ("distinct_judge_seats", "verify_route_distinctness", "check_pattern_signature_stability"),
                       plan_package="F0.8", finding="ARIA-MEDIUM-904"),
    "plan_round_cap": Family("planning-impl", f"{_K}convergence_drainer.py:AUTONOMY_CYCLE_MAX_ROUNDS",
                             ("AUTONOMY_CYCLE_MAX_ROUNDS", "MAX_CROSS_REVIEW_ROUNDS", "advance_plan_rounds"),
                             plan_package="F3.1", finding="ARIA-LOW-743"),
    "impact_analysis": Family("planning-impl", f"{_K}impact_graph.py:plan_downstream_impact",
                              ("plan_downstream_impact", "plan_impact", "compute_recursive_impact", "plan_new_merge_impact"),
                              plan_package="SE-4", finding="ARIA-MEDIUM-903"),
}


# Where each ledger's row is BUILT: "<repo path>:<top-level scope>". The ledger's own file comes from the manifest
# (``state_manifest.surface_by_name``), so no (surface, relpath) pair is repeated here (ARIA-MEDIUM-926).
ROW_SCOPES: dict[str, tuple[str, ...]] = {
    "plan_convergence_events": (f"{_K}plan_convergence.py:_append_event",),
    "change_planned": (f"{_K}change_ledger.py:emit_change_planned",),
    "change_committed": (f"{_K}change_ledger.py:emit_change_committed",),
    "change_validated": (f"{_K}change_ledger.py:emit_change_validated",),
    "change_outcome": (f"{_K}change_outcome.py:emit_change_outcome",),
    "memory_procedural": (f"{_K}agent_eval.py:_episode",),
    "kg_conventions": (f"{_K}knowledge_graph.py:Pattern", f"{_K}knowledge_graph.py:reconcile_convention_promotion"),
    "memory_beliefs": (f"{_K}memory.py:_record_belief",),
}


def production_sources(repo_root: Path) -> dict[str, str]:
    """Every importable production module of the kernel and the executor, by repo path (tests excluded)."""
    return {path: (repo_root / path).read_text(encoding="utf-8") for _, path, _ in iter_modules(str(repo_root))
            if "tests" not in path.split("/") and not path.rsplit("/", 1)[-1].startswith("test_")}


def _surface(surface: str | None, surface_ref: str | None, constants: dict[str, dict[str, str]]) -> str | None:
    """The declared surface a call names: its literal, or the string constant its name resolves to."""
    if surface_ref is None:
        return surface
    module, _, name = surface_ref.rpartition(".")
    return constants.get(module, {}).get(name)


def _sites(family: Family, facts: dict[str, Any], constants: dict[str, dict[str, str]]) -> set[tuple[int, str, str]]:
    """(line, scope, what) for every definition of a computer and every write of a ledger of ``family``."""
    sites = {(line, scope, "") for name, line, scope in facts["defs"] if name in family.computers}
    for line, scope, callee, surface, surface_ref, paths in facts["calls"]:
        if callee in LEDGER_WRITERS:
            named = _surface(surface, surface_ref, constants)
            sites.update((line, scope, f"{relpath} ({declared})") for declared, relpath in family.ledgers
                         if named == declared or any(_names_path(p, relpath) for p in paths))
    return sites


def _names_path(parts: list[str], relpath: str) -> bool:
    """A path literal's components end with ``relpath``'s (``root / "plans" / "events.jsonl"``)."""
    wanted = path_parts(relpath)
    return tuple(parts[-len(wanted):]) == wanted


def _all_facts(sources: dict[str, str]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, str]]]:
    names = {path: module_name(path) for path in sources}
    facts = {path: extract(text, path, names[path], path.endswith("/__init__.py"), symbols=True)
             for path, text in sources.items()}
    return facts, {names[path]: f["constants"] for path, f in facts.items()}


def one_owner_offenders(sources: dict[str, str]) -> list[str]:
    """``<path>:<line>:<family>`` for every writer or computer of a single-owner family outside its owner."""
    facts, constants = _all_facts(sources)
    offenders = set()
    for family_id, family in FAMILIES.items():
        if family.owner is None or family.finding is not None:
            continue
        owner_path = family.owner.rsplit(":", 1)[0]
        for path, module_facts in facts.items():
            if path != owner_path:
                offenders.update(f"{path}:{line}:{family_id}" for line, _, _ in _sites(family, module_facts, constants))
    return sorted(offenders)


def _written_keys(facts: dict[str, dict[str, Any]], surface: str) -> set[str]:
    """The keys the scopes that build ``surface``'s row write."""
    keys: set[str] = set()
    for scope in ROW_SCOPES[surface]:
        path, _, name = scope.rpartition(":")
        keys.update(key for owner, key in (facts[path]["keys"] if path in facts else ()) if owner == name)
    return keys


def _cites(facts: dict[str, dict[str, Any]], surface: str) -> dict[str, str]:
    """{field: cited surface} for the citation-vocabulary keys ``surface``'s row writes; its own id is no citation."""
    keys = _written_keys(facts, surface)
    return {field: ref.surface for field, ref in sorted(REF_FIELDS.items())
            if field in keys and (ref.surface, ref.id_field) != (surface, field)}


def _provenance(facts: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    kinds = {learned.surface: (kind, list(learned.sources)) for kind, learned in LEARNED_KINDS.items()}
    entries: dict[str, dict[str, Any]] = {}
    for surface, scopes in sorted(ROW_SCOPES.items()):
        kind, sources = kinds.get(surface, (None, []))
        entries[surface] = {"row_scopes": list(scopes), "cites": _cites(facts, surface), "kind": kind, "sources": sources}
    return entries


def provenance_edges(sources: dict[str, str]) -> dict[str, dict[str, str]]:
    """``{surface: {field: cited surface}}`` for every ledger in ``ROW_SCOPES``, from the code that builds its row."""
    facts, _ = _all_facts(sources)
    return {surface: entry["cites"] for surface, entry in _provenance(facts).items()}


def provenance_offenders(sources: dict[str, str]) -> list[str]:
    """Every place the provenance declarations and the code disagree (``[]`` on the real tree), sorted:
    ``<surface>:stale_row_scope:<path>:<scope>`` (a declared scope, or its module, is gone),
    ``<field>:id_field_not_written:<surface>.<id_field>`` (a citation names a ledger whose row no longer writes the id),
    ``<kind>:source_field_not_written:<field>`` (a learned kind's row builder no longer writes a source field) and
    ``<kind>:no_row_scope``. A ledger that is only cited (the finding mint) has no row scope and nothing to check."""
    facts, _ = _all_facts(sources)
    offenders: set[str] = set()
    for surface, scopes in ROW_SCOPES.items():
        for scope in scopes:
            path, _, name = scope.rpartition(":")
            if path not in facts or not any(def_name == def_scope == name for def_name, _, def_scope in facts[path]["defs"]):
                offenders.add(f"{surface}:stale_row_scope:{scope}")
    for field, ref in REF_FIELDS.items():
        if ref.surface in ROW_SCOPES and ref.id_field not in _written_keys(facts, ref.surface):
            offenders.add(f"{field}:id_field_not_written:{ref.surface}.{ref.id_field}")
    for kind, learned in LEARNED_KINDS.items():
        if learned.surface not in ROW_SCOPES:
            offenders.add(f"{kind}:no_row_scope")
            continue
        written = _written_keys(facts, learned.surface)
        offenders.update(f"{kind}:source_field_not_written:{source}" for source in learned.sources if source not in written)
    return sorted(offenders)


def build_atlas(repo_root: Path) -> dict[str, Any]:
    facts, constants = _all_facts(production_sources(repo_root))
    path_of = {module_name(path): path for path in facts}
    referrers: dict[tuple[str, str], set[tuple[str, str]]] = {}
    for path, module_facts in facts.items():
        for _, scope, dotted in module_facts["uses"]:
            module = deepest_module(dotted.rpartition(".")[0], path_of)
            target = (path_of[module], dotted[len(module) + 1 :].split(".")[0]) if module else None
            if target is not None and target != (path, scope):
                referrers.setdefault(target, set()).add((path, scope))
    roots = _roots(repo_root, path_of)
    surface_paths = {surface.name: surface.path_pattern for surface in iter_surfaces()}
    policy = judgment_pipeline_policy(repo_root)
    families = {}
    for family_id, family in sorted(FAMILIES.items()):
        sites = {(path, scope, what) for path, f in facts.items() for _, scope, what in _sites(family, f, constants)}
        owner_node = tuple(family.owner.rsplit(":", 1)) if family.owner else None
        via = _reached_from(owner_node, referrers, roots) if owner_node else None
        read = {f"{surface_paths[named]} ({named})" for _, _, callee, surface, surface_ref, _ in
                (facts[owner_node[0]]["calls"] if owner_node else [])
                if callee not in LEDGER_WRITERS and (named := _surface(surface, surface_ref, constants)) in surface_paths}
        liveness = "dead" if via is None else "dormant" if family.gate and policy.get(family.gate) is not True else "live"
        families[family_id] = {
            "subsystem": family.subsystem, "owner": family.owner,
            "writers": sorted({f"{path}:{scope}" for path, scope, _ in sites} | ({family.owner} if family.owner else set())),
            "ledgers_written": sorted({what for _, _, what in sites if what}), "ledgers_read": sorted(read),
            "callers": sorted(f"{p}:{s}" for p, s in referrers.get(owner_node, ())) if owner_node else [],
            "liveness": liveness, "liveness_via": via,
            "plan_package": family.plan_package, "finding": family.finding,
        }
    return {"families": families, "provenance": _provenance(facts)}


def _roots(repo_root: Path, path_of: dict[str, str]) -> dict[tuple[str, str], tuple[int, str]]:
    """Entry points by rank: a cycle phase (the loop), a workflow-run script, the kernel CLI."""
    # Imported here: the phase table is the cycle module, and docs_ssot's other renders need none of it.
    from .cycle import CYCLE_PHASES

    roots = {(path_of[p.runner.__module__], p.runner.__name__): (0, f"cycle phase {p.name}") for p in CYCLE_PHASES}
    scanned = set(path_of.values())
    for workflow in sorted((repo_root / ".github" / "workflows").glob("*.yml")):
        for script, module in _WORKFLOW_SCRIPT.findall(workflow.read_text(encoding="utf-8")):
            path = script or path_of.get(module)
            if path in scanned:  # a workflow step naming a module outside the scan roots reaches nothing here
                roots.setdefault((path, MODULE_SCOPE), (1, f"workflow {workflow.name}"))
                roots.setdefault((path, "main"), (1, f"workflow {workflow.name}"))
    roots.setdefault(_CLI, (2, "cli aria_kernel"))
    return roots


def _reached_from(owner: tuple[str, str], referrers: dict, roots: dict) -> str | None:
    """The entry points at the shallowest reference depth above ``owner``, best rank first; None if none."""
    seen, frontier = {owner}, [owner]
    while frontier:
        hits = sorted(roots[node] for node in frontier if node in roots)
        if hits:
            return "; ".join(dict.fromkeys(label for _, label in hits))
        frontier = sorted({ref for node in frontier for ref in referrers.get(node, ()) if ref not in seen})
        seen.update(frontier)
    return None


def render_atlas(atlas: dict[str, Any]) -> str:
    def cell(values: list[str] | str | None) -> str:
        if not values:
            return "—"
        return "<br>".join(f"`{v}`" for v in ([values] if isinstance(values, str) else values))

    lines = [
        "<!-- GENERATED FILE — do not edit by hand. Generator: aria-kernel/aria_kernel/ownership_atlas.py -->",
        "",
        "# ARIA ownership atlas",
        "",
        "One row per concept family (PLAN-v2 Faz 0.9, F0.9b). The owner, the plan package and the finding are",
        "declared in `ownership_atlas.FAMILIES`; writers (ledger writes and computer definitions), ledgers, callers",
        "and liveness (reached from a cycle phase, a workflow-run script or the kernel CLI) are computed from code;",
        "ledgers read are the declared surfaces the owner's module reads.",
        "A family with no finding has one owner today and `tests/invariants/test_atlas_one_owner.py` keeps it so.",
        "",
        "| Family | Subsystem | Owner | Writers | Ledgers written | Ledgers read | Callers | Liveness | Package | Finding |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for family_id, f in sorted(atlas["families"].items()):
        liveness = f["liveness"] + (f" via {f['liveness_via']}" if f["liveness_via"] else "")
        lines.append(" | ".join([
            f"| {family_id}", f["subsystem"], cell(f["owner"]), cell(f["writers"]), cell(f["ledgers_written"]),
            cell(f["ledgers_read"]), cell(f["callers"]), liveness, f["plan_package"] or "—", f["finding"] or "—",
        ]) + " |")
    lines += [
        "",
        "## Provenance",
        "",
        "Which ledgers' rows cite which, read from the code that builds each row (`ownership_atlas.ROW_SCOPES`). The",
        "citation vocabulary and the learned memory kinds are declared once in `row_provenance`; a ledger's own id",
        "field is not a citation. Keys are read at scope granularity: a scope that writes two ledgers (as",
        "`emit_change_planned` also writes a governance row) attributes its keys to both.",
        "",
        "| Ledger | Row built at | Cites | Learned kind (source fields) |",
        "|---|---|---|---|",
    ]
    for surface, entry in sorted(atlas["provenance"].items()):
        cites = "<br>".join(f"`{field}` → `{cited}`" for field, cited in sorted(entry["cites"].items())) or "—"
        learned = f"`{entry['kind']}` ({', '.join(f'`{source}`' for source in entry['sources'])})" if entry["kind"] else "—"
        lines.append(f"| {surface} | {cell(entry['row_scopes'])} | {cites} | {learned} |")
    lines += ["", "---", "", f"Regenerate: `{REGEN_COMMAND}`", "",
              "Pinned byte-for-byte by `aria-kernel/tests/test_ownership_atlas_ssot.py`."]
    return "\n".join(lines) + "\n"
