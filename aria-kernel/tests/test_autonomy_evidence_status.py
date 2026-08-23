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
EXPECTED_COMMON_AUTHORITY = (
    f"{KERNEL}autonomy_evidence.py",
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
        f"{KERNEL}tool_health.py",
        f"{KERNEL}upcasters/__init__.py",
        f"{KERNEL}upcasters/cycles.py",
        f"{KERNEL}state_manifest.py",
        ".github/workflows/aria-auto-cycle.yml",
    ),
    "executor": (
        f"{KERNEL}agent_invocations.py",
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
        f"{KERNEL}autonomy_ladder.py", f"{KERNEL}rollback_bundle.py",
        ".github/workflows/aria-auto-cycle.yml",
    ),
}
EXPECTED_CONSUMERS = {
    "cycle_runtime": (
        f"{KERNEL}autonomy_state.py", f"{KERNEL}burn_in.py",
        f"{KERNEL}runtime_artifacts.py",
    ),
    "executor": (
        f"{KERNEL}agent_invocations.py", f"{KERNEL}agent_eval.py",
        f"{KERNEL}bridge_status_ledger.py", f"{KERNEL}circuit_breaker.py",
        f"{KERNEL}convergence_drainer.py", f"{KERNEL}evidence_validator.py",
        f"{KERNEL}plan_convergence.py",
    ),
    "finding_funnel": (
        f"{KERNEL}finding_promotion.py", f"{KERNEL}funnel_health.py",
        f"{KERNEL}rule_health.py", f"{KERNEL}state_compact.py",
    ),
    "fixture_calibration": (
        f"{KERNEL}agent_genesis.py", f"{KERNEL}genesis_lifecycle.py",
        f"{KERNEL}readiness.py", f"{KERNEL}shadow_eval_bridge.py",
        f"{KERNEL}tool_registry.py",
    ),
    "pre_merge_perimeter": (
        f"{KERNEL}auto_merge.py", f"{KERNEL}implementation_safety.py",
        f"{KERNEL}merge_authority.py",
    ),
    "enterprise_readiness": (
        f"{KERNEL}auto_merge_runners.py", f"{KERNEL}enterprise_readiness.py",
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
        surface_patterns = {
            name: state_manifest_module.surface_by_name(name).path_pattern
            for name in surface_capabilities
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
        reader_primitives = {
            "find_row_by_source_ledger_ref",
            "load_declared_jsonl",
            "load_feedback",
            "load_jsonl",
            "read_strict_jsonl",
            "read_runs_rows",
            "verify_jsonl",
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
            ("executor", f"{KERNEL}migration.py", "producer"):
                "migration backfills governance history without runtime proof",
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
            aliases: dict[str, str] = {}
            # Local imports matter: agent_genesis aliases both the reader and
            # fixture path helper inside the consuming function.
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        aliases[alias.asname or alias.name] = alias.name
                elif isinstance(node, ast.ImportFrom):
                    current = module_names[relative].split(".")
                    base = current[:-node.level] if node.level else []
                    imported_module = ".".join((*base, *(node.module or "").split(".")))
                    for alias in node.names:
                        aliases[alias.asname or alias.name] = (
                            f"{imported_module}.{alias.name}"
                        )
            imports[relative] = aliases
        self.assertTrue(
            {
                source.relative_to(repository).as_posix()
                for source in literal_python_sources
            }.issubset(trees),
        )

        def call_target(relative: str, function: ast.expr) -> str:
            aliases = imports[relative]
            if isinstance(function, ast.Name):
                return aliases.get(
                    function.id,
                    f"{module_names[relative]}.{function.id}",
                )
            if isinstance(function, ast.Attribute):
                if isinstance(function.value, ast.Name):
                    owner = aliases.get(function.value.id, function.value.id)
                    return f"{owner}.{function.attr}"
                return function.attr
            return ""

        def literal_surfaces(value: str) -> set[str]:
            if value in surface_capabilities:
                return {value}
            normalized = value.replace("\\", "/").removeprefix("./")
            if not normalized or normalized.startswith("/") or normalized.endswith("/"):
                return set()
            matches: set[str] = set()
            for name, pattern in surface_patterns.items():
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

        def string_path(expression: ast.expr) -> str | None:
            if isinstance(expression, ast.Constant) and isinstance(expression.value, str):
                return expression.value
            if isinstance(expression, ast.BinOp) and isinstance(expression.op, ast.Div):
                left = string_path(expression.left)
                right = string_path(expression.right)
                if left and right:
                    return f"{left.rstrip('/')}/{right.lstrip('/')}"
                return right or left
            return None

        path_helpers: dict[str, set[str]] = {}
        for relative, tree in trees.items():
            for function in _python_function_scopes(tree):
                if not function.name.endswith("path"):
                    continue
                surfaces: set[str] = set()
                for returned in (
                    node for node in ast.walk(function) if isinstance(node, ast.Return)
                ):
                    if returned.value is None:
                        continue
                    path_expression = any(
                        (
                            isinstance(node, ast.BinOp)
                            and isinstance(node.op, ast.Div)
                        )
                        or (
                            isinstance(node, ast.Call)
                            and isinstance(node.func, ast.Attribute)
                            and node.func.attr == "joinpath"
                        )
                        for node in ast.walk(returned.value)
                    )
                    if not path_expression:
                        continue
                    path = string_path(returned.value)
                    if path:
                        surfaces.update(literal_surfaces(path))
                    for constant in ast.walk(returned.value):
                        if (
                            isinstance(constant, ast.Constant)
                            and isinstance(constant.value, str)
                        ):
                            surfaces.update(literal_surfaces(constant.value))
                if surfaces:
                    path_helpers[
                        f"{module_names[relative]}.{function.name}"
                    ] = surfaces

        def expression_surfaces(
            relative: str,
            expression: ast.expr,
            assigned: Mapping[str, set[str]],
        ) -> set[str]:
            if isinstance(expression, ast.Name):
                return set(assigned.get(expression.id, ()))
            if isinstance(expression, ast.Constant) and isinstance(expression.value, str):
                return literal_surfaces(expression.value)
            if isinstance(expression, ast.Call):
                return set(path_helpers.get(call_target(relative, expression.func), ()))
            path = string_path(expression)
            return literal_surfaces(path) if path else set()

        # Summarize exactly one local wrapper layer. A wrapper can forward a
        # surface argument (shadow_eval_bridge._rows) or a path argument
        # (feedback_store/pr_tracking append_jsonl aliases).
        wrappers: dict[str, dict[str, Any]] = {}
        for relative, tree in trees.items():
            for function in _python_function_scopes(tree):
                if function.name not in {
                    "_rows",
                    "_safe_load_jsonl",
                    "append_jsonl",
                    "load_jsonl",
                    "rewrite_jsonl",
                }:
                    continue
                parameters = [argument.arg for argument in function.args.args]
                summary = {
                    "roles": set(),
                    "fixed": set(),
                    "surface_params": set(),
                    "path_params": set(),
                }
                for call in (
                    node for node in ast.walk(function) if isinstance(node, ast.Call)
                ):
                    primitive = call_target(relative, call.func).rsplit(".", 1)[-1]
                    role = (
                        "producer" if primitive in writer_primitives
                        else "consumer" if primitive in reader_primitives
                        else None
                    )
                    if role is None:
                        continue
                    summary["roles"].add(role)
                    if call.args:
                        summary["fixed"].update(
                            expression_surfaces(relative, call.args[0], {}),
                        )
                    if call.args and isinstance(call.args[0], ast.Name):
                        if call.args[0].id in parameters:
                            summary["path_params"].add(
                                parameters.index(call.args[0].id),
                            )
                    for keyword in call.keywords:
                        if keyword.arg != "expected_surface":
                            continue
                        if (
                            isinstance(keyword.value, ast.Constant)
                            and isinstance(keyword.value.value, str)
                        ):
                            summary["fixed"].update(
                                literal_surfaces(keyword.value.value),
                            )
                        elif (
                            isinstance(keyword.value, ast.Name)
                            and keyword.value.id in parameters
                        ):
                            summary["surface_params"].add(
                                parameters.index(keyword.value.id),
                            )
                if summary["roles"]:
                    wrappers[
                        f"{module_names[relative]}.{function.name}"
                    ] = summary

        discovered: set[tuple[str, str, str]] = set()
        for relative, tree in trees.items():
            for scope in _python_function_scopes(tree):
                assigned: dict[str, set[str]] = {}
                for assignment in (
                    node for node in ast.walk(scope) if isinstance(node, ast.Assign)
                ):
                    surfaces = expression_surfaces(
                        relative,
                        assignment.value,
                        assigned,
                    )
                    for target in assignment.targets:
                        if isinstance(target, ast.Name) and surfaces:
                            assigned[target.id] = surfaces
                for call in (
                    node for node in ast.walk(scope) if isinstance(node, ast.Call)
                ):
                    target = call_target(relative, call.func)
                    primitive = target.rsplit(".", 1)[-1]
                    roles = set()
                    if primitive in writer_primitives:
                        roles.add("producer")
                    if primitive in reader_primitives:
                        roles.add("consumer")
                    wrapper = wrappers.get(target)
                    if wrapper:
                        roles.update(wrapper["roles"])
                    if not roles:
                        continue
                    surfaces: set[str] = set()
                    if primitive == "load_feedback":
                        surfaces.add("operator_feedback")
                    if call.args:
                        surfaces.update(
                            expression_surfaces(relative, call.args[0], assigned),
                        )
                    for keyword in call.keywords:
                        if keyword.arg in {"expected_surface", "surface"}:
                            surfaces.update(
                                expression_surfaces(
                                    relative,
                                    keyword.value,
                                    assigned,
                                ),
                            )
                    if wrapper:
                        surfaces.update(wrapper["fixed"])
                        for index in (
                            wrapper["surface_params"] | wrapper["path_params"]
                        ):
                            if index < len(call.args):
                                surfaces.update(
                                    expression_surfaces(
                                        relative,
                                        call.args[index],
                                        assigned,
                                    ),
                                )
                    for surface in surfaces:
                        capability = surface_capabilities.get(surface)
                        if capability:
                            discovered.update(
                                (capability, relative, role) for role in roles
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
            ("executor", f"{KERNEL}plan_convergence.py", "consumer"),
            ("executor", f"{KERNEL}tool_registry.py", "producer"),
            ("fixture_calibration", f"{KERNEL}agent_genesis.py", "consumer"),
            ("fixture_calibration", f"{KERNEL}genesis_lifecycle.py", "consumer"),
            ("fixture_calibration", f"{KERNEL}shadow_eval_bridge.py", "consumer"),
            ("enterprise_readiness", f"{KERNEL}auto_merge_runners.py", "consumer"),
            ("autonomy_unlock", f"{KERNEL}autonomy_ladder.py", "consumer"),
        }
        undiscovered = sorted(required_discoveries - discovered)
        if undiscovered:
            self.fail("scanner missed required callsites:\n" + "\n".join(map(str, undiscovered)))

        missing = []
        for capability, relative, role in sorted(discovered):
            spec = CAPABILITY_SPECS[capability]
            roster = (
                spec.producer_paths
                if role == "producer"
                else spec.authorizing_consumer_paths
            )
            if relative not in roster and (capability, relative, role) not in observational:
                missing.append((capability, relative, role))
        if missing:
            self.fail("unclassified surface callsites:\n" + "\n".join(map(str, missing)))
        self.assertTrue(all(len(reason.strip()) >= 20 for reason in observational.values()))
        self.assertTrue(set(observational).issubset(discovered))

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

    def test_fixture_terminal_requires_native_suite_row_type(self) -> None:
        base = {
            "schema_version": 1,
            "execution_run_id": "fixture-run-1",
            "passed": True,
            "actual_status": "pass",
            "ledger_hash": "sha256:" + "4" * 64,
        }
        _, counts_without_type, _ = _evaluate_native_rows(
            "fixture_calibration",
            {"agent_eval_fixture_runs": (base,)},
        )
        _, counts_with_type, blockers = _evaluate_native_rows(
            "fixture_calibration",
            {"agent_eval_fixture_runs": ({
                **base,
                "row_type": "fixture_run_suite",
            },)},
        )
        self.assertEqual(counts_without_type["terminal"], 0)
        self.assertEqual(counts_with_type["terminal"], 1)
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
