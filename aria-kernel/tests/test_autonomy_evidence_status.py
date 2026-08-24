"""Target-bound, read-only ARIA autonomy evidence status."""
from __future__ import annotations

import ast
import hashlib
import json
import os
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
import subprocess
import tempfile
from types import MappingProxyType
from unittest import mock

import aria_kernel.autonomy_evidence as autonomy_evidence_module
import aria_kernel.knowledge_graph as knowledge_graph_module
import aria_kernel.ledger as ledger_module
import aria_kernel.state_manifest as state_manifest_module
import aria_kernel.state_snapshot as state_snapshot_module
import aria_kernel.state_store as state_store_module

from aria_kernel.autonomy_evidence import (
    CAPABILITY_AUTHORITY_PATHS,
    CAPABILITY_SPECS,
    AutonomyEvidenceStatus,
    CapabilitySpec,
    CapabilityEvidence,
    EvidenceContract,
    EvidenceRef,
    _capability_authority_hash,
    _apply_operator_prerequisites,
    _ancestry_blocker,
    _capability_safe_counts,
    _derive_capability_evidence,
    _evaluate_native_rows,
    _mode_a_signed_readiness_live_proven,
    derive_autonomy_evidence_status,
)
from aria_kernel.ledger import (
    LedgerIntegrityError,
    LedgerReadLimitError,
    append_declared_jsonl,
    verify_jsonl_chunks,
)
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreError,
    build_publishable_snapshot,
    checkout_state_store,
    publish_state,
    tools_root,
)
from aria_kernel.tool_registry import ensure_tools_binding
from aria_kernel.workspace import canonical_identity


EXPECTED_CAPABILITIES = (
    "cycle_runtime",
    "executor",
    "finding_funnel",
    "fixture_calibration",
    "pre_merge_perimeter",
    "enterprise_readiness",
    "autonomy_unlock",
)

KERNEL = "aria-kernel/aria_kernel/"
EXECUTOR_ACCEPTANCE_AUTHORITY = (
    f"{KERNEL}agent_surface.py",
    f"{KERNEL}genesis_lifecycle.py",
    f"{KERNEL}context_budget_gate.py",
    f"{KERNEL}runtime_profile.py",
    f"{KERNEL}agent_contract.py",
    f"{KERNEL}agent_compliance.py",
    f"{KERNEL}implementation_safety.py",
    f"{KERNEL}agent_genesis.py",
    f"{KERNEL}evidence_trust.py",
    f"{KERNEL}canonical_path.py",
    f"{KERNEL}tool_health.py",
    f"{KERNEL}ledger_refs.py",
    f"{KERNEL}planner_dispatch_hook.py",
)
EXPECTED_COMMON_AUTHORITY = (
    f"{KERNEL}autonomy_evidence.py",
    f"{KERNEL}contention_replay.py",
    f"{KERNEL}file_lock.py",
    f"{KERNEL}ledger.py",
    f"{KERNEL}state_manifest.py",
    f"{KERNEL}state_snapshot.py",
    f"{KERNEL}state_store.py",
    f"{KERNEL}tool_registry.py",
    f"{KERNEL}tools_binding.py",
    f"{KERNEL}workspace.py",
    "docs/aria/policy/autonomy-closure-findings.json",
)
EXPECTED_SPECIFIC_AUTHORITY = {
    "cycle_runtime": (
        f"{KERNEL}cycle.py",
        f"{KERNEL}autonomy_orchestrator.py",
        f"{KERNEL}autonomy_state.py",
        f"{KERNEL}burn_in.py",
        f"{KERNEL}runtime_artifacts.py",
        f"{KERNEL}trailer_scan.py",
        f"{KERNEL}tool_health.py",
        f"{KERNEL}upcasters/__init__.py",
        f"{KERNEL}upcasters/cycles.py",
        f"{KERNEL}state_manifest.py",
        ".github/workflows/aria-auto-cycle.yml",
    ),
    "executor": (
        f"{KERNEL}agent_invocations.py",
        *EXECUTOR_ACCEPTANCE_AUTHORITY,
        f"{KERNEL}agent_eval.py",
        f"{KERNEL}bridge_status_ledger.py",
        f"{KERNEL}circuit_breaker.py",
        f"{KERNEL}convergence_drainer.py",
        f"{KERNEL}evidence_validator.py",
        f"{KERNEL}plan_convergence.py",
        f"{KERNEL}state_manifest.py",
        "tools/aria-poc/dispatch_failure.py",
        "tools/aria-poc/claude_runtime.py",
        "tools/aria-poc/ci_executor.py",
        "tools/aria-poc/ci_executor_drain.py",
        "tools/aria-poc/worker_executor.py",
        ".github/workflows/aria-agent-executor.yml",
    ),
    "finding_funnel": (
        f"{KERNEL}calibration_bootstrap.py",
        f"{KERNEL}feedback_store.py",
        f"{KERNEL}finding_promotion.py",
        f"{KERNEL}funnel_health.py",
        f"{KERNEL}pr_tracking.py",
        f"{KERNEL}rule_health.py",
        f"{KERNEL}state_compact.py",
        f"{KERNEL}state_manifest.py",
        ".github/workflows/aria-auto-cycle.yml",
        ".github/workflows/aria-agent-executor.yml",
    ),
    "fixture_calibration": (
        f"{KERNEL}agent_genesis.py",
        f"{KERNEL}feedback_store.py",
        f"{KERNEL}fixture_runner.py",
        f"{KERNEL}genesis_lifecycle.py",
        f"{KERNEL}judge_calibration.py",
        f"{KERNEL}adapter_calibration.py",
        f"{KERNEL}readiness.py",
        f"{KERNEL}shadow_eval_bridge.py",
        f"{KERNEL}tool_registry.py",
        f"{KERNEL}state_manifest.py",
        ".github/workflows/aria-auto-cycle.yml",
        ".github/workflows/aria-agent-executor.yml",
    ),
    "pre_merge_perimeter": (
        f"{KERNEL}auto_merge.py",
        f"{KERNEL}pre_merge_evidence.py",
        f"{KERNEL}implementation_safety.py",
        f"{KERNEL}merge_authority.py",
        f"{KERNEL}plan_convergence.py",
        f"{KERNEL}file_claims.py",
        f"{KERNEL}operator_feedback_signature.py",
        f"{KERNEL}expert_review_gate.py",
        f"{KERNEL}plan_coverage.py",
        f"{KERNEL}budget.py",
        f"{KERNEL}cost_budget.py",
        f"{KERNEL}state_manifest.py",
        ".github/workflows/aria-merge-authority.yml",
    ),
    "enterprise_readiness": (
        f"{KERNEL}auto_merge_runners.py",
        f"{KERNEL}gh_token_factory.py",
        f"{KERNEL}readiness_schema.py",
        f"{KERNEL}readiness_proofs.py",
        f"{KERNEL}runtime_artifacts.py",
        f"{KERNEL}enterprise_readiness.py",
        f"{KERNEL}state_snapshot.py",
        f"{KERNEL}state_store.py",
        f"{KERNEL}rollback_bundle.py",
        f"{KERNEL}state_manifest.py",
        ".github/CODEOWNERS",
        ".github/actions/mint-aria-app-token/action.yml",
        ".github/workflows/aria-auto-cycle.yml",
        ".github/workflows/aria-agent-executor.yml",
        ".github/workflows/aria-agent-eval.yml",
        ".github/workflows/aria-readiness-claim.yml",
    ),
    "autonomy_unlock": (
        f"{KERNEL}acceptance_reconciler.py",
        f"{KERNEL}autonomy_unlock.py",
        f"{KERNEL}autonomy_ladder.py",
        f"{KERNEL}runtime_profile.py",
        f"{KERNEL}merge_authority.py",
        f"{KERNEL}rollback_bundle.py",
        f"{KERNEL}state_manifest.py",
        "docs/aria/policy/autonomy-unlock.json",
        ".github/workflows/aria-auto-cycle.yml",
    ),
}
EXPECTED_PRODUCERS = {
    "cycle_runtime": (
        f"{KERNEL}cycle.py", f"{KERNEL}autonomy_orchestrator.py",
        f"{KERNEL}autonomy_state.py", f"{KERNEL}burn_in.py",
        f"{KERNEL}tool_health.py",
        ".github/workflows/aria-auto-cycle.yml",
    ),
    "executor": (
        f"{KERNEL}agent_invocations.py", f"{KERNEL}tool_registry.py",
        "tools/aria-poc/dispatch_failure.py",
        "tools/aria-poc/claude_runtime.py", "tools/aria-poc/ci_executor.py",
        "tools/aria-poc/ci_executor_drain.py", "tools/aria-poc/worker_executor.py",
        ".github/workflows/aria-agent-executor.yml",
    ),
    "finding_funnel": (
        f"{KERNEL}calibration_bootstrap.py", f"{KERNEL}feedback_store.py",
        f"{KERNEL}finding_promotion.py", f"{KERNEL}pr_tracking.py",
        f"{KERNEL}rule_health.py", f"{KERNEL}state_compact.py",
        ".github/workflows/aria-auto-cycle.yml",
        ".github/workflows/aria-agent-executor.yml",
    ),
    "fixture_calibration": (
        f"{KERNEL}feedback_store.py", f"{KERNEL}fixture_runner.py",
        f"{KERNEL}judge_calibration.py",
        f"{KERNEL}adapter_calibration.py", ".github/workflows/aria-auto-cycle.yml",
        ".github/workflows/aria-agent-executor.yml",
    ),
    "pre_merge_perimeter": (
        f"{KERNEL}auto_merge.py", f"{KERNEL}pre_merge_evidence.py",
        f"{KERNEL}merge_authority.py",
        f"{KERNEL}plan_convergence.py",
        f"{KERNEL}file_claims.py", f"{KERNEL}operator_feedback_signature.py",
        f"{KERNEL}expert_review_gate.py", f"{KERNEL}plan_coverage.py",
        f"{KERNEL}budget.py", f"{KERNEL}cost_budget.py",
        ".github/workflows/aria-merge-authority.yml",
    ),
    "enterprise_readiness": (
        f"{KERNEL}gh_token_factory.py", f"{KERNEL}readiness_schema.py",
        f"{KERNEL}readiness_proofs.py", f"{KERNEL}enterprise_readiness.py",
        f"{KERNEL}state_snapshot.py", f"{KERNEL}rollback_bundle.py",
        ".github/actions/mint-aria-app-token/action.yml",
        ".github/workflows/aria-auto-cycle.yml",
        ".github/workflows/aria-agent-executor.yml",
        ".github/workflows/aria-agent-eval.yml",
        ".github/workflows/aria-readiness-claim.yml",
    ),
    "autonomy_unlock": (
        f"{KERNEL}acceptance_reconciler.py", f"{KERNEL}autonomy_unlock.py",
        f"{KERNEL}autonomy_ladder.py", f"{KERNEL}merge_authority.py",
        f"{KERNEL}rollback_bundle.py",
        ".github/workflows/aria-auto-cycle.yml",
    ),
}
EXPECTED_CONSUMERS = {
    "cycle_runtime": (
        f"{KERNEL}autonomy_state.py", f"{KERNEL}burn_in.py",
        f"{KERNEL}runtime_artifacts.py",
        f"{KERNEL}trailer_scan.py",
    ),
    "executor": (
        f"{KERNEL}agent_invocations.py", f"{KERNEL}agent_eval.py",
        f"{KERNEL}bridge_status_ledger.py", f"{KERNEL}circuit_breaker.py",
        f"{KERNEL}convergence_drainer.py", f"{KERNEL}evidence_validator.py",
        f"{KERNEL}genesis_lifecycle.py",
        f"{KERNEL}plan_convergence.py",
    ),
    "finding_funnel": (
        f"{KERNEL}finding_promotion.py", f"{KERNEL}funnel_health.py",
        f"{KERNEL}rule_health.py", f"{KERNEL}state_compact.py",
    ),
    "fixture_calibration": (
        f"{KERNEL}agent_genesis.py", f"{KERNEL}fixture_runner.py",
        f"{KERNEL}genesis_lifecycle.py",
        f"{KERNEL}readiness.py", f"{KERNEL}shadow_eval_bridge.py",
        f"{KERNEL}tool_registry.py",
    ),
    "pre_merge_perimeter": (
        f"{KERNEL}auto_merge.py", f"{KERNEL}implementation_safety.py",
        f"{KERNEL}merge_authority.py",
    ),
    "enterprise_readiness": (
        f"{KERNEL}auto_merge_runners.py", f"{KERNEL}readiness_proofs.py",
        f"{KERNEL}enterprise_readiness.py",
    ),
    "autonomy_unlock": (
        f"{KERNEL}autonomy_ladder.py", f"{KERNEL}autonomy_unlock.py",
        f"{KERNEL}runtime_profile.py", f"{KERNEL}merge_authority.py",
    ),
}


def _capability(
    state: str,
    *,
    blocker: str | None = None,
) -> CapabilityEvidence:
    return CapabilityEvidence(
        state=state,
        counts={"accepted": 1},
        blockers=(blocker,) if blocker else (),
        evidence_refs=(),
    )


def _python_function_scopes(tree: ast.Module) -> tuple[ast.AST, ...]:
    """Every Python function scope the authority-surface scanner must inspect."""
    return tuple(
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    )


def _python_import_aliases(tree: ast.Module, module_name: str) -> dict[str, str]:
    """Resolve import aliases used by the static authority-surface scanner."""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                aliases[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.ImportFrom):
            current = module_name.split(".")
            base = current[:-node.level] if node.level else []
            imported_parts = tuple(
                part for part in (node.module or "").split(".") if part
            )
            imported_module = ".".join((*base, *imported_parts))
            for alias in node.names:
                aliases[alias.asname or alias.name] = (
                    f"{imported_module}.{alias.name}"
                )
    return aliases


def _python_call_target(
    module_name: str,
    aliases: Mapping[str, str],
    function: ast.expr,
) -> str:
    """Return a stable qualified target for names and arbitrary attr chains."""
    if isinstance(function, ast.Name):
        return aliases.get(function.id, f"{module_name}.{function.id}")
    if isinstance(function, ast.Attribute):
        attributes = [function.attr]
        owner = function.value
        while isinstance(owner, ast.Attribute):
            attributes.append(owner.attr)
            owner = owner.value
        if isinstance(owner, ast.Name):
            root = aliases.get(owner.id, owner.id)
            return ".".join((root, *reversed(attributes)))
        return function.attr
    return ""


def _python_open_role(call: ast.AST) -> str | None:
    """Classify a literal ``open`` mode without executing source code.

    Pure read modes are consumers. Any mode that can mutate bytes is a
    producer only: treating ``r+`` as a reader would let a write-capable raw
    handle hide behind the consumer roster. Dynamic modes are deliberately
    unknown and therefore grant neither role.
    """
    if not isinstance(call, ast.Call):
        return None
    positional_mode_index: int | None = None
    if isinstance(call.func, ast.Attribute) and call.func.attr == "open":
        positional_mode_index = 0
    elif isinstance(call.func, ast.Name) and call.func.id == "open":
        positional_mode_index = 1
    if positional_mode_index is None:
        return None

    mode_node: ast.AST | None = next(
        (
            keyword.value
            for keyword in call.keywords
            if keyword.arg == "mode"
        ),
        None,
    )
    if mode_node is None and len(call.args) > positional_mode_index:
        mode_node = call.args[positional_mode_index]
    if mode_node is None:
        mode = "r"
    elif isinstance(mode_node, ast.Constant) and isinstance(mode_node.value, str):
        mode = mode_node.value
    else:
        return None

    if any(marker in mode for marker in ("w", "a", "x", "+")):
        return "producer"
    if mode.count("r") == 1 and set(mode) <= {"r", "b", "t"}:
        return "consumer"
    return None


def _python_open_path_expression(call: ast.Call) -> ast.expr | None:
    """Return the path operand for builtin ``open`` or ``Path.open``."""
    if isinstance(call.func, ast.Name) and call.func.id == "open":
        if call.args:
            return call.args[0]
        return next(
            (
                keyword.value
                for keyword in call.keywords
                if keyword.arg in {"file", "path"}
            ),
            None,
        )
    if isinstance(call.func, ast.Attribute) and call.func.attr == "open":
        if isinstance(call.func.value, ast.Name) and call.func.value.id == "builtins":
            return call.args[0] if call.args else None
        return call.func.value
    return None


def _module_function_definitions(
    tree: ast.Module,
    module_name: str,
) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """Top-level functions and class methods addressable by Python callsites."""
    definitions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
    function_types = (ast.FunctionDef, ast.AsyncFunctionDef)
    for node in tree.body:
        if isinstance(node, function_types):
            definitions[f"{module_name}.{node.name}"] = node
        elif isinstance(node, ast.ClassDef):
            for child in node.body:
                if isinstance(child, function_types):
                    definitions[f"{module_name}.{node.name}.{child.name}"] = child
    return definitions


class _PythonScanIndex:
    """Single-pass function/symbol index shared by every scanner phase."""

    def __init__(
        self,
        trees: Mapping[str, ast.Module],
        module_names: Mapping[str, str],
        *,
        node_budget: int = 2_000_000,
    ) -> None:
        self.scopes: dict[str, list[ast.FunctionDef | ast.AsyncFunctionDef]] = {
            relative: [] for relative in trees
        }
        self.nodes: dict[int, tuple[ast.AST, ...]] = {}
        self.targets: dict[int, str] = {}
        self.definitions: dict[
            str,
            tuple[
                str,
                ast.FunctionDef | ast.AsyncFunctionDef,
                tuple[ast.AST, ...],
            ],
        ] = {}
        visited = 0

        for relative, tree in trees.items():
            module_name = module_names[relative]
            scopes = self.scopes[relative]
            node_lists: dict[int, list[ast.AST]] = {}
            target_by_id: dict[int, str] = {}

            class Visitor(ast.NodeVisitor):
                def __init__(self) -> None:
                    self.current_function: int | None = None
                    self.class_names: list[str] = []

                def generic_visit(self, node: ast.AST) -> None:
                    nonlocal visited
                    visited += 1
                    if visited > node_budget:
                        raise AssertionError(
                            "surface_scanner_ast_index_node_budget_exceeded",
                        )
                    if self.current_function is not None:
                        node_lists[self.current_function].append(node)
                    super().generic_visit(node)

                def visit_ClassDef(self, node: ast.ClassDef) -> None:
                    nonlocal visited
                    visited += 1
                    if visited > node_budget:
                        raise AssertionError(
                            "surface_scanner_ast_index_node_budget_exceeded",
                        )
                    if self.current_function is not None:
                        node_lists[self.current_function].append(node)
                    self.class_names.append(node.name)
                    for child in ast.iter_child_nodes(node):
                        self.visit(child)
                    self.class_names.pop()

                def _visit_function(
                    self,
                    node: ast.FunctionDef | ast.AsyncFunctionDef,
                ) -> None:
                    nonlocal visited
                    visited += 1
                    if visited > node_budget:
                        raise AssertionError(
                            "surface_scanner_ast_index_node_budget_exceeded",
                        )
                    scopes.append(node)
                    owner = f"{self.class_names[-1]}." if self.class_names else ""
                    target = f"{module_name}.{owner}{node.name}"
                    target_by_id[id(node)] = target
                    node_lists[id(node)] = [node]
                    previous = self.current_function
                    self.current_function = id(node)
                    for child in ast.iter_child_nodes(node):
                        self.visit(child)
                    self.current_function = previous

                visit_FunctionDef = _visit_function
                visit_AsyncFunctionDef = _visit_function

            Visitor().visit(tree)
            for scope in scopes:
                nodes = tuple(node_lists[id(scope)])
                target = target_by_id[id(scope)]
                self.nodes[id(scope)] = nodes
                self.targets[id(scope)] = target
                self.definitions[target] = (relative, scope, nodes)
        self.visited_node_count = visited


def _literal_module_exports(tree: ast.Module) -> frozenset[str]:
    """Read a literal ``__all__`` without executing the authority module."""
    exports: list[str] = []
    for node in tree.body:
        value: ast.expr | None = None
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "__all__" for target in node.targets)
        ):
            value = node.value
        elif (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == "__all__"
        ):
            value = node.value
        if value is None:
            continue
        try:
            literal = ast.literal_eval(value)
        except (ValueError, TypeError, SyntaxError):
            continue
        if isinstance(literal, (list, tuple, set)):
            exports.extend(item for item in literal if isinstance(item, str))
    return frozenset(exports)


def _source_derived_ledger_readers(
    tree: ast.Module,
    module_name: str,
) -> tuple[frozenset[str], frozenset[str]]:
    """Classify exported read-only ledger APIs from their source call graph.

    The scanner intentionally derives this set from ``ledger.__all__`` and
    filesystem effects. A newly exported reader or ``StateTransaction`` load
    method therefore enters the closed world without updating an allowlist.
    """
    definitions = _module_function_definitions(tree, module_name)
    aliases = _python_import_aliases(tree, module_name)
    exports = _literal_module_exports(tree)
    read_sinks = frozenset({"read", "read_bytes", "read_text"})
    # ``datetime.replace`` is a common pure call in policy validation, so
    # mutating filesystem effects are pinned to byte/text write operations.
    write_sinks = frozenset({"write", "write_bytes", "write_text"})
    calls: dict[str, set[str]] = {}
    reads: dict[str, bool] = {}
    writes: dict[str, bool] = {}
    for target, function in definitions.items():
        owner = target.rsplit(".", 2)[-2] if target.count(".") > module_name.count(".") + 1 else None
        targets: set[str] = set()
        open_roles: set[str] = set()
        for call in (node for node in ast.walk(function) if isinstance(node, ast.Call)):
            open_role = _python_open_role(call)
            if open_role is not None:
                open_roles.add(open_role)
            if (
                owner is not None
                and isinstance(call.func, ast.Attribute)
                and isinstance(call.func.value, ast.Name)
                and call.func.value.id in {"self", "cls"}
            ):
                called = f"{module_name}.{owner}.{call.func.attr}"
            else:
                called = _python_call_target(module_name, aliases, call.func)
            if called:
                targets.add(called)
        calls[target] = targets
        leaves = {called.rsplit(".", 1)[-1] for called in targets}
        reads[target] = bool(leaves & read_sinks) or "consumer" in open_roles
        writes[target] = bool(leaves & write_sinks) or "producer" in open_roles

    changed = True
    while changed:
        changed = False
        for target, targets in calls.items():
            next_reads = reads[target] or any(reads.get(called, False) for called in targets)
            next_writes = writes[target] or any(writes.get(called, False) for called in targets)
            if next_reads != reads[target] or next_writes != writes[target]:
                reads[target] = next_reads
                writes[target] = next_writes
                changed = True

    exported_readers = {
        f"{module_name}.{name}"
        for name in exports
        if reads.get(f"{module_name}.{name}", False)
        and not writes.get(f"{module_name}.{name}", False)
    }
    exported_reader_methods = {
        target.rsplit(".", 1)[-1]
        for target in definitions
        if target.startswith(f"{module_name}.StateTransaction.")
        and "StateTransaction" in exports
        and reads.get(target, False)
        and not writes.get(target, False)
    }
    return frozenset(exported_readers), frozenset(exported_reader_methods)


def _source_derived_stream_readers(
    tree: ast.Module,
    module_name: str,
) -> frozenset[str]:
    """Exported APIs that consume immutable byte streams without filesystem I/O."""
    exports = _literal_module_exports(tree)
    return frozenset(
        target
        for target, function in _module_function_definitions(
            tree,
            module_name,
        ).items()
        if target.rsplit(".", 1)[-1] in exports
        and any(
            argument.annotation is not None
            and "Iterable[bytes]"
            in ast.unparse(argument.annotation).replace(" ", "")
            for argument in (
                *function.args.posonlyargs,
                *function.args.args,
                *function.args.kwonlyargs,
            )
        )
    )


def _source_derived_reader_targets(
    trees: Mapping[str, ast.Module],
    module_names: Mapping[str, str],
    imports: Mapping[str, Mapping[str, str]],
    seed_targets: frozenset[str],
    reader_method_names: frozenset[str],
    scan_index: _PythonScanIndex | None = None,
) -> frozenset[str]:
    """Close reader entrypoints over aliases and value-forwarding wrappers."""
    index = scan_index or _PythonScanIndex(trees, module_names)
    definitions = index.definitions

    read_targets = set(seed_targets)
    direct_read_sinks = frozenset({"read", "read_bytes", "read_text"})
    path_open_read_target = "__aria_static_path_open_read__"
    node_budget = 2_000_000
    edge_budget = 1_000_000

    def assigned_names(target: ast.expr) -> set[str]:
        return {
            node.id
            for node in ast.walk(target)
            if isinstance(node, ast.Name)
        }

    def return_dependencies(
        relative: str,
        function: ast.FunctionDef | ast.AsyncFunctionDef,
        nodes: tuple[ast.AST, ...],
    ) -> set[str]:
        nonlocal node_budget, edge_budget
        node_budget -= len(nodes)
        if node_budget < 0:
            raise AssertionError("surface_scanner_reader_ast_node_budget_exceeded")
        expression_cache: dict[int, tuple[set[str], set[str]]] = {}

        def expression_inputs(
            expression: ast.AST | None,
        ) -> tuple[set[str], set[str]]:
            nonlocal edge_budget
            if expression is None:
                return set(), set()
            cached = expression_cache.get(id(expression))
            if cached is not None:
                return cached
            expression_nodes = tuple(ast.walk(expression))
            names = {
                node.id
                for node in expression_nodes
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
            }
            called: set[str] = set()
            for call in expression_nodes:
                if not isinstance(call, ast.Call):
                    continue
                target = _python_call_target(
                    module_names[relative],
                    imports[relative],
                    call.func,
                )
                if target:
                    called.add(target)
                if _python_open_role(call) == "consumer":
                    called.add(path_open_read_target)
            edge_budget -= len(names) + len(called)
            if edge_budget < 0:
                raise AssertionError("surface_scanner_reader_graph_edge_budget_exceeded")
            expression_cache[id(expression)] = (names, called)
            return names, called

        flows: list[tuple[set[str], ast.AST | None]] = []
        terminals: list[ast.AST | None] = []
        for node in nodes:
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                flows.append((
                    {
                        name
                        for target in targets
                        for name in assigned_names(target)
                    },
                    node.value,
                ))
            elif isinstance(node, (ast.For, ast.AsyncFor)):
                flows.append((assigned_names(node.target), node.iter))
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if item.optional_vars is not None:
                        flows.append((
                            assigned_names(item.optional_vars),
                            item.context_expr,
                        ))
            elif (
                isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Attribute)
                and isinstance(node.value.func.value, ast.Name)
                and node.value.func.attr
                in {"add", "append", "extend", "insert", "setdefault", "update"}
            ):
                receiver = node.value.func.value.id
                for argument in (
                    *node.value.args,
                    *(keyword.value for keyword in node.value.keywords),
                ):
                    flows.append(({receiver}, argument))
            elif isinstance(node, (ast.Return, ast.Yield, ast.YieldFrom)):
                terminals.append(node.value)

        sources: dict[str, set[str]] = {}
        iteration_budget = max(1, len(flows) * (len(flows) + 1))
        changed = True
        while changed:
            changed = False
            for names, expression in flows:
                iteration_budget -= 1
                if iteration_budget < 0:
                    raise AssertionError(
                        "surface_scanner_reader_dataflow_iteration_budget_exceeded",
                    )
                input_names, direct_calls = expression_inputs(expression)
                dependencies = set(direct_calls)
                for name in input_names:
                    dependencies.update(sources.get(name, ()))
                for name in names:
                    prior = sources.setdefault(name, set())
                    before = len(prior)
                    prior.update(dependencies)
                    changed = changed or len(prior) != before

        dependencies: set[str] = set()
        for terminal in terminals:
            input_names, direct_calls = expression_inputs(terminal)
            dependencies.update(direct_calls)
            for name in input_names:
                dependencies.update(sources.get(name, ()))
        return dependencies

    dependencies = {
        target: return_dependencies(relative, function, nodes)
        for target, (relative, function, nodes) in definitions.items()
    }
    reverse_dependencies: dict[str, set[str]] = {}
    for target, called in dependencies.items():
        for dependency in called:
            reverse_dependencies.setdefault(dependency, set()).add(target)
        if any(
            dependency.rsplit(".", 1)[-1] in direct_read_sinks
            or dependency.rsplit(".", 1)[-1] in reader_method_names
            or dependency == path_open_read_target
            for dependency in called
        ):
            read_targets.add(target)

    queue = list(read_targets)
    while queue:
        reader = queue.pop()
        for wrapper in reverse_dependencies.get(reader, ()):
            if wrapper not in read_targets:
                read_targets.add(wrapper)
                queue.append(wrapper)
    return frozenset(read_targets)


def _static_string_path(
    expression: ast.expr,
    constants: Mapping[str, str | tuple[str, ...]] | None = None,
) -> str | None:
    """Recover the known suffix of ``/`` and ``joinpath`` expressions."""
    known = constants or {}
    if isinstance(expression, ast.Constant) and isinstance(expression.value, str):
        return expression.value
    if isinstance(expression, ast.Name):
        value = known.get(expression.id)
        if isinstance(value, str):
            return value
        if isinstance(value, tuple):
            return "/".join(value)
        return None
    if isinstance(expression, ast.Starred):
        return _static_string_path(expression.value, known)
    if isinstance(expression, ast.BinOp) and isinstance(expression.op, ast.Div):
        left = _static_string_path(expression.left, known)
        right = _static_string_path(expression.right, known)
        if left and right:
            return f"{left.rstrip('/')}/{right.lstrip('/')}"
        return right or left
    if (
        isinstance(expression, ast.Call)
        and isinstance(expression.func, ast.Attribute)
        and expression.func.attr == "joinpath"
    ):
        parts: list[str] = []
        root = _static_string_path(expression.func.value, known)
        if root:
            parts.append(root)
        for argument in expression.args:
            part = _static_string_path(argument, known)
            if part:
                parts.extend(piece for piece in part.split("/") if piece)
        return "/".join(parts) or None
    return None


def _source_derived_path_helpers(
    trees: Mapping[str, ast.Module],
    module_names: Mapping[str, str],
    imports: Mapping[str, Mapping[str, str]],
    surface_resolver: Callable[[str], set[str]],
    scan_index: _PythonScanIndex | None = None,
) -> dict[str, set[str]]:
    """Summarize every path-returning helper, independent of its name."""
    constants: dict[str, dict[str, str | tuple[str, ...]]] = {}
    index = scan_index or _PythonScanIndex(trees, module_names)
    definitions = index.definitions
    for relative, tree in trees.items():
        module_constants: dict[str, str | tuple[str, ...]] = {}
        for node in tree.body:
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            value = node.value
            if value is None:
                continue
            try:
                literal = ast.literal_eval(value)
            except (ValueError, TypeError, SyntaxError):
                continue
            normalized: str | tuple[str, ...] | None = None
            if isinstance(literal, str):
                normalized = literal
            elif isinstance(literal, (tuple, list)) and all(
                isinstance(item, str) for item in literal
            ):
                normalized = tuple(literal)
            if normalized is not None:
                for target in targets:
                    if isinstance(target, ast.Name):
                        module_constants[target.id] = normalized
        constants[relative] = module_constants

    helpers: dict[str, set[str]] = {target: set() for target in definitions}
    dependencies: dict[str, set[str]] = {target: set() for target in definitions}
    node_budget = 2_000_000
    edge_budget = 1_000_000
    for target, (relative, function, nodes) in definitions.items():
        node_budget -= len(nodes)
        if node_budget < 0:
            raise AssertionError("surface_scanner_path_ast_node_budget_exceeded")
        for returned in (node for node in nodes if isinstance(node, ast.Return)):
            if returned.value is None:
                continue
            path = _static_string_path(returned.value, constants[relative])
            if path:
                helpers[target].update(surface_resolver(path))
            returned_nodes = tuple(ast.walk(returned.value))
            for call in (
                node for node in returned_nodes if isinstance(node, ast.Call)
            ):
                called = _python_call_target(
                    module_names[relative],
                    imports[relative],
                    call.func,
                )
                if called:
                    dependencies[target].add(called)
        edge_budget -= len(dependencies[target])
        if edge_budget < 0:
            raise AssertionError("surface_scanner_path_graph_edge_budget_exceeded")

    reverse_dependencies: dict[str, set[str]] = {}
    for wrapper, called in dependencies.items():
        for helper in called:
            reverse_dependencies.setdefault(helper, set()).add(wrapper)
    queue = [target for target, surfaces in helpers.items() if surfaces]
    propagation_budget = max(1, edge_budget)
    while queue:
        helper = queue.pop()
        for wrapper in reverse_dependencies.get(helper, ()):
            propagation_budget -= 1
            if propagation_budget < 0:
                raise AssertionError(
                    "surface_scanner_path_propagation_budget_exceeded",
                )
            before = len(helpers[wrapper])
            helpers[wrapper].update(helpers[helper])
            if len(helpers[wrapper]) != before:
                queue.append(wrapper)
    return {target: surfaces for target, surfaces in helpers.items() if surfaces}


class PublicEvidenceModelTests(unittest.TestCase):
    def test_surface_scanner_scope_fixture_includes_nested_and_async_functions(
        self,
    ) -> None:
        fixture = ast.parse(
            """
def outer():
    def nested():
        pass
    async def nested_async():
        pass

async def top_async():
    pass
""",
        )
        self.assertEqual(
            {node.name for node in _python_function_scopes(fixture)},
            {"outer", "nested", "nested_async", "top_async"},
        )

    def test_surface_scanner_derives_new_exported_readers_aliases_and_wrappers(
        self,
    ) -> None:
        ledger_tree = ast.parse(
            '''
__all__ = ["future_rows", "future_append", "StateTransaction"]

def _decode(path):
    return path.read_text()

def future_rows(path):
    return _decode(path)

def future_append(path):
    old = path.read_text()
    path.write_text(old)

class StateTransaction:
    def load_future(self, path):
        return future_rows(path)

    def append_future(self, path):
        return future_append(path)
''',
        )
        consumer_tree = ast.parse(
            '''
from aria_kernel.ledger import future_rows as renamed_reader

def arbitrary_bridge(path):
    return renamed_reader(path)

def another_layer(path):
    return arbitrary_bridge(path)
''',
        )
        trees = {"ledger.py": ledger_tree, "consumer.py": consumer_tree}
        module_names = {
            "ledger.py": "aria_kernel.ledger",
            "consumer.py": "aria_kernel.consumer",
        }
        imports = {
            relative: _python_import_aliases(tree, module_names[relative])
            for relative, tree in trees.items()
        }
        seeds, transaction_methods = _source_derived_ledger_readers(
            ledger_tree,
            "aria_kernel.ledger",
        )
        targets = _source_derived_reader_targets(
            trees,
            module_names,
            imports,
            seeds,
            transaction_methods,
        )

        self.assertIn("aria_kernel.ledger.future_rows", seeds)
        self.assertNotIn("aria_kernel.ledger.future_append", seeds)
        self.assertEqual(transaction_methods, frozenset({"load_future"}))
        self.assertIn("aria_kernel.consumer.arbitrary_bridge", targets)
        self.assertIn("aria_kernel.consumer.another_layer", targets)

    def test_surface_scanner_resolves_package_relative_module_aliases(self) -> None:
        tree = ast.parse(
            """
from . import ledger

def rows(path):
    return ledger.load_declared_jsonl(path, expected_surface="cycles")
""",
        )

        aliases = _python_import_aliases(tree, "aria_kernel.consumer")

        self.assertEqual(aliases["ledger"], "aria_kernel.ledger")
        self.assertEqual(
            _python_call_target(
                "aria_kernel.consumer",
                aliases,
                next(
                    node.func
                    for node in ast.walk(tree)
                    if isinstance(node, ast.Call)
                ),
            ),
            "aria_kernel.ledger.load_declared_jsonl",
        )

    def test_surface_scanner_follows_read_only_path_open_through_iteration(
        self,
    ) -> None:
        tree = ast.parse(
            '''
def read_default(path):
    rows = []
    with path.open() as handle:
        for line in handle:
            rows.append(line)
    return rows

def read_text(path):
    rows = []
    with path.open("r") as handle:
        for line in handle:
            decoded = line
            rows.append(decoded)
    return rows

def read_binary(path):
    rows = []
    with path.open(mode="rb") as handle:
        for chunk in handle:
            rows.append(chunk)
    return rows

def builtin_default(path):
    rows = []
    with open(path) as handle:
        for line in handle:
            rows.append(line)
    return rows

def builtin_text(path):
    rows = []
    with open(path, "r") as handle:
        for line in handle:
            rows.append(line)
    return rows

def builtin_binary(path):
    rows = []
    with open(path, mode="rb") as handle:
        for chunk in handle:
            rows.append(chunk)
    return rows

def dynamic_mode(path, mode):
    rows = []
    with path.open(mode) as handle:
        for item in handle:
            rows.append(item)
    return rows

def append_only(path):
    rows = []
    with path.open("a") as handle:
        for line in handle:
            rows.append(line)
    return rows

def overwrite_only(path):
    rows = []
    with path.open("w") as handle:
        for line in handle:
            rows.append(line)
    return rows
''',
        )
        trees = {"fixture.py": tree}
        module_names = {"fixture.py": "aria_kernel.fixture"}
        imports = {
            "fixture.py": _python_import_aliases(tree, "aria_kernel.fixture"),
        }

        targets = _source_derived_reader_targets(
            trees,
            module_names,
            imports,
            frozenset(),
            frozenset(),
        )

        self.assertTrue({
            "aria_kernel.fixture.read_default",
            "aria_kernel.fixture.read_text",
            "aria_kernel.fixture.read_binary",
            "aria_kernel.fixture.builtin_default",
            "aria_kernel.fixture.builtin_text",
            "aria_kernel.fixture.builtin_binary",
        }.issubset(targets))
        self.assertNotIn("aria_kernel.fixture.dynamic_mode", targets)
        self.assertNotIn("aria_kernel.fixture.append_only", targets)
        self.assertNotIn("aria_kernel.fixture.overwrite_only", targets)

    def test_surface_scanner_classifies_open_modes_without_execution(self) -> None:
        expected = {
            'path.open()': "consumer",
            'path.open("r")': "consumer",
            'path.open(mode="rb")': "consumer",
            'open(path)': "consumer",
            'open(path, "r")': "consumer",
            'open(path, mode="rb")': "consumer",
            'path.open("w")': "producer",
            'path.open(mode="a")': "producer",
            'path.open("x")': "producer",
            'path.open("r+")': "producer",
            'open(path, "w")': "producer",
            'path.open(mode)': None,
            'open(path, mode)': None,
        }
        observed = {
            source: _python_open_role(
                ast.parse(source, mode="eval").body,
            )
            for source in expected
        }
        self.assertEqual(observed, expected)

    def test_external_outage_reaper_has_no_raw_open_writer(self) -> None:
        repository = Path(__file__).resolve().parents[2]
        relative = f"{KERNEL}external_outage_reaper.py"
        tree = ast.parse(
            (repository / relative).read_text(encoding="utf-8"),
            filename=relative,
        )
        offenders = [
            call.lineno
            for call in ast.walk(tree)
            if isinstance(call, ast.Call)
            and _python_open_role(call) == "producer"
        ]
        self.assertEqual(
            offenders,
            [],
            "declared claims ledger writes must use governed ledger primitives",
        )

    def test_surface_scanner_derives_arbitrarily_named_joinpath_helpers(
        self,
    ) -> None:
        tree = ast.parse(
            '''
PARTS = ("nested", "governance.jsonl")

def location_factory(root):
    return root.joinpath(*PARTS)

def alias_factory(root):
    return location_factory(root)
''',
        )
        trees = {"fixture.py": tree}
        module_names = {"fixture.py": "aria_kernel.fixture"}
        imports = {
            "fixture.py": _python_import_aliases(tree, "aria_kernel.fixture"),
        }
        helpers = _source_derived_path_helpers(
            trees,
            module_names,
            imports,
            lambda path: {"tools_governance"}
            if path.endswith("governance.jsonl")
            else set(),
        )

        self.assertEqual(
            _static_string_path(
                ast.parse(
                    'root.joinpath("nested", "governance.jsonl")',
                    mode="eval",
                ).body,
            ),
            "nested/governance.jsonl",
        )
        self.assertEqual(
            helpers,
            {
                "aria_kernel.fixture.location_factory": {"tools_governance"},
                "aria_kernel.fixture.alias_factory": {"tools_governance"},
            },
        )

    def test_surface_scanner_index_budget_exhaustion_fails_closed(self) -> None:
        tree = ast.parse("def reader(path):\n    return path.read_text()\n")
        with self.assertRaisesRegex(
            AssertionError,
            "surface_scanner_ast_index_node_budget_exceeded",
        ):
            _PythonScanIndex(
                {"reader.py": tree},
                {"reader.py": "aria_kernel.reader"},
                node_budget=1,
            )

    def test_surface_scanner_indexes_real_ledger_and_trust_once(self) -> None:
        repository = Path(__file__).resolve().parents[2]
        relatives = (
            f"{KERNEL}ledger.py",
            f"{KERNEL}trust.py",
        )
        trees = {
            relative: ast.parse(
                (repository / relative).read_text(encoding="utf-8"),
                filename=relative,
            )
            for relative in relatives
        }
        module_names = {
            relative: f"aria_kernel.{Path(relative).stem}"
            for relative in relatives
        }
        imports = {
            relative: _python_import_aliases(tree, module_names[relative])
            for relative, tree in trees.items()
        }
        index = _PythonScanIndex(trees, module_names, node_budget=100_000)
        readers, methods = _source_derived_ledger_readers(
            trees[f"{KERNEL}ledger.py"],
            "aria_kernel.ledger",
        )
        targets = _source_derived_reader_targets(
            trees,
            module_names,
            imports,
            readers,
            methods,
            index,
        )

        self.assertLess(index.visited_node_count, 100_000)
        self.assertIn("aria_kernel.trust._governance", targets)

    def test_public_model_is_deeply_immutable_and_serializes_fresh_copies(
        self,
    ) -> None:
        ref = EvidenceRef(
            surface="cycles",
            proof_kind="live",
            schema_id=None,
            schema_version=3,
            row_id="cycle-1",
            row_hash="sha256:" + "1" * 64,
            evidence_target_sha="a" * 40,
            evaluated_target_sha="a" * 40,
            capability_authority_hash="sha256:" + "2" * 64,
            state_commit="b" * 40,
        )
        capability = CapabilityEvidence(
            state="live_proven",
            counts={"accepted": 1},
            blockers=(),
            evidence_refs=(ref,),
        )
        status = AutonomyEvidenceStatus(
            target_sha="a" * 40,
            derived_at="2026-08-22T00:00:00Z",
            overall_state="live_proven",
            blockers=(),
            capabilities={"cycle_runtime": capability},
        )

        self.assertIsInstance(capability.counts, MappingProxyType)
        self.assertIsInstance(status.capabilities, MappingProxyType)
        with self.assertRaises(TypeError):
            capability.counts["accepted"] = 2
        with self.assertRaises(TypeError):
            status.capabilities["executor"] = capability
        with self.assertRaises(FrozenInstanceError):
            ref.surface = "other"

        mutable_blockers = ["first"]
        mutable_refs = [ref]
        normalized = CapabilityEvidence(
            state="live_proven",
            counts={},
            blockers=mutable_blockers,  # type: ignore[arg-type]
            evidence_refs=mutable_refs,  # type: ignore[arg-type]
        )
        mutable_blockers.append("second")
        mutable_refs.clear()
        self.assertEqual(normalized.blockers, ("first",))
        self.assertEqual(normalized.evidence_refs, (ref,))

        first = status.to_dict()
        first["capabilities"]["cycle_runtime"]["counts"]["accepted"] = 99
        second = status.to_dict()
        self.assertEqual(
            second["capabilities"]["cycle_runtime"]["counts"]["accepted"],
            1,
        )
        self.assertEqual(
            second["capabilities"]["cycle_runtime"]["evidence_refs"][0]["row_id"],
            "cycle-1",
        )

    def test_overall_state_is_derived_with_operator_blocker_precedence(
        self,
    ) -> None:
        status = AutonomyEvidenceStatus(
            target_sha="a" * 40,
            derived_at="2026-08-22T00:00:00Z",
            overall_state="live_proven",
            blockers=("caller_supplied_blocker",),
            capabilities={
                "cycle_runtime": _capability("code_proven"),
                "enterprise_readiness": _capability(
                    "operator_blocked",
                    blocker="github_app_mode_a_unconfigured",
                ),
            },
        )

        self.assertEqual(status.overall_state, "operator_blocked")
        self.assertEqual(status.blockers, ("github_app_mode_a_unconfigured",))

    def test_overall_state_is_the_lowest_non_operator_evidence_state(self) -> None:
        status = AutonomyEvidenceStatus(
            target_sha="a" * 40,
            derived_at="2026-08-22T00:00:00Z",
            overall_state="live_proven",
            blockers=(),
            capabilities={
                "cycle_runtime": _capability("live_proven"),
                "executor": _capability("declared"),
                "finding_funnel": _capability("code_proven"),
            },
        )
        self.assertEqual(status.overall_state, "declared")

    def test_capability_spec_is_the_only_deeply_immutable_authority_roster(
        self,
    ) -> None:
        self.assertEqual(tuple(CAPABILITY_SPECS), EXPECTED_CAPABILITIES)
        self.assertIsInstance(CAPABILITY_SPECS, MappingProxyType)
        self.assertFalse(hasattr(autonomy_evidence_module, "_CAPABILITY_SPECS"))
        self.assertIsInstance(CAPABILITY_AUTHORITY_PATHS, MappingProxyType)
        for key in EXPECTED_CAPABILITIES:
            spec = CAPABILITY_SPECS[key]
            expected_authority = tuple(dict.fromkeys((
                *EXPECTED_SPECIFIC_AUTHORITY[key],
                *EXPECTED_COMMON_AUTHORITY,
            )))
            self.assertEqual(spec.authority_paths, expected_authority)
            self.assertEqual(spec.producer_paths, EXPECTED_PRODUCERS[key])
            self.assertEqual(
                spec.authorizing_consumer_paths,
                EXPECTED_CONSUMERS[key],
            )
            self.assertEqual(CAPABILITY_AUTHORITY_PATHS[key], spec.authority_paths)
            self.assertIsInstance(spec.authority_paths, tuple)
            self.assertIsInstance(spec.producer_paths, tuple)
            self.assertIsInstance(spec.authorizing_consumer_paths, tuple)
            self.assertIsInstance(spec.contracts, tuple)
            self.assertIsInstance(spec.count_surfaces, tuple)
            self.assertTrue(
                set(spec.producer_paths).issubset(spec.authority_paths),
            )
            self.assertTrue(
                set(spec.authorizing_consumer_paths).issubset(
                    spec.authority_paths,
                ),
            )
        with self.assertRaises(TypeError):
            CAPABILITY_SPECS["other"] = CAPABILITY_SPECS["cycle_runtime"]

    def test_capability_specs_cover_discovered_surface_writers_and_consumers(
        self,
    ) -> None:
        """Alias/path/wrapper-derived callsites are owned or observational."""
        repository = Path(__file__).resolve().parents[2]
        surface_capabilities = {
            surface: capability
            for capability, spec in CAPABILITY_SPECS.items()
            for surface in spec.count_surfaces
        }
        tracked_surface_names = {
            *surface_capabilities,
            "workspace_memory_governance",
        }
        all_surfaces = {
            surface.name: surface
            for surface in state_manifest_module.iter_surfaces()
            if surface.name in tracked_surface_names
        }
        writer_primitives = {
            "_append_declared_jsonl_unlocked",
            "_append_jsonl_unlocked",
            "append_declared_jsonl",
            "append_jsonl",
            "rewrite_declared_json",
            "rewrite_declared_jsonl",
            "rewrite_jsonl",
        }
        global_transport_writers = {
            f"{KERNEL}contention_replay.py":
                "contention replay can rewrite every capability ledger",
        }
        observational = {
            ("cycle_runtime", f"{KERNEL}reflection.py", "consumer"):
                "reflection reports completed cycles but cannot authorize them",
            ("finding_funnel", f"{KERNEL}burn_in.py", "consumer"):
                "burn-in only reports funnel counts",
            ("finding_funnel", f"{KERNEL}runtime_artifacts.py", "consumer"):
                "artifact packaging only inventories raw findings",
            ("executor", f"{KERNEL}human_required.py", "consumer"):
                "human escalation observes outstanding requests",
            ("executor", f"{KERNEL}judge_fanout.py", "consumer"):
                "fanout selects work but cannot authorize executor proof",
            ("executor", f"{KERNEL}plan_016_metrics.py", "consumer"):
                "metrics are observational by definition",
            ("enterprise_readiness", f"{KERNEL}runner_attestation.py", "consumer"):
                "runner attestation reports readiness without authorizing it",
            ("cycle_runtime", f"{KERNEL}integrity.py", "consumer"):
                "integrity verification observes cycle chain bytes only",
            ("executor", f"{KERNEL}shadow_eval_bridge.py", "consumer"):
                "shadow bridge consumes execution to authorize genesis evidence",
            ("executor", f"{KERNEL}tool_registry.py", "consumer"):
                "registry reads governance history for inventory reporting",
            ("executor", f"{KERNEL}worker_dispatch.py", "consumer"):
                "worker dispatch consumes requests but cannot validate results",
            ("finding_funnel", f"{KERNEL}belief_escalation.py", "consumer"):
                "belief escalation observes feedback for a separate belief lane",
            ("finding_funnel", f"{KERNEL}calibration.py", "consumer"):
                "calibration reports funnel examples without authorizing promotion",
            ("finding_funnel", f"{KERNEL}calibration_bootstrap.py", "consumer"):
                "bootstrap reads prior feedback only to seed calibration rows",
            ("finding_funnel", f"{KERNEL}cycle.py", "consumer"):
                "cycle scheduling observes funnel backlog without judging proof",
            ("finding_funnel", f"{KERNEL}feedback_store.py", "consumer"):
                "feedback store query helpers expose bytes but grant no proof",
            ("finding_funnel", f"{KERNEL}goldset.py", "consumer"):
                "goldset proposal reads verdicts for a separate review artifact",
            ("finding_funnel", f"{KERNEL}judge_calibration.py", "consumer"):
                "judge calibration consumes samples for calibration statistics",
            ("finding_funnel", f"{KERNEL}judge_fanout.py", "consumer"):
                "judge fanout selects samples but cannot authorize promotion",
            ("finding_funnel", f"{KERNEL}judge_replay.py", "consumer"):
                "judge replay is a diagnostic comparison over prior rows",
            ("finding_funnel", f"{KERNEL}memory.py", "consumer"):
                "memory derives beliefs without authorizing funnel completion",
            ("finding_funnel", f"{KERNEL}pr_tracking.py", "consumer"):
                "PR tracking reads findings to update separate impact records",
            ("finding_funnel", f"{KERNEL}pressure.py", "consumer"):
                "pressure metrics count funnel rows without judging their proof",
            ("finding_funnel", f"{KERNEL}proactive_priority.py", "consumer"):
                "priority scoring observes findings without promoting them",
            ("finding_funnel", f"{KERNEL}reflection.py", "consumer"):
                "reflection summarizes funnel history for learning telemetry",
            ("finding_funnel", f"{KERNEL}tool_health.py", "consumer"):
                "tool health derives adapter metrics rather than funnel proof",
            ("fixture_calibration", f"{KERNEL}adapter_calibration.py", "consumer"):
                "adapter calibration reads its history for statistical updates",
            ("fixture_calibration", f"{KERNEL}proactive_priority.py", "consumer"):
                "priority scoring observes calibration without authorizing it",
            ("fixture_calibration", f"{KERNEL}reflection.py", "consumer"):
                "reflection summarizes fixture history for learning telemetry",
            ("pre_merge_perimeter", f"{KERNEL}reflection.py", "consumer"):
                "reflection summarizes merge decisions but cannot authorize them",
        }
        surface_observational = {
            ("workspace_memory_governance", f"{KERNEL}trust.py", "consumer"):
                "trust policy observes workspace governance without authorizing executor proof",
        }
        proof_observational_categories = {
            "operator_adapter": {
                ("cycle_runtime", "cycles", f"{KERNEL}cli.py", "consumer"),
                ("cycle_runtime", "cycles", f"{KERNEL}cli.py", "producer"),
                (
                    "enterprise_readiness",
                    "enterprise_readiness_claims",
                    f"{KERNEL}cli.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}cli.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}cli.py",
                    "producer",
                ),
                (
                    "fixture_calibration",
                    "agent_eval_fixture_runs",
                    f"{KERNEL}cli.py",
                    "consumer",
                ),
            },
            "scheduler_orchestration": {
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}autonomy_orchestrator.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}planner_dispatch_hook.py",
                    "consumer",
                ),
                (
                    "pre_merge_perimeter",
                    "auto_merge_decisions",
                    f"{KERNEL}autonomy_orchestrator.py",
                    "consumer",
                ),
                (
                    "pre_merge_perimeter",
                    "auto_merge_decisions",
                    f"{KERNEL}cycle.py",
                    "consumer",
                ),
                (
                    "finding_funnel",
                    "promotions",
                    f"{KERNEL}cycle.py",
                    "producer",
                ),
            },
            "reporting_or_prioritization": {
                (
                    "cycle_runtime",
                    "cycles",
                    f"{KERNEL}promotion_controller.py",
                    "consumer",
                ),
                (
                    "cycle_runtime",
                    "cycles",
                    f"{KERNEL}report.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}reflection.py",
                    "consumer",
                ),
            },
            "downstream_workflow": {
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}dispatcher_factory.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}handoff_ledger.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}human_required_adjudication.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}plan_round_controller.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}review_runner.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}specialist_review_runner.py",
                    "consumer",
                ),
            },
            "cross_capability_observer": {
                (
                    "enterprise_readiness",
                    "enterprise_readiness_claims",
                    f"{KERNEL}merge_authority.py",
                    "consumer",
                ),
                (
                    "fixture_calibration",
                    "agent_eval_fixture_runs",
                    f"{KERNEL}agent_invocations.py",
                    "consumer",
                ),
            },
            "recovery_safety": {
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}cycle.py",
                    "consumer",
                ),
                (
                    "executor",
                    "agent_invocation_results",
                    f"{KERNEL}external_outage_reaper.py",
                    "consumer",
                ),
            },
        }

        trees: dict[str, ast.Module] = {}
        module_names: dict[str, str] = {}
        imports: dict[str, dict[str, str]] = {}
        literal_python_authority = {
            path
            for spec in CAPABILITY_SPECS.values()
            for path in spec.authority_paths
            if path.endswith(".py")
        }
        source_paths = set((repository / KERNEL).rglob("*.py"))
        literal_python_sources = {
            repository / relative
            for relative in literal_python_authority
            if (repository / relative).is_file()
        }
        source_paths.update(literal_python_sources)
        for source in sorted(source_paths):
            relative = source.relative_to(repository).as_posix()
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=relative)
            trees[relative] = tree
            suffix = Path(relative).with_suffix("")
            parts = list(suffix.parts)
            if parts[0] == "aria-kernel":
                parts.pop(0)
            if parts[-1] == "__init__":
                parts.pop()
            module_names[relative] = ".".join(parts)
            # Function-local aliases matter too; ``ast.walk`` intentionally
            # treats them as module scan aliases without executing imports.
            imports[relative] = _python_import_aliases(
                tree,
                module_names[relative],
            )
        self.assertTrue(
            {
                source.relative_to(repository).as_posix()
                for source in literal_python_sources
            }.issubset(trees),
        )
        scan_index = _PythonScanIndex(trees, module_names)

        def call_target(relative: str, function: ast.expr) -> str:
            return _python_call_target(
                module_names[relative],
                imports[relative],
                function,
            )

        def matching_surfaces(
            value: str,
            root_kind: str | None = None,
        ) -> set[str]:
            if value in all_surfaces:
                return {value}
            normalized = value.replace("\\", "/").removeprefix("./")
            if not normalized or normalized.startswith("/") or normalized.endswith("/"):
                return set()
            matches: set[str] = set()
            for name, surface in all_surfaces.items():
                if root_kind is not None and surface.root_kind != root_kind:
                    continue
                pattern = surface.path_pattern
                try:
                    matched = state_manifest_module.surface_path_matches(
                        normalized,
                        pattern,
                    )
                except ValueError:
                    matched = False
                if matched or pattern == normalized or pattern.endswith(f"/{normalized}"):
                    matches.add(name)
            return matches

        def literal_surfaces(
            value: str,
            root_kind: str | None = None,
        ) -> set[str]:
            matches = matching_surfaces(value, root_kind)
            if root_kind is not None or len(matches) < 2:
                return matches
            roots = {all_surfaces[name].root_kind for name in matches}
            # A basename shared by tools/workspace/repo roots is not identity.
            # It can only become a surface after receiver-root provenance.
            return set() if len(roots) > 1 else matches

        ledger_relative = f"{KERNEL}ledger.py"
        exported_reader_targets, transaction_reader_methods = (
            _source_derived_ledger_readers(
                trees[ledger_relative],
                module_names[ledger_relative],
            )
        )
        self.assertTrue(
            {
                "aria_kernel.ledger.read_jsonl",
                "aria_kernel.ledger.load_jsonl",
                "aria_kernel.ledger.load_declared_jsonl",
            }.issubset(exported_reader_targets),
        )
        self.assertTrue(
            {"load_jsonl", "load_declared_jsonl"}.issubset(
                transaction_reader_methods,
            ),
        )
        stream_reader_targets = _source_derived_stream_readers(
            trees[ledger_relative],
            module_names[ledger_relative],
        )
        self.assertIn(
            "aria_kernel.ledger.verify_jsonl_chunks",
            stream_reader_targets,
        )
        reader_targets = _source_derived_reader_targets(
            trees,
            module_names,
            imports,
            exported_reader_targets,
            transaction_reader_methods,
            scan_index,
        )
        path_helpers = _source_derived_path_helpers(
            trees,
            module_names,
            imports,
            literal_surfaces,
            scan_index,
        )

        def scope_root_bindings(
            relative: str,
            scope: ast.AST,
        ) -> dict[str, str]:
            bindings: dict[str, str] = {}
            arguments = getattr(scope, "args", None)
            if arguments is not None:
                for argument in (*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs):
                    annotation = ast.unparse(argument.annotation) if argument.annotation else ""
                    if "WorkspacePaths" in annotation:
                        bindings[argument.arg] = "workspace"
                    elif "tools_root" in argument.arg.lower():
                        bindings[argument.arg] = "tools"
            for assignment in (
                node
                for node in scan_index.nodes[id(scope)]
                if isinstance(node, ast.Assign)
            ):
                if not isinstance(assignment.value, ast.Call):
                    continue
                called = call_target(relative, assignment.value.func).rsplit(".", 1)[-1]
                root_kind = (
                    "workspace" if called == "workspace_paths"
                    else "tools" if called in {
                        "ensure_tools_dir",
                        "ensure_tools_dir_readonly",
                        "tools_dir",
                        "tools_index_group_ledgers",
                    }
                    else None
                )
                if root_kind is not None:
                    for target in assignment.targets:
                        if isinstance(target, ast.Name):
                            bindings[target.id] = root_kind
            return bindings

        def expression_root_kind(
            relative: str,
            expression: ast.expr,
            root_bindings: Mapping[str, str],
        ) -> str | None:
            if isinstance(expression, ast.Name):
                return root_bindings.get(expression.id)
            if isinstance(expression, ast.BinOp) and isinstance(expression.op, ast.Div):
                return expression_root_kind(relative, expression.left, root_bindings)
            if isinstance(expression, ast.Call):
                called = call_target(relative, expression.func).rsplit(".", 1)[-1]
                if called == "workspace_paths":
                    return "workspace"
                if called in {
                    "ensure_tools_dir",
                    "ensure_tools_dir_readonly",
                    "tools_dir",
                    "tools_index_group_ledgers",
                }:
                    return "tools"
                if isinstance(expression.func, ast.Attribute) and expression.func.attr == "joinpath":
                    return expression_root_kind(
                        relative,
                        expression.func.value,
                        root_bindings,
                    )
            if isinstance(expression, ast.Attribute):
                return expression_root_kind(relative, expression.value, root_bindings)
            return None

        def expression_surfaces(
            relative: str,
            expression: ast.expr,
            assigned: Mapping[str, set[str]],
            root_bindings: Mapping[str, str],
        ) -> set[str]:
            if isinstance(expression, ast.Name):
                return set(assigned.get(expression.id, ()))
            if isinstance(expression, ast.Constant) and isinstance(expression.value, str):
                return literal_surfaces(expression.value)
            if isinstance(expression, ast.Call):
                return set(path_helpers.get(call_target(relative, expression.func), ()))
            if isinstance(expression, ast.Subscript):
                key = expression.slice
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    receiver = expression.value
                    if (
                        isinstance(receiver, ast.Attribute)
                        and receiver.attr == "ledgers"
                        and isinstance(receiver.value, ast.Name)
                        and root_bindings.get(receiver.value.id) == "workspace"
                    ):
                        return literal_surfaces(
                            f"aria-memory/{key.value}.jsonl",
                            "workspace",
                        )
                    if (
                        isinstance(receiver, ast.Call)
                        and call_target(relative, receiver.func).rsplit(".", 1)[-1]
                        == "tools_index_group_ledgers"
                    ):
                        return literal_surfaces(f"{key.value}.jsonl", "tools")
                    return set()
            path = _static_string_path(expression)
            return (
                literal_surfaces(
                    path,
                    expression_root_kind(relative, expression, root_bindings),
                )
                if path
                else set()
            )

        # Every source-derived reader target participates. A new exported
        # primitive, alias, or arbitrarily named wrapper cannot evade this
        # projection merely because its spelling is absent from this test.
        wrappers: dict[str, dict[str, Any]] = {}
        for relative, tree in trees.items():
            for function in scan_index.scopes[relative]:
                function_target = scan_index.targets[id(function)]
                open_roles = {
                    role
                    for call in scan_index.nodes[id(function)]
                    if isinstance(call, ast.Call)
                    for role in (_python_open_role(call),)
                    if role is not None
                }
                direct_targets = {
                    call_target(relative, call.func)
                    for call in scan_index.nodes[id(function)]
                    if isinstance(call, ast.Call)
                }
                has_direct_ledger_role = any(
                    target in reader_targets
                    or target in stream_reader_targets
                    or target.rsplit(".", 1)[-1] in transaction_reader_methods
                    or target.rsplit(".", 1)[-1] in writer_primitives
                    for target in direct_targets
                )
                if (
                    function_target not in reader_targets
                    and function.name not in writer_primitives
                    and not open_roles
                    and not has_direct_ledger_role
                ):
                    continue
                parameters = [argument.arg for argument in function.args.args]
                root_bindings = scope_root_bindings(relative, function)
                function_assigned: dict[str, set[str]] = {}
                for assignment in (
                    node
                    for node in scan_index.nodes[id(function)]
                    if isinstance(node, ast.Assign)
                ):
                    assigned_surfaces = expression_surfaces(
                        relative,
                        assignment.value,
                        function_assigned,
                        root_bindings,
                    )
                    for assigned_target in assignment.targets:
                        if (
                            isinstance(assigned_target, ast.Name)
                            and assigned_surfaces
                        ):
                            function_assigned[assigned_target.id] = (
                                assigned_surfaces
                            )
                summary = {
                    "parameters": tuple(parameters),
                    "roles": set(),
                    "fixed_roles": set(),
                    "surface_param_roles": set(),
                    "path_param_roles": set(),
                }
                for call in (
                    node
                    for node in scan_index.nodes[id(function)]
                    if isinstance(node, ast.Call)
                ):
                    target = call_target(relative, call.func)
                    primitive = target.rsplit(".", 1)[-1]
                    roles: set[str] = set()
                    if primitive in writer_primitives:
                        roles.add("producer")
                    elif (
                        target in reader_targets
                        or target in stream_reader_targets
                        or primitive in transaction_reader_methods
                    ):
                        roles.add("consumer")
                    open_role = _python_open_role(call)
                    if open_role is not None:
                        roles.add(open_role)
                    if not roles:
                        continue
                    summary["roles"].update(roles)
                    fixed_surfaces: set[str] = set()
                    open_path = _python_open_path_expression(call)
                    surface_operand = (
                        open_path
                        if open_path is not None
                        else call.args[0] if call.args else None
                    )
                    if surface_operand is not None:
                        fixed_surfaces.update(
                            expression_surfaces(
                                relative,
                                surface_operand,
                                function_assigned,
                                root_bindings,
                            ),
                        )
                    if isinstance(surface_operand, ast.Name):
                        if surface_operand.id in parameters:
                            parameter_index = parameters.index(surface_operand.id)
                            summary["path_param_roles"].update(
                                (parameter_index, role) for role in roles
                            )
                    for keyword in call.keywords:
                        if keyword.arg == "source":
                            fixed_surfaces.update(
                                expression_surfaces(
                                    relative,
                                    keyword.value,
                                    function_assigned,
                                    root_bindings,
                                ),
                            )
                            if (
                                isinstance(keyword.value, ast.Name)
                                and keyword.value.id in parameters
                            ):
                                parameter_index = parameters.index(
                                    keyword.value.id,
                                )
                                summary["path_param_roles"].update(
                                    (parameter_index, role) for role in roles
                                )
                            continue
                        if keyword.arg != "expected_surface":
                            continue
                        if (
                            isinstance(keyword.value, ast.Constant)
                            and isinstance(keyword.value.value, str)
                        ):
                            fixed_surfaces.update(
                                literal_surfaces(keyword.value.value),
                            )
                        elif (
                            isinstance(keyword.value, ast.Name)
                            and keyword.value.id in parameters
                        ):
                            parameter_index = parameters.index(keyword.value.id)
                            summary["surface_param_roles"].update(
                                (parameter_index, role) for role in roles
                            )
                    summary["fixed_roles"].update(
                        (surface, role)
                        for surface in fixed_surfaces
                        for role in roles
                    )
                if summary["roles"]:
                    wrappers[function_target] = summary

        def wrapper_argument(
            call: ast.Call,
            summary: Mapping[str, Any],
            index: int,
        ) -> ast.expr | None:
            if index < len(call.args):
                return call.args[index]
            parameters = summary["parameters"]
            if index >= len(parameters):
                return None
            return next(
                (
                    keyword.value
                    for keyword in call.keywords
                    if keyword.arg == parameters[index]
                ),
                None,
            )

        discovered: set[tuple[str, str, str]] = set()
        discovered_capability_surfaces: set[tuple[str, str, str, str]] = set()
        discovered_surfaces: set[tuple[str, str, str]] = set()
        discovered_global_transport_writers: set[str] = set()
        for relative, tree in trees.items():
            for scope in scan_index.scopes[relative]:
                assigned: dict[str, set[str]] = {}
                root_bindings = scope_root_bindings(relative, scope)
                for assignment in (
                    node
                    for node in scan_index.nodes[id(scope)]
                    if isinstance(node, ast.Assign)
                ):
                    surfaces = expression_surfaces(
                        relative,
                        assignment.value,
                        assigned,
                        root_bindings,
                    )
                    for target in assignment.targets:
                        if isinstance(target, ast.Name) and surfaces:
                            assigned[target.id] = surfaces
                for call in (
                    node
                    for node in scan_index.nodes[id(scope)]
                    if isinstance(node, ast.Call)
                ):
                    target = call_target(relative, call.func)
                    primitive = target.rsplit(".", 1)[-1]
                    roles = set()
                    if primitive in writer_primitives:
                        roles.add("producer")
                    elif (
                        target in reader_targets
                        or target in stream_reader_targets
                        or primitive in transaction_reader_methods
                    ):
                        roles.add("consumer")
                    open_role = _python_open_role(call)
                    if open_role is not None:
                        roles.add(open_role)
                    wrapper = wrappers.get(target)
                    all_roles = roles | (wrapper["roles"] if wrapper else set())
                    if not all_roles:
                        continue
                    surfaces: set[str] = set()
                    if primitive == "load_feedback":
                        surfaces.add("operator_feedback")
                    open_path = _python_open_path_expression(call)
                    surface_operand = (
                        open_path
                        if open_path is not None
                        else call.args[0] if call.args else None
                    )
                    if surface_operand is not None:
                        surfaces.update(
                            expression_surfaces(
                                relative,
                                surface_operand,
                                assigned,
                                root_bindings,
                            ),
                        )
                    for keyword in call.keywords:
                        if keyword.arg in {
                            "expected_surface",
                            "source",
                            "surface",
                        }:
                            surfaces.update(
                                expression_surfaces(
                                    relative,
                                    keyword.value,
                                    assigned,
                                    root_bindings,
                                ),
                            )
                    surface_roles = {
                        (surface, role)
                        for surface in surfaces
                        for role in roles
                    }
                    if wrapper:
                        surface_roles.update(wrapper["fixed_roles"])
                        parameter_roles = (
                            wrapper["surface_param_roles"]
                            | wrapper["path_param_roles"]
                        )
                        for index, role in parameter_roles:
                            argument = wrapper_argument(call, wrapper, index)
                            if argument is not None:
                                surface_roles.update(
                                    (surface, role)
                                    for surface in expression_surfaces(
                                        relative,
                                        argument,
                                        assigned,
                                        root_bindings,
                                    )
                                )
                    if (
                        "producer" in all_roles
                        and relative in global_transport_writers
                    ):
                        discovered_global_transport_writers.add(relative)
                    for surface, role in surface_roles:
                        discovered_surfaces.add((surface, relative, role))
                        capability = surface_capabilities.get(surface)
                        if capability:
                            discovered_capability_surfaces.add(
                                (capability, surface, relative, role),
                            )
                            discovered.add(
                                (capability, relative, role),
                            )

        required_discoveries = {
            ("cycle_runtime", f"{KERNEL}burn_in.py", "producer"),
            ("cycle_runtime", f"{KERNEL}burn_in.py", "consumer"),
            ("cycle_runtime", f"{KERNEL}runtime_artifacts.py", "consumer"),
            ("cycle_runtime", f"{KERNEL}tool_health.py", "producer"),
            ("finding_funnel", f"{KERNEL}rule_health.py", "producer"),
            ("finding_funnel", f"{KERNEL}rule_health.py", "consumer"),
            ("finding_funnel", f"{KERNEL}pr_tracking.py", "producer"),
            ("finding_funnel", f"{KERNEL}finding_promotion.py", "consumer"),
            ("executor", f"{KERNEL}agent_eval.py", "consumer"),
            ("executor", f"{KERNEL}bridge_status_ledger.py", "consumer"),
            ("executor", f"{KERNEL}convergence_drainer.py", "consumer"),
            ("executor", f"{KERNEL}evidence_validator.py", "consumer"),
            ("executor", f"{KERNEL}genesis_lifecycle.py", "consumer"),
            ("executor", f"{KERNEL}plan_convergence.py", "consumer"),
            ("executor", f"{KERNEL}tool_registry.py", "producer"),
            ("fixture_calibration", f"{KERNEL}agent_genesis.py", "consumer"),
            ("fixture_calibration", f"{KERNEL}fixture_runner.py", "consumer"),
            ("fixture_calibration", f"{KERNEL}genesis_lifecycle.py", "consumer"),
            ("fixture_calibration", f"{KERNEL}shadow_eval_bridge.py", "consumer"),
            ("enterprise_readiness", f"{KERNEL}auto_merge_runners.py", "consumer"),
            ("enterprise_readiness", f"{KERNEL}readiness_proofs.py", "consumer"),
            ("autonomy_unlock", f"{KERNEL}autonomy_ladder.py", "consumer"),
            ("pre_merge_perimeter", f"{KERNEL}merge_authority.py", "producer"),
            ("pre_merge_perimeter", f"{KERNEL}reflection.py", "consumer"),
        }
        undiscovered = sorted(required_discoveries - discovered)
        if undiscovered:
            self.fail("scanner missed required callsites:\n" + "\n".join(map(str, undiscovered)))
        required_surface_discoveries = {
            (
                "workspace_memory_governance",
                f"{KERNEL}trust.py",
                "consumer",
            ),
        }
        undiscovered_surfaces = sorted(
            required_surface_discoveries - discovered_surfaces,
        )
        if undiscovered_surfaces:
            self.fail(
                "scanner missed required rooted surface callsites:\n"
                + "\n".join(map(str, undiscovered_surfaces)),
            )
        self.assertEqual(
            discovered_global_transport_writers,
            set(global_transport_writers),
            "every dynamic cross-surface writer must remain explicitly "
            "classified as global transport",
        )
        for path, rationale in global_transport_writers.items():
            self.assertGreaterEqual(len(rationale), 20)
            self.assertTrue(
                all(path in spec.authority_paths for spec in CAPABILITY_SPECS.values()),
                f"global transport writer is not common authority: {path}",
            )

        unrostered_proof_callsites: set[tuple[str, str, str, str]] = set()
        for capability, surface, relative, role in sorted(
            discovered_capability_surfaces,
        ):
            spec = CAPABILITY_SPECS[capability]
            proof_surfaces = {
                contract.surface for contract in spec.contracts
            } or set(spec.count_surfaces)
            if surface not in proof_surfaces:
                # Count-only telemetry/request surfaces cannot prove the
                # capability, so their readers/writers are observational by
                # contract rather than a per-callsite spelling allowlist.
                continue
            roster = (
                spec.producer_paths
                if role == "producer"
                else spec.authorizing_consumer_paths
            )
            if relative not in roster:
                unrostered_proof_callsites.add(
                    (capability, surface, relative, role),
                )
        legacy_observational_proof_callsites = {
            callsite
            for callsite in unrostered_proof_callsites
            if (callsite[0], callsite[2], callsite[3]) in observational
        }
        categorized_proof_callsites = set().union(
            *proof_observational_categories.values(),
        )
        self.assertEqual(
            unrostered_proof_callsites,
            legacy_observational_proof_callsites | categorized_proof_callsites,
            "proof-surface callsites must be rostered or explicitly observational",
        )
        category_members = [
            callsite
            for members in proof_observational_categories.values()
            for callsite in members
        ]
        self.assertEqual(len(category_members), len(set(category_members)))
        self.assertTrue(
            all(len(category.replace("_", " ")) >= 15 for category in proof_observational_categories),
        )
        self.assertTrue(all(len(reason.strip()) >= 20 for reason in observational.values()))
        stale_observational = sorted(set(observational) - discovered)
        self.assertFalse(
            stale_observational,
            "stale observational classifications:\n"
            + "\n".join(map(str, stale_observational)),
        )
        self.assertTrue(
            all(len(reason.strip()) >= 20 for reason in surface_observational.values()),
        )
        self.assertTrue(set(surface_observational).issubset(discovered_surfaces))

    def test_public_contract_models_normalize_adversarial_mutable_inputs(self) -> None:
        versions = {1}
        contract = EvidenceContract(
            surface="cycles",
            proof_kind="live",
            schema_id=None,
            schema_versions=versions,  # type: ignore[arg-type]
            identity_field="cycle_id",
            integrity_hash_field="ledger_hash",
            authoritative_sha_field="git_head_sha_at_cycle",
            upcaster=lambda row: row,
            terminal_predicate=lambda _row: True,
        )
        authority = ["authority.py"]
        producers = ["producer.py"]
        consumers = ["consumer.py"]
        contracts = [contract]
        surfaces = ["cycles"]
        spec = CapabilitySpec(
            authority_paths=authority,  # type: ignore[arg-type]
            producer_paths=producers,  # type: ignore[arg-type]
            authorizing_consumer_paths=consumers,  # type: ignore[arg-type]
            contracts=contracts,  # type: ignore[arg-type]
            count_surfaces=surfaces,  # type: ignore[arg-type]
        )

        versions.add(2)
        authority.append("other.py")
        producers.clear()
        consumers.clear()
        contracts.clear()
        surfaces.clear()
        self.assertEqual(contract.schema_versions, frozenset({1}))
        self.assertEqual(spec.authority_paths, ("authority.py",))
        self.assertEqual(spec.producer_paths, ("producer.py",))
        self.assertEqual(spec.authorizing_consumer_paths, ("consumer.py",))
        self.assertEqual(spec.contracts, (contract,))
        self.assertEqual(spec.count_surfaces, ("cycles",))

    def test_bounded_identity_matches_remote_root_and_basename_semantics(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aria-bounded-identity-") as tmp:
            repository = Path(tmp) / "repo"
            repository.mkdir()
            _git(repository, "init", "--initial-branch=main", ".")
            _git(
                repository,
                "remote", "add", "origin",
                "git@GitHub.com:Example/ARIA.git",
            )
            self.assertEqual(
                autonomy_evidence_module._bounded_repository_identity(repository),
                canonical_identity(repository),
            )

            _git(repository, "remote", "remove", "origin")
            _git(repository, "config", "user.name", "ARIA Test")
            _git(repository, "config", "user.email", "aria@example.invalid")
            (repository / "seed.txt").write_text("seed\n", encoding="utf-8")
            _git(repository, "add", "seed.txt")
            _git(repository, "commit", "-m", "seed")
            self.assertEqual(
                autonomy_evidence_module._bounded_repository_identity(repository),
                canonical_identity(repository),
            )

            unborn = Path(tmp) / "offline-basename"
            unborn.mkdir()
            _git(unborn, "init", "--initial-branch=main", ".")
            self.assertEqual(
                autonomy_evidence_module._bounded_repository_identity(unborn),
                canonical_identity(unborn),
            )

    def test_bounded_identity_uses_nonempty_remote_output_even_on_nonzero_rc(
        self,
    ) -> None:
        remote = "git@GitHub.com:Example/ARIA.git"

        def identity_git_text(_repo_root, *args):
            if args == ("rev-parse", "--git-common-dir"):
                return 0, ".git"
            if args == ("config", "--get", "remote.origin.url"):
                return 1, remote
            self.fail(f"unexpected fallback query: {args!r}")

        with mock.patch.object(
            autonomy_evidence_module,
            "_git_text_strict",
            side_effect=identity_git_text,
        ):
            observed = autonomy_evidence_module._bounded_repository_identity(
                Path("/tmp/bounded-identity-contract"),
            )
        from aria_kernel.workspace import canonicalize_remote_url

        expected = hashlib.sha256(
            canonicalize_remote_url(remote).encode("utf-8"),
        ).hexdigest()[:16]
        self.assertEqual(observed, expected)


class NativeProofContractTests(unittest.TestCase):
    def test_immutable_ledger_text_rejects_a_torn_tail(self) -> None:
        with self.assertRaises(LedgerIntegrityError) as caught:
            ledger_module.load_jsonl_verified_text("{", source="HEAD:cycles.jsonl")
        self.assertIn("immutable_torn_tail", str(caught.exception))

    def test_contracts_match_current_producer_schemas_without_future_proof(
        self,
    ) -> None:
        self.assertEqual(CAPABILITY_SPECS["pre_merge_perimeter"].contracts, ())

        readiness = CAPABILITY_SPECS["enterprise_readiness"].contracts
        self.assertEqual(len(readiness), 1)
        self.assertEqual(readiness[0].schema_id, "aria/enterprise-readiness-claim/v2")
        self.assertEqual(readiness[0].schema_versions, frozenset({2}))
        self.assertEqual(readiness[0].identity_field, "row_id")
        self.assertEqual(readiness[0].authoritative_sha_field, "head_sha")
        self.assertFalse(readiness[0].terminal_predicate({
            "$schema": "aria/enterprise-readiness-claim/v2",
            "schema_version": 2,
            "claim_row_id": "claim-1",
            "head_sha": "a" * 40,
        }))

        unlock = CAPABILITY_SPECS["autonomy_unlock"].contracts
        self.assertEqual(len(unlock), 1)
        self.assertIsNone(unlock[0].authoritative_sha_field)

    def test_cycle_contract_upcasts_legacy_rows_before_terminal_evaluation(
        self,
    ) -> None:
        candidates, counts, blockers = _evaluate_native_rows(
            "cycle_runtime",
            {"cycles": ({
                "schema_version": 2,
                "cycle_id": "cycle-legacy",
                "event": "completed",
                "git_head_sha_at_cycle": "a" * 40,
                "ledger_hash": "sha256:" + "3" * 64,
            },)},
        )
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].row_id, "cycle-legacy")
        self.assertEqual(counts["terminal"], 1)
        self.assertEqual(blockers, ())

    def test_safe_count_surfaces_are_capability_native(self) -> None:
        expected = {
            "cycle_runtime": ("cycles", "autonomy_state"),
            "executor": (
                "agent_invocation_requests",
                "agent_invocation_results",
                "tools_governance",
            ),
            "finding_funnel": (
                "raw_findings",
                "operator_feedback",
                "findings",
                "promotions",
            ),
            "fixture_calibration": (
                "agent_eval_fixture_runs",
                "calibration_judge",
                "calibration_adapter_reports",
            ),
            "pre_merge_perimeter": ("auto_merge_decisions",),
            "enterprise_readiness": ("enterprise_readiness_claims",),
            "autonomy_unlock": (
                "enterprise_acceptance_events",
                "enterprise_autonomy_unlock_events",
            ),
        }
        self.assertEqual(
            {key: spec.count_surfaces for key, spec in CAPABILITY_SPECS.items()},
            expected,
        )

    def test_every_capability_hash_includes_common_admission_authorities(
        self,
    ) -> None:
        common = {
            "aria-kernel/aria_kernel/autonomy_evidence.py",
            "aria-kernel/aria_kernel/contention_replay.py",
            "aria-kernel/aria_kernel/file_lock.py",
            "aria-kernel/aria_kernel/ledger.py",
            "aria-kernel/aria_kernel/state_manifest.py",
            "aria-kernel/aria_kernel/state_snapshot.py",
            "aria-kernel/aria_kernel/state_store.py",
            "aria-kernel/aria_kernel/tool_registry.py",
            "aria-kernel/aria_kernel/tools_binding.py",
            "aria-kernel/aria_kernel/workspace.py",
            "docs/aria/policy/autonomy-closure-findings.json",
        }
        for key, spec in CAPABILITY_SPECS.items():
            with self.subTest(capability=key):
                self.assertTrue(common.issubset(spec.authority_paths))

        self.assertIn(
            "aria-kernel/aria_kernel/upcasters/cycles.py",
            CAPABILITY_SPECS["cycle_runtime"].authority_paths,
        )
        self.assertIn(
            "aria-kernel/aria_kernel/upcasters/__init__.py",
            CAPABILITY_SPECS["cycle_runtime"].authority_paths,
        )
        self.assertIn(
            "aria-kernel/aria_kernel/runtime_artifacts.py",
            CAPABILITY_SPECS["enterprise_readiness"].authority_paths,
        )

    def test_generic_green_validation_row_does_not_prove_a_capability(
        self,
    ) -> None:
        candidates, counts, blockers = _evaluate_native_rows(
            "cycle_runtime",
            {
                "validation_runs": ({
                    "$schema": "aria/validation-run/v2",
                    "schema_version": 2,
                    "validation_run_id": "vrun-green",
                    "status": "ok",
                    "exit_code": 0,
                    "commit_sha": "a" * 40,
                    "ledger_hash": "sha256:" + "1" * 64,
                },),
            },
        )
        self.assertEqual(candidates, ())
        self.assertEqual(counts, {"rows": 0, "terminal": 0, "admissible": 0})
        self.assertEqual(blockers, ())

    def test_native_terminal_row_requires_identity_integrity_hash_and_sha(
        self,
    ) -> None:
        valid = {
            "schema_version": 3,
            "cycle_id": "cycle-1",
            "event": "completed",
            "status": "completed",
            "git_head_sha_at_cycle": "a" * 40,
            "ledger_hash": "sha256:" + "1" * 64,
        }
        candidates, counts, blockers = _evaluate_native_rows(
            "cycle_runtime", {"cycles": (valid,)},
        )
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].row_id, "cycle-1")
        self.assertEqual(candidates[0].evidence_target_sha, "a" * 40)
        self.assertEqual(counts, {"rows": 1, "terminal": 1, "admissible": 1})
        self.assertEqual(blockers, ())

        mutations = (
            ("cycle_id", None, "proof_identity_missing:cycles"),
            ("ledger_hash", None, "proof_integrity_hash_missing:cycles"),
            (
                "git_head_sha_at_cycle",
                "short",
                "proof_target_sha_invalid:cycles",
            ),
        )
        for field, value, expected_blocker in mutations:
            with self.subTest(field=field):
                row = dict(valid)
                row[field] = value
                candidates, counts, blockers = _evaluate_native_rows(
                    "cycle_runtime", {"cycles": (row,)},
                )
                self.assertEqual(candidates, ())
                self.assertEqual(counts["terminal"], 1)
                self.assertIn(expected_blocker, blockers)

    def test_boolean_schema_version_is_not_an_integer_contract_version(self) -> None:
        row = {
            "schema_version": True,
            "cycle_id": "cycle-bool-version",
            "event": "completed",
            "status": "completed",
            "git_head_sha_at_cycle": "a" * 40,
            "ledger_hash": "sha256:" + "1" * 64,
        }
        candidates, counts, blockers = _evaluate_native_rows(
            "cycle_runtime", {"cycles": (row,)},
        )
        self.assertEqual(candidates, ())
        self.assertEqual(counts["terminal"], 0)
        self.assertIn("proof_schema_unsupported:cycles", blockers)

    def test_schema_less_contract_rejects_present_schema_discriminator(self) -> None:
        valid = {
            "schema_version": 3,
            "cycle_id": "cycle-schema-less",
            "event": "completed",
            "status": "completed",
            "git_head_sha_at_cycle": "a" * 40,
            "ledger_hash": "sha256:" + "1" * 64,
        }
        for supplied_schema in ("aria/foreign-cycle/v99", None, ""):
            with self.subTest(supplied_schema=supplied_schema):
                row = {**valid, "$schema": supplied_schema}
                candidates, counts, blockers = _evaluate_native_rows(
                    "cycle_runtime",
                    {"cycles": (row,)},
                )
                self.assertEqual(candidates, ())
                self.assertEqual(
                    counts,
                    {"rows": 1, "terminal": 0, "admissible": 0},
                )
                self.assertIn("proof_schema_unsupported:cycles", blockers)

    def test_native_upcaster_rejection_is_a_named_nonproof(self) -> None:
        candidates, counts, blockers = _evaluate_native_rows(
            "cycle_runtime",
            {"cycles": ({
                "schema_version": 2,
                "cycle_id": "cycle-unknown-event",
                "event": "invented",
                "git_head_sha_at_cycle": "a" * 40,
                "ledger_hash": "sha256:" + "1" * 64,
            },)},
        )
        self.assertEqual(candidates, ())
        self.assertEqual(counts, {"rows": 1, "terminal": 0, "admissible": 0})
        self.assertIn("proof_upcast_rejected:cycles", blockers)

    def test_native_terminal_exception_is_a_named_nonproof(self) -> None:
        class ExplodingStatus(dict):
            def get(self, key, default=None):  # type: ignore[no-untyped-def]
                if key == "status":
                    raise ValueError("malformed status")
                return super().get(key, default)

        row = ExplodingStatus({
            "$schema": "aria/agent-claim-result/v1",
            "schema_version": 1,
            "row_id": "result-1",
            "ledger_hash": "sha256:" + "1" * 64,
        })
        candidates, counts, blockers = _evaluate_native_rows(
            "executor",
            {"agent_invocation_results": (row,)},
        )
        self.assertEqual(candidates, ())
        self.assertEqual(counts["terminal"], 0)
        self.assertIn(
            "proof_terminal_rejected:agent_invocation_results",
            blockers,
        )

    def test_malformed_readiness_count_is_invalid_not_an_exception(self) -> None:
        counts = _capability_safe_counts(
            "enterprise_readiness",
            {"enterprise_readiness_claims": ({"$schema": []},)},
        )
        self.assertEqual(counts["readiness_valid"], 0)
        self.assertEqual(counts["readiness_invalid"], 1)

    def test_malformed_autonomy_state_count_is_named_and_fail_closed(
        self,
    ) -> None:
        counts, blocker = (
            autonomy_evidence_module._capability_counts_with_blocker(
                "cycle_runtime",
                {"autonomy_state": ({
                    "planner_claims_delta": [1],
                },)},
            )
        )
        self.assertEqual(blocker, "count_rejected:cycle_runtime")
        self.assertEqual(counts["count_rejected"], 1)

    def test_unlock_policy_counting_rejects_bool_versions_and_bad_thresholds(
        self,
    ) -> None:
        valid_policy = {
            "$schema": "aria/autonomy-unlock-policy/v1",
            "schema_version": 1,
            "policy_id": "test",
            "critical_violation_limit": 0,
            "lane_requirements": {
                "L1": {"observe_successes": 30},
                "L2": {
                    "observe_successes": 30,
                    "l1_autonomous_successes": 30,
                    "l2_supervised_successes": 30,
                },
                "L3": {
                    "observe_successes": 30,
                    "l1_autonomous_successes": 30,
                    "l2_supervised_successes": 30,
                    "l2_autonomous_successes": 10,
                    "l3_approval_successes": 5,
                    "rollback_successes": 3,
                },
            },
        }
        for label, mutation in (
            (
                "bool_version",
                lambda policy: policy.update({"schema_version": True}),
            ),
            (
                "list_threshold",
                lambda policy: policy["lane_requirements"]["L1"].update({
                    "observe_successes": [],
                }),
            ),
            (
                "empty_lane",
                lambda policy: policy["lane_requirements"].update({"L1": {}}),
            ),
        ):
            with self.subTest(label=label):
                policy = json.loads(json.dumps(valid_policy))
                mutation(policy)
                with mock.patch.object(
                    autonomy_evidence_module,
                    "_unlock_policy_at_target",
                    return_value=(None, "autonomy_unlock_policy_invalid"),
                ):
                    counts, blocker = autonomy_evidence_module._unlock_verdict_counts(
                        (),
                        repo_root=Path("."),
                        target_sha="a" * 40,
                    )
                self.assertEqual(
                    blocker,
                    "autonomy_unlock_policy_invalid",
                )
                self.assertEqual(
                    counts["autonomy_unlock_policy_available"],
                    0,
                )

    def test_unlock_verdict_count_exception_is_named(self) -> None:
        policy = {
            "$schema": "aria/autonomy-unlock-policy/v1",
            "schema_version": 1,
            "policy_id": "test",
            "critical_violation_limit": 0,
            "lane_requirements": {
                "L1": {"observe_successes": 30},
                "L2": {
                    "observe_successes": 30,
                    "l1_autonomous_successes": 30,
                    "l2_supervised_successes": 30,
                },
                "L3": {
                    "observe_successes": 30,
                    "l1_autonomous_successes": 30,
                    "l2_supervised_successes": 30,
                    "l2_autonomous_successes": 10,
                    "l3_approval_successes": 5,
                    "rollback_successes": 3,
                },
            },
        }
        with mock.patch.object(
            autonomy_evidence_module,
            "_unlock_policy_at_target",
            return_value=(policy, None),
        ), mock.patch(
            "aria_kernel.autonomy_unlock.verdict_from_rows",
            side_effect=TypeError("malformed acceptance rows"),
        ):
            counts, blocker = autonomy_evidence_module._unlock_verdict_counts(
                (),
                repo_root=Path("."),
                target_sha="a" * 40,
            )
        self.assertEqual(blocker, "count_rejected:autonomy_unlock")
        self.assertEqual(counts["count_rejected"], 1)

    def test_executor_result_without_authoritative_sha_cannot_prove_live(
        self,
    ) -> None:
        # ARIA-HIGH-003 — the contract now binds target_sha, so a terminal
        # row missing it (or carrying a malformed / PR-head-only value) is
        # countable history that can never become live_proven.
        candidates, counts, blockers = _evaluate_native_rows(
            "executor",
            {
                "agent_invocation_results": (
                    {
                        "$schema": "aria/agent-claim-result/v1",
                        "schema_version": 1,
                        "row_id": "result:claim-1",
                        "status": "accepted",
                        "ledger_hash": "sha256:" + "2" * 64,
                    },
                    {
                        "$schema": "aria/agent-claim-result/v1",
                        "schema_version": 1,
                        "row_id": "result:claim-2",
                        "status": "accepted",
                        "ledger_hash": "sha256:" + "3" * 64,
                        "target_sha": "not-a-full-sha",
                    },
                ),
            },
        )
        self.assertEqual(candidates, ())
        self.assertEqual(counts, {"rows": 2, "terminal": 2, "admissible": 0})
        self.assertEqual(
            blockers,
            ("proof_target_sha_invalid:agent_invocation_results",),
        )

    def test_executor_result_with_stamped_target_sha_is_admissible(self) -> None:
        candidates, counts, blockers = _evaluate_native_rows(
            "executor",
            {
                "agent_invocation_results": ({
                    "$schema": "aria/agent-claim-result/v1",
                    "schema_version": 1,
                    "row_id": "result:claim-1",
                    "status": "accepted",
                    "ledger_hash": "sha256:" + "2" * 64,
                    "target_sha": "a" * 40,
                },),
            },
        )
        self.assertEqual(blockers, ())
        self.assertEqual(counts, {"rows": 1, "terminal": 1, "admissible": 1})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].evidence_target_sha, "a" * 40)

    def test_fixture_native_schema_reaches_declared_non_live_target_gate(self) -> None:
        base = {
            "$schema": "aria/agent-eval-fixture-run/v1",
            "schema_version": 1,
            "at": "2026-08-23T00:00:00Z",
            "tool_id": "fixture-adapter",
            "tool_version": "1.0.0",
            "tool_manifest_hash": "sha256:" + "1" * 64,
            "fixture_set_hash": "sha256:" + "2" * 64,
            "cycle_id": "cycle-1",
            "fixture_set": "fixtures/fixture-adapter",
            "case_count": 1,
            "fixture_lanes": {"real_repo_baseline": 1},
            "fixture_baseline_passed": True,
            "semantic_fixture_passed": False,
            "failed_cases": [],
            "cases": [{
                "name": "baseline",
                "lane": "real_repo_baseline",
                "path": "fixtures/fixture-adapter/cases/baseline.json",
                "passed": True,
                "errors": [],
                "status": "ok",
                "duration_ms": 1,
                "input_hash": "sha256:" + "3" * 64,
                "output_hash": "sha256:" + "4" * 64,
                "stderr_hash": "sha256:" + "5" * 64,
                "exit_code": 0,
                "timed_out": False,
                "raw_observations_count": 1,
                "raw_findings_count": 0,
                "evidence_validation": {"valid": True},
            }],
            "execution_run_id": "fixture-run-1",
            "passed": True,
            "actual_status": "pass",
            "error_code": None,
            "evidence_hash": "sha256:" + "6" * 64,
            "previous_ledger_hash": None,
            "ledger_hash": "sha256:" + "7" * 64,
        }
        candidates, counts, blockers = _evaluate_native_rows(
            "fixture_calibration",
            {"agent_eval_fixture_runs": ({
                **base,
                "row_type": "fixture_run_suite",
            },)},
        )
        self.assertEqual(candidates, ())
        self.assertEqual(counts, {"rows": 1, "terminal": 1, "admissible": 0})
        self.assertEqual(
            blockers,
            ("proof_target_sha_unavailable:agent_eval_fixture_runs",),
        )

    def test_safe_counts_use_native_non_overlapping_semantics(self) -> None:
        rows = {
            "cycles": tuple(
                {"status": status}
                for status in ("started", "completed", "failed")
            ),
            "autonomy_state": ({"phase": "cycle_completed"},),
            "agent_invocation_requests": ({}, {}),
            "agent_invocation_results": (
                {"status": "accepted"},
                {"status": "rejected"},
                {"status": "other"},
            ),
            "tools_governance": (
                {
                    "kind": "executor_drain_completed",
                    "details": {"attempted": 2, "succeeded": 1, "failed": 1},
                },
                {
                    "kind": "executor_drain_completed",
                    "details": {"attempted": 3, "succeeded": 3, "failed": 0},
                },
            ),
            "raw_findings": (
                {"finding_fingerprint": "fp-1"},
                {"finding_fingerprint": "fp-1"},
                {},
            ),
            "operator_feedback": (
                {"source_type": "ai_consensus", "verdict": "true_positive"},
                {"source_type": "human", "verdict": "true_positive"},
            ),
            "findings": ({},),
            "promotions": (
                {"finding_fingerprint": "fp-1"},
                {"finding_fingerprint": "fp-1"},
                {"finding_fingerprint": "fp-2"},
            ),
            "agent_eval_fixture_runs": (
                {
                    "row_type": "fixture_run_suite",
                    "passed": True,
                    "actual_status": "pass",
                },
                {
                    "row_type": "fixture_run_suite",
                    "passed": True,
                    "actual_status": "fail",
                },
                {"row_type": "legacy", "passed": True},
            ),
            "calibration_judge": ({}, {}),
            "calibration_adapter_reports": ({},),
            "auto_merge_decisions": (
                {"decision": "eligible"},
                {"decision": "blocked", "stage": "pre_merge"},
                {"decision": "merged"},
                {"decision": "failed", "stage": "merge"},
            ),
            "enterprise_readiness_claims": (
                {"valid_for_test": True},
                {"valid_for_test": False},
            ),
            "enterprise_acceptance_events": (
                {"event_type": "observe_success"},
                {"event_type": "observe_success"},
                {"event_type": "critical_violation"},
            ),
            "enterprise_autonomy_unlock_events": (
                {"valid": True},
                {"valid": False},
            ),
        }
        with mock.patch.object(
            autonomy_evidence_module,
            "_enterprise_readiness_v2_terminal",
            side_effect=lambda row: row.get("valid_for_test") is True,
        ):
            counts = {
                capability: _capability_safe_counts(capability, rows)
                for capability in EXPECTED_CAPABILITIES
            }

        self.assertEqual(counts["cycle_runtime"]["cycle_status_completed"], 1)
        self.assertEqual(counts["cycle_runtime"]["cycle_status_failed"], 1)
        self.assertEqual(
            counts["cycle_runtime"]["autonomy_state_transition_count"],
            1,
        )
        self.assertEqual(counts["executor"]["executor_results_accepted"], 1)
        self.assertEqual(counts["executor"]["executor_results_rejected"], 1)
        self.assertEqual(counts["executor"]["executor_drain_attempted"], 5)
        self.assertEqual(counts["executor"]["executor_drain_succeeded"], 4)
        self.assertEqual(counts["executor"]["executor_drain_failed"], 1)
        self.assertEqual(counts["finding_funnel"]["raw_unique_fingerprints"], 1)
        self.assertEqual(counts["finding_funnel"]["ai_consensus_true_positive"], 1)
        self.assertEqual(counts["finding_funnel"]["unique_promoted"], 2)
        self.assertEqual(counts["fixture_calibration"]["fixture_suites_passed"], 1)
        self.assertEqual(counts["fixture_calibration"]["fixture_suites_failed"], 1)
        self.assertEqual(counts["fixture_calibration"]["judge_rows"], 2)
        self.assertEqual(counts["fixture_calibration"]["adapter_rows"], 1)
        self.assertEqual(counts["pre_merge_perimeter"]["premerge_decisions"], 4)
        self.assertEqual(counts["pre_merge_perimeter"]["premerge_stages"], 2)
        self.assertEqual(counts["pre_merge_perimeter"]["premerge_merged"], 1)
        self.assertEqual(counts["enterprise_readiness"]["readiness_valid"], 1)
        self.assertEqual(counts["enterprise_readiness"]["readiness_invalid"], 1)
        self.assertEqual(counts["autonomy_unlock"]["acceptance_observe_success"], 2)
        self.assertEqual(counts["autonomy_unlock"]["unlock_verdict_valid"], 1)
        self.assertEqual(counts["autonomy_unlock"]["unlock_verdict_invalid"], 1)


def _git(cwd: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()


def _write_current_evaluator(repo: Path) -> Path:
    target = repo / "aria-kernel" / "aria_kernel" / "autonomy_evidence.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(Path(autonomy_evidence_module.__file__).read_bytes())
    return target


def _tree_fingerprint(root: Path) -> dict[str, tuple[bytes, int]]:
    return {
        path.relative_to(root).as_posix(): (
            path.read_bytes(),
            path.stat().st_mtime_ns,
        )
        for path in root.rglob("*")
        if path.is_file()
    }


class ImmutableLedgerStreamingTests(unittest.TestCase):
    @staticmethod
    def _row(previous: str | None, row_id: str) -> dict:
        row = {
            "schema_version": 1,
            "row_id": row_id,
            "previous_ledger_hash": previous,
        }
        row["ledger_hash"] = ledger_module._record_hash(row, previous)
        return row

    def test_chunked_verifier_is_strict_without_retaining_rows(self) -> None:
        first = self._row(None, "one")
        second = self._row(first["ledger_hash"], "two")
        payload = (
            json.dumps(first, sort_keys=True)
            + "\n"
            + json.dumps(second, sort_keys=True)
            + "\n"
        ).encode("utf-8")
        observed: list[str] = []

        summary = verify_jsonl_chunks(
            (payload[:7], payload[7:31], payload[31:]),
            source="immutable:test",
            expected_size=len(payload),
            max_line_bytes=1024,
            max_rows=2,
            on_row=lambda row: observed.append(row["row_id"]),
        )

        self.assertEqual(observed, ["one", "two"])
        self.assertEqual(summary["row_count"], 2)
        self.assertEqual(summary["last_hash"], second["ledger_hash"])

    def test_stream_limits_are_availability_failures(self) -> None:
        row = self._row(None, "one")
        payload = (json.dumps(row, sort_keys=True) + "\n").encode("utf-8")
        with self.assertRaises(LedgerReadLimitError):
            verify_jsonl_chunks(
                (payload,),
                source="immutable:line",
                expected_size=len(payload),
                max_line_bytes=8,
                max_rows=10,
            )
        with self.assertRaises(LedgerReadLimitError):
            verify_jsonl_chunks(
                (payload,),
                source="immutable:rows",
                expected_size=len(payload),
                max_line_bytes=1024,
                max_rows=0,
            )

    def test_torn_size_and_pathological_json_remain_integrity_errors(self) -> None:
        row = self._row(None, "one")
        payload = (json.dumps(row, sort_keys=True) + "\n").encode("utf-8")
        with self.assertRaises(LedgerIntegrityError):
            verify_jsonl_chunks(
                (payload[:-9],),
                source="immutable:torn",
                expected_size=len(payload) - 9,
                max_line_bytes=1024,
                max_rows=10,
            )
        with self.assertRaises(LedgerIntegrityError):
            verify_jsonl_chunks(
                (payload,),
                source="immutable:size",
                expected_size=len(payload) + 1,
                max_line_bytes=1024,
                max_rows=10,
            )
        nested = b'{"value":' + (b"[" * 1500) + b"0" + (b"]" * 1500) + b"}\n"
        with self.assertRaises(LedgerIntegrityError):
            verify_jsonl_chunks(
                (nested,),
                source="immutable:nesting",
                expected_size=len(nested),
                max_line_bytes=len(nested),
                max_rows=10,
            )


class TargetBoundGitProofTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-evidence-git-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "--initial-branch=main", ".")
        _git(self.repo, "config", "user.name", "ARIA Test")
        _git(self.repo, "config", "user.email", "aria@example.invalid")
        _git(self.repo, "config", "commit.gpgsign", "false")
        cycle = self.repo / "aria-kernel" / "aria_kernel" / "cycle.py"
        cycle.parent.mkdir(parents=True)
        cycle.write_text("CYCLE = 1\n", encoding="utf-8")
        _write_current_evaluator(self.repo)
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "seed")
        self.event_sha = _git(self.repo, "rev-parse", "HEAD")

    def _cycle_rows(self, event_sha: str | None = None) -> dict[str, tuple[dict, ...]]:
        return {"cycles": ({
            "schema_version": 3,
            "cycle_id": "cycle-1",
            "event": "completed",
            "status": "completed",
            "git_head_sha_at_cycle": event_sha or self.event_sha,
            "ledger_hash": "sha256:" + "1" * 64,
        },)}

    def _derive(self, target_sha: str, event_sha: str | None = None) -> CapabilityEvidence:
        return _derive_capability_evidence(
            capability="cycle_runtime",
            rows_by_surface=self._cycle_rows(event_sha),
            repo_root=self.repo,
            target_sha=target_sha,
            state_commit="b" * 40,
            _test_evaluator_repo_root=self.repo,
        )

    def _commit(self, path: str, content: str, message: str) -> str:
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        _git(self.repo, "add", path)
        _git(self.repo, "commit", "-m", message)
        return _git(self.repo, "rev-parse", "HEAD")

    def test_exact_sha_native_proof_is_live(self) -> None:
        evidence = self._derive(self.event_sha)
        self.assertEqual(evidence.state, "live_proven")
        self.assertEqual(len(evidence.evidence_refs), 1)
        self.assertEqual(
            evidence.evidence_refs[0].capability_authority_hash,
            _capability_authority_hash(
                self.repo, "cycle_runtime", self.event_sha,
            ),
        )

    def test_target_must_contain_the_exact_executing_evaluator(self) -> None:
        self.assertEqual(
            autonomy_evidence_module._evaluator_definition_blocker(
                self.repo,
                self.event_sha,
            ),
            "evaluator_repository_mismatch",
        )
        changed = self._commit(
            "aria-kernel/aria_kernel/autonomy_evidence.py",
            "# historical evaluator\n",
            "change evaluator",
        )
        evidence = self._derive(changed, changed)
        self.assertEqual(evidence.state, "declared")
        self.assertEqual(evidence.evidence_refs, ())
        self.assertIn("evaluator_definition_changed", evidence.blockers)

        _git(
            self.repo,
            "rm",
            "aria-kernel/aria_kernel/autonomy_evidence.py",
        )
        _git(self.repo, "commit", "-m", "remove evaluator")
        missing = _git(self.repo, "rev-parse", "HEAD")
        evidence = self._derive(missing, missing)
        self.assertEqual(evidence.state, "declared")
        self.assertEqual(evidence.evidence_refs, ())
        self.assertIn("evaluator_definition_missing", evidence.blockers)

    def test_target_evaluator_must_be_a_regular_blob(self) -> None:
        evaluator = (
            self.repo / "aria-kernel" / "aria_kernel" /
            "autonomy_evidence.py"
        )
        evaluator.unlink()
        evaluator.symlink_to("../../../README.md")
        _git(self.repo, "add", "aria-kernel/aria_kernel/autonomy_evidence.py")
        _git(self.repo, "commit", "-m", "replace evaluator with symlink")
        target_sha = _git(self.repo, "rev-parse", "HEAD")

        evidence = self._derive(target_sha, target_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertEqual(evidence.evidence_refs, ())
        self.assertIn("evaluator_definition_not_regular", evidence.blockers)

    @unittest.skipUnless(os.name == "posix", "FIFO and no-follow are POSIX-only")
    def test_executing_evaluator_fifo_is_bounded_and_unavailable(self) -> None:
        fifo = Path(self.tmp.name) / "executing-evaluator.fifo"
        os.mkfifo(fifo)

        with mock.patch.object(
            autonomy_evidence_module,
            "__file__",
            str(fifo),
        ):
            blocker = autonomy_evidence_module._evaluator_definition_blocker(
                self.repo,
                self.event_sha,
                evaluator_repo_root=self.repo,
            )

        self.assertEqual(blocker, "evaluator_definition_unavailable")

    @unittest.skipUnless(os.name == "posix", "no-follow is POSIX-only")
    def test_executing_evaluator_symlink_is_not_accepted_by_bytes(self) -> None:
        external = Path(self.tmp.name) / "external-evaluator.py"
        external.write_bytes(Path(autonomy_evidence_module.__file__).read_bytes())
        link = Path(self.tmp.name) / "executing-evaluator.py"
        link.symlink_to(external)

        with mock.patch.object(
            autonomy_evidence_module,
            "__file__",
            str(link),
        ):
            blocker = autonomy_evidence_module._evaluator_definition_blocker(
                self.repo,
                self.event_sha,
                evaluator_repo_root=self.repo,
            )

        self.assertEqual(blocker, "evaluator_definition_unavailable")

    def test_executing_evaluator_changed_during_read_is_unavailable(self) -> None:
        with mock.patch.object(
            state_store_module,
            "_read_bounded_regular_file",
            side_effect=StateStoreError(
                "state_store_host_derivative_changed_during_read",
            ),
        ):
            blocker = autonomy_evidence_module._evaluator_definition_blocker(
                self.repo,
                self.event_sha,
                evaluator_repo_root=self.repo,
            )

        self.assertEqual(blocker, "evaluator_definition_unavailable")

    def test_target_evaluator_size_is_preflighted_before_blob_read(self) -> None:
        evaluator = (
            self.repo / "aria-kernel" / "aria_kernel" /
            "autonomy_evidence.py"
        )
        evaluator.write_bytes(
            b"x" * (autonomy_evidence_module._MAX_EVALUATOR_BLOB_BYTES + 1),
        )
        _git(self.repo, "add", evaluator.relative_to(self.repo).as_posix())
        _git(self.repo, "commit", "-m", "oversized evaluator")
        target = _git(self.repo, "rev-parse", "HEAD")

        self.assertEqual(
            autonomy_evidence_module._evaluator_definition_blocker(
                self.repo,
                target,
                evaluator_repo_root=self.repo,
            ),
            "evaluator_definition_too_large",
        )

    def test_current_transitive_authority_must_match_historical_target(self) -> None:
        self._commit(
            "aria-kernel/aria_kernel/state_snapshot.py",
            "SNAPSHOT = 'new evaluator dependency'\n",
            "change current transitive authority",
        )
        evidence = self._derive(self.event_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertEqual(evidence.evidence_refs, ())
        self.assertIn(
            "evaluator_authority_changed:cycle_runtime",
            evidence.blockers,
        )

    def test_executor_acceptance_delegates_change_the_target_tree_hash(self) -> None:
        previous_sha = self.event_sha
        previous_hash = _capability_authority_hash(
            self.repo,
            "executor",
            previous_sha,
        )
        for ordinal, path in enumerate(EXECUTOR_ACCEPTANCE_AUTHORITY):
            with self.subTest(path=path):
                changed_sha = self._commit(
                    path,
                    f"ACCEPTANCE_AUTHORITY = {ordinal}\n",
                    f"mutate executor acceptance authority {ordinal}",
                )
                changed_hash = _capability_authority_hash(
                    self.repo,
                    "executor",
                    changed_sha,
                )
                self.assertNotEqual(previous_hash, changed_hash)
                previous_sha = changed_sha
                previous_hash = changed_hash

    def test_unchanged_authority_and_unrelated_docs_descendants_preserve_proof(
        self,
    ) -> None:
        readme_sha = self._commit("README.md", "descendant\n", "readme")
        docs_sha = self._commit("docs/note.md", "unrelated\n", "docs")
        self.assertEqual(self._derive(readme_sha).state, "live_proven")
        self.assertEqual(self._derive(docs_sha).state, "live_proven")

    def test_relevant_blob_change_invalidates_proof(self) -> None:
        changed_sha = self._commit(
            "aria-kernel/aria_kernel/cycle.py",
            "CYCLE = 2\n",
            "change cycle",
        )
        evidence = self._derive(changed_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertIn("proof_authority_changed:cycle_runtime", evidence.blockers)

    def test_authority_mode_only_change_invalidates_proof(self) -> None:
        cycle = self.repo / "aria-kernel" / "aria_kernel" / "cycle.py"
        cycle.chmod(0o755)
        _git(self.repo, "add", "aria-kernel/aria_kernel/cycle.py")
        _git(self.repo, "commit", "-m", "make cycle executable")
        changed_sha = _git(self.repo, "rev-parse", "HEAD")

        self.assertNotEqual(
            _capability_authority_hash(
                self.repo, "cycle_runtime", self.event_sha,
            ),
            _capability_authority_hash(
                self.repo, "cycle_runtime", changed_sha,
            ),
        )
        evidence = self._derive(changed_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertIn("proof_authority_changed:cycle_runtime", evidence.blockers)

    def test_regular_to_symlink_with_same_blob_bytes_invalidates_proof(
        self,
    ) -> None:
        cycle = self.repo / "aria-kernel" / "aria_kernel" / "cycle.py"
        original = cycle.read_text(encoding="utf-8")
        cycle.unlink()
        cycle.symlink_to(original)
        _git(self.repo, "add", "aria-kernel/aria_kernel/cycle.py")
        _git(self.repo, "commit", "-m", "replace cycle with symlink")
        changed_sha = _git(self.repo, "rev-parse", "HEAD")

        with self.assertRaisesRegex(
            RuntimeError,
            "git_authority_tree_invalid",
        ):
            _capability_authority_hash(
                self.repo, "cycle_runtime", changed_sha,
            )
        with mock.patch.object(
            autonomy_evidence_module,
            "_evaluator_capability_blocker",
            return_value=None,
        ):
            evidence = self._derive(changed_sha, changed_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertIn("git_authority_tree_invalid", evidence.blockers)

    def test_missing_authority_member_becoming_present_invalidates_proof(self) -> None:
        changed_sha = self._commit(
            "aria-kernel/aria_kernel/autonomy_orchestrator.py",
            "ORCHESTRATOR = True\n",
            "add orchestrator",
        )
        self.assertNotEqual(
            _capability_authority_hash(
                self.repo, "cycle_runtime", self.event_sha,
            ),
            _capability_authority_hash(
                self.repo, "cycle_runtime", changed_sha,
            ),
        )
        evidence = self._derive(changed_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertIn("proof_authority_changed:cycle_runtime", evidence.blockers)

    def test_authority_blob_read_failure_is_unavailable_not_missing(self) -> None:
        real_stream = autonomy_evidence_module._iter_git_output_bounded
        cycle_oid = _git(
            self.repo,
            "rev-parse",
            f"{self.event_sha}:aria-kernel/aria_kernel/cycle.py",
        )

        def fail_existing_blob(repo_root, *args, **kwargs):
            if args == ("cat-file", "blob", cycle_oid):
                raise RuntimeError("injected_blob_read_failure")
            return real_stream(repo_root, *args, **kwargs)

        with mock.patch.object(
            autonomy_evidence_module,
            "_iter_git_output_bounded",
            side_effect=fail_existing_blob,
        ), mock.patch.object(
            autonomy_evidence_module,
            "_evaluator_capability_blocker",
            return_value=None,
        ):
            evidence = self._derive(self.event_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertEqual(evidence.evidence_refs, ())
        self.assertIn("git_authority_blob_unavailable", evidence.blockers)

    def test_authority_size_and_decimal_preflight_are_named(self) -> None:
        cycle = self.repo / "aria-kernel" / "aria_kernel" / "cycle.py"
        cycle.write_bytes(
            b"x" * (autonomy_evidence_module._MAX_AUTHORITY_BLOB_BYTES + 1),
        )
        _git(self.repo, "add", cycle.relative_to(self.repo).as_posix())
        _git(self.repo, "commit", "-m", "oversized authority")
        target = _git(self.repo, "rev-parse", "HEAD")
        with self.assertRaisesRegex(RuntimeError, "git_authority_blob_too_large"):
            _capability_authority_hash(self.repo, "cycle_runtime", target)

        with mock.patch.object(
            autonomy_evidence_module,
            "_run_git",
            return_value=subprocess.CompletedProcess((), 0, b"12x\n", b""),
        ), self.assertRaisesRegex(RuntimeError, "git_blob_size_invalid"):
            autonomy_evidence_module._read_git_blob_bounded(
                self.repo,
                "a" * 40,
                max_bytes=16,
                too_large="test_blob_too_large",
            )

    def test_many_same_sha_proofs_emit_one_witness_with_exact_cardinality(self) -> None:
        row = self._cycle_rows()["cycles"][0]
        rows = {"cycles": (row,) * 100_000}
        with mock.patch.object(
            autonomy_evidence_module,
            "_evaluator_capability_blocker",
            return_value=None,
        ):
            evidence = _derive_capability_evidence(
                capability="cycle_runtime",
                rows_by_surface=rows,
                repo_root=self.repo,
                target_sha=self.event_sha,
                state_commit="b" * 40,
                _test_evaluator_repo_root=self.repo,
            )

        self.assertEqual(evidence.state, "live_proven")
        self.assertEqual(len(evidence.evidence_refs), 1)
        self.assertEqual(evidence.counts["admissible"], 100_000)
        self.assertEqual(sum(evidence.proof_cardinality.values()), 100_000)

    def test_cardinality_counts_only_the_selected_exact_sha_witness(self) -> None:
        target_sha = self._commit("README.md", "descendant\n", "descendant")
        ancestor = dict(self._cycle_rows()["cycles"][0])
        exact = {
            **ancestor,
            "cycle_id": "cycle-exact",
            "git_head_sha_at_cycle": target_sha,
            "ledger_hash": "sha256:" + "2" * 64,
        }
        with mock.patch.object(
            autonomy_evidence_module,
            "_evaluator_capability_blocker",
            return_value=None,
        ):
            evidence = _derive_capability_evidence(
                capability="cycle_runtime",
                rows_by_surface={"cycles": (ancestor, exact)},
                repo_root=self.repo,
                target_sha=target_sha,
                state_commit="b" * 40,
                _test_evaluator_repo_root=self.repo,
            )

        self.assertEqual(evidence.evidence_refs[0].evidence_target_sha, target_sha)
        self.assertEqual(sum(evidence.proof_cardinality.values()), 1)

    def test_cardinality_keeps_duplicates_at_the_selected_sha(self) -> None:
        target_sha = self._commit("README.md", "descendant\n", "descendant")
        ancestor = dict(self._cycle_rows()["cycles"][0])
        exact_one = {
            **ancestor,
            "cycle_id": "cycle-exact-1",
            "git_head_sha_at_cycle": target_sha,
            "ledger_hash": "sha256:" + "2" * 64,
        }
        exact_two = {
            **exact_one,
            "cycle_id": "cycle-exact-2",
            "ledger_hash": "sha256:" + "3" * 64,
        }
        with mock.patch.object(
            autonomy_evidence_module,
            "_evaluator_capability_blocker",
            return_value=None,
        ):
            evidence = _derive_capability_evidence(
                capability="cycle_runtime",
                rows_by_surface={"cycles": (ancestor, exact_one, exact_two)},
                repo_root=self.repo,
                target_sha=target_sha,
                state_commit="b" * 40,
                _test_evaluator_repo_root=self.repo,
            )

        self.assertEqual(evidence.evidence_refs[0].evidence_target_sha, target_sha)
        self.assertEqual(sum(evidence.proof_cardinality.values()), 2)

    def test_distinct_sha_budget_fails_before_history_search(self) -> None:
        rows = {
            "cycles": tuple(
                {
                    **self._cycle_rows()["cycles"][0],
                    "row_id": f"cycle-{index}",
                    "git_head_sha_at_cycle": str(index) * 40,
                }
                for index in range(1, 4)
            ),
        }
        with mock.patch.object(
            autonomy_evidence_module,
            "_MAX_DISTINCT_PROOF_TARGETS_PER_CAPABILITY",
            2,
        ), mock.patch.object(
            autonomy_evidence_module,
            "_ancestry_blocker",
            side_effect=AssertionError("history search must not start"),
        ):
            evidence = _derive_capability_evidence(
                capability="cycle_runtime",
                rows_by_surface=rows,
                repo_root=self.repo,
                target_sha=self.event_sha,
                state_commit="b" * 40,
                _test_evaluator_repo_root=self.repo,
            )
        self.assertIn(
            "proof_distinct_sha_budget_exceeded:cycle_runtime",
            evidence.blockers,
        )

    def test_complete_history_non_ancestor_is_rejected(self) -> None:
        target_sha = self._commit("target.txt", "target\n", "target")
        _git(self.repo, "checkout", "--detach", self.event_sha)
        proof_sha = self._commit("proof.txt", "proof\n", "proof branch")
        evidence = self._derive(target_sha, proof_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertIn("proof_non_ancestor", evidence.blockers)

    def test_squash_pr_head_is_not_proof_for_resulting_main_sha(self) -> None:
        _git(self.repo, "checkout", "-b", "feature", self.event_sha)
        pr_head_sha = self._commit(
            "feature.txt",
            "squash payload\n",
            "feature commit",
        )
        _git(self.repo, "checkout", "main")
        _git(self.repo, "merge", "--squash", "feature")
        _git(self.repo, "commit", "-m", "squash feature")
        resulting_main_sha = _git(self.repo, "rev-parse", "HEAD")

        # Squash preserves a tree change, not ancestry. A producer must emit
        # the verified post-merge SHA rather than treating the PR head or tree
        # equality as authority for the resulting main commit.
        self.assertEqual(
            _ancestry_blocker(
                self.repo,
                evidence_target_sha=pr_head_sha,
                evaluated_target_sha=resulting_main_sha,
            ),
            "proof_non_ancestor",
        )
        self.assertIsNone(
            _ancestry_blocker(
                self.repo,
                evidence_target_sha=resulting_main_sha,
                evaluated_target_sha=resulting_main_sha,
            ),
        )

    def test_missing_history_has_named_unavailable_blockers(self) -> None:
        with mock.patch.object(
            autonomy_evidence_module,
            "_evaluator_capability_blocker",
            return_value=None,
        ):
            missing_target = self._derive("f" * 40)
            self.assertEqual(missing_target.state, "declared")
            self.assertIn("git_target_commit_unavailable", missing_target.blockers)

            missing_event = self._derive(self.event_sha, "e" * 40)
            self.assertEqual(missing_event.state, "declared")
            self.assertIn("git_evidence_commit_unavailable", missing_event.blockers)

    def test_git_history_exception_has_a_named_unavailable_blocker(self) -> None:
        evaluator_patch = mock.patch.object(
            autonomy_evidence_module,
            "_evaluator_capability_blocker",
            return_value=None,
        )
        evaluator_patch.start()
        self.addCleanup(evaluator_patch.stop)
        with mock.patch.object(
            autonomy_evidence_module,
            "_commit_exists",
            side_effect=RuntimeError("injected_git_failure"),
        ):
            evidence = self._derive(self.event_sha)
        self.assertEqual(evidence.state, "declared")
        self.assertEqual(evidence.evidence_refs, ())
        self.assertIn("git_history_unavailable", evidence.blockers)

        target = self._commit("descendant.txt", "descendant\n", "descendant")
        real_run = autonomy_evidence_module._run_git

        def fail_merge_base(repo_root, *args):
            if args and args[0] == "merge-base":
                raise RuntimeError("injected_merge_base_failure")
            return real_run(repo_root, *args)

        with mock.patch.object(
            autonomy_evidence_module,
            "_run_git",
            side_effect=fail_merge_base,
        ):
            evidence = self._derive(target)
        self.assertEqual(evidence.state, "declared")
        self.assertEqual(evidence.evidence_refs, ())
        self.assertIn("git_history_unavailable", evidence.blockers)

        def fail_shallow_probe(repo_root, *args):
            if args and args[0] == "merge-base":
                return subprocess.CompletedProcess(args, 1, b"", b"")
            if args == ("rev-parse", "--is-shallow-repository"):
                raise RuntimeError("injected_shallow_probe_failure")
            return real_run(repo_root, *args)

        with mock.patch.object(
            autonomy_evidence_module,
            "_run_git",
            side_effect=fail_shallow_probe,
        ):
            evidence = self._derive(target)
        self.assertEqual(evidence.state, "declared")
        self.assertEqual(evidence.evidence_refs, ())
        self.assertIn("git_history_unavailable", evidence.blockers)

    def test_shallow_false_ancestry_is_unavailable_not_non_ancestor(self) -> None:
        target_sha = self._commit("target.txt", "target\n", "target")
        remote = Path(self.tmp.name) / "remote.git"
        _git(Path(self.tmp.name), "clone", "--bare", str(self.repo), str(remote))
        shallow = Path(self.tmp.name) / "shallow"
        _git(
            Path(self.tmp.name),
            "clone",
            "--depth=1",
            f"file://{remote}",
            str(shallow),
        )
        _git(shallow, "fetch", "--depth=1", "origin", self.event_sha)

        evidence = _derive_capability_evidence(
            capability="cycle_runtime",
            rows_by_surface=self._cycle_rows(),
            repo_root=shallow,
            target_sha=target_sha,
            state_commit="b" * 40,
            _test_evaluator_repo_root=shallow,
        )
        self.assertEqual(evidence.state, "declared")
        self.assertIn("git_history_unavailable_shallow", evidence.blockers)
        self.assertNotIn("proof_non_ancestor", evidence.blockers)


class ReadOnlyStateAdmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-evidence-state-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.remote = root / "remote.git"
        self.remote.mkdir()
        _git(self.remote, "init", "--bare", "--initial-branch=main", ".")
        self.repo = root / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "--initial-branch=main", ".")
        _git(self.repo, "config", "user.name", "ARIA Test")
        _git(self.repo, "config", "user.email", "aria@example.invalid")
        _git(self.repo, "config", "commit.gpgsign", "false")
        _git(self.repo, "remote", "add", "origin", str(self.remote))
        _write_current_evaluator(self.repo)
        (self.repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "seed")
        _git(self.repo, "push", "origin", "main")
        self.target_sha = _git(self.repo, "rev-parse", "HEAD")
        identity = self.remote.parent.name + "/" + self.remote.name.removesuffix(".git")
        with mock.patch.dict(os.environ, {BOOTSTRAP_ACK_ENV: identity}):
            self.store = checkout_state_store(
                self.repo,
                store_dir=root / "state-store",
            )
        self.tools = tools_root(self.store)

    def _publish(self, *, with_cycle: bool = True) -> None:
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        if with_cycle:
            append_declared_jsonl(
                self.tools / "cycles.jsonl",
                {
                    "schema_version": 3,
                    "cycle_id": "cycle-state-1",
                    "event": "completed",
                    "status": "completed",
                    "git_head_sha_at_cycle": self.target_sha,
                },
                expected_surface="cycles",
            )
        identity = canonical_identity(self.repo)
        snapshot = build_publishable_snapshot(
            self.store,
            snapshot_id="snapshot-state-1",
            cycle_id="cycle-state-1",
            lane="test",
            repo_hash=identity,
        )
        publish_state(
            self.store,
            snapshot=snapshot,
            cycle_id="cycle-state-1",
            repo_hash=identity,
        )

    def _commit_snapshot_mutation(
        self,
        mutation,
        *,
        message: str,
        extra_paths: tuple[str, ...] = (),
    ) -> tuple[str, str]:
        snapshot_path = self.store.root / "snapshot.json"
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        mutation(snapshot)
        snapshot["manifest_root"] = state_snapshot_module.compute_manifest_root(
            snapshot,
        )
        snapshot_path.write_text(
            ledger_module.canonical_json(snapshot) + "\n",
            encoding="utf-8",
        )
        roots = state_store_module.store_roots(
            self.store,
            canonical_identity(self.repo),
        )
        staged = {"snapshot.json", *extra_paths}
        for claim in snapshot.get("surfaces", {}).values():
            if not isinstance(claim, dict):
                continue
            root = roots.get(claim.get("root_kind"))
            relative = claim.get("path")
            if root is None or not isinstance(relative, str):
                continue
            prefix = root.relative_to(self.store.root).as_posix()
            staged.add(f"{prefix}/{relative}")
        _git(self.store.root, "add", "--all", "--", *sorted(staged))
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", message,
        )
        state_commit = _git(self.store.root, "rev-parse", "HEAD")
        snapshot_object_id = _git(
            self.store.root,
            "rev-parse",
            f"{state_commit}:snapshot.json",
        )
        return state_commit, snapshot_object_id

    def _verify_current_snapshot(
        self,
        state_commit: str,
        snapshot_object_id: str,
    ) -> None:
        autonomy_evidence_module._verify_snapshot_and_collect_evidence(
            store=self.store,
            repo_identity=canonical_identity(self.repo),
            state_commit=state_commit,
            expected_snapshot_object_id=snapshot_object_id,
        )

    def _derive_at(
        self,
        *,
        base_dir: Path,
        repo_root: Path,
        target_sha: str,
    ):
        with mock.patch.object(
            autonomy_evidence_module,
            "_executing_repository_root",
            return_value=repo_root,
        ):
            return derive_autonomy_evidence_status(
                base_dir=base_dir,
                repo_root=repo_root,
                target_sha=target_sha,
            )

    def _derive(self):
        return self._derive_at(
            base_dir=self.tools,
            repo_root=self.repo,
            target_sha=self.target_sha,
        )

    def _assert_unavailable(self, expected_blocker: str) -> None:
        status = self._derive()
        self.assertIn(expected_blocker, status.blockers)
        for capability in status.capabilities.values():
            self.assertEqual(capability.evidence_refs, ())
            self.assertEqual(capability.counts, {"unavailable": 1})

    def _derive_with_outer_hashless_kg(self, *, mixed: bool):
        self._publish(with_cycle=False)
        relative = "knowledge-graph/conventions.jsonl"
        path = self.tools / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if mixed:
            append_declared_jsonl(
                path,
                {
                    "kind": "convention",
                    "name": "outer-chained",
                    "prev_row_hash": knowledge_graph_module.GENESIS_PREV_HASH,
                },
                expected_surface="kg_conventions",
            )
            first = json.loads(path.read_text(encoding="utf-8"))
            rows = [
                first,
                {
                    "kind": "convention",
                    "name": "legacy-tail",
                    "prev_row_hash": knowledge_graph_module._row_hash(first),
                },
            ]
        else:
            first = {
                "kind": "convention",
                "name": "legacy-first",
                "prev_row_hash": knowledge_graph_module.GENESIS_PREV_HASH,
            }
            rows = [
                first,
                {
                    "kind": "convention",
                    "name": "legacy-second",
                    "prev_row_hash": knowledge_graph_module._row_hash(first),
                },
            ]
        payload = "".join(
            ledger_module.canonical_json(row) + "\n"
            for row in rows
        ).encode("utf-8")
        path.write_bytes(payload)

        def attest_legacy_kg(snapshot):
            snapshot["surfaces"]["kg_conventions"] = {
                "path": relative,
                "root_kind": "tools",
                "state_class": "ledger",
                "storage": "carried",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size_bytes": len(payload),
                "segments": [relative],
                "chain_valid": True,
                "row_count": len(rows),
                "tail_ledger_hash": (
                    first.get("ledger_hash")
                    or knowledge_graph_module._row_hash(rows[-1])
                ),
            }

        state_commit, _snapshot_object_id = self._commit_snapshot_mutation(
            attest_legacy_kg,
            message="attest legacy knowledge graph",
            extra_paths=(f"tools/{relative}",),
        )
        _git(
            self.store.root,
            "push",
            self.store.remote,
            f"{state_commit}:refs/heads/{self.store.branch}",
        )
        _git(
            self.store.root,
            "update-ref",
            f"refs/remotes/{self.store.remote}/{self.store.branch}",
            state_commit,
        )
        return self._derive()

    def test_public_derivation_never_calls_unbounded_workspace_identity(self) -> None:
        self._publish()
        with mock.patch(
            "aria_kernel.workspace.canonical_identity",
            side_effect=AssertionError("unbounded canonical_identity was called"),
        ):
            status = self._derive()
        self.assertEqual(status.capabilities["cycle_runtime"].state, "live_proven")

    def test_bounded_repository_identity_failure_is_named_and_fails_closed(
        self,
    ) -> None:
        self._publish()
        real_git_text = autonomy_evidence_module._git_text_strict

        def fail_identity_query(repo_root, *args):
            if args == ("config", "--get", "remote.origin.url"):
                raise RuntimeError("git_history_unavailable")
            return real_git_text(repo_root, *args)

        with mock.patch.object(
            autonomy_evidence_module,
            "_git_text_strict",
            side_effect=fail_identity_query,
        ):
            self._assert_unavailable("state_repository_identity_unavailable")

    def test_malformed_utf8_repository_identity_fails_closed_by_name(self) -> None:
        self._publish()
        real_run_git = autonomy_evidence_module._run_git

        def malformed_remote(repo_root, *args):
            if args == ("config", "--get", "remote.origin.url"):
                return subprocess.CompletedProcess(args, 0, b"\xff", b"")
            return real_run_git(repo_root, *args)

        with mock.patch.object(
            autonomy_evidence_module,
            "_run_git",
            side_effect=malformed_remote,
        ):
            self._assert_unavailable("state_repository_identity_unavailable")

    def test_published_bound_clean_store_is_admitted_and_ignored_identity_is_nonproof(
        self,
    ) -> None:
        self._publish()
        identity_before = (self.tools / "repo_identity.json").read_bytes()

        status = self._derive()

        self.assertEqual(status.capabilities["cycle_runtime"].state, "live_proven")
        self.assertEqual(status.capabilities["cycle_runtime"].counts["cycles"], 1)
        self.assertEqual(
            status.capabilities["finding_funnel"].counts["raw_findings"],
            0,
        )
        self.assertNotEqual(
            status.capabilities["finding_funnel"].counts,
            {"unavailable": 1},
        )
        self.assertEqual(
            status.capabilities["cycle_runtime"].evidence_refs[0].state_commit,
            _git(self.store.root, "rev-parse", "HEAD"),
        )
        self.assertEqual(
            (self.tools / "repo_identity.json").read_bytes(),
            identity_before,
        )
        self.assertNotIn(
            "legacy_kg_canonical_migration_required",
            status.blockers,
        )

    def test_legacy_kg_requires_operator_migration_before_activation(self) -> None:
        status = self._derive_with_outer_hashless_kg(mixed=False)

        self.assertEqual(status.overall_state, "operator_blocked")
        for capability in ("enterprise_readiness", "autonomy_unlock"):
            self.assertEqual(status.capabilities[capability].state, "operator_blocked")
            self.assertIn(
                "legacy_kg_canonical_migration_required",
                status.capabilities[capability].blockers,
            )

    def test_mixed_outer_and_legacy_kg_requires_same_operator_migration(self) -> None:
        status = self._derive_with_outer_hashless_kg(mixed=True)

        self.assertEqual(status.overall_state, "operator_blocked")
        for capability in ("enterprise_readiness", "autonomy_unlock"):
            self.assertEqual(status.capabilities[capability].state, "operator_blocked")
            self.assertIn(
                "legacy_kg_canonical_migration_required",
                status.capabilities[capability].blockers,
            )

    def test_dirty_current_authority_worktree_rejects_public_derivation(self) -> None:
        self._publish()
        dirty = self.repo / "aria-kernel" / "aria_kernel" / "state_snapshot.py"
        dirty.write_text("DIRTY = True\n", encoding="utf-8")

        self._assert_unavailable("evaluator_authority_worktree_dirty")

    def test_ignored_current_authority_worktree_is_also_rejected(self) -> None:
        self._publish()
        relative = "aria-kernel/aria_kernel/state_snapshot.py"
        exclude = Path(_git(self.repo, "rev-parse", "--git-path", "info/exclude"))
        if not exclude.is_absolute():
            exclude = self.repo / exclude
        exclude.write_text(relative + "\n", encoding="utf-8")
        dirty = self.repo / relative
        dirty.write_text("IGNORED_DIRTY = True\n", encoding="utf-8")
        self.assertEqual(_git(self.repo, "status", "--porcelain"), "")

        self._assert_unavailable("evaluator_authority_worktree_dirty")

    def test_stale_arbitrary_host_bound_root_is_named_invalid(self) -> None:
        self._publish()
        identity_path = self.tools / "repo_identity.json"
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        identity["bound_repo_root"] = str(Path(self.tmp.name) / "foreign-clone")
        identity_path.write_text(json.dumps(identity), encoding="utf-8")

        self._assert_unavailable("state_repository_identity_invalid")

    @unittest.skipUnless(os.name == "posix", "FIFO and no-follow are POSIX-only")
    def test_identity_fifo_is_bounded_and_fail_closed(self) -> None:
        self._publish()
        identity_path = self.tools / "repo_identity.json"
        identity_path.unlink()
        os.mkfifo(identity_path)

        self._assert_unavailable("state_repository_identity_mismatch")

    @unittest.skipUnless(os.name == "posix", "no-follow is POSIX-only")
    def test_contract_symlink_cannot_supply_external_valid_json(self) -> None:
        self._publish()
        contract_path = self.tools / "tools_contract.json"
        external = Path(self.tmp.name) / "external-tools-contract.json"
        external.write_bytes(contract_path.read_bytes())
        contract_path.unlink()
        contract_path.symlink_to(external)

        self._assert_unavailable("state_tools_contract_identity_mismatch")

    def test_dirty_store_returns_before_any_snapshot_verifier(self) -> None:
        self._publish()
        external = Path(self.tmp.name) / "external-huge"
        external.touch()
        os.truncate(external, 256 * 1024 * 1024)
        (self.store.root / "hostile-link").symlink_to(external)

        with mock.patch.object(
            autonomy_evidence_module,
            "_read_immutable_snapshot_claim",
            side_effect=AssertionError("dirty store must return before snapshot"),
        ), mock.patch.object(
            state_store_module,
            "verify_state_store",
            side_effect=AssertionError("legacy mutable verifier is forbidden"),
        ):
            self._assert_unavailable("state_store_dirty")

    def test_full_immutable_snapshot_rejects_unconsumed_surface_mismatch(self) -> None:
        self._publish()
        admitted = autonomy_evidence_module._capture_state_admission(
            store=self.store,
            repo_identity=canonical_identity(self.repo),
        )
        contract = self.tools / "tools_contract.json"
        contract.write_text(contract.read_text(encoding="utf-8") + " ", encoding="utf-8")
        _git(self.store.root, "add", "tools/tools_contract.json")
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "tamper unconsumed surface",
        )
        tampered_commit = _git(self.store.root, "rev-parse", "HEAD")

        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_surface_mismatch:tools_contract",
        ):
            autonomy_evidence_module._verify_snapshot_and_collect_evidence(
                store=self.store,
                repo_identity=canonical_identity(self.repo),
                state_commit=tampered_commit,
                expected_snapshot_object_id=admitted.snapshot_object_id or "",
            )

    def test_immutable_state_requires_genesis_in_both_parent_and_current_tree(
        self,
    ) -> None:
        self._publish(with_cycle=False)
        _git(self.store.root, "rm", "GENESIS")
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "drop genesis",
        )
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "--allow-empty", "-m", "descendant without genesis",
        )
        state_commit = _git(self.store.root, "rev-parse", "HEAD")
        snapshot_object_id = _git(
            self.store.root,
            "rev-parse",
            f"{state_commit}:snapshot.json",
        )

        with self.assertRaisesRegex(RuntimeError, "state_snapshot_genesis_missing"):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_unconsumed_ledger_metadata_is_recomputed_from_stream(self) -> None:
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        append_declared_jsonl(
            self.tools / "runs.jsonl",
            {"schema_version": 1, "run_id": "unconsumed-run"},
            expected_surface="runs",
        )
        self._publish()

        def forge_metadata(snapshot):
            claim = snapshot["surfaces"]["runs"]
            claim["row_count"] += 1
            claim["tail_ledger_hash"] = "sha256:" + ("0" * 64)

        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            forge_metadata,
            message="forge unconsumed ledger metadata",
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_surface_mismatch:runs",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_unconsumed_ledger_chain_is_strictly_verified(self) -> None:
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        append_declared_jsonl(
            self.tools / "runs.jsonl",
            {"schema_version": 1, "run_id": "unconsumed-run"},
            expected_surface="runs",
        )
        self._publish()
        runs_path = self.tools / "runs.jsonl"
        row = json.loads(runs_path.read_text(encoding="utf-8"))
        row["ledger_hash"] = "sha256:" + ("0" * 64)
        runs_path.write_text(json.dumps(row, sort_keys=True) + "\n", encoding="utf-8")

        def attest_broken_bytes(snapshot):
            claim = snapshot["surfaces"]["runs"]
            payload = runs_path.read_bytes()
            claim["sha256"] = hashlib.sha256(payload).hexdigest()
            claim["size_bytes"] = len(payload)

        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            attest_broken_bytes,
            message="attest broken unconsumed ledger",
        )
        with self.assertRaises(LedgerIntegrityError):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_immutable_glob_surface_binds_replay_transport_to_claim_path(
        self,
    ) -> None:
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        august_relative = "cost-attribution/2026-08.jsonl"
        september_relative = "cost-attribution/2026-09.jsonl"
        august_path = self.tools / august_relative
        september_path = self.tools / september_relative
        producer_payload = {
            "schema_version": 1,
            "event": "cost_observed",
            "month": "2026-08",
        }
        producer_event_id = ledger_module._record_hash(producer_payload, None)
        append_declared_jsonl(
            august_path,
            ledger_module._make_replay_transport_row(
                producer_payload,
                expected_surface="cost_attribution",
                surface_instance=august_relative,
                producer_event_id=producer_event_id,
                producer_previous_ledger_hash=None,
                replay_transaction_id="snapshot-instance-binding",
            ),
            expected_surface="cost_attribution",
        )
        self._publish(with_cycle=False)

        september_path.parent.mkdir(parents=True, exist_ok=True)
        september_path.write_bytes(august_path.read_bytes())
        august_path.unlink()

        def move_claim_without_rebinding_envelope(snapshot):
            surfaces = snapshot["surfaces"]
            old_key = f"cost_attribution:{august_relative}"
            new_key = f"cost_attribution:{september_relative}"
            claim = surfaces.pop(old_key)
            claim["path"] = september_relative
            claim["segments"] = [september_relative]
            surfaces[new_key] = claim

        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            move_claim_without_rebinding_envelope,
            message="move replay envelope across glob instances",
            extra_paths=(
                f"tools/{august_relative}",
                f"tools/{september_relative}",
            ),
        )

        with self.assertRaisesRegex(
            LedgerIntegrityError,
            "replay_transport_surface_instance_mismatch",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_snapshot_top_level_and_projection_metadata_are_exact(self) -> None:
        self._publish()
        original = json.loads(
            (self.store.root / "snapshot.json").read_text(encoding="utf-8"),
        )
        mutations = {
            "extra": lambda snapshot: snapshot.update({"alien": True}),
            "missing": lambda snapshot: snapshot.pop("cycle_id"),
            "schema-bool": lambda snapshot: snapshot.update({"schema_version": True}),
            "snapshot-id-type": lambda snapshot: snapshot.update({"snapshot_id": 1}),
            "cycle-id-type": lambda snapshot: snapshot.update({"cycle_id": []}),
            "lane-type": lambda snapshot: snapshot.update({"lane": False}),
            "parent-type": lambda snapshot: snapshot.update({"parent_commit": 1}),
            "previous-id-type": lambda snapshot: snapshot.update({"prev_snapshot_id": []}),
            "previous-root-type": lambda snapshot: snapshot.update({"prev_manifest_root": 1}),
            "root-order": lambda snapshot: snapshot.update({
                "root_kinds": list(reversed(snapshot["root_kinds"])),
            }),
            "root-missing": lambda snapshot: snapshot.update({
                "root_kinds": snapshot["root_kinds"][:-1],
            }),
            "artifact-extra": lambda snapshot: snapshot.update({
                "artifact_only_surfaces": ["not-a-surface"],
            }),
            "artifact-item-type": lambda snapshot: snapshot.update({
                "artifact_only_surfaces": [{"not": "a string"}],
            }),
            "ledger-chain-bool": lambda snapshot: next(
                claim for claim in snapshot["surfaces"].values()
                if claim["state_class"] == "ledger"
            ).update({"chain_valid": 1}),
            "ledger-row-count-bool": lambda snapshot: next(
                claim for claim in snapshot["surfaces"].values()
                if claim["state_class"] == "ledger"
            ).update({"row_count": True}),
            "ledger-row-count-float": lambda snapshot: next(
                claim for claim in snapshot["surfaces"].values()
                if claim["state_class"] == "ledger"
            ).update({"row_count": 1.0}),
            "ledger-tail-type": lambda snapshot: next(
                claim for claim in snapshot["surfaces"].values()
                if claim["state_class"] == "ledger"
            ).update({"tail_ledger_hash": 7}),
            "relative-path-not-normalized": lambda snapshot: next(
                claim for claim in snapshot["surfaces"].values()
                if claim["state_class"] == "ledger"
            ).update({
                "path": "./runs.jsonl",
                "segments": ["./runs.jsonl"],
            }),
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                candidate = json.loads(json.dumps(original))
                mutation(candidate)
                candidate["manifest_root"] = (
                    state_snapshot_module.compute_manifest_root(candidate)
                )
                payload = ledger_module.canonical_json(candidate).encode("utf-8")
                with mock.patch.object(
                    autonomy_evidence_module,
                    "_git_tree_entry",
                    return_value=(b"entry", "100644", "blob", "a" * 40),
                ), mock.patch.object(
                    autonomy_evidence_module,
                    "_read_git_blob_bounded",
                    return_value=payload,
                ), self.assertRaisesRegex(RuntimeError, "state_snapshot_invalid"):
                    autonomy_evidence_module._read_immutable_snapshot_claim(
                        self.store.root,
                        "b" * 40,
                    )

    def test_tree_parser_rejects_overlong_and_deep_paths_by_name(self) -> None:
        metadata = b"100644 blob " + (b"a" * 40) + b"\t"
        cases = {
            "state_snapshot_tree_path_too_long": b"x" * 4097,
            "state_snapshot_tree_path_too_deep": b"/".join(
                [b"component"] * 129,
            ),
        }
        for expected, path in cases.items():
            with self.subTest(expected=expected), mock.patch.object(
                autonomy_evidence_module,
                "_iter_git_output_bounded",
                return_value=(metadata + path + b"\0",),
            ), self.assertRaisesRegex(RuntimeError, expected):
                autonomy_evidence_module._git_tree_entries(
                    self.store.root,
                    "a" * 40,
                )

    def test_state_commit_parent_resolution_is_single_parent_and_fail_closed(
        self,
    ) -> None:
        state_commit = "a" * 40
        cases = {
            "state_snapshot_parent_unavailable": subprocess.CompletedProcess(
                (),
                1,
                b"",
                b"",
            ),
            "state_snapshot_parent_invalid": subprocess.CompletedProcess(
                (),
                0,
                f"{state_commit} {'b' * 40} {'c' * 40}\n".encode("ascii"),
                b"",
            ),
        }
        for expected, result in cases.items():
            with self.subTest(expected=expected), mock.patch.object(
                autonomy_evidence_module,
                "_run_git",
                return_value=result,
            ), self.assertRaisesRegex(RuntimeError, expected):
                autonomy_evidence_module._state_commit_single_parent(
                    self.store.root,
                    state_commit,
                )

    def test_snapshot_glob_matcher_has_path_glob_component_semantics(self) -> None:
        root = Path(self.tmp.name) / "glob-fixture"
        candidates = (
            "dispatch/direct.jsonl",
            "dispatch/nested/rejected.jsonl",
            "agent-invocations/outputs/direct.md",
            "agent-invocations/outputs/group/one.md",
            "agent-invocations/outputs/group/deep/two.md",
        )
        for relative in candidates:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(relative, encoding="utf-8")
        for pattern in (
            "dispatch/*.jsonl",
            "agent-invocations/outputs/**/*.md",
        ):
            canonical = {
                path.relative_to(root).as_posix()
                for path in root.glob(pattern)
            }
            for relative in candidates:
                with self.subTest(pattern=pattern, relative=relative):
                    self.assertEqual(
                        state_manifest_module.surface_path_matches(
                            relative,
                            pattern,
                        ),
                        relative in canonical,
                    )

    def test_excluded_surface_claim_is_rejected(self) -> None:
        self._publish()
        lock_path = self.tools / "locks" / "autonomous-host.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text("not snapshot state\n", encoding="utf-8")

        def claim_excluded(snapshot):
            payload = lock_path.read_bytes()
            snapshot["surfaces"]["autonomous_host_local_lease"] = {
                "path": "locks/autonomous-host.lock",
                "root_kind": "tools",
                "state_class": "lock",
                "storage": "excluded",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size_bytes": len(payload),
                "segments": ["locks/autonomous-host.lock"],
            }

        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            claim_excluded,
            message="claim excluded lock",
        )
        with self.assertRaisesRegex(RuntimeError, "state_snapshot_invalid"):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_unclaimed_declared_symlink_is_rejected(self) -> None:
        self._publish(with_cycle=False)
        queue_path = self.tools / "queues" / "next_cycle_queue.jsonl"
        queue_path.parent.mkdir(parents=True, exist_ok=True)
        queue_path.symlink_to("../../GENESIS")
        _git(self.store.root, "add", "--all", ".")
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "unclaimed symlink surface",
        )
        state_commit = _git(self.store.root, "rev-parse", "HEAD")
        snapshot_object_id = _git(
            self.store.root,
            "rev-parse",
            f"{state_commit}:snapshot.json",
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_unclaimed_surface:next_cycle_queue",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_declared_tools_root_symlink_is_rejected_with_empty_claims(self) -> None:
        self._publish(with_cycle=False)
        external = self.store.root.parent / "external-tools"
        self.tools.rename(external)
        self.tools.symlink_to(external, target_is_directory=True)

        def clear_claims(snapshot):
            snapshot["surfaces"].clear()

        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            clear_claims,
            message="replace tools root with symlink",
            extra_paths=("tools",),
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_root_not_tree:tools",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_declared_tools_root_gitlink_is_rejected_with_empty_claims(self) -> None:
        self._publish(with_cycle=False)
        snapshot_path = self.store.root / "snapshot.json"
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        snapshot["surfaces"].clear()
        snapshot["manifest_root"] = state_snapshot_module.compute_manifest_root(
            snapshot,
        )
        snapshot_path.write_text(
            ledger_module.canonical_json(snapshot) + "\n",
            encoding="utf-8",
        )
        _git(self.store.root, "add", "snapshot.json")
        _git(self.store.root, "rm", "-r", "--cached", "tools")
        _git(
            self.store.root,
            "update-index",
            "--add",
            "--cacheinfo",
            f"160000,{self.target_sha},tools",
        )
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "replace tools root with gitlink",
        )
        state_commit = _git(self.store.root, "rev-parse", "HEAD")
        snapshot_object_id = _git(
            self.store.root,
            "rev-parse",
            f"{state_commit}:snapshot.json",
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_root_not_tree:tools",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_workspace_ancestor_symlink_is_rejected(self) -> None:
        self._publish(with_cycle=False)
        workspace = self.store.root / "workspace"
        external = self.store.root.parent / "external-workspace"
        workspace.rename(external)
        workspace.symlink_to(external, target_is_directory=True)
        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            lambda _snapshot: None,
            message="replace workspace ancestor with symlink",
            extra_paths=("workspace",),
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_root_not_tree:workspace",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_workspace_identity_root_symlink_is_rejected(self) -> None:
        self._publish(with_cycle=False)
        identity = canonical_identity(self.repo)
        workspace_root = self.store.root / "workspace" / identity
        workspace_root.parent.mkdir(parents=True, exist_ok=True)
        workspace_root.symlink_to(
            self.store.root.parent / "outside-workspace-identity",
            target_is_directory=True,
        )
        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            lambda _snapshot: None,
            message="replace workspace identity root with symlink",
            extra_paths=(f"workspace/{identity}",),
        )
        with self.assertRaisesRegex(
            RuntimeError,
            f"state_snapshot_root_not_tree:workspace/{identity}",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_unknown_immutable_tree_entry_is_rejected(self) -> None:
        self._publish(with_cycle=False)
        unknown = self.store.root / "secret.txt"
        unknown.write_text("must remain local\n", encoding="utf-8")
        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            lambda _snapshot: None,
            message="add unknown immutable tree entry",
            extra_paths=("secret.txt",),
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_unclaimed_tree_entry:secret.txt",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_nonempty_bootstrap_marker_is_rejected(self) -> None:
        self._publish(with_cycle=False)
        marker = self.tools / ".gitkeep"
        marker.write_text("not empty\n", encoding="utf-8")
        state_commit, snapshot_object_id = self._commit_snapshot_mutation(
            lambda _snapshot: None,
            message="mutate bootstrap marker",
            extra_paths=("tools/.gitkeep",),
        )
        with self.assertRaisesRegex(
            RuntimeError,
            r"state_snapshot_bootstrap_marker_invalid:tools/\.gitkeep",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_missing_optional_bootstrap_marker_is_admitted(self) -> None:
        self._publish(with_cycle=False)
        marker = self.store.root / "workspace" / ".gitkeep"
        marker.unlink()
        _git(self.store.root, "add", "--all", "--", "workspace/.gitkeep")
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "remove optional bootstrap marker",
        )
        state_commit = _git(self.store.root, "rev-parse", "HEAD")
        snapshot_object_id = _git(
            self.store.root,
            "rev-parse",
            f"{state_commit}:snapshot.json",
        )
        self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_unclaimed_declared_gitlink_is_rejected(self) -> None:
        self._publish(with_cycle=False)
        _git(
            self.store.root,
            "update-index", "--add", "--cacheinfo",
            f"160000,{self.target_sha},tools/queues/next_cycle_queue.jsonl",
        )
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "unclaimed gitlink surface",
        )
        state_commit = _git(self.store.root, "rev-parse", "HEAD")
        snapshot_object_id = _git(
            self.store.root,
            "rev-parse",
            f"{state_commit}:snapshot.json",
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_unclaimed_surface:next_cycle_queue",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_fixed_surface_directory_children_are_rejected(self) -> None:
        self._publish(with_cycle=False)
        directory = self.tools / "queues" / "next_cycle_queue.jsonl"
        directory.mkdir(parents=True)
        (directory / "child").write_text("alien\n", encoding="utf-8")
        _git(self.store.root, "add", "--all", ".")
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "replace fixed surface with directory",
        )
        state_commit = _git(self.store.root, "rev-parse", "HEAD")
        snapshot_object_id = _git(
            self.store.root,
            "rev-parse",
            f"{state_commit}:snapshot.json",
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_unclaimed_surface:next_cycle_queue",
        ):
            self._verify_current_snapshot(state_commit, snapshot_object_id)

    def test_snapshot_surface_size_budget_is_named_before_stream(self) -> None:
        self._publish()
        admitted = autonomy_evidence_module._capture_state_admission(
            store=self.store,
            repo_identity=canonical_identity(self.repo),
        )
        contract_oid = _git(
            self.store.root,
            "rev-parse",
            f"{admitted.state_commit}:tools/tools_contract.json",
        )
        real_size = autonomy_evidence_module._git_blob_size

        def oversized_contract(repo_root, object_id, **kwargs):
            if object_id == contract_oid:
                raise RuntimeError("state_snapshot_surface_too_large:tools_contract")
            return real_size(repo_root, object_id, **kwargs)

        with mock.patch.object(
            autonomy_evidence_module,
            "_git_blob_size",
            side_effect=oversized_contract,
        ), self.assertRaisesRegex(
            RuntimeError,
            "state_snapshot_surface_too_large:tools_contract",
        ):
            autonomy_evidence_module._verify_snapshot_and_collect_evidence(
                store=self.store,
                repo_identity=canonical_identity(self.repo),
                state_commit=admitted.state_commit or "",
                expected_snapshot_object_id=admitted.snapshot_object_id or "",
            )

    def test_evidence_read_folds_autonomy_state_without_writing_any_file(self) -> None:
        self._publish()
        before = _tree_fingerprint(self.store.root)
        with mock.patch(
            "aria_kernel.autonomy_state.autonomy_state_path",
            side_effect=AssertionError("bootstrap path is forbidden"),
        ):
            status = self._derive()
        after = _tree_fingerprint(self.store.root)

        self.assertEqual(before, after)
        self.assertEqual(
            status.capabilities["cycle_runtime"].counts[
                "autonomy_state_transition_count"
            ],
            0,
        )

    def test_evidence_git_reads_do_not_refresh_the_linked_worktree_index(self) -> None:
        self._publish()
        index_path = Path(_git(self.store.root, "rev-parse", "--git-path", "index"))
        before = (index_path.read_bytes(), index_path.stat().st_mtime_ns)

        self._derive()

        after = (index_path.read_bytes(), index_path.stat().st_mtime_ns)
        self.assertEqual(after, before)

    def test_rows_and_counts_are_loaded_from_admitted_head_not_worktree(self) -> None:
        self._publish()
        cycle_path = self.tools / "cycles.jsonl"
        original = cycle_path.read_bytes()
        spoof = {
            "schema_version": 3,
            "cycle_id": "cycle-worktree-spoof",
            "event": "completed",
            "status": "completed",
            "git_head_sha_at_cycle": self.target_sha,
            "previous_ledger_hash": None,
        }
        spoof["ledger_hash"] = ledger_module._record_hash(spoof)
        real_load = autonomy_evidence_module._load_counted_rows

        def spoof_during_load(*args, **kwargs):
            cycle_path.write_text(
                ledger_module.canonical_json(spoof) + "\n",
                encoding="utf-8",
            )
            try:
                return real_load(*args, **kwargs)
            finally:
                cycle_path.write_bytes(original)

        with mock.patch.object(
            autonomy_evidence_module,
            "_load_counted_rows",
            side_effect=spoof_during_load,
        ), mock.patch.object(
            ledger_module,
            "load_declared_jsonl",
            side_effect=AssertionError("mutable state loader is forbidden"),
        ):
            status = self._derive()

        cycle = status.capabilities["cycle_runtime"]
        self.assertEqual(cycle.counts["cycles"], 1)
        self.assertEqual(cycle.evidence_refs[0].row_id, "cycle-state-1")
        self.assertNotEqual(cycle.evidence_refs[0].row_id, spoof["cycle_id"])

    def test_missing_and_raw_state_stores_are_named_unavailable(self) -> None:
        missing = self._derive_at(
            base_dir=Path(self.tmp.name) / "missing" / "tools",
            repo_root=self.repo,
            target_sha=self.target_sha,
        )
        self.assertIn("state_tools_unavailable", missing.blockers)
        self._publish()
        raw_store = Path(self.tmp.name) / "raw-state-clone"
        _git(
            Path(self.tmp.name),
            "clone",
            "--single-branch",
            "--branch", "aria/state",
            str(self.remote),
            str(raw_store),
        )
        raw = raw_store / "tools"
        (raw / "repo_identity.json").write_text(
            json.dumps({
                "schema_version": 3,
                "aria_tools_contract_version": 3,
                "bound_canonical_identity": canonical_identity(self.repo),
            }),
            encoding="utf-8",
        )
        raw_status = self._derive_at(
            base_dir=raw,
            repo_root=self.repo,
            target_sha=self.target_sha,
        )
        self.assertIn("state_store_not_open", raw_status.blockers)

    def test_structurally_wrong_tools_root_is_unavailable(self) -> None:
        self._publish()
        faux = self.store.root / "faux-tools"
        faux.mkdir()
        (faux / "repo_identity.json").write_text(
            json.dumps({
                "schema_version": 3,
                "aria_tools_contract_version": 3,
                "bound_canonical_identity": canonical_identity(self.repo),
            }),
            encoding="utf-8",
        )
        status = self._derive_at(
            base_dir=faux,
            repo_root=self.repo,
            target_sha=self.target_sha,
        )
        self.assertIn("state_tools_root_mismatch", status.blockers)

    def test_foreign_published_tools_contract_is_unavailable(self) -> None:
        self._publish()
        contract_path = self.tools / "tools_contract.json"
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract["bound_canonical_identity"] = "foreign-contract"
        contract_path.write_text(json.dumps(contract), encoding="utf-8")
        identity = canonical_identity(self.repo)
        snapshot = build_publishable_snapshot(
            self.store,
            snapshot_id="snapshot-foreign-contract",
            cycle_id="cycle-foreign-contract",
            lane="test",
            repo_hash=identity,
        )
        publish_state(
            self.store,
            snapshot=snapshot,
            cycle_id="cycle-foreign-contract",
            repo_hash=identity,
        )
        self._assert_unavailable("state_tools_contract_identity_mismatch")

    def test_ignored_declared_surface_drift_is_rejected_by_snapshot(self) -> None:
        self._publish()
        exclude = Path(_git(
            self.store.root,
            "rev-parse",
            "--git-path",
            "info/exclude",
        ))
        exclude.write_text(
            exclude.read_text(encoding="utf-8") + "\ntools/raw-findings.jsonl\n",
            encoding="utf-8",
        )
        append_declared_jsonl(
            self.tools / "raw-findings.jsonl",
            {"schema_version": 1, "finding_id": "ignored-drift"},
            expected_surface="raw_findings",
        )
        self.assertEqual(
            _git(
                self.store.root,
                "check-ignore",
                "tools/raw-findings.jsonl",
            ),
            "tools/raw-findings.jsonl",
        )
        self._assert_unavailable("state_store_dirty")

    def test_attached_state_head_is_unavailable(self) -> None:
        self._publish()
        _git(self.store.root, "switch", "-c", "local-attached-state")
        self._assert_unavailable("state_store_head_not_detached")

    def test_foreign_dirty_unpublished_and_genesis_stores_are_unavailable(
        self,
    ) -> None:
        cases = []

        ensure_tools_binding(self.tools, workspace_root=self.repo)
        identity_path = self.tools / "repo_identity.json"
        identity = json.loads(identity_path.read_text(encoding="utf-8"))
        identity["bound_canonical_identity"] = "foreign"
        identity_path.write_text(json.dumps(identity), encoding="utf-8")
        cases.append(("state_repository_identity_mismatch", self._derive()))
        identity["bound_canonical_identity"] = canonical_identity(self.repo)
        identity_path.write_text(json.dumps(identity), encoding="utf-8")

        self._publish()
        (self.store.root / "dirty.txt").write_text("dirty\n", encoding="utf-8")
        cases.append(("state_store_dirty", self._derive()))
        (self.store.root / "dirty.txt").unlink()

        (self.store.root / "local.txt").write_text("local\n", encoding="utf-8")
        _git(self.store.root, "add", "local.txt")
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "local state",
        )
        cases.append(("state_store_unpublished_head", self._derive()))

        for blocker, status in cases:
            with self.subTest(blocker=blocker):
                self.assertIn(blocker, status.blockers)
                for evidence in status.capabilities.values():
                    self.assertEqual(evidence.evidence_refs, ())

        other_root = Path(self.tmp.name) / "genesis"
        other_root.mkdir()
        other_remote = other_root / "remote.git"
        other_remote.mkdir()
        _git(other_remote, "init", "--bare", "--initial-branch=main", ".")
        other_repo = other_root / "repo"
        other_repo.mkdir()
        _git(other_repo, "init", "--initial-branch=main", ".")
        _git(other_repo, "config", "user.name", "ARIA Test")
        _git(other_repo, "config", "user.email", "aria@example.invalid")
        _git(other_repo, "config", "commit.gpgsign", "false")
        _git(other_repo, "remote", "add", "origin", str(other_remote))
        _write_current_evaluator(other_repo)
        (other_repo / "README.md").write_text("seed\n", encoding="utf-8")
        _git(other_repo, "add", ".")
        _git(other_repo, "commit", "-m", "seed")
        _git(other_repo, "push", "origin", "main")
        identity_name = other_remote.parent.name + "/" + other_remote.name.removesuffix(".git")
        with mock.patch.dict(os.environ, {BOOTSTRAP_ACK_ENV: identity_name}):
            genesis = checkout_state_store(
                other_repo,
                store_dir=other_root / "state-store",
            )
        ensure_tools_binding(tools_root(genesis), workspace_root=other_repo)
        genesis_status = self._derive_at(
            base_dir=tools_root(genesis),
            repo_root=other_repo,
            target_sha=_git(other_repo, "rev-parse", "HEAD"),
        )
        self.assertTrue(genesis_status.blockers)

    def test_stale_remote_and_remote_failure_are_named_unavailable(self) -> None:
        self._publish()
        old_tip = _git(self.store.root, "rev-parse", "HEAD")
        (self.store.root / "remote-change.txt").write_text("remote\n", encoding="utf-8")
        _git(self.store.root, "add", "remote-change.txt")
        _git(
            self.store.root,
            "-c", "user.name=ARIA Test",
            "-c", "user.email=aria@example.invalid",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "remote state",
        )
        new_tip = _git(self.store.root, "rev-parse", "HEAD")
        _git(self.store.root, "push", "origin", "HEAD:refs/heads/aria/state")
        _git(self.store.root, "reset", "--hard", old_tip)
        _git(
            self.store.root,
            "update-ref", "refs/remotes/origin/aria/state", old_tip,
        )
        self.assertNotEqual(old_tip, new_tip)
        self._assert_unavailable("state_remote_tip_stale")

        moved = Path(self.tmp.name) / "remote-offline.git"
        self.remote.rename(moved)
        self._assert_unavailable("state_remote_unavailable")

    def test_remote_transport_exception_is_named_unavailable(self) -> None:
        self._publish()
        real_run = autonomy_evidence_module._run_git

        def fail_remote(repo_root, *args):
            if args and args[0] == "ls-remote":
                raise RuntimeError("git_history_unavailable")
            return real_run(repo_root, *args)

        with mock.patch.object(
            autonomy_evidence_module,
            "_run_git",
            side_effect=fail_remote,
        ):
            self._assert_unavailable("state_remote_unavailable")

    def _assert_remote_listing_unavailable(self, listing: str) -> None:
        real_run_git = autonomy_evidence_module._run_git

        def remote_listing(repo_root, *args):
            if args and args[0] == "ls-remote":
                return subprocess.CompletedProcess(
                    ["git", "-C", str(repo_root), *args],
                    0,
                    listing.encode("utf-8"),
                    b"",
                )
            return real_run_git(repo_root, *args)

        with mock.patch.object(
            autonomy_evidence_module,
            "_run_git",
            side_effect=remote_listing,
        ):
            self._assert_unavailable("state_remote_unavailable")

    def test_state_remote_wrong_ref_record_is_unavailable(self) -> None:
        self._publish()
        self._assert_remote_listing_unavailable(
            f"{_git(self.store.root, 'rev-parse', 'HEAD')}\trefs/heads/not-state\n",
        )

    def test_state_remote_multiple_records_are_unavailable(self) -> None:
        self._publish()
        tip = _git(self.store.root, "rev-parse", "HEAD")
        self._assert_remote_listing_unavailable(
            f"{tip}\trefs/heads/aria/state\n{tip}\trefs/heads/other\n",
        )

    def test_state_remote_malformed_record_is_unavailable(self) -> None:
        self._publish()
        self._assert_remote_listing_unavailable(
            f"{_git(self.store.root, 'rev-parse', 'HEAD')} refs/heads/aria/state extra\n",
        )

    def test_state_remote_zero_records_are_unavailable(self) -> None:
        self._publish()
        self._assert_remote_listing_unavailable("")

    def test_state_remote_zero_sha_and_raw_whitespace_are_unavailable(self) -> None:
        self._publish()
        tip = _git(self.store.root, "rev-parse", "HEAD")
        remote_ref = "refs/heads/aria/state"
        for listing in (
            f"{'0' * 40}\t{remote_ref}\n",
            f" {tip}\t{remote_ref}\n",
            f"\n{tip}\t{remote_ref}\n\n",
        ):
            with self.subTest(listing=repr(listing)):
                self._assert_remote_listing_unavailable(listing)

    def test_local_git_admission_exceptions_are_named_unavailable(self) -> None:
        self._publish()
        real_evidence_run = autonomy_evidence_module._run_git

        def fail_head(repo_root, *args):
            if args[:3] == ("rev-parse", "--verify", "HEAD"):
                raise RuntimeError("injected_head_failure")
            return real_evidence_run(repo_root, *args)

        with mock.patch.object(
            autonomy_evidence_module,
            "_run_git",
            side_effect=fail_head,
        ):
            self._assert_unavailable("state_store_head_unavailable")

        real_state_run = state_store_module._run_git_bytes_bounded

        def fail_status(repo_root, args, **kwargs):
            if args and args[0] == "status":
                raise StateStoreError("injected_status_failure")
            return real_state_run(repo_root, args, **kwargs)

        with mock.patch.object(
            state_store_module,
            "_run_git_bytes_bounded",
            side_effect=fail_status,
        ):
            self._assert_unavailable("state_store_status_unavailable")

    def test_corrupt_declared_ledger_is_rejected_by_snapshot_producer(self) -> None:
        self._publish()
        cycle_path = self.tools / "cycles.jsonl"
        rows = cycle_path.read_text(encoding="utf-8").splitlines()
        row = json.loads(rows[0])
        row["ledger_hash"] = "sha256:" + "0" * 64
        cycle_path.write_text(json.dumps(row, sort_keys=True) + "\n", encoding="utf-8")
        from aria_kernel.tool_registry import update_tools_index

        update_tools_index(self.tools)
        identity = canonical_identity(self.repo)
        with self.assertRaisesRegex(
            state_snapshot_module.SnapshotError,
            "snapshot_ledger_invalid:cycles.jsonl",
        ):
            build_publishable_snapshot(
                self.store,
                snapshot_id="snapshot-corrupt",
                cycle_id="cycle-corrupt",
                lane="test",
                repo_hash=identity,
            )

    def test_non_utf8_committed_ledger_is_integrity_corruption(self) -> None:
        self._publish()
        state_commit = _git(self.store.root, "rev-parse", "HEAD")
        cycle_oid = _git(
            self.store.root,
            "rev-parse",
            f"{state_commit}:tools/cycles.jsonl",
        )
        cycle_size = len((self.tools / "cycles.jsonl").read_bytes())
        real_stream = autonomy_evidence_module._iter_git_output_bounded

        def invalid_cycle_blob(repo_root, *args, **kwargs):
            if (
                Path(repo_root).resolve() == self.store.root.resolve()
                and args == ("cat-file", "blob", cycle_oid)
            ):
                return iter((b"\xff" + b"x" * (cycle_size - 1),))
            return real_stream(repo_root, *args, **kwargs)

        with mock.patch.object(
            autonomy_evidence_module,
            "_iter_git_output_bounded",
            side_effect=invalid_cycle_blob,
        ), self.assertRaises(LedgerIntegrityError) as caught:
            self._derive()
        self.assertIn("invalid_utf8", str(caught.exception))

    def test_concurrent_state_change_discards_all_refs_and_counts(self) -> None:
        self._publish()
        real_capture = autonomy_evidence_module._capture_state_admission
        calls = 0

        def changed_on_recheck(*args, **kwargs):
            nonlocal calls
            calls += 1
            snapshot = real_capture(*args, **kwargs)
            if calls == 2:
                return autonomy_evidence_module._StateAdmission(
                    state_commit="f" * 40,
                    remote_tip=snapshot.remote_tip,
                    clean=snapshot.clean,
                    snapshot_status=snapshot.snapshot_status,
                    snapshot_root=snapshot.snapshot_root,
                    snapshot_object_id=snapshot.snapshot_object_id,
                    host_identity=snapshot.host_identity,
                    contract_identity=snapshot.contract_identity,
                    host_identity_fingerprint=snapshot.host_identity_fingerprint,
                    contract_fingerprint=snapshot.contract_fingerprint,
                    blockers=snapshot.blockers,
                )
            return snapshot

        with mock.patch.object(
            autonomy_evidence_module,
            "_capture_state_admission",
            side_effect=changed_on_recheck,
        ):
            self._assert_unavailable("state_store_changed_during_read")

    def test_concurrent_ignored_binding_change_discards_all_refs(self) -> None:
        self._publish()
        real_load = autonomy_evidence_module._load_counted_rows

        def change_identity_after_load(*args, **kwargs):
            loaded = real_load(*args, **kwargs)
            identity_path = self.tools / "repo_identity.json"
            before = identity_path.read_bytes()
            identity = json.loads(identity_path.read_text(encoding="utf-8"))
            original = identity["bound_canonical_identity"]
            replacement = (
                ("0" if original[0] != "0" else "1") + original[1:]
            )
            identity_path.write_bytes(
                before.replace(original.encode("utf-8"), replacement.encode("utf-8")),
            )
            self.assertEqual(len(before), len(identity_path.read_bytes()))
            return loaded

        with mock.patch.object(
            autonomy_evidence_module,
            "_load_counted_rows",
            side_effect=change_identity_after_load,
        ):
            self._assert_unavailable("state_store_changed_during_read")


class OperatorPrerequisiteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-evidence-policy-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        _git(self.repo, "init", "--initial-branch=main", ".")
        _git(self.repo, "config", "user.name", "ARIA Test")
        _git(self.repo, "config", "user.email", "aria@example.invalid")
        _git(self.repo, "config", "commit.gpgsign", "false")
        _write_current_evaluator(self.repo)

    def _commit_policy(self, registry_state: str) -> str:
        policy = self.repo / "docs" / "aria" / "policy" / "autonomy-closure-findings.json"
        policy.parent.mkdir(parents=True, exist_ok=True)
        source_policy = (
            Path(__file__).resolve().parents[2]
            / "docs" / "aria" / "policy" / "autonomy-closure-findings.json"
        )
        payload = json.loads(source_policy.read_text(encoding="utf-8"))
        policy.write_text(json.dumps(payload), encoding="utf-8")
        headings_by_path: dict[str, set[str]] = {}
        for entry in payload["entries"]:
            for key in ("review_anchor", "narrative_anchor"):
                anchor = entry.get(key)
                if isinstance(anchor, str) and "#" in anchor:
                    path, finding_id = anchor.split("#", 1)
                    headings_by_path.setdefault(path, set()).add(finding_id)
        for relative, finding_ids in headings_by_path.items():
            review = self.repo / relative
            review.parent.mkdir(parents=True, exist_ok=True)
            review.write_text(
                "\n\n".join(
                    f"## {finding_id} test fixture"
                    for finding_id in sorted(finding_ids)
                ) + "\n",
                encoding="utf-8",
            )
        for entry in payload["entries"]:
            for relative in entry["regression_test_refs"]:
                regression = self.repo / relative
                regression.parent.mkdir(parents=True, exist_ok=True)
                if not regression.exists():
                    regression.write_text("regression fixture\n", encoding="utf-8")
        registry = self.repo / "docs" / "aria" / "findings" / "registry.json"
        registry.parent.mkdir(parents=True, exist_ok=True)
        registry.write_text(
            json.dumps({"ORPHAN-MEDIUM-789": registry_state}) + "\n",
            encoding="utf-8",
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", f"policy {registry_state}")
        return _git(self.repo, "rev-parse", "HEAD")

    def _capabilities(self, readiness_state: str) -> dict[str, CapabilityEvidence]:
        return {
            capability: CapabilityEvidence(
                state=readiness_state if capability == "enterprise_readiness" else "declared",
                counts={},
                blockers=(),
                evidence_refs=(),
            )
            for capability in EXPECTED_CAPABILITIES
        }

    def test_orphan_789_is_not_cleared_by_a_v2_live_readiness_claim(
        self,
    ) -> None:
        target = self._commit_policy("CLOSED")
        blocked = _apply_operator_prerequisites(
            capabilities=self._capabilities("declared"),
            repo_root=self.repo,
            target_sha=target,
        )
        readiness = blocked["enterprise_readiness"]
        self.assertEqual(readiness.state, "operator_blocked")
        self.assertEqual(readiness.blockers, ("github_app_mode_a_unconfigured",))

        v2_live = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=target,
        )
        self.assertEqual(
            v2_live["enterprise_readiness"].state,
            "operator_blocked",
        )
        self.assertIn(
            "github_app_mode_a_unconfigured",
            v2_live["enterprise_readiness"].blockers,
        )
        self.assertEqual(
            CAPABILITY_SPECS["enterprise_readiness"].contracts[0].schema_id,
            "aria/enterprise-readiness-claim/v2",
        )

    def test_same_surface_v2_ref_is_not_a_signed_v3_ref(self) -> None:
        v2 = CAPABILITY_SPECS["enterprise_readiness"].contracts[0]
        v3 = EvidenceContract(
            surface=v2.surface,
            proof_kind="live",
            schema_id="aria/enterprise-readiness-claim/v3",
            schema_versions=frozenset({3}),
            identity_field="row_id",
            integrity_hash_field="ledger_hash",
            authoritative_sha_field="resulting_main_sha",
            upcaster=autonomy_evidence_module._identity_upcaster,
            terminal_predicate=lambda row: row.get("signed") is True,
        )
        v4 = EvidenceContract(
            surface=v2.surface,
            proof_kind="live",
            schema_id="aria/enterprise-readiness-claim/v4",
            schema_versions=frozenset({4}),
            identity_field="row_id",
            integrity_hash_field="ledger_hash",
            authoritative_sha_field="resulting_main_sha",
            upcaster=autonomy_evidence_module._identity_upcaster,
            terminal_predicate=lambda row: row.get("signed") is True,
        )
        readiness_spec = CapabilitySpec(
            authority_paths=(),
            producer_paths=(),
            authorizing_consumer_paths=(),
            contracts=(v2, v3, v4),
            count_surfaces=(v2.surface,),
        )

        def ref(schema_id: str, schema_version: int) -> EvidenceRef:
            return EvidenceRef(
                surface=v2.surface,
                proof_kind="live",
                schema_id=schema_id,
                schema_version=schema_version,
                row_id=f"row-{schema_version}",
                row_hash="sha256:" + str(schema_version) * 64,
                evidence_target_sha="a" * 40,
                evaluated_target_sha="a" * 40,
                capability_authority_hash="sha256:" + "b" * 64,
                state_commit="c" * 40,
            )

        with mock.patch.object(
            autonomy_evidence_module,
            "CAPABILITY_SPECS",
            {"enterprise_readiness": readiness_spec},
        ):
            v2_only = CapabilityEvidence(
                state="live_proven",
                counts={},
                blockers=(),
                evidence_refs=(ref(v2.schema_id, 2),),
            )
            self.assertFalse(_mode_a_signed_readiness_live_proven(v2_only))

            mixed = CapabilityEvidence(
                state="live_proven",
                counts={},
                blockers=(),
                evidence_refs=(
                    ref(v2.schema_id, 2),
                    ref(v3.schema_id, 3),
                ),
            )
            self.assertTrue(_mode_a_signed_readiness_live_proven(mixed))

            v4_only = CapabilityEvidence(
                state="live_proven",
                counts={},
                blockers=(),
                evidence_refs=(ref(v4.schema_id, 4),),
            )
            self.assertFalse(_mode_a_signed_readiness_live_proven(v4_only))

            duplicate_v3 = CapabilityEvidence(
                state="live_proven",
                counts={},
                blockers=(),
                evidence_refs=(
                    ref(v3.schema_id, 3),
                    ref(v3.schema_id, 3),
                ),
            )
            self.assertFalse(
                _mode_a_signed_readiness_live_proven(duplicate_v3),
            )

    def test_registry_state_is_irrelevant_and_task_finding_cannot_self_block(
        self,
    ) -> None:
        closed_target = self._commit_policy("CLOSED")
        closed = _apply_operator_prerequisites(
            capabilities=self._capabilities("declared"),
            repo_root=self.repo,
            target_sha=closed_target,
        )
        open_target = self._commit_policy("OPEN")
        opened = _apply_operator_prerequisites(
            capabilities=self._capabilities("declared"),
            repo_root=self.repo,
            target_sha=open_target,
        )
        self.assertEqual(
            closed["enterprise_readiness"].blockers,
            opened["enterprise_readiness"].blockers,
        )
        all_blockers = {
            blocker
            for evidence in opened.values()
            for blocker in evidence.blockers
        }
        self.assertEqual(all_blockers, {"github_app_mode_a_unconfigured"})

    def test_operator_metadata_on_any_other_finding_is_rejected_not_applied(
        self,
    ) -> None:
        self._commit_policy("OPEN")
        policy_path = (
            self.repo / "docs" / "aria" / "policy"
            / "autonomy-closure-findings.json"
        )
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        policy["entries"][1]["operator_prerequisite"] = {
            "capability": "cycle_runtime",
            "blocker": "task_finding_self_blocked",
        }
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "unauthorized metadata")
        target = _git(self.repo, "rev-parse", "HEAD")

        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("declared"),
            repo_root=self.repo,
            target_sha=target,
        )

        self.assertEqual(
            capabilities["enterprise_readiness"].state,
            "operator_blocked",
        )
        self.assertIn(
            "operator_prerequisite_policy_invalid",
            capabilities["enterprise_readiness"].blockers,
        )
        self.assertNotIn(
            "task_finding_self_blocked",
            capabilities["cycle_runtime"].blockers,
        )

    def test_policy_is_loaded_from_target_tree_not_working_tree(self) -> None:
        target = self._commit_policy("OPEN")
        policy_path = (
            self.repo / "docs" / "aria" / "policy"
            / "autonomy-closure-findings.json"
        )
        policy_path.write_text("not-json\n", encoding="utf-8")

        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("declared"),
            repo_root=self.repo,
            target_sha=target,
        )

        self.assertEqual(
            capabilities["enterprise_readiness"].blockers,
            ("github_app_mode_a_unconfigured",),
        )

    def test_malformed_target_policy_fails_closed_with_named_blocker(self) -> None:
        policy_path = (
            self.repo / "docs" / "aria" / "policy"
            / "autonomy-closure-findings.json"
        )
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        policy_path.write_text("not-json\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "malformed policy")
        target = _git(self.repo, "rev-parse", "HEAD")

        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=target,
        )

        self.assertEqual(
            capabilities["enterprise_readiness"].state,
            "operator_blocked",
        )
        self.assertIn(
            "operator_prerequisite_policy_invalid",
            capabilities["enterprise_readiness"].blockers,
        )

    def test_target_policy_size_and_pathological_json_are_named(self) -> None:
        policy_path = (
            self.repo / "docs" / "aria" / "policy"
            / "autonomy-closure-findings.json"
        )
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        policy_path.write_bytes(
            b"x" * (autonomy_evidence_module._MAX_POLICY_BLOB_BYTES + 1),
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "oversized policy")
        oversized = _git(self.repo, "rev-parse", "HEAD")
        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=oversized,
        )
        self.assertIn(
            "operator_prerequisite_policy_too_large",
            capabilities["enterprise_readiness"].blockers,
        )

        policy_path.write_bytes(
            b'{"value":' + (b"[" * 1500) + b"0" + (b"]" * 1500) + b"}",
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "pathological policy")
        nested = _git(self.repo, "rev-parse", "HEAD")
        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=nested,
        )
        self.assertIn(
            "operator_prerequisite_policy_invalid",
            capabilities["enterprise_readiness"].blockers,
        )

    def test_target_policy_contract_and_finding_ids_are_validated(self) -> None:
        for label, mutation in (
            ("schema", lambda policy: policy.update({"$schema": "wrong/v1"})),
            ("version", lambda policy: policy.update({"schema_version": True})),
            ("policy_id", lambda policy: policy.update({"policy_id": "other"})),
            ("missing_scope_entry", lambda policy: policy["entries"].pop()),
            (
                "duplicate_finding",
                lambda policy: policy["entries"].append(dict(policy["entries"][0])),
            ),
            (
                "duplicate_task",
                lambda policy: policy["entries"][1].update({
                    "task_id": policy["entries"][0]["task_id"],
                }),
            ),
            ("missing_owner", lambda policy: policy["entries"][0].pop("owner_task")),
            (
                "missing_required_key",
                lambda policy: policy["entries"][0].pop("closing_sha_rule"),
            ),
            (
                "closure_mode",
                lambda policy: policy["entries"][0].update({"closure_mode": "other"}),
            ),
            (
                "closing_sha_rule",
                lambda policy: policy["entries"][0].update({"closing_sha_rule": "other"}),
            ),
            (
                "review_anchor",
                lambda policy: policy["entries"][0].update({
                    "review_anchor": "docs/reviews/policy.md#ARIA-HIGH-001",
                }),
            ),
            (
                "narrative_anchor",
                lambda policy: policy["entries"][0].update({
                    "narrative_anchor": "../outside.md#ORPHAN-MEDIUM-789",
                }),
            ),
            (
                "empty_regression_refs",
                lambda policy: policy["entries"][0].update({"regression_test_refs": []}),
            ),
            (
                "bad_regression_ref",
                lambda policy: policy["entries"][0].update({
                    "regression_test_refs": ["docs/aria/BEHAVIOUR.md"],
                }),
            ),
            (
                "historical_sha",
                lambda policy: policy["entries"][0].update({
                    "historical_fix_shas": ["ABC123"],
                }),
            ),
            ("extra_envelope_key", lambda policy: policy.update({"state": "OPEN"})),
            (
                "extra_entry_key",
                lambda policy: policy["entries"][0].update({"state": "OPEN"}),
            ),
        ):
            with self.subTest(label=label):
                self._commit_policy("OPEN")
                policy_path = (
                    self.repo / "docs" / "aria" / "policy"
                    / "autonomy-closure-findings.json"
                )
                policy = json.loads(policy_path.read_text(encoding="utf-8"))
                mutation(policy)
                policy_path.write_text(json.dumps(policy), encoding="utf-8")
                _git(self.repo, "add", ".")
                _git(self.repo, "commit", "-m", f"invalid policy {label}")
                target = _git(self.repo, "rev-parse", "HEAD")

                capabilities = _apply_operator_prerequisites(
                    capabilities=self._capabilities("live_proven"),
                    repo_root=self.repo,
                    target_sha=target,
                )
                self.assertEqual(
                    capabilities["enterprise_readiness"].state,
                    "operator_blocked",
                )
                self.assertIn(
                    "operator_prerequisite_policy_invalid",
                    capabilities["enterprise_readiness"].blockers,
                )

    def test_target_policy_rejects_validly_shaped_semantic_reassignment(self) -> None:
        def swap_task_ids(policy: dict[str, Any]) -> None:
            first, second = policy["entries"][:2]
            first["task_id"], second["task_id"] = (
                second["task_id"],
                first["task_id"],
            )

        def reassign_owner(policy: dict[str, Any]) -> None:
            policy["entries"][0]["owner_task"] = "task-2"

        def swap_predicate(policy: dict[str, Any]) -> None:
            policy["entries"][0]["required_predicate"] = policy["entries"][1][
                "required_predicate"
            ]

        def change_mode_and_rule(policy: dict[str, Any]) -> None:
            policy["entries"][1].update({
                "closure_mode": "task_commit",
                "closing_sha_rule": "task_commit",
            })

        def reorder_history(policy: dict[str, Any]) -> None:
            policy["entries"][5]["historical_fix_shas"].reverse()

        def substitute_full_sha(policy: dict[str, Any]) -> None:
            policy["entries"][1]["historical_fix_shas"] = ["f" * 40]

        def add_empty_optional_history(policy: dict[str, Any]) -> None:
            policy["entries"][14]["historical_fix_shas"] = []

        def relocate_review_anchor(policy: dict[str, Any]) -> None:
            finding_id = "ARIA-HIGH-001"
            alternate = self.repo / "docs" / "reviews" / "orphan-findings.md"
            alternate.write_text(
                alternate.read_text(encoding="utf-8")
                + f"\n## {finding_id} alternate fixture\n",
                encoding="utf-8",
            )
            policy["entries"][18]["review_anchor"] = (
                f"docs/reviews/orphan-findings.md#{finding_id}"
            )

        def remove_required_narrative_presence(policy: dict[str, Any]) -> None:
            policy["entries"][0].pop("narrative_anchor")

        def relocate_narrative_anchor(policy: dict[str, Any]) -> None:
            finding_id = "ORPHAN-HIGH-775"
            alternate = (
                self.repo
                / "docs"
                / "reviews"
                / "aria"
                / "2026-08-22-autonomy-closure-plan-audit.md"
            )
            alternate.write_text(
                alternate.read_text(encoding="utf-8")
                + f"\n## {finding_id} alternate fixture\n",
                encoding="utf-8",
            )
            policy["entries"][0]["narrative_anchor"] = (
                "docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md"
                f"#{finding_id}"
            )

        def add_unexpected_narrative_presence(policy: dict[str, Any]) -> None:
            policy["entries"][18]["narrative_anchor"] = policy["entries"][18][
                "review_anchor"
            ]

        def reorder_regression_refs(policy: dict[str, Any]) -> None:
            policy["entries"][0]["regression_test_refs"].reverse()

        def substitute_valid_regression_ref(policy: dict[str, Any]) -> None:
            policy["entries"][1]["regression_test_refs"] = [
                policy["entries"][2]["regression_test_refs"][0]
            ]

        for label, mutation in (
            ("task_id_swap", swap_task_ids),
            ("owner_reassignment", reassign_owner),
            ("predicate_reassignment", swap_predicate),
            ("mode_rule_reassignment", change_mode_and_rule),
            ("history_reordered", reorder_history),
            ("history_full_sha_substitution", substitute_full_sha),
            ("unexpected_empty_history", add_empty_optional_history),
            ("review_anchor_relocated", relocate_review_anchor),
            ("narrative_presence_removed", remove_required_narrative_presence),
            ("narrative_anchor_relocated", relocate_narrative_anchor),
            ("narrative_presence_added", add_unexpected_narrative_presence),
            ("regression_refs_reordered", reorder_regression_refs),
            ("regression_ref_substituted", substitute_valid_regression_ref),
        ):
            with self.subTest(label=label):
                self._commit_policy("OPEN")
                policy_path = (
                    self.repo
                    / "docs"
                    / "aria"
                    / "policy"
                    / "autonomy-closure-findings.json"
                )
                policy = json.loads(policy_path.read_text(encoding="utf-8"))
                mutation(policy)
                policy_path.write_text(json.dumps(policy), encoding="utf-8")
                _git(self.repo, "add", ".")
                _git(self.repo, "commit", "-m", f"semantic policy drift {label}")

                capabilities = _apply_operator_prerequisites(
                    capabilities=self._capabilities("live_proven"),
                    repo_root=self.repo,
                    target_sha=_git(self.repo, "rev-parse", "HEAD"),
                )
                self.assertIn(
                    "operator_prerequisite_policy_invalid",
                    capabilities["enterprise_readiness"].blockers,
                )

    def test_target_policy_anchor_blob_must_contain_its_finding_heading(self) -> None:
        self._commit_policy("OPEN")
        review = self.repo / "docs" / "reviews" / "orphan-findings.md"
        review.write_text("## SOME-OTHER-FINDING fixture\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "policy anchor heading missing")
        target = _git(self.repo, "rev-parse", "HEAD")

        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=target,
        )
        self.assertIn(
            "operator_prerequisite_policy_invalid",
            capabilities["enterprise_readiness"].blockers,
        )

    def test_target_policy_anchor_heading_must_start_a_line(self) -> None:
        self._commit_policy("OPEN")
        policy_path = (
            self.repo / "docs" / "aria" / "policy"
            / "autonomy-closure-findings.json"
        )
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        first = policy["entries"][0]
        relative, finding_id = first["review_anchor"].split("#", 1)
        review = self.repo / relative
        review.write_text(
            review.read_text(encoding="utf-8").replace(
                f"## {finding_id} ",
                f"embedded ## {finding_id} ",
                1,
            ),
            encoding="utf-8",
        )
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "embed policy heading")

        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=_git(self.repo, "rev-parse", "HEAD"),
        )
        self.assertIn(
            "operator_prerequisite_policy_invalid",
            capabilities["enterprise_readiness"].blockers,
        )

    def test_policy_paths_and_headings_use_canonical_repository_boundaries(
        self,
    ) -> None:
        def nul_anchor(policy: dict[str, Any]) -> None:
            entry = policy["entries"][0]
            _, finding_id = entry["review_anchor"].split("#", 1)
            entry["review_anchor"] = f"docs/reviews/bad\x00path.md#{finding_id}"

        def surrogate_regression(policy: dict[str, Any]) -> None:
            policy["entries"][0]["regression_test_refs"] = [
                "tests/test_bad_\ud800.py",
            ]

        def unicode_line_separator(policy: dict[str, Any]) -> None:
            entry = policy["entries"][0]
            relative, finding_id = entry["review_anchor"].split("#", 1)
            review = self.repo / relative
            review.write_text(
                review.read_text(encoding="utf-8").replace(
                    f"## {finding_id} ",
                    f"prefix\u2028## {finding_id} ",
                    1,
                ),
                encoding="utf-8",
            )

        def excessive_anchor_depth(policy: dict[str, Any]) -> None:
            entry = policy["entries"][0]
            _, finding_id = entry["review_anchor"].split("#", 1)
            entry["review_anchor"] = f"{'/'.join(['d'] * 129)}#{finding_id}"

        def excessive_regression_length(policy: dict[str, Any]) -> None:
            policy["entries"][0]["regression_test_refs"] = [
                f"tests/{'x' * 4096}.py",
            ]

        for label, mutation in (
            ("nul_anchor", nul_anchor),
            ("surrogate_regression", surrogate_regression),
            ("unicode_line_separator", unicode_line_separator),
            ("excessive_anchor_depth", excessive_anchor_depth),
            ("excessive_regression_length", excessive_regression_length),
        ):
            with self.subTest(label=label):
                self._commit_policy("OPEN")
                policy_path = (
                    self.repo
                    / "docs"
                    / "aria"
                    / "policy"
                    / "autonomy-closure-findings.json"
                )
                policy = json.loads(policy_path.read_text(encoding="utf-8"))
                mutation(policy)
                policy_path.write_text(json.dumps(policy), encoding="utf-8")
                _git(self.repo, "add", ".")
                _git(self.repo, "commit", "-m", f"hostile policy {label}")

                capabilities = _apply_operator_prerequisites(
                    capabilities=self._capabilities("live_proven"),
                    repo_root=self.repo,
                    target_sha=_git(self.repo, "rev-parse", "HEAD"),
                )
                self.assertIn(
                    "operator_prerequisite_policy_invalid",
                    capabilities["enterprise_readiness"].blockers,
                )

    def test_target_policy_regression_ref_must_exist_as_regular_blob(self) -> None:
        self._commit_policy("OPEN")
        policy_path = (
            self.repo / "docs" / "aria" / "policy"
            / "autonomy-closure-findings.json"
        )
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        relative = policy["entries"][0]["regression_test_refs"][0]
        regression = self.repo / relative
        regression.unlink()
        _git(self.repo, "add", "--all", ".")
        _git(self.repo, "commit", "-m", "remove policy regression ref")

        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=_git(self.repo, "rev-parse", "HEAD"),
        )
        self.assertIn(
            "operator_prerequisite_policy_invalid",
            capabilities["enterprise_readiness"].blockers,
        )

    def test_target_policy_regression_ref_rejects_non_blob_entry(self) -> None:
        self._commit_policy("OPEN")
        policy_path = (
            self.repo / "docs" / "aria" / "policy"
            / "autonomy-closure-findings.json"
        )
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        relative = policy["entries"][0]["regression_test_refs"][0]
        regression = self.repo / relative
        regression.unlink()
        regression.symlink_to("missing-regression-target")
        _git(self.repo, "add", "--all", ".")
        _git(self.repo, "commit", "-m", "symlink policy regression ref")

        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=_git(self.repo, "rev-parse", "HEAD"),
        )
        self.assertIn(
            "operator_prerequisite_policy_invalid",
            capabilities["enterprise_readiness"].blockers,
        )

    def test_non_object_target_policy_is_invalid_not_unavailable(self) -> None:
        self._commit_policy("OPEN")
        policy = (
            self.repo / "docs" / "aria" / "policy"
            / "autonomy-closure-findings.json"
        )
        policy.write_text("[]\n", encoding="utf-8")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-m", "non-object policy")
        target = _git(self.repo, "rev-parse", "HEAD")

        capabilities = _apply_operator_prerequisites(
            capabilities=self._capabilities("live_proven"),
            repo_root=self.repo,
            target_sha=target,
        )
        blockers = capabilities["enterprise_readiness"].blockers
        self.assertIn("operator_prerequisite_policy_invalid", blockers)
        self.assertNotIn("operator_prerequisite_policy_unavailable", blockers)

    def test_target_policy_git_read_exception_fails_closed(self) -> None:
        target = self._commit_policy("OPEN")
        with mock.patch.object(
            autonomy_evidence_module,
            "_policy_at_target",
            return_value=(None, "operator_prerequisite_policy_unavailable"),
        ):
            capabilities = _apply_operator_prerequisites(
                capabilities=self._capabilities("live_proven"),
                repo_root=self.repo,
                target_sha=target,
            )

        self.assertEqual(
            capabilities["enterprise_readiness"].state,
            "operator_blocked",
        )
        self.assertIn(
            "operator_prerequisite_policy_unavailable",
            capabilities["enterprise_readiness"].blockers,
        )

    def test_store_unavailable_preserves_target_operator_prerequisite(self) -> None:
        target = self._commit_policy("CLOSED")
        with mock.patch.object(
            autonomy_evidence_module,
            "_executing_repository_root",
            return_value=self.repo,
        ):
            status = derive_autonomy_evidence_status(
                base_dir=Path(self.tmp.name) / "missing-tools",
                repo_root=self.repo,
                target_sha=target,
            )
        self.assertEqual(
            status.capabilities["enterprise_readiness"].state,
            "operator_blocked",
        )
        self.assertIn("state_tools_unavailable", status.blockers)
        self.assertIn("github_app_mode_a_unconfigured", status.blockers)


if __name__ == "__main__":
    unittest.main()
