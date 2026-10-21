"""ARIA-CRITICAL-216 + ARIA-HIGH-238 — every function that takes an operator
approval reference, classified and pinned.

THE POPULATION is decided from the code, not from a list someone remembers:
every kernel function with a parameter named like an approval reference
(``APPROVAL_PARAMETER``) plus every function that calls one of the two
verifiers. ``APPROVAL_FUNCTIONS`` must name that population exactly. A new
parameter, a new verifier call or a vanished function fails here until it is
classified — that is how ARIA-HIGH-238 found 25 modules accepting a free
string the old pin (verifier call sites only) never saw.

THE CLASSES, each with one rule checked from the AST:

* RAISING — success widens what ARIA may do. It calls
  ``verify_operator_approval`` naming exactly its literal surfaces (a GitHub
  act of a listed operator, scoped, consumed once), or hands its reference to
  a classified RAISING callee that does.
* RAISING|LOWERING — one entry point, both directions: as RAISING.
* PASS_THROUGH — hands the reference only to the named RAISING callee and
  verifies nothing itself.
* RECORD — calls ``verify_recorded_reference`` with exactly its literal
  ``RECORD_SURFACES``: a decision that grants no authority.
* LOWERING — narrows authority; a reason on the record is enough.
* PROVENANCE — the reference is written as context and nothing reads it as
  authority; each entry says why. Neither LOWERING nor PROVENANCE verifies or
  calls a RAISING function (``lowering_violations``): one that does raises.
* INTERNAL — a private helper with no call site outside the named callers.
* PANEL — the authority is a panel adjudication the kernel resolves itself.
* INERT — no production call site at all. The first caller fails the pin and
  forces a real class with a real surface; designing a scope for a door
  nobody uses would freeze a contract with no caller.
* OWNED_ELSEWHERE — another open finding owns the fix. The entry lapses when
  that finding leaves OPEN/IN-PROGRESS: the pin then fails and forces a class.

``UNVERIFIED_UNTIL`` names RAISING entries whose verification lands in a later
slice of ARIA-HIGH-238. Each is a strict expected failure: the pin fails the
moment the function verifies (drop the entry), the moment its surface is
declared without a verifier, and when the finding closes with it still listed.

P5 is the build-time gate for the event kinds that record a raise: each is
written only inside a RAISING function, so a future raise that asks for
nothing cannot write the event without failing CI.
"""
from __future__ import annotations

import ast
import os
import re
import shutil
import tempfile
import unittest
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aria_kernel
from aria_kernel.circuit_breaker import BREAKER_EVIDENCE_QUARANTINED_EVENT, BREAKER_RESET_EVENT
from aria_kernel.control import CONTROL_RECORDED_EVENT
from aria_kernel.cost_budget import COST_BREAKER_RESET_EVENT
from aria_kernel.mcp_client import MCP_RELEASED_EVENT, QUARANTINE_SURFACE, RELEASE_ROW_EVENT
from aria_kernel.operator_approval import AUTHORITY_RAISING_SURFACES, RECORD_SURFACES
from aria_kernel.report_ingestion import read_registry_view
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from tests._helpers.operator_acts import github_operator_acts, operator_set_profile

KERNEL = Path(aria_kernel.__file__).resolve().parent
REPO = KERNEL.parents[1]

GITHUB_VERIFIER = "verify_operator_approval"
RECORDED_VERIFIER = "verify_recorded_reference"
VERIFIERS = frozenset({GITHUB_VERIFIER, RECORDED_VERIFIER})
PANEL_RESOLVERS = frozenset({"resolve_panel_approval", "resolve_panel_adjudication_proof"})
GOVERNANCE_WRITERS = frozenset({"append_tools_governance", "append_tools_governance_once"})
DECLARED_WRITERS = frozenset({"append_declared_jsonl"})
OPEN_STATES = frozenset({"OPEN", "IN-PROGRESS"})

# The vocabulary: a parameter that carries an approval reference.
APPROVAL_PARAMETER = re.compile(r"^(operator_ref|.*approval(_ledger)?_ref)$")


@dataclass(frozen=True)
class Klass:
    kind: str
    surfaces: frozenset[str] = frozenset()
    callee: str = ""  # module.function the reference is handed to (RAISING via, PASS_THROUGH)
    parameter: str = ""  # the parameter PASS_THROUGH hands on
    callers: frozenset[str] = frozenset()  # INTERNAL: the only module.function call sites
    finding: str = ""  # OWNED_ELSEWHERE
    why: str = ""


def raising(*surfaces: str) -> Klass:
    return Klass("RAISING", surfaces=frozenset(surfaces))


def raising_via(callee: str) -> Klass:
    return Klass("RAISING", callee=callee)


def raising_or_lowering(*surfaces: str) -> Klass:
    return Klass("RAISING|LOWERING", surfaces=frozenset(surfaces))


def pass_through(parameter: str, callee: str) -> Klass:
    return Klass("PASS_THROUGH", callee=callee, parameter=parameter)


def record(*surfaces: str) -> Klass:
    return Klass("RECORD", surfaces=frozenset(surfaces))


def lowering(why: str) -> Klass:
    return Klass("LOWERING", why=why)


def provenance(why: str) -> Klass:
    return Klass("PROVENANCE", why=why)


def internal(*callers: str) -> Klass:
    return Klass("INTERNAL", callers=frozenset(callers))


def panel(why: str) -> Klass:
    return Klass("PANEL", why=why)


def inert(why: str) -> Klass:
    return Klass("INERT", why=why)


def owned_elsewhere(finding: str, why: str) -> Klass:
    return Klass("OWNED_ELSEWHERE", finding=finding, why=why)


RAISING_KINDS = frozenset({"RAISING", "RAISING|LOWERING"})

APPROVAL_FUNCTIONS: dict[tuple[str, str], Klass] = {
    # --- RAISING: a GitHub act of a listed operator, bound to the grant ----------
    ("runtime_profile", "set_merge_lane_grant"): raising("merge_lane_grant"),
    ("self_merge_freeze", "unfreeze_self_merge"): raising("self_merge_unfreeze"),
    ("tool_registry", "resolve_transition_approval"): raising("tool_promote", "tool_unquarantine"),
    ("policy_approval", "record_policy_approval"): raising("l3_policy_approval"),
    ("circuit_breaker", "reset_breaker"): raising("breaker_reset"),
    ("circuit_breaker", "quarantine_breaker_evidence"): raising("breaker_evidence_quarantine"),
    ("cost_budget", "reset_breaker"): raising("breaker_reset"),
    ("mcp_client", "release_quarantine"): raising("mcp_unquarantine"),
    ("tool_registry", "transition_tool"): raising_via("tool_registry.resolve_transition_approval"),
    ("tool_registry", "unquarantine_tool"): raising_via("tool_registry.transition_tool"),
    ("agent_genesis", "approve_agent_pr"): raising("genesis_pr_approval"),
    ("skill_genesis", "approve_skill_pr"): raising("genesis_pr_approval"),
    # A transition that widens the recorded grant raises; frozen, observe, a
    # lower ceiling or a lane inside its ceiling lowers. `resume` with a
    # standing pause raises; `pause` and `cancel` lower.
    ("runtime_profile", "set_profile"): raising_or_lowering("runtime_profile"),
    ("control", "record_control"): raising_or_lowering("control_resume"),
    # --- PASS_THROUGH ----------------------------------------------------------
    ("promotion", "promote_tool"): pass_through("operator_approval_ref", "tool_registry.transition_tool"),
    # --- RECORD: attests a decision that grants no authority ---------------------
    ("finding_promotion", "promote_consensus_findings"): record("consensus_finding_promotion"),
    ("memory_gap", "record_surface_reset"): record("surface_reset"),
    ("runtime_artifacts", "approve_runtime_v2_promotion"): record("runtime_v2_promotion"),
    ("knowledge_graph", "record_anti_pattern"): record("knowledge_graph_anti_pattern"),
    # --- LOWERING: a reason is enough --------------------------------------------
    ("runtime_profile", "revoke_merge_lane_grant"): lowering("removes the merge lane grant"),
    ("self_merge_freeze", "freeze_self_merge"): lowering("stops ARIA merging until an operator unfreezes"),
    ("promotion_veto", "veto_promotion"): lowering("cancels an armed panel promotion inside its veto window"),
    ("skill_curator", "rollback_skill_materialization"): lowering("removes a materialized skill"),
    ("ack_ledger", "revoke_key"): lowering(
        "drops a compromised ack key from the verifying set; every row it signed verifies as "
        "signed_key_revoked (ARIA-LOW-598)"),
    # --- PROVENANCE: written as context, read by nothing as authority -------------
    # The ack key: since ARIA-MEDIUM-254 (b9b77d107) an operator ack is the
    # operator's ssh-signed ADR-0023 act and the kernel's HMAC key signs only
    # the kernel's own autonomous ack rows, so minting or rotating that key
    # raises no authority. (ARIA-HIGH-414 resolved too:
    # genesis_adapter_custody.verify_genesis_promotion now takes the RESOLVED
    # approval record, not a reference, and left the population.)
    ("ack_ledger", "init_ack_ledger"): provenance(
        "mints the kernel's own HMAC key (autonomous ack rows only); the ref is audit context on the governance row"),
    ("ack_ledger", "rotate_key"): provenance(
        "rotates the kernel's own HMAC key (autonomous ack rows only); the ref is audit context on the governance row"),
    ("agent_eval", "run_agent_eval"): provenance("the refs are written into the eval record; an eval grants nothing"),
    ("agent_eval", "_validate_real_eval_provenance"): provenance(
        "checks the shape of a real-eval ledger reference; grants nothing"),
    ("agent_genesis", "record_draft_lifecycle_chain"): provenance(
        "recorded as operator_feedback_ref evidence; PR approval stays behind approve_agent_pr"),
    ("agent_genesis", "draft_agent_from_gap"): provenance("a draft is a proposal; the ref goes to the lifecycle record"),
    ("genesis_lifecycle", "record_transition"): provenance(
        "ACTIVE is gated by the kernel-computed superiority proof and two reviewers; the ref is only written"),
    ("skill_genesis", "sandbox_skill"): provenance("a sandbox run grants nothing; approve_skill_pr re-checks synthetic mode"),
    ("skill_curator", "decide_curation"): provenance(
        "a decision log read only by context_compiler; nothing materializes from an accepted row"),
    ("pressure", "record_weight_override"): provenance("reorders what ARIA looks at, never what it may do"),
    ("gateway.scheduler", "add_schedule"): provenance(
        "a schedule runs a kernel action under that action's own gates; the ref names who asked"),
    ("gateway.scheduler", "change_schedule"): provenance(
        "a schedule runs a kernel action under that action's own gates; the ref names who asked"),
    ("runtime_artifacts", "retention_apply"): provenance(
        "copies to .archive/ and appends artifact_archived, deleting nothing; the kernel archives cycle artifacts itself"),
    ("runtime_artifacts", "restore_artifact"): provenance("restores an archived copy; widens no authority"),
    ("runtime_artifacts", "rollback_retention"): provenance("undoes an archive move; widens no authority"),
    ("shadow_eval_bridge", "bridge_shadow_eval_from_invocation"): provenance(
        "SHADOW grants no authority; ACTIVE stays behind transition_tool"),
    # --- INTERNAL ------------------------------------------------------------------
    ("runtime_profile", "_transition_merge_lane_grant"): internal(
        "runtime_profile.set_merge_lane_grant", "runtime_profile.revoke_merge_lane_grant"),
    ("proposal", "_write_approval"): internal("proposal.approve_proposal", "proposal.record_machine_approval"),
    # --- PANEL ---------------------------------------------------------------------
    ("promotion_veto", "resolve_panel_approval"): panel("re-derives the panel adjudication for this tool"),
    ("promotion_veto", "record_pending_promotion"): panel("arms the veto window only on a resolved panel approval"),
    # --- INERT: no production caller -------------------------------------------------
    ("self_modification", "request_kernel_change"): inert("no production caller"),
    ("autonomous_host_lease", "release_lease"): inert("no production caller"),
    ("proposal", "approve_proposal"): inert("no production caller (its only writer of approval_source=operator)"),
    ("instinct_candidate", "promote_candidate"): inert("no production caller"),
    ("tool_registry", "update_tool"): inert("no production caller; tool_health writes through the internal primitive"),
    ("security.grant", "new_claims"): inert("no production caller"),
    ("agent_invocations", "_submit_legacy_invocation_result_internal"): inert("no production caller"),
}

# RAISING entries whose verification lands in a later slice of ARIA-HIGH-238.
UNVERIFIED_UNTIL: dict[tuple[str, str], str] = {
    ("control", "record_control"): "ARIA-HIGH-238",
    ("agent_genesis", "approve_agent_pr"): "ARIA-HIGH-238",
    ("skill_genesis", "approve_skill_pr"): "ARIA-HIGH-238",
}

# P5 — the writes that record an authority raise.
RAISING_GOVERNANCE_KINDS: frozenset[str] = frozenset({
    BREAKER_RESET_EVENT,
    COST_BREAKER_RESET_EVENT,
    BREAKER_EVIDENCE_QUARANTINED_EVENT,
    MCP_RELEASED_EVENT,
    CONTROL_RECORDED_EVENT,
})
RAISING_DECLARED_ROWS: frozenset[tuple[str, str]] = frozenset({(QUARANTINE_SURFACE, RELEASE_ROW_EVENT)})


# ----- the kernel, read once ------------------------------------------------------


@dataclass(frozen=True)
class Module:
    name: str
    tree: ast.Module
    parents: dict[ast.AST, ast.AST]
    constants: dict[str, str]
    imported: dict[str, tuple[str, str]]  # local name -> (module, name)


def _module_name(path: Path) -> str:
    parts = list(path.relative_to(KERNEL).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _resolve_from(module: str, node: ast.ImportFrom, *, is_package: bool) -> str:
    package = module.split(".") if is_package else module.split(".")[:-1]
    if node.level:
        package = package[: len(package) - (node.level - 1)] if node.level > 1 else package
    else:
        package = []
    target = (node.module or "").split(".") if node.module else []
    if not node.level and target[:1] == ["aria_kernel"]:
        target = target[1:]
    return ".".join([*package, *target])


def parse_module(name: str, source: str, *, is_package: bool = False) -> Module:
    tree = ast.parse(source)
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    constants: dict[str, str] = {}
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        value = getattr(node, "value", None)
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            for target in targets:
                if isinstance(target, ast.Name):
                    constants[target.id] = value.value
    imported: dict[str, tuple[str, str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            source_module = _resolve_from(name, node, is_package=is_package)
            for alias in node.names:
                imported[alias.asname or alias.name] = (source_module, alias.name)
    return Module(name, tree, parents, constants, imported)


def load_kernel() -> dict[str, Module]:
    return {
        _module_name(path): parse_module(
            _module_name(path), path.read_text(encoding="utf-8"), is_package=path.name == "__init__.py",
        )
        for path in sorted(KERNEL.rglob("*.py"))
    }


MODULES = load_kernel()


def _functions(module: Module) -> Iterator[ast.FunctionDef | ast.AsyncFunctionDef]:
    for node in ast.walk(module.tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


def _function(
    key: tuple[str, str], modules: dict[str, Module] = MODULES,
) -> ast.FunctionDef | ast.AsyncFunctionDef:
    module, name = key
    found = [f for f in _functions(modules[module]) if f.name == name]
    if len(found) != 1:
        raise AssertionError(f"{module}.{name}: {len(found)} definitions")
    return found[0]


def _parameters(function: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    arguments = function.args
    return [a.arg for a in (*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs)]


def _call_name(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _calls(node: ast.AST) -> Iterator[ast.Call]:
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            yield child


def _verifier_surfaces(function: ast.AST) -> dict[str, frozenset[str]]:
    """verifier -> every string literal under its ``surface=`` keyword."""
    found: dict[str, set[str]] = {}
    for call in _calls(function):
        name = _call_name(call)
        if name not in VERIFIERS:
            continue
        literals = found.setdefault(name, set())
        for keyword in call.keywords:
            if keyword.arg == "surface":
                literals.update(
                    node.value for node in ast.walk(keyword.value)
                    if isinstance(node, ast.Constant) and isinstance(node.value, str)
                )
    return {name: frozenset(values) for name, values in found.items()}


def _hands_on(function: ast.AST, parameter: str) -> set[str]:
    """Names of the callees whose arguments carry ``parameter``."""
    callees: set[str] = set()
    for call in _calls(function):
        arguments = [*call.args, *(keyword.value for keyword in call.keywords)]
        if any(isinstance(node, ast.Name) and node.id == parameter for arg in arguments for node in ast.walk(arg)):
            name = _call_name(call)
            if name is not None:
                callees.add(name)
    return callees


def population(modules: dict[str, Module]) -> set[tuple[str, str]]:
    """Every function with an approval parameter, plus every verifier caller."""
    found: set[tuple[str, str]] = set()
    for module in modules.values():
        if module.name == "operator_approval":
            continue
        for function in _functions(module):
            if any(APPROVAL_PARAMETER.match(p) for p in _parameters(function)) or _verifier_surfaces(function):
                found.add((module.name, function.name))
    return found


def _resolve_string(module: Module, node: ast.AST, modules: dict[str, Module]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in module.constants:
            return module.constants[node.id]
        origin = module.imported.get(node.id)
        if origin is not None and origin[0] in modules:
            return modules[origin[0]].constants.get(origin[1])
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
        origin = module.imported.get(node.value.id)
        if origin is not None:
            target = ".".join(part for part in origin if part)
            if target in modules:
                return modules[target].constants.get(node.attr)
    return None


def _enclosing(module: Module, node: ast.AST) -> list[str]:
    names: list[str] = []
    current = module.parents.get(node)
    while current is not None:
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.append(current.name)
        current = module.parents.get(current)
    return names


def raising_writes(modules: dict[str, Module]) -> list[tuple[str, tuple[str, ...], str]]:
    """(module, enclosing functions inner->outer, what) for every raising write."""
    writes: list[tuple[str, tuple[str, ...], str]] = []
    for module in modules.values():
        for call in _calls(module.tree):
            name = _call_name(call)
            if name in GOVERNANCE_WRITERS:
                kind_node = call.args[1] if len(call.args) > 1 else next(
                    (k.value for k in call.keywords if k.arg == "kind"), None)
                kind = _resolve_string(module, kind_node, modules) if kind_node is not None else None
                if kind in RAISING_GOVERNANCE_KINDS:
                    writes.append((module.name, tuple(_enclosing(module, call)), kind))
            elif name in DECLARED_WRITERS and len(call.args) > 1 and isinstance(call.args[1], ast.Dict):
                surface_node = next((k.value for k in call.keywords if k.arg == "expected_surface"), None)
                surface = _resolve_string(module, surface_node, modules) if surface_node is not None else None
                for key, value in zip(call.args[1].keys, call.args[1].values):
                    if isinstance(key, ast.Constant) and key.value == "event":
                        event = _resolve_string(module, value, modules)
                        if surface is not None and event is not None and (surface, event) in RAISING_DECLARED_ROWS:
                            writes.append((module.name, tuple(_enclosing(module, call)), f"{surface}:{event}"))
    return writes


def raising_write_violations(
    modules: dict[str, Module], classification: dict[tuple[str, str], Klass],
) -> list[str]:
    violations = []
    for module, enclosing, what in raising_writes(modules):
        if not any(classification.get((module, name), Klass("")).kind in RAISING_KINDS for name in enclosing):
            where = f"{module}.{enclosing[0]}" if enclosing else f"{module} (module level)"
            violations.append(f"{where} writes {what}")
    return violations


def lowering_violations(
    modules: dict[str, Module], classification: dict[tuple[str, str], Klass],
) -> list[str]:
    """P2 for LOWERING and PROVENANCE: neither calls a RAISING function.

    A call to one raises authority (verified inside the callee), so the class
    would no longer say what the function does. Callees match by name, which
    over-approximates (a same-named function elsewhere counts too); the remedy
    is the same either way: reclassify, or rename.
    """
    raising_names = {name for (_module, name), klass in classification.items() if klass.kind in RAISING_KINDS}
    violations: list[str] = []
    for key, klass in classification.items():
        if klass.kind not in {"LOWERING", "PROVENANCE"}:
            continue
        called = {_call_name(call) for call in _calls(_function(key, modules))}
        violations.extend(f"{_qualified(key)} calls RAISING {name}" for name in sorted(called & raising_names))
    return violations


def _production_call_sites(name: str) -> list[str]:
    sites: list[str] = []
    for module in MODULES.values():
        for call in _calls(module.tree):
            if _call_name(call) == name:
                sites.append(f"aria_kernel/{module.name}:{call.lineno}")
    for root in ("tools", "scripts"):
        for path in sorted((REPO / root).rglob("*.py")):
            if "node_modules" in path.parts:
                continue
            for call in _calls(ast.parse(path.read_text(encoding="utf-8"))):
                if _call_name(call) == name:
                    sites.append(f"{path.relative_to(REPO)}:{call.lineno}")
    word = re.compile(rf"\b{re.escape(name)}\b")
    for path in sorted([*(REPO / ".github" / "workflows").glob("*.yml"), *(REPO / ".github" / "actions").rglob("*.yml")]):
        if word.search(path.read_text(encoding="utf-8")):
            sites.append(str(path.relative_to(REPO)))
    return sites


def _registry_states() -> dict[str, str]:
    return {str(row.get("id")): str(row.get("state")) for row in read_registry_view(REPO).rows}


def _function_name(qualified: str) -> str:
    return qualified.rsplit(".", 1)[1]


def _qualified(key: tuple[str, str]) -> str:
    return f"{key[0]}.{key[1]}"


class CallerClassificationTests(unittest.TestCase):
    def test_every_approval_function_is_classified(self) -> None:
        """P1 — the table is the population: nothing unclassified, nothing stale."""
        found = population(MODULES)
        self.assertEqual(sorted(found - set(APPROVAL_FUNCTIONS)), [], "classify these in APPROVAL_FUNCTIONS")
        defined = {(module.name, f.name) for module in MODULES.values() for f in _functions(module)}
        stale = [
            key for key in set(APPROVAL_FUNCTIONS) - found
            if key not in defined or APPROVAL_FUNCTIONS[key].kind != "LOWERING"
        ]
        self.assertEqual(sorted(stale), [], "stale entries (gone, or outside the population and not a pinned LOWERING)")

    def test_raising_functions_verify_their_surface(self) -> None:
        """P2 — RAISING asks GitHub for exactly its surfaces, or hands the ref to one that does."""
        for key, klass in APPROVAL_FUNCTIONS.items():
            if klass.kind not in RAISING_KINDS or key in UNVERIFIED_UNTIL:
                continue
            with self.subTest(function=_qualified(key)):
                function = _function(key)
                verifiers = _verifier_surfaces(function)
                self.assertNotIn(RECORDED_VERIFIER, verifiers)
                if klass.callee:
                    callee = tuple(klass.callee.rsplit(".", 1))
                    self.assertIn(APPROVAL_FUNCTIONS[callee].kind, RAISING_KINDS)
                    self.assertIn(_function_name(klass.callee), _hands_on(function, "operator_approval_ref"))
                else:
                    self.assertEqual(verifiers.get(GITHUB_VERIFIER), klass.surfaces)
                    self.assertLessEqual(klass.surfaces, set(AUTHORITY_RAISING_SURFACES))

    def test_every_other_class_keeps_its_rule(self) -> None:
        """P2 — PASS_THROUGH, RECORD, LOWERING, PROVENANCE, INTERNAL, PANEL."""
        lowering = lowering_violations(MODULES, APPROVAL_FUNCTIONS)
        for key, klass in APPROVAL_FUNCTIONS.items():
            with self.subTest(function=_qualified(key), kind=klass.kind):
                function = _function(key)
                verifiers = _verifier_surfaces(function)
                if klass.kind == "PASS_THROUGH":
                    self.assertEqual(verifiers, {})
                    self.assertEqual(_hands_on(function, klass.parameter), {_function_name(klass.callee)})
                    self.assertIn(APPROVAL_FUNCTIONS[tuple(klass.callee.rsplit(".", 1))].kind, RAISING_KINDS)
                elif klass.kind == "RECORD":
                    self.assertEqual(verifiers, {RECORDED_VERIFIER: klass.surfaces})
                    self.assertLessEqual(klass.surfaces, RECORD_SURFACES)
                elif klass.kind in {"LOWERING", "PROVENANCE"}:
                    self.assertEqual(verifiers, {})
                    self.assertTrue(klass.why)
                    # Main's pin refused the resolver here; any RAISING callee is refused now.
                    self.assertEqual([v for v in lowering if v.startswith(f"{_qualified(key)} ")], [])
                elif klass.kind == "INTERNAL":
                    sites = {
                        f"{module.name}.{(_enclosing(module, call) or ['<module>'])[0]}"
                        for module in MODULES.values() for call in _calls(module.tree)
                        if _call_name(call) == key[1]
                    }
                    self.assertTrue(sites)
                    self.assertLessEqual(sites, set(klass.callers))
                elif klass.kind == "PANEL":
                    self.assertTrue({_call_name(call) for call in _calls(function)} & PANEL_RESOLVERS)

    def test_inert_functions_have_no_production_caller(self) -> None:
        """P3 — the first production caller forces a real class."""
        for key, klass in APPROVAL_FUNCTIONS.items():
            if klass.kind == "INERT":
                with self.subTest(function=_qualified(key)):
                    self.assertEqual(_production_call_sites(key[1]), [])

    def test_owned_elsewhere_ids_are_open(self) -> None:
        """P4 — an entry lapses with the finding that owns it."""
        states = _registry_states()
        for key, klass in APPROVAL_FUNCTIONS.items():
            if klass.kind == "OWNED_ELSEWHERE":
                with self.subTest(function=_qualified(key), finding=klass.finding):
                    self.assertIn(states.get(klass.finding), OPEN_STATES)

    def test_unverified_raising_entries_are_strict_expected_failures(self) -> None:
        """A RAISING entry still waiting for its slice may not verify, declare, or outlive its finding."""
        states = _registry_states()
        for key, finding in UNVERIFIED_UNTIL.items():
            klass = APPROVAL_FUNCTIONS[key]
            with self.subTest(function=_qualified(key)):
                self.assertIn(klass.kind, RAISING_KINDS)
                self.assertEqual(_verifier_surfaces(_function(key)), {}, "it verifies now: drop it from UNVERIFIED_UNTIL")
                self.assertFalse(klass.surfaces & set(AUTHORITY_RAISING_SURFACES), "surface declared, no verifier")
                self.assertIn(states.get(finding), OPEN_STATES, f"{finding} closed with the entry still unverified")

    def test_the_surface_sets_are_exactly_the_classified_surfaces(self) -> None:
        raising_surfaces = set().union(*(
            klass.surfaces for key, klass in APPROVAL_FUNCTIONS.items()
            if klass.kind in RAISING_KINDS and key not in UNVERIFIED_UNTIL
        ))
        record_surfaces = set().union(*(k.surfaces for k in APPROVAL_FUNCTIONS.values() if k.kind == "RECORD"))
        self.assertEqual(raising_surfaces, set(AUTHORITY_RAISING_SURFACES))
        self.assertEqual(record_surfaces, set(RECORD_SURFACES))

    def test_raising_event_kinds_written_only_by_raising_functions(self) -> None:
        """P5 — and every raising kind still has its writer (a renamed constant is not a pass)."""
        self.assertEqual(raising_write_violations(MODULES, APPROVAL_FUNCTIONS), [])
        written = {what for _module, _enclosing, what in raising_writes(MODULES)}
        expected = set(RAISING_GOVERNANCE_KINDS) | {f"{s}:{e}" for s, e in RAISING_DECLARED_ROWS}
        self.assertEqual(written, expected)

    def test_the_raising_write_detector_catches_an_unclassified_writer(self) -> None:
        """P5's detector, on a module that clears the breaker without asking anyone."""
        source = (
            "from .tool_registry import append_tools_governance\n"
            "from .circuit_breaker import BREAKER_RESET_EVENT\n"
            "def quiet_reset(root):\n"
            "    append_tools_governance(root, BREAKER_RESET_EVENT, {})\n"
            "def quiet_release(root, path):\n"
            "    append_declared_jsonl(path, {'event': 'released'}, expected_surface='mcp_quarantine')\n"
        )
        modules = {**MODULES, "rogue": parse_module("rogue", source)}
        self.assertEqual(
            raising_write_violations(modules, APPROVAL_FUNCTIONS),
            [f"rogue.quiet_reset writes {BREAKER_RESET_EVENT}", "rogue.quiet_release writes mcp_quarantine:released"],
        )

    def test_the_lowering_rule_catches_a_lowering_function_that_reaches_a_raising_callee(self) -> None:
        """P2's LOWERING/PROVENANCE rule, on functions whose class no longer says what they do.

        A freeze that also promotes a tool through the resolver raises; so does a
        provenance writer that hands its ref to ``transition_tool``. The authority
        is still verified inside the callee, but the table would call them
        narrowing, so the pin refuses them until they are reclassified.
        """
        source = (
            "from .tool_registry import resolve_transition_approval, transition_tool\n"
            "def quiet_freeze(root, operator_approval_ref, reason):\n"
            "    resolve_transition_approval(root, operator_approval_ref)\n"
            "def quiet_note(root, operator_approval_ref):\n"
            "    transition_tool(root, operator_approval_ref=operator_approval_ref)\n"
            "def honest_freeze(root, operator_approval_ref, reason):\n"
            "    return reason\n"
        )
        modules = {**MODULES, "rogue": parse_module("rogue", source)}
        classification = {
            **APPROVAL_FUNCTIONS,
            ("rogue", "quiet_freeze"): lowering("stops something"),
            ("rogue", "quiet_note"): provenance("writes context"),
            ("rogue", "honest_freeze"): lowering("stops something"),
        }
        self.assertEqual(
            lowering_violations(modules, classification),
            ["rogue.quiet_freeze calls RAISING resolve_transition_approval",
             "rogue.quiet_note calls RAISING transition_tool"],
        )

    def test_the_legacy_verifier_is_gone(self) -> None:
        for path in sorted(KERNEL.rglob("*.py")):
            self.assertNotIn("verify_operator_approval_ref", path.read_text(encoding="utf-8"), msg=str(path))


class RaisingSurfacesRefuseRecordedReferences(unittest.TestCase):
    """Each RAISING entry point refuses a ref that ARIA itself could author."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-callers-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")
        event = append_tools_governance(self.tools, "operator_action", {"action": "approve"})
        doc = self._tmp / "review.md"
        doc.write_text("## OP-1\n", encoding="utf-8")
        os.environ["ARIA_TEST_ACK_216"] = "yes"
        self.addCleanup(os.environ.pop, "ARIA_TEST_ACK_216", None)
        self.refs = (f"gov:{event['event_id']}", f"review:{doc}#OP-1", "ack-env:ARIA_TEST_ACK_216")

    def _assert_refused(self, action) -> None:
        for ref in self.refs:
            with self.subTest(ref=ref), self.assertRaisesRegex(GovernanceError, "gh:<owner>/<repo>#<number>"):
                action(ref)

    def test_profile_raise(self) -> None:
        from aria_kernel.runtime_profile import set_profile

        self._assert_refused(lambda ref: set_profile("strict", operator_approval_ref=ref, base_dir=self.tools))
        self._assert_refused(lambda ref: set_profile(
            "standard", operator_approval_ref=ref, base_dir=self.tools, scheduler_ceiling="strict",
        ))

    def test_merge_lane_grant(self) -> None:
        from aria_kernel.runtime_profile import set_merge_lane_grant

        expires = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self._assert_refused(lambda ref: set_merge_lane_grant(
            lane="L1", expires_at=expires, operator_approval_ref=ref, base_dir=self.tools,
        ))

    def test_self_merge_unfreeze(self) -> None:
        from aria_kernel.self_merge_freeze import freeze_self_merge, unfreeze_self_merge

        row = freeze_self_merge(merge_sha="a" * 40, pr_number=1, trigger="test", evidence={}, base_dir=self.tools)
        self._assert_refused(lambda ref: unfreeze_self_merge(
            freeze_id=row["freeze_id"], operator_approval_ref=ref, base_dir=self.tools,
        ))

    def test_tool_promotion_and_unquarantine(self) -> None:
        from aria_kernel.tool_registry import resolve_transition_approval

        self._assert_refused(lambda ref: resolve_transition_approval(
            ref, tool_id="adapter-x", current_status="SHADOW", target_status="ACTIVE", base_dir=self.tools,
        ))
        self._assert_refused(lambda ref: resolve_transition_approval(
            ref, tool_id="adapter-x", current_status="QUARANTINED", target_status="CALIBRATE", base_dir=self.tools,
        ))

    def test_l3_policy_approval(self) -> None:
        from aria_kernel.policy_approval import record_policy_approval

        self._assert_refused(lambda ref: record_policy_approval({
            "approval_id": "a-1", "stage": "risk_owner", "pr_number": 5, "head_sha": "b" * 40,
            "policy_hash": "sha256:" + "c" * 64, "expires_at": "2099-01-01T00:00:00Z",
            "operator_approval_ref": ref,
        }, base_dir=self.tools))

    def test_breaker_resets_and_evidence_quarantine(self) -> None:
        from aria_kernel import circuit_breaker, cost_budget

        for index in range(3):
            circuit_breaker.record_failure(base_dir=self.tools, kind="ci_red", materialize_event_id=f"EV-{index}")
        cost_budget._trip_breaker(self.tools, cap_name="daily", amount=6.0, cap=5.0)
        with circuit_breaker._failures_path(self.tools).open("a", encoding="utf-8") as ledger:
            ledger.write('{"ts":"2020-01\n')
        self._assert_refused(lambda ref: circuit_breaker.quarantine_breaker_evidence(
            base_dir=self.tools, operator_approval_ref=ref, reason="damaged row",
        ))
        self._assert_refused(lambda ref: circuit_breaker.reset_breaker(
            base_dir=self.tools, operator_approval_ref=ref, reason="investigated",
        ))
        self._assert_refused(lambda ref: cost_budget.reset_breaker(
            base_dir=self.tools, operator_approval_ref=ref, reason="caps adjusted",
        ))

    def test_mcp_release(self) -> None:
        from aria_kernel import mcp_client

        # Only the kernel's own side=server outcomes quarantine (ARIA-MEDIUM-609),
        # and a caller-caused fault class never counts.
        for _ in range(mcp_client.QUARANTINE_MIN_CALLS):
            mcp_client.record_mcp_call(tool_name="aria/search", ok=False, side="server",
                                       error_class="RuntimeError", base_dir=self.tools)
        self.assertIn("aria", mcp_client.quarantined_servers(self.tools))
        self._assert_refused(lambda ref: mcp_client.release_quarantine("aria", base_dir=self.tools, operator_ref=ref))


class LoweringSurfacesTakeAReason(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-opa-lower-"))
        self.addCleanup(lambda: shutil.rmtree(self._tmp, ignore_errors=True))
        self.tools = ensure_tools_dir(self._tmp / "aria-tools")

    def test_lowering_needs_no_github_act(self) -> None:
        from aria_kernel.runtime_profile import (
            get_profile,
            get_scheduler_profile_ceiling,
            revoke_merge_lane_grant,
            set_profile,
        )
        from aria_kernel.self_merge_freeze import active_freeze, freeze_self_merge

        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        with github_operator_acts() as github:
            set_profile("frozen", operator_approval_ref="incident: stop everything", base_dir=self.tools)
            set_profile("observe", operator_approval_ref="incident: watch only", base_dir=self.tools)
            set_profile(
                "observe", operator_approval_ref="incident: lower the grant",
                base_dir=self.tools, scheduler_ceiling="standard",
            )
            revoke_merge_lane_grant(operator_approval_ref="incident: no merges", base_dir=self.tools)
            freeze_self_merge(merge_sha="d" * 40, pr_number=3, trigger="test", evidence={}, base_dir=self.tools)
            self.assertEqual(github.reads, [])
        self.assertEqual(get_profile(base_dir=self.tools), "observe")
        self.assertEqual(get_scheduler_profile_ceiling(base_dir=self.tools), "standard")
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_a_lane_inside_the_recorded_ceiling_needs_no_github_act(self) -> None:
        from aria_kernel.runtime_profile import get_profile, set_profile

        operator_set_profile("standard", base_dir=self.tools, scheduler_ceiling="strict")
        set_profile("frozen", operator_approval_ref="incident", base_dir=self.tools)
        with github_operator_acts() as github:
            set_profile("strict", operator_approval_ref="cli-flag:nightly", base_dir=self.tools, set_by="autonomy-cli")
            self.assertEqual(github.reads, [])
        self.assertEqual(get_profile(base_dir=self.tools), "strict")


if __name__ == "__main__":
    unittest.main()
