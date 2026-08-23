"""Derived, target-bound ARIA autonomy evidence status.

The status in this module is a read-only projection.  It never creates,
repairs, publishes, or otherwise changes the external ``aria/state`` store.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
import hashlib
import json
import os
import re
import selectors
from pathlib import Path, PurePosixPath
import subprocess
import time
from types import MappingProxyType
from typing import Any, Callable, Iterable, Iterator, Literal, Mapping

from .autonomy_state import fold_autonomy_state_rows as _fold_autonomy_state_rows
from .state_snapshot import (
    SNAPSHOT_MAX_INPUT_BYTES,
    SNAPSHOT_MAX_LEDGER_LINE_BYTES,
    SNAPSHOT_MAX_LEDGER_ROWS,
    SNAPSHOT_MAX_SURFACE_BLOB_BYTES,
)
from .state_manifest import normalize_surface_relative_path


EvidenceState = Literal[
    "declared",
    "code_proven",
    "live_proven",
    "operator_blocked",
]
ProofKind = Literal["code", "live"]
RowUpcaster = Callable[[Mapping[str, Any]], Mapping[str, Any]]
TerminalPredicate = Callable[[Mapping[str, Any]], bool]


_FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
_LEDGER_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
_GIT_OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_OWNER_TASK = re.compile(r"^task-(?:[1-9]|1\d|20a)$")
_REQUIRED_PREDICATE = re.compile(r"^[a-z][a-z0-9_]+$")
_REGRESSION_TEST_REF = re.compile(r"(?:^|/)(?:tests?|[^/]*\.(?:spec|test)\.)")
_EXPECTED_CLOSURE_SCOPE = frozenset({
    "ORPHAN-HIGH-775",
    "ORPHAN-CRITICAL-776",
    "ORPHAN-HIGH-777",
    "ORPHAN-HIGH-778",
    "ORPHAN-HIGH-779",
    "ORPHAN-HIGH-780",
    "ORPHAN-HIGH-781",
    "ORPHAN-HIGH-782",
    "ORPHAN-MEDIUM-783",
    "ORPHAN-HIGH-784",
    "ORPHAN-MEDIUM-785",
    "ORPHAN-HIGH-786",
    "ORPHAN-HIGH-787",
    "ORPHAN-HIGH-788",
    "ORPHAN-MEDIUM-789",
    "ORPHAN-HIGH-790",
    "ORPHAN-HIGH-791",
    "ORPHAN-MEDIUM-792",
    "ARIA-HIGH-001",
    "ARIA-HIGH-002",
    "ARIA-HIGH-003",
    "ARIA-HIGH-004",
    "ARIA-HIGH-005",
    "ARIA-HIGH-006",
    "ARIA-CRITICAL-007",
    "ARIA-HIGH-008",
    "ARIA-CRITICAL-009",
    "ARIA-HIGH-010",
    "ARIA-HIGH-011",
    "ARIA-HIGH-012",
    "ARIA-HIGH-013",
    "ARIA-HIGH-014",
    "ARIA-CRITICAL-015",
    "ARIA-HIGH-016",
})
_MAX_EVALUATOR_BLOB_BYTES = 2 * 1024 * 1024
_MAX_AUTHORITY_BLOB_BYTES = 2 * 1024 * 1024
_MAX_AUTHORITY_CAPABILITY_BYTES = 16 * 1024 * 1024
_MAX_POLICY_BLOB_BYTES = 2 * 1024 * 1024
_MAX_SNAPSHOT_JSON_BYTES = 4 * 1024 * 1024
_MAX_SNAPSHOT_TREE_BYTES = 16 * 1024 * 1024
_MAX_SNAPSHOT_TREE_ENTRIES = 10_000
_MAX_SNAPSHOT_SURFACE_BLOB_BYTES = SNAPSHOT_MAX_SURFACE_BLOB_BYTES
_MAX_SNAPSHOT_INPUT_BYTES = SNAPSHOT_MAX_INPUT_BYTES
_MAX_EVIDENCE_LEDGER_BLOB_BYTES = 64 * 1024 * 1024
_MAX_EVIDENCE_INPUT_BYTES = 80 * 1024 * 1024
_MAX_EVIDENCE_LEDGER_LINE_BYTES = 1024 * 1024
_MAX_EVIDENCE_LEDGER_ROWS = 100_000
_MAX_SNAPSHOT_LEDGER_LINE_BYTES = SNAPSHOT_MAX_LEDGER_LINE_BYTES
_MAX_SNAPSHOT_LEDGER_ROWS = SNAPSHOT_MAX_LEDGER_ROWS
_MAX_SNAPSHOT_SURFACE_MATCH_CANDIDATES = 100_000
_MAX_DISTINCT_PROOF_TARGETS_PER_CAPABILITY = 128
_MAX_DISTINCT_PROOF_TARGETS_GLOBAL = 256
_GIT_STREAM_TIMEOUT_SECONDS = 30
_STATE_BOOTSTRAP_EMPTY_MARKERS = frozenset({
    "findings/.gitkeep",
    "tools/.gitkeep",
    "workspace/.gitkeep",
})


def _proof_cardinality_key(
    surface: str,
    proof_kind: ProofKind,
    schema_id: str | None,
    schema_version: int,
) -> str:
    return ":".join((
        surface,
        proof_kind,
        schema_id or "none",
        str(schema_version),
    ))


def _identity_upcaster(row: Mapping[str, Any]) -> Mapping[str, Any]:
    return row


def _field_equals(field: str, value: Any) -> TerminalPredicate:
    def matches(row: Mapping[str, Any]) -> bool:
        return row.get(field) == value

    return matches


def _enterprise_readiness_v2_terminal(row: Mapping[str, Any]) -> bool:
    from .enterprise_readiness import evaluate_enterprise_readiness_claim

    try:
        return evaluate_enterprise_readiness_claim(dict(row)).valid
    except Exception:  # noqa: BLE001 - malformed audit rows are invalid
        return False


def _upcast_cycle_row(row: Mapping[str, Any]) -> Mapping[str, Any]:
    from .upcasters import upcast_cycle_rows

    return upcast_cycle_rows([dict(row)])[0]


@dataclass(frozen=True, slots=True)
class EvidenceContract:
    """One producer-native proof row contract."""

    surface: str
    proof_kind: ProofKind
    schema_id: str | None
    schema_versions: frozenset[int]
    identity_field: str
    integrity_hash_field: str
    authoritative_sha_field: str | None
    upcaster: RowUpcaster
    terminal_predicate: TerminalPredicate

    def __post_init__(self) -> None:
        object.__setattr__(self, "schema_versions", frozenset(self.schema_versions))


@dataclass(frozen=True, slots=True)
class CapabilitySpec:
    """Immutable authority and proof ownership for one capability."""

    authority_paths: tuple[str, ...]
    producer_paths: tuple[str, ...]
    authorizing_consumer_paths: tuple[str, ...]
    contracts: tuple[EvidenceContract, ...]
    count_surfaces: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "authority_paths", tuple(self.authority_paths))
        object.__setattr__(self, "producer_paths", tuple(self.producer_paths))
        object.__setattr__(
            self,
            "authorizing_consumer_paths",
            tuple(self.authorizing_consumer_paths),
        )
        object.__setattr__(self, "contracts", tuple(self.contracts))
        object.__setattr__(self, "count_surfaces", tuple(self.count_surfaces))


@dataclass(frozen=True, slots=True)
class _NativeCandidate:
    contract: EvidenceContract
    schema_id: str | None
    schema_version: int
    row_id: str
    row_hash: str
    evidence_target_sha: str


@dataclass(frozen=True, slots=True)
class _TargetCandidate:
    candidate: _NativeCandidate
    admissible_count: int
    admissible_by_schema: Mapping[int, int]
    ordinal: int


@dataclass(frozen=True, slots=True)
class _NativeSummary:
    targets_by_contract: Mapping[EvidenceContract, tuple[_TargetCandidate, ...]]
    counts: Mapping[str, int]
    blockers: tuple[str, ...]
    distinct_target_budget_exceeded: bool = False
    global_target_budget_exceeded: bool = False


@dataclass(frozen=True, slots=True)
class _StateAdmission:
    state_commit: str | None
    remote_tip: str | None
    clean: bool
    snapshot_status: str | None
    snapshot_root: str | None
    snapshot_object_id: str | None
    host_identity: str | None
    contract_identity: str | None
    host_identity_fingerprint: tuple[int, int, int, int, str] | None
    contract_fingerprint: tuple[int, int, int, int, str] | None
    blockers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class EvidenceRef:
    surface: str
    proof_kind: ProofKind
    schema_id: str | None
    schema_version: int
    row_id: str
    row_hash: str
    evidence_target_sha: str | None
    evaluated_target_sha: str
    capability_authority_hash: str
    state_commit: str


@dataclass(frozen=True, slots=True)
class CapabilityEvidence:
    state: EvidenceState
    counts: Mapping[str, int]
    blockers: tuple[str, ...]
    evidence_refs: tuple[EvidenceRef, ...]
    proof_cardinality: Mapping[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "counts", MappingProxyType(dict(self.counts)))
        object.__setattr__(self, "blockers", tuple(self.blockers))
        object.__setattr__(self, "evidence_refs", tuple(self.evidence_refs))
        cardinality = dict(self.proof_cardinality)
        if not cardinality:
            for ref in self.evidence_refs:
                key = _proof_cardinality_key(
                    ref.surface,
                    ref.proof_kind,
                    ref.schema_id,
                    ref.schema_version,
                )
                cardinality[key] = cardinality.get(key, 0) + 1
        object.__setattr__(
            self,
            "proof_cardinality",
            MappingProxyType(cardinality),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "counts": dict(self.counts),
            "blockers": list(self.blockers),
            "evidence_refs": [asdict(ref) for ref in self.evidence_refs],
            "proof_cardinality": dict(self.proof_cardinality),
        }


_EVIDENCE_RANK: Mapping[EvidenceState, int] = MappingProxyType({
    "declared": 0,
    "code_proven": 1,
    "live_proven": 2,
    "operator_blocked": 3,
})


@dataclass(frozen=True, slots=True)
class AutonomyEvidenceStatus:
    target_sha: str
    derived_at: str
    overall_state: EvidenceState
    blockers: tuple[str, ...]
    capabilities: Mapping[str, CapabilityEvidence]

    def __post_init__(self) -> None:
        capabilities = MappingProxyType(dict(self.capabilities))
        blockers = tuple(sorted({
            blocker
            for evidence in capabilities.values()
            for blocker in evidence.blockers
        }))
        states = tuple(evidence.state for evidence in capabilities.values())
        if "operator_blocked" in states:
            overall: EvidenceState = "operator_blocked"
        elif states:
            overall = min(states, key=_EVIDENCE_RANK.__getitem__)
        else:
            overall = "declared"
        object.__setattr__(self, "capabilities", capabilities)
        object.__setattr__(self, "blockers", blockers)
        object.__setattr__(self, "overall_state", overall)

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_sha": self.target_sha,
            "derived_at": self.derived_at,
            "overall_state": self.overall_state,
            "blockers": list(self.blockers),
            "capabilities": {
                key: evidence.to_dict()
                for key, evidence in self.capabilities.items()
            },
        }


_KERNEL = "aria-kernel/aria_kernel/"
_COMMON_AUTHORITY_PATHS = (
    f"{_KERNEL}autonomy_evidence.py",
    f"{_KERNEL}file_lock.py",
    f"{_KERNEL}ledger.py",
    f"{_KERNEL}state_manifest.py",
    f"{_KERNEL}state_snapshot.py",
    f"{_KERNEL}state_store.py",
    f"{_KERNEL}tool_registry.py",
    f"{_KERNEL}tools_binding.py",
    f"{_KERNEL}workspace.py",
    "docs/aria/policy/autonomy-closure-findings.json",
)


def _paths(*paths: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys((*paths, *_COMMON_AUTHORITY_PATHS)))


CAPABILITY_SPECS: Mapping[str, CapabilitySpec] = MappingProxyType({
    "cycle_runtime": CapabilitySpec(
        authority_paths=_paths(
            f"{_KERNEL}cycle.py",
            f"{_KERNEL}autonomy_orchestrator.py",
            f"{_KERNEL}autonomy_state.py",
            f"{_KERNEL}burn_in.py",
            f"{_KERNEL}runtime_artifacts.py",
            f"{_KERNEL}tool_health.py",
            f"{_KERNEL}upcasters/__init__.py",
            f"{_KERNEL}upcasters/cycles.py",
            f"{_KERNEL}state_manifest.py",
            ".github/workflows/aria-auto-cycle.yml",
        ),
        producer_paths=(
            f"{_KERNEL}cycle.py",
            f"{_KERNEL}autonomy_orchestrator.py",
            f"{_KERNEL}autonomy_state.py",
            f"{_KERNEL}burn_in.py",
            f"{_KERNEL}tool_health.py",
            ".github/workflows/aria-auto-cycle.yml",
        ),
        authorizing_consumer_paths=(
            f"{_KERNEL}autonomy_state.py",
            f"{_KERNEL}burn_in.py",
            f"{_KERNEL}runtime_artifacts.py",
        ),
        contracts=(EvidenceContract(
            surface="cycles",
            proof_kind="live",
            schema_id=None,
            schema_versions=frozenset({1, 2, 3}),
            identity_field="cycle_id",
            integrity_hash_field="ledger_hash",
            authoritative_sha_field="git_head_sha_at_cycle",
            upcaster=_upcast_cycle_row,
            terminal_predicate=lambda row: (
                row.get("event") == "completed"
                and row.get("status") == "completed"
            ),
        ),),
        count_surfaces=("cycles", "autonomy_state"),
    ),
    "executor": CapabilitySpec(
        authority_paths=_paths(
            f"{_KERNEL}agent_invocations.py",
            f"{_KERNEL}agent_eval.py",
            f"{_KERNEL}bridge_status_ledger.py",
            f"{_KERNEL}circuit_breaker.py",
            f"{_KERNEL}convergence_drainer.py",
            f"{_KERNEL}evidence_validator.py",
            f"{_KERNEL}plan_convergence.py",
            f"{_KERNEL}state_manifest.py",
            "tools/aria-poc/dispatch_failure.py",
            "tools/aria-poc/claude_runtime.py",
            "tools/aria-poc/ci_executor.py",
            "tools/aria-poc/ci_executor_drain.py",
            "tools/aria-poc/worker_executor.py",
            ".github/workflows/aria-agent-executor.yml",
        ),
        producer_paths=(
            f"{_KERNEL}agent_invocations.py",
            f"{_KERNEL}tool_registry.py",
            "tools/aria-poc/dispatch_failure.py",
            "tools/aria-poc/claude_runtime.py",
            "tools/aria-poc/ci_executor.py",
            "tools/aria-poc/ci_executor_drain.py",
            "tools/aria-poc/worker_executor.py",
            ".github/workflows/aria-agent-executor.yml",
        ),
        authorizing_consumer_paths=(
            f"{_KERNEL}agent_invocations.py",
            f"{_KERNEL}agent_eval.py",
            f"{_KERNEL}bridge_status_ledger.py",
            f"{_KERNEL}circuit_breaker.py",
            f"{_KERNEL}convergence_drainer.py",
            f"{_KERNEL}evidence_validator.py",
            f"{_KERNEL}plan_convergence.py",
        ),
        contracts=(EvidenceContract(
            surface="agent_invocation_results",
            proof_kind="live",
            schema_id="aria/agent-claim-result/v1",
            schema_versions=frozenset({1}),
            identity_field="row_id",
            integrity_hash_field="ledger_hash",
            # ARIA-HIGH-003 — accepted results carry the trusted request's
            # immutable target SHA (stamped by agent_invocations at
            # acceptance, never read from the submitted envelope), so an
            # executor proof binds the tree it ran against. A row whose SHA
            # is missing or malformed stays terminal/countable history but
            # can never become live_proven for any evaluated target.
            authoritative_sha_field="target_sha",
            upcaster=_identity_upcaster,
            terminal_predicate=_field_equals("status", "accepted"),
        ),),
        count_surfaces=(
            "agent_invocation_requests",
            "agent_invocation_results",
            "tools_governance",
        ),
    ),
    "finding_funnel": CapabilitySpec(
        authority_paths=_paths(
            f"{_KERNEL}calibration_bootstrap.py",
            f"{_KERNEL}feedback_store.py",
            f"{_KERNEL}finding_promotion.py",
            f"{_KERNEL}funnel_health.py",
            f"{_KERNEL}pr_tracking.py",
            f"{_KERNEL}rule_health.py",
            f"{_KERNEL}state_compact.py",
            f"{_KERNEL}state_manifest.py",
            ".github/workflows/aria-auto-cycle.yml",
            ".github/workflows/aria-agent-executor.yml",
        ),
        producer_paths=(
            f"{_KERNEL}calibration_bootstrap.py",
            f"{_KERNEL}feedback_store.py",
            f"{_KERNEL}finding_promotion.py",
            f"{_KERNEL}pr_tracking.py",
            f"{_KERNEL}rule_health.py",
            f"{_KERNEL}state_compact.py",
            ".github/workflows/aria-auto-cycle.yml",
            ".github/workflows/aria-agent-executor.yml",
        ),
        authorizing_consumer_paths=(
            f"{_KERNEL}finding_promotion.py",
            f"{_KERNEL}funnel_health.py",
            f"{_KERNEL}rule_health.py",
            f"{_KERNEL}state_compact.py",
        ),
        contracts=(EvidenceContract(
            surface="promotions",
            proof_kind="live",
            schema_id=None,
            schema_versions=frozenset({1}),
            identity_field="finding_fingerprint",
            integrity_hash_field="ledger_hash",
            authoritative_sha_field=None,
            upcaster=_identity_upcaster,
            terminal_predicate=lambda row: bool(row.get("finding_id")),
        ),),
        count_surfaces=(
            "raw_findings",
            "operator_feedback",
            "findings",
            "promotions",
        ),
    ),
    "fixture_calibration": CapabilitySpec(
        authority_paths=_paths(
            f"{_KERNEL}agent_genesis.py",
            f"{_KERNEL}feedback_store.py",
            f"{_KERNEL}fixture_runner.py",
            f"{_KERNEL}genesis_lifecycle.py",
            f"{_KERNEL}judge_calibration.py",
            f"{_KERNEL}adapter_calibration.py",
            f"{_KERNEL}readiness.py",
            f"{_KERNEL}shadow_eval_bridge.py",
            f"{_KERNEL}tool_registry.py",
            f"{_KERNEL}state_manifest.py",
            ".github/workflows/aria-auto-cycle.yml",
            ".github/workflows/aria-agent-executor.yml",
        ),
        producer_paths=(
            f"{_KERNEL}feedback_store.py",
            f"{_KERNEL}fixture_runner.py",
            f"{_KERNEL}judge_calibration.py",
            f"{_KERNEL}adapter_calibration.py",
            ".github/workflows/aria-auto-cycle.yml",
            ".github/workflows/aria-agent-executor.yml",
        ),
        authorizing_consumer_paths=(
            f"{_KERNEL}agent_genesis.py",
            f"{_KERNEL}genesis_lifecycle.py",
            f"{_KERNEL}readiness.py",
            f"{_KERNEL}shadow_eval_bridge.py",
            f"{_KERNEL}tool_registry.py",
        ),
        contracts=(EvidenceContract(
            surface="agent_eval_fixture_runs",
            proof_kind="live",
            schema_id=None,
            schema_versions=frozenset({1}),
            identity_field="execution_run_id",
            integrity_hash_field="ledger_hash",
            authoritative_sha_field=None,
            upcaster=_identity_upcaster,
            terminal_predicate=lambda row: (
                row.get("row_type") == "fixture_run_suite"
                and row.get("passed") is True
                and row.get("actual_status") == "pass"
            ),
        ),),
        count_surfaces=(
            "agent_eval_fixture_runs",
            "calibration_judge",
            "calibration_adapter_reports",
        ),
    ),
    "pre_merge_perimeter": CapabilitySpec(
        authority_paths=_paths(
            f"{_KERNEL}auto_merge.py",
            f"{_KERNEL}pre_merge_evidence.py",
            f"{_KERNEL}implementation_safety.py",
            f"{_KERNEL}merge_authority.py",
            f"{_KERNEL}plan_convergence.py",
            f"{_KERNEL}file_claims.py",
            f"{_KERNEL}operator_feedback_signature.py",
            f"{_KERNEL}expert_review_gate.py",
            f"{_KERNEL}plan_coverage.py",
            f"{_KERNEL}budget.py",
            f"{_KERNEL}cost_budget.py",
            f"{_KERNEL}state_manifest.py",
            ".github/workflows/aria-merge-authority.yml",
        ),
        producer_paths=(
            f"{_KERNEL}auto_merge.py",
            f"{_KERNEL}pre_merge_evidence.py",
            f"{_KERNEL}plan_convergence.py",
            f"{_KERNEL}file_claims.py",
            f"{_KERNEL}operator_feedback_signature.py",
            f"{_KERNEL}expert_review_gate.py",
            f"{_KERNEL}plan_coverage.py",
            f"{_KERNEL}budget.py",
            f"{_KERNEL}cost_budget.py",
            ".github/workflows/aria-merge-authority.yml",
        ),
        authorizing_consumer_paths=(
            f"{_KERNEL}auto_merge.py",
            f"{_KERNEL}implementation_safety.py",
            f"{_KERNEL}merge_authority.py",
        ),
        contracts=(),
        count_surfaces=("auto_merge_decisions",),
    ),
    "enterprise_readiness": CapabilitySpec(
        authority_paths=_paths(
            f"{_KERNEL}auto_merge_runners.py",
            f"{_KERNEL}gh_token_factory.py",
            f"{_KERNEL}readiness_schema.py",
            f"{_KERNEL}readiness_proofs.py",
            f"{_KERNEL}runtime_artifacts.py",
            f"{_KERNEL}enterprise_readiness.py",
            f"{_KERNEL}state_snapshot.py",
            f"{_KERNEL}state_store.py",
            f"{_KERNEL}rollback_bundle.py",
            f"{_KERNEL}state_manifest.py",
            ".github/CODEOWNERS",
            ".github/actions/mint-aria-app-token/action.yml",
            ".github/workflows/aria-auto-cycle.yml",
            ".github/workflows/aria-agent-executor.yml",
            ".github/workflows/aria-agent-eval.yml",
            ".github/workflows/aria-readiness-claim.yml",
        ),
        producer_paths=(
            f"{_KERNEL}gh_token_factory.py",
            f"{_KERNEL}readiness_schema.py",
            f"{_KERNEL}readiness_proofs.py",
            f"{_KERNEL}enterprise_readiness.py",
            f"{_KERNEL}state_snapshot.py",
            f"{_KERNEL}rollback_bundle.py",
            ".github/actions/mint-aria-app-token/action.yml",
            ".github/workflows/aria-auto-cycle.yml",
            ".github/workflows/aria-agent-executor.yml",
            ".github/workflows/aria-agent-eval.yml",
            ".github/workflows/aria-readiness-claim.yml",
        ),
        authorizing_consumer_paths=(
            f"{_KERNEL}auto_merge_runners.py",
            f"{_KERNEL}enterprise_readiness.py",
        ),
        contracts=(EvidenceContract(
            surface="enterprise_readiness_claims",
            proof_kind="live",
            schema_id="aria/enterprise-readiness-claim/v2",
            schema_versions=frozenset({2}),
            identity_field="row_id",
            integrity_hash_field="ledger_hash",
            authoritative_sha_field="head_sha",
            upcaster=_identity_upcaster,
            terminal_predicate=_enterprise_readiness_v2_terminal,
        ),),
        count_surfaces=("enterprise_readiness_claims",),
    ),
    "autonomy_unlock": CapabilitySpec(
        authority_paths=_paths(
            f"{_KERNEL}acceptance_reconciler.py",
            f"{_KERNEL}autonomy_unlock.py",
            f"{_KERNEL}autonomy_ladder.py",
            f"{_KERNEL}runtime_profile.py",
            f"{_KERNEL}merge_authority.py",
            f"{_KERNEL}rollback_bundle.py",
            f"{_KERNEL}state_manifest.py",
            "docs/aria/policy/autonomy-unlock.json",
            ".github/workflows/aria-auto-cycle.yml",
        ),
        producer_paths=(
            f"{_KERNEL}acceptance_reconciler.py",
            f"{_KERNEL}autonomy_unlock.py",
            f"{_KERNEL}autonomy_ladder.py",
            f"{_KERNEL}rollback_bundle.py",
            ".github/workflows/aria-auto-cycle.yml",
        ),
        authorizing_consumer_paths=(
            f"{_KERNEL}autonomy_ladder.py",
            f"{_KERNEL}autonomy_unlock.py",
            f"{_KERNEL}runtime_profile.py",
            f"{_KERNEL}merge_authority.py",
        ),
        contracts=(EvidenceContract(
            surface="enterprise_autonomy_unlock_events",
            proof_kind="live",
            schema_id=None,
            schema_versions=frozenset({1}),
            identity_field="row_id",
            integrity_hash_field="ledger_hash",
            authoritative_sha_field=None,
            upcaster=_identity_upcaster,
            terminal_predicate=_field_equals("valid", True),
        ),),
        count_surfaces=(
            "enterprise_acceptance_events",
            "enterprise_autonomy_unlock_events",
        ),
    ),
})
CAPABILITY_AUTHORITY_PATHS: Mapping[str, tuple[str, ...]] = MappingProxyType({
    key: spec.authority_paths
    for key, spec in CAPABILITY_SPECS.items()
})


def _summarize_native_rows(
    capability: str,
    rows_by_surface: Mapping[str, Iterable[Mapping[str, Any]]],
) -> _NativeSummary:
    """Bound terminal proof material by distinct immutable target SHA."""
    spec = CAPABILITY_SPECS[capability]
    targets_by_contract: dict[
        EvidenceContract,
        dict[str, _TargetCandidate],
    ] = {contract: {} for contract in spec.contracts}
    distinct_targets: set[str] = set()
    budget_exceeded = False
    blockers: set[str] = set()
    row_count = 0
    terminal_count = 0
    admissible_count = 0
    ordinal = 0
    for contract in spec.contracts:
        for raw_row in rows_by_surface.get(contract.surface, ()):
            row_count += 1
            ordinal += 1
            try:
                row = contract.upcaster(raw_row)
            except Exception:  # noqa: BLE001 - native rejection is nonproof
                blockers.add(f"proof_upcast_rejected:{contract.surface}")
                continue
            schema_version = row.get("schema_version")
            schema_id = row.get("$schema")
            if (
                not isinstance(schema_version, int)
                or isinstance(schema_version, bool)
                or schema_version not in contract.schema_versions
                or (
                    contract.schema_id is not None
                    and schema_id != contract.schema_id
                )
            ):
                blockers.add(f"proof_schema_unsupported:{contract.surface}")
                continue
            try:
                terminal = contract.terminal_predicate(row)
            except Exception:  # noqa: BLE001 - native rejection is nonproof
                blockers.add(f"proof_terminal_rejected:{contract.surface}")
                continue
            if not terminal:
                continue
            terminal_count += 1
            row_id = row.get(contract.identity_field)
            if not isinstance(row_id, str) or not row_id.strip():
                blockers.add(f"proof_identity_missing:{contract.surface}")
                continue
            row_hash = row.get(contract.integrity_hash_field)
            if not isinstance(row_hash, str) or not _LEDGER_HASH.fullmatch(row_hash):
                blockers.add(
                    f"proof_integrity_hash_missing:{contract.surface}",
                )
                continue
            sha_field = contract.authoritative_sha_field
            if sha_field is None:
                blockers.add(
                    f"proof_target_sha_unavailable:{contract.surface}",
                )
                continue
            evidence_target_sha = row.get(sha_field)
            if (
                not isinstance(evidence_target_sha, str)
                or not _FULL_SHA.fullmatch(evidence_target_sha)
            ):
                blockers.add(f"proof_target_sha_invalid:{contract.surface}")
                continue
            admissible_count += 1
            candidate = _NativeCandidate(
                contract=contract,
                schema_id=schema_id if isinstance(schema_id, str) else None,
                schema_version=schema_version,
                row_id=row_id,
                row_hash=row_hash,
                evidence_target_sha=evidence_target_sha,
            )
            existing = targets_by_contract[contract].get(evidence_target_sha)
            if existing is not None:
                by_schema = Counter(existing.admissible_by_schema)
                by_schema[schema_version] += 1
                targets_by_contract[contract][evidence_target_sha] = _TargetCandidate(
                    candidate=candidate,
                    admissible_count=existing.admissible_count + 1,
                    admissible_by_schema=MappingProxyType(dict(by_schema)),
                    ordinal=ordinal,
                )
                continue
            if evidence_target_sha not in distinct_targets:
                if (
                    len(distinct_targets)
                    >= _MAX_DISTINCT_PROOF_TARGETS_PER_CAPABILITY
                ):
                    budget_exceeded = True
                    continue
                distinct_targets.add(evidence_target_sha)
            targets_by_contract[contract][evidence_target_sha] = _TargetCandidate(
                candidate=candidate,
                admissible_count=1,
                admissible_by_schema=MappingProxyType({schema_version: 1}),
                ordinal=ordinal,
            )
    return _NativeSummary(
        targets_by_contract=MappingProxyType({
            contract: tuple(targets.values())
            for contract, targets in targets_by_contract.items()
        }),
        counts=MappingProxyType({
            "rows": row_count,
            "terminal": terminal_count,
            "admissible": admissible_count,
        }),
        blockers=tuple(sorted(blockers)),
        distinct_target_budget_exceeded=budget_exceeded,
    )


def _evaluate_native_rows(
    capability: str,
    rows_by_surface: Mapping[str, tuple[Mapping[str, Any], ...]],
) -> tuple[tuple[_NativeCandidate, ...], dict[str, int], tuple[str, ...]]:
    """Compatibility projection with at most one newest witness per contract."""
    summary = _summarize_native_rows(capability, rows_by_surface)
    candidates = tuple(
        max(targets, key=lambda target: target.ordinal).candidate
        for targets in summary.targets_by_contract.values()
        if targets
    )
    blockers = set(summary.blockers)
    if summary.distinct_target_budget_exceeded:
        blockers.add(f"proof_distinct_sha_budget_exceeded:{capability}")
    if summary.global_target_budget_exceeded:
        blockers.add("proof_distinct_sha_budget_exceeded:global")
    return candidates, dict(summary.counts), tuple(sorted(blockers))


def _run_git(
    repo_root: Path,
    *args: str,
) -> subprocess.CompletedProcess[bytes]:
    max_output_bytes = 1024 * 1024
    try:
        process = subprocess.Popen(
            ["git", "-C", str(repo_root), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
            bufsize=0,
        )
    except OSError as exc:
        raise RuntimeError("git_history_unavailable") from exc
    if process.stdout is None:  # pragma: no cover - PIPE guarantees stdout
        process.kill()
        raise RuntimeError("git_history_unavailable")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + _GIT_STREAM_TIMEOUT_SECONDS
    output = bytearray()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("git_history_unavailable")
            if not selector.select(remaining):
                raise RuntimeError("git_history_unavailable")
            chunk = os.read(process.stdout.fileno(), 64 * 1024)
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > max_output_bytes:
                raise RuntimeError("git_output_budget_exceeded")
        try:
            returncode = process.wait(
                timeout=max(0.001, deadline - time.monotonic()),
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("git_history_unavailable") from exc
        return subprocess.CompletedProcess(
            ["git", "-C", str(repo_root), *args],
            returncode,
            bytes(output),
            b"",
        )
    finally:
        selector.close()
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()


def _git_blob_size(
    repo_root: Path,
    object_id: str,
    *,
    max_bytes: int,
    too_large: str,
) -> int:
    """Return one immutable blob's strict decimal Git object size."""
    if _GIT_OBJECT_ID.fullmatch(object_id) is None:
        raise RuntimeError("git_blob_object_id_invalid")
    result = _run_git(repo_root, "cat-file", "-s", object_id)
    if result.returncode != 0:
        raise RuntimeError("git_blob_size_unavailable")
    if re.fullmatch(rb"(?:0|[1-9][0-9]*)\n", result.stdout) is None:
        raise RuntimeError("git_blob_size_invalid")
    size = int(result.stdout[:-1])
    if size > max_bytes:
        raise RuntimeError(too_large)
    return size


def _iter_git_output_bounded(
    repo_root: Path,
    *args: str,
    max_bytes: int,
    expected_size: int | None = None,
    unavailable: str,
) -> Iterator[bytes]:
    """Yield bounded Git stdout chunks with wall-clock timeout and no stderr."""
    try:
        process = subprocess.Popen(
            ["git", "-C", str(repo_root), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
            bufsize=0,
        )
    except OSError as exc:
        raise RuntimeError(unavailable) from exc
    if process.stdout is None:  # pragma: no cover - PIPE guarantees stdout
        process.kill()
        raise RuntimeError(unavailable)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + _GIT_STREAM_TIMEOUT_SECONDS
    total = 0
    completed = False
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(unavailable)
            events = selector.select(remaining)
            if not events:
                raise RuntimeError(unavailable)
            chunk = os.read(process.stdout.fileno(), 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError(unavailable)
            yield chunk
        try:
            returncode = process.wait(
                timeout=max(0.001, deadline - time.monotonic()),
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(unavailable) from exc
        if returncode != 0 or (
            expected_size is not None and total != expected_size
        ):
            raise RuntimeError(unavailable)
        completed = True
    finally:
        selector.close()
        process.stdout.close()
        if not completed and process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _iter_git_blob_bounded(
    repo_root: Path,
    object_id: str,
    *,
    max_bytes: int,
    too_large: str,
    unavailable: str,
) -> tuple[int, Iterable[bytes]]:
    size = _git_blob_size(
        repo_root,
        object_id,
        max_bytes=max_bytes,
        too_large=too_large,
    )
    return size, _iter_git_output_bounded(
        repo_root,
        "cat-file",
        "blob",
        object_id,
        max_bytes=size,
        expected_size=size,
        unavailable=unavailable,
    )


def _read_git_blob_bounded(
    repo_root: Path,
    object_id: str,
    *,
    max_bytes: int,
    too_large: str,
    unavailable: str = "git_blob_unavailable",
) -> bytes:
    _size, chunks = _iter_git_blob_bounded(
        repo_root,
        object_id,
        max_bytes=max_bytes,
        too_large=too_large,
        unavailable=unavailable,
    )
    return b"".join(chunks)


def _hash_git_blob_bounded(
    repo_root: Path,
    object_id: str,
    *,
    max_bytes: int,
    too_large: str,
    unavailable: str,
) -> tuple[int, str]:
    size, chunks = _iter_git_blob_bounded(
        repo_root,
        object_id,
        max_bytes=max_bytes,
        too_large=too_large,
        unavailable=unavailable,
    )
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(chunk)
    return size, digest.hexdigest()


def _commit_exists(repo_root: Path, sha: str) -> bool:
    return _run_git(repo_root, "cat-file", "-e", f"{sha}^{{commit}}").returncode == 0


def _git_tree_entry(
    repo_root: Path,
    commit_sha: str,
    path: str,
) -> tuple[bytes, str, str, str] | None:
    """Return one exact ls-tree record plus mode, type, and object id."""
    listing = _run_git(
        repo_root,
        "ls-tree",
        "-z",
        "--full-tree",
        commit_sha,
        "--",
        path,
    )
    if listing.returncode != 0:
        raise RuntimeError("git_authority_tree_unavailable")
    if not listing.stdout:
        return None
    records = listing.stdout.removesuffix(b"\0").split(b"\0")
    if len(records) != 1:
        raise RuntimeError("git_authority_tree_invalid")
    metadata, separator, listed_path = records[0].partition(b"\t")
    fields = metadata.split(b" ")
    if (
        separator != b"\t"
        or len(fields) != 3
        or listed_path != path.encode("utf-8")
    ):
        raise RuntimeError("git_authority_tree_invalid")
    try:
        mode, object_type, object_id = (
            field.decode("ascii") for field in fields
        )
    except UnicodeDecodeError as exc:
        raise RuntimeError("git_authority_tree_invalid") from exc
    if (
        re.fullmatch(r"[0-7]{6}", mode) is None
        or object_type not in {"blob", "tree", "commit"}
        or re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", object_id) is None
    ):
        raise RuntimeError("git_authority_tree_invalid")
    return listing.stdout, mode, object_type, object_id


def _git_tree_entries(
    repo_root: Path,
    commit_sha: str,
) -> dict[str, tuple[bytes, str, str, str]]:
    """Enumerate one commit tree under a bounded binary output budget."""
    from .state_manifest import (
        MAX_SURFACE_PATH_BYTES,
        MAX_SURFACE_PATH_COMPONENTS,
        normalize_surface_relative_path,
    )

    output = b"".join(_iter_git_output_bounded(
        repo_root,
        "ls-tree",
        "-r",
        "-t",
        "-z",
        "--full-tree",
        commit_sha,
        max_bytes=_MAX_SNAPSHOT_TREE_BYTES,
        unavailable="state_snapshot_tree_unavailable",
    ))
    if output and not output.endswith(b"\0"):
        raise RuntimeError("state_snapshot_tree_invalid")
    records = output.removesuffix(b"\0").split(b"\0") if output else []
    if len(records) > _MAX_SNAPSHOT_TREE_ENTRIES:
        raise RuntimeError("state_snapshot_tree_budget_exceeded")
    entries: dict[str, tuple[bytes, str, str, str]] = {}
    for record in records:
        metadata, separator, raw_path = record.partition(b"\t")
        fields = metadata.split(b" ")
        if separator != b"\t" or len(fields) != 3 or not raw_path:
            raise RuntimeError("state_snapshot_tree_invalid")
        if len(raw_path) > MAX_SURFACE_PATH_BYTES:
            raise RuntimeError("state_snapshot_tree_path_too_long")
        if raw_path.count(b"/") + 1 > MAX_SURFACE_PATH_COMPONENTS:
            raise RuntimeError("state_snapshot_tree_path_too_deep")
        try:
            mode, object_type, object_id = (
                field.decode("ascii") for field in fields
            )
            path = raw_path.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RuntimeError("state_snapshot_tree_invalid") from exc
        try:
            normalize_surface_relative_path(path)
        except (RecursionError, ValueError) as exc:
            reason = str(exc)
            if reason == "surface_path_too_long":
                raise RuntimeError("state_snapshot_tree_path_too_long") from exc
            if reason == "surface_path_too_deep":
                raise RuntimeError("state_snapshot_tree_path_too_deep") from exc
            raise RuntimeError("state_snapshot_tree_path_invalid") from exc
        if (
            re.fullmatch(r"[0-7]{6}", mode) is None
            or object_type not in {"blob", "tree", "commit"}
            or _GIT_OBJECT_ID.fullmatch(object_id) is None
            or path in entries
        ):
            raise RuntimeError("state_snapshot_tree_invalid")
        entries[path] = (record + b"\0", mode, object_type, object_id)
    return entries


def _capability_authority_hash(
    repo_root: str | Path,
    capability: str,
    commit_sha: str,
) -> str:
    """Hash exact authority path names and blobs from one Git tree."""
    root = Path(repo_root).resolve()
    if not _commit_exists(root, commit_sha):
        raise RuntimeError(f"git_commit_unavailable:{commit_sha}")
    digest = hashlib.sha256()
    aggregate_size = 0
    for path in sorted(CAPABILITY_SPECS[capability].authority_paths):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        entry = _git_tree_entry(root, commit_sha, path)
        if entry is None:
            digest.update(b"MISSING")
        else:
            record, mode, object_type, object_id = entry
            if object_type != "blob" or mode not in {"100644", "100755"}:
                raise RuntimeError("git_authority_tree_invalid")
            digest.update(b"ENTRY\0")
            digest.update(record)
            try:
                size, chunks = _iter_git_blob_bounded(
                    root,
                    object_id,
                    max_bytes=_MAX_AUTHORITY_BLOB_BYTES,
                    too_large="git_authority_blob_too_large",
                    unavailable="git_authority_blob_unavailable",
                )
            except RuntimeError as exc:
                if str(exc) == "git_authority_blob_too_large":
                    raise
                raise RuntimeError("git_authority_blob_unavailable") from exc
            aggregate_size += size
            if aggregate_size > _MAX_AUTHORITY_CAPABILITY_BYTES:
                raise RuntimeError("git_authority_capability_budget_exceeded")
            digest.update(b"BLOB\0")
            for chunk in chunks:
                digest.update(chunk)
        digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def _executing_repository_root() -> Path | None:
    try:
        returncode, root = _git_text(
            Path(__file__).resolve().parent,
            "rev-parse",
            "--show-toplevel",
        )
    except RuntimeError:
        return None
    return Path(root).resolve() if returncode == 0 and root else None


def _evaluator_definition_blocker(
    repo_root: Path,
    target_sha: str,
    *,
    evaluator_repo_root: Path | None = None,
) -> str | None:
    """Pin the executing roster/logic to the evaluator blob at the target."""
    executing_root = evaluator_repo_root or _executing_repository_root()
    if executing_root is None:
        return "evaluator_repository_unavailable"
    if executing_root.resolve() != repo_root.resolve():
        return "evaluator_repository_mismatch"
    evaluator_path = f"{_KERNEL}autonomy_evidence.py"
    try:
        entry = _git_tree_entry(repo_root, target_sha, evaluator_path)
    except RuntimeError:
        return "evaluator_definition_unavailable"
    if entry is None:
        return "evaluator_definition_missing"
    _record, mode, object_type, object_id = entry
    if object_type != "blob" or mode not in {"100644", "100755"}:
        return "evaluator_definition_not_regular"
    try:
        from .state_store import StateStoreError, _read_bounded_regular_file

        blob = _read_git_blob_bounded(
            repo_root,
            object_id,
            max_bytes=_MAX_EVALUATOR_BLOB_BYTES,
            too_large="evaluator_definition_too_large",
            unavailable="evaluator_definition_unavailable",
        )
        executing, _fingerprint = _read_bounded_regular_file(Path(__file__))
    except RuntimeError as exc:
        if str(exc) == "evaluator_definition_too_large":
            return "evaluator_definition_too_large"
        return "evaluator_definition_unavailable"
    except (OSError, StateStoreError):
        return "evaluator_definition_unavailable"
    if blob != executing:
        return "evaluator_definition_changed"
    return None


def _evaluator_capability_blocker(
    repo_root: Path,
    capability: str,
    target_sha: str,
    *,
    evaluator_repo_root: Path | None = None,
) -> str | None:
    definition_blocker = _evaluator_definition_blocker(
        repo_root,
        target_sha,
        evaluator_repo_root=evaluator_repo_root,
    )
    if definition_blocker is not None:
        return definition_blocker
    try:
        returncode, current_head = _git_text(
            repo_root,
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
        )
    except RuntimeError as exc:
        named = str(exc)
        if named in {
            "git_authority_blob_too_large",
            "git_authority_capability_budget_exceeded",
        }:
            return named
        return f"evaluator_authority_unavailable:{capability}"
    if returncode != 0 or not _FULL_SHA.fullmatch(current_head):
        return f"evaluator_authority_unavailable:{capability}"
    try:
        current_hash = _capability_authority_hash(
            repo_root,
            capability,
            current_head,
        )
        target_hash = _capability_authority_hash(
            repo_root,
            capability,
            target_sha,
        )
    except RuntimeError as exc:
        named = str(exc)
        if named in {
            "git_authority_blob_too_large",
            "git_authority_capability_budget_exceeded",
        }:
            return named
        return f"evaluator_authority_unavailable:{capability}"
    if current_hash != target_hash:
        return f"evaluator_authority_changed:{capability}"
    return None


def _evaluator_worktree_blocker(repo_root: Path) -> str | None:
    authority_paths = tuple(sorted({
        path
        for spec in CAPABILITY_SPECS.values()
        for path in spec.authority_paths
    }))
    try:
        result = _run_git(
            repo_root,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--",
            *authority_paths,
        )
    except RuntimeError:
        return "evaluator_authority_worktree_unavailable"
    if result.returncode != 0:
        return "evaluator_authority_worktree_unavailable"
    if result.stdout:
        return "evaluator_authority_worktree_dirty"
    return None


def _ancestry_blocker(
    repo_root: Path,
    *,
    evidence_target_sha: str,
    evaluated_target_sha: str,
) -> str | None:
    try:
        if not _commit_exists(repo_root, evidence_target_sha):
            return "git_evidence_commit_unavailable"
        if not _commit_exists(repo_root, evaluated_target_sha):
            return "git_target_commit_unavailable"
    except RuntimeError:
        return "git_history_unavailable"
    if evidence_target_sha == evaluated_target_sha:
        return None
    try:
        result = _run_git(
            repo_root,
            "merge-base",
            "--is-ancestor",
            evidence_target_sha,
            evaluated_target_sha,
        )
    except RuntimeError:
        return "git_history_unavailable"
    if result.returncode == 0:
        return None
    try:
        shallow = _run_git(repo_root, "rev-parse", "--is-shallow-repository")
    except RuntimeError:
        return "git_history_unavailable"
    if shallow.returncode == 0 and shallow.stdout.strip() == b"true":
        return "git_history_unavailable_shallow"
    if result.returncode not in {0, 1}:
        return "git_history_unavailable"
    return "proof_non_ancestor"


def _derive_capability_evidence(
    *,
    capability: str,
    rows_by_surface: Mapping[str, tuple[Mapping[str, Any], ...]],
    repo_root: str | Path,
    target_sha: str,
    state_commit: str,
    _test_evaluator_repo_root: str | Path | None = None,
    _native_summary: _NativeSummary | None = None,
) -> CapabilityEvidence:
    """Derive one capability from already-admitted, producer-native rows."""
    root = Path(repo_root).resolve()
    summary = _native_summary or _summarize_native_rows(
        capability, rows_by_surface,
    )
    counts = dict(summary.counts)
    native_blockers = summary.blockers
    budget_blockers: set[str] = set()
    if summary.distinct_target_budget_exceeded:
        budget_blockers.add(f"proof_distinct_sha_budget_exceeded:{capability}")
    if summary.global_target_budget_exceeded:
        budget_blockers.add("proof_distinct_sha_budget_exceeded:global")
    if budget_blockers:
        return CapabilityEvidence(
            state="declared",
            counts=counts,
            blockers=tuple(sorted({*native_blockers, *budget_blockers})),
            evidence_refs=(),
        )
    evaluator_blocker = _evaluator_capability_blocker(
        root,
        capability,
        target_sha,
        evaluator_repo_root=(
            Path(_test_evaluator_repo_root).resolve()
            if _test_evaluator_repo_root is not None
            else None
        ),
    )
    if evaluator_blocker is not None:
        return CapabilityEvidence(
            state="declared",
            counts=counts,
            blockers=tuple(sorted({*native_blockers, evaluator_blocker})),
            evidence_refs=(),
        )
    refs: list[EvidenceRef] = []
    blockers = set(native_blockers)
    proof_kinds: set[ProofKind] = set()
    proof_cardinality: dict[str, int] = {}
    ancestry_cache: dict[str, str | None] = {}
    authority_cache: dict[str, str] = {}

    def authority_hash(sha: str) -> str:
        if sha not in authority_cache:
            authority_cache[sha] = _capability_authority_hash(
                root,
                capability,
                sha,
            )
        return authority_cache[sha]

    for contract, targets in summary.targets_by_contract.items():
        ordered = sorted(
            targets,
            key=lambda target: (
                target.candidate.evidence_target_sha == target_sha,
                target.ordinal,
            ),
            reverse=True,
        )
        witness: _TargetCandidate | None = None
        witness_hash: str | None = None
        for retained in ordered:
            candidate = retained.candidate
            evidence_sha = candidate.evidence_target_sha
            if evidence_sha not in ancestry_cache:
                ancestry_cache[evidence_sha] = _ancestry_blocker(
                    root,
                    evidence_target_sha=evidence_sha,
                    evaluated_target_sha=target_sha,
                )
            blocker = ancestry_cache[evidence_sha]
            if blocker is not None:
                blockers.add(blocker)
                continue
            try:
                evidence_hash = authority_hash(evidence_sha)
                target_hash = authority_hash(target_sha)
            except RuntimeError as exc:
                named = str(exc)
                blockers.add(
                    named if named.startswith("git_authority_")
                    else "git_authority_unavailable"
                )
                continue
            if evidence_hash != target_hash:
                blockers.add(f"proof_authority_changed:{capability}")
                continue
            if witness is None:
                witness = retained
                witness_hash = target_hash
        for version in contract.schema_versions:
            proof_cardinality[_proof_cardinality_key(
                contract.surface,
                contract.proof_kind,
                contract.schema_id,
                version,
            )] = (
                witness.admissible_by_schema.get(version, 0)
                if witness is not None
                else 0
            )
        if witness is not None and witness_hash is not None:
            candidate = witness.candidate
            refs.append(EvidenceRef(
                surface=contract.surface,
                proof_kind=contract.proof_kind,
                schema_id=candidate.schema_id,
                schema_version=candidate.schema_version,
                row_id=candidate.row_id,
                row_hash=candidate.row_hash,
                evidence_target_sha=candidate.evidence_target_sha,
                evaluated_target_sha=target_sha,
                capability_authority_hash=witness_hash,
                state_commit=state_commit,
            ))
            proof_kinds.add(contract.proof_kind)
    state: EvidenceState = "declared"
    if "live" in proof_kinds:
        state = "live_proven"
    elif "code" in proof_kinds:
        state = "code_proven"
    return CapabilityEvidence(
        state=state,
        counts=counts,
        blockers=() if refs else tuple(sorted(blockers)),
        evidence_refs=tuple(refs),
        proof_cardinality=proof_cardinality,
    )


def _git_text(repo_root: Path, *args: str) -> tuple[int, str]:
    result = _run_git(repo_root, *args)
    return result.returncode, result.stdout.decode("utf-8", errors="replace").strip()


def _git_text_strict(repo_root: Path, *args: str) -> tuple[int, str]:
    """Decode identity-bearing Git output without lossy replacement."""
    result = _run_git(repo_root, *args)
    return result.returncode, result.stdout.decode("utf-8").strip()


def _git_text_raw_strict(repo_root: Path, *args: str) -> tuple[int, str]:
    """Decode an identity-bearing Git record without normalizing its bytes."""
    result = _run_git(repo_root, *args)
    try:
        return result.returncode, result.stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError("git_output_encoding_unavailable") from exc


def _unavailable_status(
    *,
    target_sha: str,
    blocker: str | tuple[str, ...],
    repo_root: Path,
) -> AutonomyEvidenceStatus:
    blockers = (blocker,) if isinstance(blocker, str) else blocker
    capabilities = {
        capability: CapabilityEvidence(
            state="declared",
            counts={"unavailable": 1},
            blockers=blockers,
            evidence_refs=(),
        )
        for capability in CAPABILITY_SPECS
    }
    capabilities = _apply_operator_prerequisites(
        capabilities=capabilities,
        repo_root=repo_root,
        target_sha=target_sha,
    )
    return AutonomyEvidenceStatus(
        target_sha=target_sha,
        derived_at=_derived_at(),
        overall_state="declared",
        blockers=blockers,
        capabilities=capabilities,
    )


def _derived_at() -> str:
    from .tool_registry import utc_now

    return utc_now().replace("+00:00", "Z")


def _resolve_repository(repo_root: str | Path) -> Path:
    candidate = Path(repo_root).resolve()
    returncode, top = _git_text(candidate, "rev-parse", "--show-toplevel")
    if returncode != 0 or not top:
        raise ValueError("evidence_repository_unavailable")
    return Path(top).resolve()


def _resolve_target_sha(repo_root: Path, target_sha: str | None) -> str:
    requested = target_sha or "HEAD"
    returncode, resolved = _git_text(
        repo_root,
        "rev-parse",
        "--verify",
        f"{requested}^{{commit}}",
    )
    if returncode != 0 or not _FULL_SHA.fullmatch(resolved):
        raise ValueError(f"evidence_target_sha_unavailable:{requested}")
    if target_sha is not None and target_sha != resolved:
        raise ValueError(f"evidence_target_sha_not_full:{target_sha}")
    return resolved


def _bounded_repository_identity(repo_root: Path) -> str:
    """Mirror workspace identity semantics using only bounded Git reads."""
    from .workspace import canonicalize_remote_url

    canonical_root = repo_root.resolve()
    returncode, common_dir_text = _git_text_strict(
        repo_root,
        "rev-parse",
        "--git-common-dir",
    )
    if returncode == 0 and common_dir_text:
        common_dir = Path(common_dir_text)
        if not common_dir.is_absolute():
            common_dir = repo_root / common_dir
        canonical_root = common_dir.resolve().parent

    _returncode, raw_remote = _git_text_strict(
        canonical_root,
        "config",
        "--get",
        "remote.origin.url",
    )
    normalized = canonicalize_remote_url(raw_remote)
    if normalized:
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]

    returncode, roots = _git_text_strict(
        canonical_root,
        "rev-list",
        "--max-parents=0",
        "HEAD",
    )
    root_sha = roots.splitlines()[0].strip() if returncode == 0 and roots else ""
    if root_sha:
        return hashlib.sha256(
            f"local-root:{root_sha}".encode("utf-8"),
        ).hexdigest()[:16]
    fallback = canonical_root.name or "unknown"
    return hashlib.sha256(
        f"local-basename:{fallback}".encode("utf-8"),
    ).hexdigest()[:16]


def _read_immutable_snapshot_claim(
    store_root: Path,
    state_commit: str,
) -> tuple[dict[str, Any], str]:
    from .state_snapshot import SnapshotError, validate_snapshot_manifest

    try:
        entry = _git_tree_entry(
            store_root,
            state_commit,
            "snapshot.json",
        )
    except RuntimeError as exc:
        raise RuntimeError("state_snapshot_unavailable") from exc
    if entry is None:
        raise RuntimeError("state_store_genesis")
    _record, mode, object_type, object_id = entry
    if mode not in {"100644", "100755"} or object_type != "blob":
        raise RuntimeError("state_snapshot_not_regular")
    try:
        payload = _read_git_blob_bounded(
            store_root,
            object_id,
            max_bytes=_MAX_SNAPSHOT_JSON_BYTES,
            too_large="state_snapshot_too_large",
            unavailable="state_snapshot_unavailable",
        )
        text = payload.decode("utf-8")
        from .ledger import json_nesting_within_limit

        if not json_nesting_within_limit(text):
            raise ValueError("json_nesting_limit_exceeded")
        snapshot = json.loads(text)
    except RuntimeError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise RuntimeError("state_snapshot_invalid") from exc
    try:
        validate_snapshot_manifest(
            snapshot,
            expected_root_kinds=("repo", "tools", "workspace"),
        )
    except (RecursionError, SnapshotError, TypeError, ValueError) as exc:
        raise RuntimeError("state_snapshot_invalid") from exc
    return snapshot, object_id


def _snapshot_surface_git_path(
    *,
    store: Any,
    repo_identity: str,
    root_kind: str,
    relative: str,
) -> str:
    from .state_store import store_roots

    path = PurePosixPath(relative)
    if (
        path.is_absolute()
        or not path.parts
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise RuntimeError("state_snapshot_surface_path_invalid")
    root = store_roots(store, repo_identity).get(root_kind)
    if root is None:
        raise RuntimeError("state_snapshot_surface_root_invalid")
    try:
        prefix = root.relative_to(store.root).as_posix()
    except ValueError as exc:  # pragma: no cover - store roots are internal
        raise RuntimeError("state_snapshot_surface_root_invalid") from exc
    return f"{prefix}/{path.as_posix()}"


def _verify_declared_root_tree_entries(
    *,
    store: Any,
    repo_identity: str,
    tree: Mapping[str, tuple[bytes, str, str, str]],
) -> None:
    """Require every existing declared-root component to be a Git tree."""
    from .state_store import store_roots

    checked: set[str] = set()
    for root in store_roots(store, repo_identity).values():
        try:
            relative = root.relative_to(store.root).as_posix()
        except ValueError as exc:  # pragma: no cover - internal root contract
            raise RuntimeError("state_snapshot_surface_root_invalid") from exc
        parts = PurePosixPath(relative).parts
        for count in range(1, len(parts) + 1):
            path = PurePosixPath(*parts[:count]).as_posix()
            if path in checked:
                continue
            checked.add(path)
            entry = tree.get(path)
            if entry is None:
                break
            if entry[1] != "040000" or entry[2] != "tree":
                raise RuntimeError(f"state_snapshot_root_not_tree:{path}")


def _state_commit_single_parent(store_root: Path, state_commit: str) -> str:
    """Resolve exactly one parent for a published state commit."""
    result = _run_git(
        store_root,
        "rev-list",
        "--parents",
        "--max-count=1",
        state_commit,
    )
    if result.returncode != 0:
        raise RuntimeError("state_snapshot_parent_unavailable")
    try:
        fields = result.stdout.decode("ascii").strip().split()
    except UnicodeDecodeError as exc:
        raise RuntimeError("state_snapshot_parent_invalid") from exc
    if (
        len(fields) != 2
        or fields[0] != state_commit
        or any(_GIT_OBJECT_ID.fullmatch(field) is None for field in fields)
    ):
        raise RuntimeError("state_snapshot_parent_invalid")
    return fields[1]


def _tree_path_ancestors(path: str) -> set[str]:
    parts = PurePosixPath(path).parts
    return {
        PurePosixPath(*parts[:count]).as_posix()
        for count in range(1, len(parts))
    }


def _verify_state_commit_tree_contract(
    *,
    store: Any,
    state_commit: str,
    tree: Mapping[str, tuple[bytes, str, str, str]],
    claimed_paths: set[str],
) -> None:
    """Reject every immutable tree entry not named by the snapshot contract."""
    parent = _state_commit_single_parent(store.root, state_commit)
    current_genesis = tree.get("GENESIS")
    try:
        parent_genesis = _git_tree_entry(store.root, parent, "GENESIS")
    except RuntimeError as exc:
        raise RuntimeError("state_snapshot_parent_unavailable") from exc
    if current_genesis is None or parent_genesis is None:
        raise RuntimeError("state_snapshot_genesis_missing")
    if (
        current_genesis[1] != "100644"
        or current_genesis[2] != "blob"
        or parent_genesis[1] != "100644"
        or parent_genesis[2] != "blob"
    ):
        raise RuntimeError("state_snapshot_genesis_invalid")
    if current_genesis != parent_genesis:
        raise RuntimeError("state_snapshot_genesis_mismatch")

    present_markers: set[str] = set()
    for path in _STATE_BOOTSTRAP_EMPTY_MARKERS:
        entry = tree.get(path)
        if entry is None:
            continue
        if entry[1] != "100644" or entry[2] != "blob":
            raise RuntimeError(f"state_snapshot_bootstrap_marker_invalid:{path}")
        try:
            size = _git_blob_size(
                store.root,
                entry[3],
                max_bytes=0,
                too_large=f"state_snapshot_bootstrap_marker_invalid:{path}",
            )
        except RuntimeError as exc:
            named = f"state_snapshot_bootstrap_marker_invalid:{path}"
            raise RuntimeError(named) from exc
        if size != 0:  # pragma: no cover - max_bytes=0 rejects this first
            raise RuntimeError(f"state_snapshot_bootstrap_marker_invalid:{path}")
        present_markers.add(path)

    allowed_files = {"GENESIS", "snapshot.json", *claimed_paths, *present_markers}
    allowed_trees: set[str] = set()
    for path in allowed_files:
        allowed_trees.update(_tree_path_ancestors(path))
    for path in allowed_trees:
        entry = tree.get(path)
        if entry is None or entry[1] != "040000" or entry[2] != "tree":
            raise RuntimeError(f"state_snapshot_tree_ancestor_invalid:{path}")
    for path in tree:
        if path not in allowed_files and path not in allowed_trees:
            raise RuntimeError(f"state_snapshot_unclaimed_tree_entry:{path}")


def _verify_snapshot_and_collect_evidence(
    *,
    store: Any,
    repo_identity: str,
    state_commit: str,
    expected_snapshot_object_id: str,
) -> _StreamingEvidenceAccumulator:
    """Verify every snapshot surface, parsing only the evidence ledgers."""
    from .ledger import LedgerReadLimitError, verify_jsonl_chunks
    from .state_manifest import (
        normalize_surface_relative_path,
        surface_by_name,
        surface_for_relative_path,
        surface_path_matches,
        surface_key_name,
        iter_surfaces,
    )
    from .state_store import store_roots
    from .state_snapshot import STORAGE_POLICY

    snapshot, object_id = _read_immutable_snapshot_claim(
        store.root,
        state_commit,
    )
    if object_id != expected_snapshot_object_id:
        raise RuntimeError("state_snapshot_changed_during_read")
    try:
        tree = _git_tree_entries(store.root, state_commit)
    except RuntimeError as exc:
        named = str(exc)
        raise RuntimeError(
            named if named.startswith("state_snapshot_")
            else "state_snapshot_tree_unavailable",
        ) from exc
    _verify_declared_root_tree_entries(
        store=store,
        repo_identity=repo_identity,
        tree=tree,
    )
    counted_names = {
        name
        for spec in CAPABILITY_SPECS.values()
        for name in spec.count_surfaces
    }
    accumulator = _StreamingEvidenceAccumulator()
    claims: list[
        tuple[str, Mapping[str, Any], str, str, int, bool]
    ] = []
    claimed_paths: set[str] = set()
    snapshot_total = 0
    evidence_total = 0
    for key, raw_claim in sorted(snapshot["surfaces"].items()):
        if not isinstance(key, str) or not isinstance(raw_claim, dict):
            raise RuntimeError("state_snapshot_surface_claim_invalid")
        try:
            surface_name = surface_key_name(key)
            surface = surface_by_name(surface_name)
        except (KeyError, TypeError) as exc:
            raise RuntimeError("state_snapshot_surface_claim_invalid") from exc
        relative = raw_claim.get("path")
        root_kind = raw_claim.get("root_kind")
        size = raw_claim.get("size_bytes")
        claimed_hash = raw_claim.get("sha256")
        expected_keys = {
            "path",
            "root_kind",
            "state_class",
            "storage",
            "sha256",
            "size_bytes",
            "segments",
        }
        if surface.state_class == "ledger":
            expected_keys.update({"chain_valid", "row_count", "tail_ledger_hash"})
        if (
            set(raw_claim) != expected_keys
            or not isinstance(relative, str)
            or root_kind != surface.root_kind
            or raw_claim.get("state_class") != surface.state_class
            or raw_claim.get("storage") != STORAGE_POLICY[surface.state_class]
            or raw_claim.get("segments") != [relative]
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(claimed_hash, str)
            or re.fullmatch(r"[0-9a-f]{64}", claimed_hash) is None
            or normalize_surface_relative_path(relative) != relative
            or not surface_path_matches(
                relative,
                surface.path_pattern,
            )
            or (
                "*" not in surface.path_pattern
                and key != surface.name
            )
            or (
                "*" in surface.path_pattern
                and key != f"{surface.name}:{relative}"
            )
        ):
            raise RuntimeError(f"state_snapshot_surface_claim_invalid:{key}")
        git_path = _snapshot_surface_git_path(
            store=store,
            repo_identity=repo_identity,
            root_kind=root_kind,
            relative=relative,
        )
        if git_path in claimed_paths:
            raise RuntimeError("state_snapshot_surface_claim_duplicate")
        claimed_paths.add(git_path)
        tree_entry = tree.get(git_path)
        if (
            tree_entry is None
            or tree_entry[1] not in {"100644", "100755"}
            or tree_entry[2] != "blob"
        ):
            raise RuntimeError(f"state_snapshot_surface_not_regular:{key}")
        try:
            observed_size = _git_blob_size(
                store.root,
                tree_entry[3],
                max_bytes=_MAX_SNAPSHOT_SURFACE_BLOB_BYTES,
                too_large=f"state_snapshot_surface_too_large:{key}",
            )
        except RuntimeError as exc:
            named = str(exc)
            raise RuntimeError(
                named if named.startswith("state_snapshot_surface_too_large:")
                else f"state_snapshot_surface_unavailable:{key}",
            ) from exc
        if observed_size != size:
            raise RuntimeError(f"state_snapshot_surface_mismatch:{key}")
        snapshot_total += observed_size
        if snapshot_total > _MAX_SNAPSHOT_INPUT_BYTES:
            raise RuntimeError("state_snapshot_budget_exceeded")
        consumed = key == surface_name and surface_name in counted_names
        if consumed:
            if observed_size > _MAX_EVIDENCE_LEDGER_BLOB_BYTES:
                raise RuntimeError(
                    f"state_commit_surface_too_large:{surface_name}",
                )
            evidence_total += observed_size
            if evidence_total > _MAX_EVIDENCE_INPUT_BYTES:
                raise RuntimeError("state_commit_evidence_budget_exceeded")
        claims.append((
            key,
            raw_claim,
            tree_entry[3],
            git_path,
            observed_size,
            consumed,
        ))

    root_prefixes = tuple(
        (
            root.relative_to(store.root).as_posix() + "/",
            root_kind,
        )
        for root_kind, root in store_roots(store, repo_identity).items()
    )
    surfaces_by_root_and_first: dict[tuple[str, str], list[Any]] = defaultdict(list)
    for surface in iter_surfaces():
        if STORAGE_POLICY[surface.state_class] == "excluded":
            continue
        first = PurePosixPath(surface.path_pattern).parts[0]
        surfaces_by_root_and_first[(surface.root_kind, first)].append(surface)
    match_candidates = 0
    for git_path, _tree_entry in tree.items():
        for prefix, root_kind in root_prefixes:
            if not git_path.startswith(prefix):
                continue
            relative = git_path.removeprefix(prefix)
            first = PurePosixPath(relative).parts[0]
            candidates = surfaces_by_root_and_first.get((root_kind, first), ())
            match_candidates += len(candidates)
            if match_candidates > _MAX_SNAPSHOT_SURFACE_MATCH_CANDIDATES:
                raise RuntimeError("state_snapshot_surface_match_budget_exceeded")
            try:
                surface = surface_for_relative_path(
                    relative,
                    root_kind=root_kind,
                    surfaces=candidates,
                )
            except (RecursionError, ValueError) as exc:
                raise RuntimeError("state_snapshot_surface_match_invalid") from exc
            if surface is not None and git_path not in claimed_paths:
                raise RuntimeError(
                    f"state_snapshot_unclaimed_surface:{surface.name}",
                )
            break

    _verify_state_commit_tree_contract(
        store=store,
        state_commit=state_commit,
        tree=tree,
        claimed_paths=claimed_paths,
    )

    for key, claim, object_id, git_path, size, consumed in claims:
        chunks = _iter_git_output_bounded(
            store.root,
            "cat-file",
            "blob",
            object_id,
            max_bytes=size,
            expected_size=size,
            unavailable=f"state_snapshot_surface_unavailable:{key}",
        )
        surface_name = surface_key_name(key)
        surface = surface_by_name(surface_name)
        if surface.state_class == "ledger":
            try:
                summary = verify_jsonl_chunks(
                    chunks,
                    source=f"{state_commit}:{git_path}",
                    expected_size=size,
                    max_line_bytes=_MAX_SNAPSHOT_LEDGER_LINE_BYTES,
                    max_rows=(
                        _MAX_EVIDENCE_LEDGER_ROWS
                        if consumed
                        else _MAX_SNAPSHOT_LEDGER_ROWS
                    ),
                    on_row=(
                        (lambda row, name=surface_name: accumulator.consume(
                            name,
                            row,
                        ))
                        if consumed
                        else None
                    ),
                )
            except LedgerReadLimitError as exc:
                reason = str(exc)
                prefix = "state_commit" if consumed else "state_snapshot"
                blocker = (
                    f"{prefix}_surface_line_too_large"
                    if "line_too_large" in reason
                    else f"{prefix}_surface_row_limit_exceeded"
                )
                raise RuntimeError(f"{blocker}:{surface_name}") from exc
            if (
                summary["sha256"] != claim["sha256"]
                or summary["size_bytes"] != claim["size_bytes"]
                or claim.get("chain_valid") is not True
                or summary["row_count"] != claim.get("row_count")
                or summary["last_hash"] != claim.get("tail_ledger_hash")
            ):
                raise RuntimeError(f"state_snapshot_surface_mismatch:{key}")
        else:
            digest = hashlib.sha256()
            observed = 0
            for chunk in chunks:
                observed += len(chunk)
                digest.update(chunk)
            if (
                observed != claim["size_bytes"]
                or digest.hexdigest() != claim["sha256"]
            ):
                raise RuntimeError(f"state_snapshot_surface_mismatch:{key}")
    return accumulator


def _verify_published_snapshot_commit(
    *,
    store: Any,
    repo_identity: str,
    state_commit: str,
    expected_snapshot: Mapping[str, Any],
) -> None:
    """Apply the canonical immutable verifier to one just-created commit."""
    committed_snapshot, snapshot_object_id = _read_immutable_snapshot_claim(
        store.root,
        state_commit,
    )
    if committed_snapshot != dict(expected_snapshot):
        raise RuntimeError("state_snapshot_claim_mismatch")
    _verify_snapshot_and_collect_evidence(
        store=store,
        repo_identity=repo_identity,
        state_commit=state_commit,
        expected_snapshot_object_id=snapshot_object_id,
    )


def _read_json_object(
    path: Path,
) -> tuple[
    dict[str, Any],
    bytes | None,
    tuple[int, int, int, int, str] | None,
]:
    """Read one bounded regular JSON object and fingerprint the same bytes."""
    from .ledger import json_nesting_within_limit
    from .state_store import StateStoreError, _read_bounded_regular_file

    try:
        content, fingerprint = _read_bounded_regular_file(path)
        text = content.decode("utf-8")
        if not json_nesting_within_limit(text):
            raise ValueError("json_nesting_limit_exceeded")
        value = json.loads(text)
    except (
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
        ValueError,
        StateStoreError,
    ):
        return {}, None, None
    return (
        value if isinstance(value, dict) else {},
        content,
        fingerprint,
    )


def _capture_state_admission(
    *,
    store: Any,
    repo_identity: str,
) -> _StateAdmission:
    """Observe the read-only state-store admission facts once."""
    from .state_store import (
        StateStoreError,
        _parse_remote_tip_listing,
        _valid_host_identity,
        _state_store_uncommitted_paths,
        tools_root,
    )

    blockers: set[str] = set()
    admitted_tools = tools_root(store)
    host_object, host_payload, host_fingerprint = _read_json_object(
        admitted_tools / "repo_identity.json",
    )
    contract_object, contract_payload, contract_fingerprint = _read_json_object(
        admitted_tools / "tools_contract.json",
    )
    host_identity = host_object.get("bound_canonical_identity")
    contract_identity = contract_object.get("bound_canonical_identity")
    if host_identity != repo_identity:
        blockers.add("state_repository_identity_mismatch")
    if not _valid_host_identity(
        admitted_tools,
        repo_identity,
        Path(store.repo_root).resolve(),
        identity_payload=host_payload,
        contract_payload=contract_payload,
    ):
        blockers.add("state_repository_identity_invalid")
    if contract_identity != repo_identity:
        blockers.add("state_tools_contract_identity_mismatch")
    try:
        head_code, head = _git_text(store.root, "rev-parse", "--verify", "HEAD")
    except RuntimeError:
        head_code, head = 1, ""
    if head_code != 0 or not _FULL_SHA.fullmatch(head):
        blockers.add("state_store_head_unavailable")
        head = ""
    try:
        symbolic_code, _ = _git_text(
            store.root,
            "symbolic-ref",
            "--quiet",
            "HEAD",
        )
    except RuntimeError:
        symbolic_code = 1
        blockers.add("state_store_symbolic_head_unavailable")
    if symbolic_code == 0:
        blockers.add("state_store_head_not_detached")

    tracking_ref = f"refs/remotes/{store.remote}/{store.branch}"
    try:
        tracking_code, tracking = _git_text(
            store.root,
            "rev-parse",
            "--verify",
            tracking_ref,
        )
    except RuntimeError:
        tracking_code, tracking = 1, ""
    if tracking_code != 0 or not _FULL_SHA.fullmatch(tracking):
        blockers.add("state_store_tracking_tip_unavailable")
    elif head and tracking != head:
        blockers.add("state_store_unpublished_head")

    remote_ref = f"refs/heads/{store.branch}"
    try:
        remote_code, listing = _git_text_raw_strict(
            store.root,
            "ls-remote",
            store.remote,
            remote_ref,
        )
    except RuntimeError:
        remote_code, listing = 1, ""
    remote_probe = (
        _parse_remote_tip_listing(listing, ref=remote_ref)
        if remote_code == 0
        else None
    )
    remote_tip = (
        remote_probe.sha
        if remote_probe is not None and remote_probe.status == "present"
        else ""
    )
    if remote_code != 0 or not remote_tip:
        blockers.add("state_remote_unavailable")
        remote_tip = ""
    elif tracking_code == 0 and remote_tip != tracking:
        blockers.add("state_remote_tip_stale")

    try:
        dirty = _state_store_uncommitted_paths(
            store.root,
            expected_repo_identity=repo_identity,
            expected_repo_root=Path(store.repo_root).resolve(),
        )
    except StateStoreError:
        clean = False
        blockers.add("state_store_status_unavailable")
    else:
        clean = not dirty
        if not clean:
            blockers.add("state_store_dirty")

    snapshot_status: str | None = None
    snapshot_root: str | None = None
    snapshot_object_id: str | None = None
    # Do not invoke any snapshot reader after a binding/status refusal.  In
    # particular, a hostile dirty worktree may contain symlinks, FIFOs, or
    # huge files; none of those mutable paths are evidence and none are read.
    if not blockers and head:
        try:
            snapshot, snapshot_object_id = _read_immutable_snapshot_claim(
                store.root,
                head,
            )
        except RuntimeError as exc:
            named = str(exc)
            if named == "state_store_genesis":
                blockers.add(named)
                snapshot_status = "genesis"
            elif named.startswith("state_snapshot_"):
                blockers.add(named)
            else:
                blockers.add("state_store_verification_unavailable")
        else:
            snapshot_status = "immutable_claim_valid"
            root = snapshot.get("manifest_root")
            snapshot_root = str(root) if isinstance(root, str) else None

    return _StateAdmission(
        state_commit=head or None,
        remote_tip=remote_tip or None,
        clean=clean,
        snapshot_status=snapshot_status,
        snapshot_root=snapshot_root,
        snapshot_object_id=snapshot_object_id,
        host_identity=str(host_identity) if host_identity is not None else None,
        contract_identity=(
            str(contract_identity) if contract_identity is not None else None
        ),
        host_identity_fingerprint=host_fingerprint,
        contract_fingerprint=contract_fingerprint,
        blockers=tuple(sorted(blockers)),
    )


class _StreamingEvidenceAccumulator:
    """Bounded projections for counts and proof witnesses while rows stream."""

    def __init__(self) -> None:
        from .autonomy_state import AutonomyStateAccumulator

        self.surface_counts: Counter[str] = Counter()
        self.metrics: Counter[str] = Counter()
        self.raw_fingerprints: set[str] = set()
        self.promoted_fingerprints: set[str] = set()
        self.autonomy_state = AutonomyStateAccumulator()
        self.acceptance_event_counts: Counter[str] = Counter()
        self.acceptance_success_event_counts: Counter[str] = Counter()
        self.acceptance_unlock_counts: Counter[str] = Counter()
        self.acceptance_success_stamps: list[datetime] = []
        self.acceptance_success_undateable = False
        self.count_rejected: set[str] = set()
        self.native_counts: dict[str, Counter[str]] = {
            capability: Counter(rows=0, terminal=0, admissible=0)
            for capability in CAPABILITY_SPECS
        }
        self.native_blockers: dict[str, set[str]] = {
            capability: set() for capability in CAPABILITY_SPECS
        }
        self.native_targets: dict[
            str,
            dict[EvidenceContract, dict[str, _TargetCandidate]],
        ] = {
            capability: {
                contract: {} for contract in spec.contracts
            }
            for capability, spec in CAPABILITY_SPECS.items()
        }
        self.distinct_targets: dict[str, set[str]] = {
            capability: set() for capability in CAPABILITY_SPECS
        }
        self.distinct_target_budget_exceeded: set[str] = set()
        self.global_distinct_targets: set[str] = set()
        self.global_distinct_target_budget_exceeded = False
        self.ordinal = 0

    def consume(self, surface: str, row: Mapping[str, Any]) -> None:
        self.surface_counts[surface] += 1
        self.ordinal += 1
        self._consume_counts(surface, row)
        for capability, spec in CAPABILITY_SPECS.items():
            if not any(contract.surface == surface for contract in spec.contracts):
                continue
            summary = _summarize_native_rows(
                capability,
                {surface: (row,)},
            )
            self.native_counts[capability].update(summary.counts)
            self.native_blockers[capability].update(summary.blockers)
            for contract, targets in summary.targets_by_contract.items():
                for observed in targets:
                    self._retain_target(capability, contract, observed)

    def _retain_target(
        self,
        capability: str,
        contract: EvidenceContract,
        observed: _TargetCandidate,
    ) -> None:
        sha = observed.candidate.evidence_target_sha
        existing = self.native_targets[capability][contract].get(sha)
        if existing is not None:
            by_schema = Counter(existing.admissible_by_schema)
            by_schema.update(observed.admissible_by_schema)
            self.native_targets[capability][contract][sha] = _TargetCandidate(
                candidate=observed.candidate,
                admissible_count=(
                    existing.admissible_count + observed.admissible_count
                ),
                admissible_by_schema=MappingProxyType(dict(by_schema)),
                ordinal=self.ordinal,
            )
            return
        capability_targets = self.distinct_targets[capability]
        if sha not in capability_targets and (
            len(capability_targets)
            >= _MAX_DISTINCT_PROOF_TARGETS_PER_CAPABILITY
        ):
            self.distinct_target_budget_exceeded.add(capability)
            return
        capability_targets.add(sha)
        if sha not in self.global_distinct_targets and (
            len(self.global_distinct_targets)
            >= _MAX_DISTINCT_PROOF_TARGETS_GLOBAL
        ):
            self.global_distinct_target_budget_exceeded = True
            return
        self.global_distinct_targets.add(sha)
        self.native_targets[capability][contract][sha] = _TargetCandidate(
            candidate=observed.candidate,
            admissible_count=observed.admissible_count,
            admissible_by_schema=MappingProxyType(
                dict(observed.admissible_by_schema),
            ),
            ordinal=self.ordinal,
        )

    def _consume_counts(self, surface: str, row: Mapping[str, Any]) -> None:
        try:
            if surface == "cycles":
                try:
                    projected = _upcast_cycle_row(row)
                except Exception:  # noqa: BLE001 - same legacy fallback
                    projected = row
                self.metrics[f"cycle_status_{projected.get('status')}"] += 1
            elif surface == "autonomy_state":
                self.autonomy_state.consume(row)
            elif surface == "agent_invocation_results":
                self.metrics[f"executor_results_{row.get('status')}"] += 1
            elif surface == "tools_governance" and (
                row.get("kind") == "executor_drain_completed"
            ):
                self.metrics["executor_drain_completed"] += 1
                details = row.get("details")
                for name in ("attempted", "succeeded", "failed"):
                    self.metrics[f"executor_drain_{name}"] += (
                        _integer(details.get(name))
                        if isinstance(details, dict)
                        else 0
                    )
            elif surface == "raw_findings" and row.get("finding_fingerprint"):
                self.raw_fingerprints.add(str(row["finding_fingerprint"]))
            elif surface == "operator_feedback" and (
                row.get("source_type") == "ai_consensus"
                and row.get("verdict") == "true_positive"
            ):
                self.metrics["ai_consensus_true_positive"] += 1
            elif surface == "promotions" and row.get("finding_fingerprint"):
                self.promoted_fingerprints.add(str(row["finding_fingerprint"]))
            elif surface == "agent_eval_fixture_runs" and (
                row.get("row_type") == "fixture_run_suite"
            ):
                self.metrics["fixture_suites"] += 1
                if (
                    row.get("passed") is True
                    and row.get("actual_status") == "pass"
                ):
                    self.metrics["fixture_suites_passed"] += 1
            elif surface == "auto_merge_decisions":
                self.metrics["premerge_stages"] += int(bool(row.get("stage")))
                decision = str(row.get("decision") or "")
                self.metrics[f"premerge_decision_{decision}"] += 1
            elif surface == "enterprise_readiness_claims":
                self.metrics["readiness_valid"] += int(
                    _enterprise_readiness_v2_terminal(row),
                )
            elif surface == "enterprise_acceptance_events":
                event_type = str(row.get("event_type") or "")
                self.acceptance_event_counts[event_type] += 1
                if (
                    event_type == "critical_violation"
                    and row.get("status") == "violation"
                ):
                    self.metrics["acceptance_critical_violations"] += 1
                if str(row.get("status")) == "success":
                    self.acceptance_success_event_counts[event_type] += 1
                    from .tool_registry import parse_utc_stamp

                    stamp = parse_utc_stamp(row.get("recorded_at"))
                    if stamp is None:
                        self.acceptance_success_undateable = True
                    else:
                        self.acceptance_success_stamps.append(stamp)
            elif surface == "enterprise_autonomy_unlock_events":
                self.acceptance_unlock_counts[
                    "valid" if row.get("valid") is True else "invalid"
                ] += 1
        except Exception:  # noqa: BLE001 - diagnostics never authorize on error
            for capability, spec in CAPABILITY_SPECS.items():
                if surface in spec.count_surfaces:
                    self.count_rejected.add(capability)

    def native_summaries(self) -> dict[str, _NativeSummary]:
        return {
            capability: _NativeSummary(
                targets_by_contract=MappingProxyType({
                    contract: tuple(targets.values())
                    for contract, targets in contracts.items()
                }),
                counts=MappingProxyType(dict(self.native_counts[capability])),
                blockers=tuple(sorted(self.native_blockers[capability])),
                distinct_target_budget_exceeded=(
                    capability in self.distinct_target_budget_exceeded
                ),
                global_target_budget_exceeded=(
                    self.global_distinct_target_budget_exceeded
                ),
            )
            for capability, contracts in self.native_targets.items()
        }

    def capability_counts(
        self,
        *,
        repo_root: Path,
        target_sha: str,
    ) -> tuple[dict[str, dict[str, int]], dict[str, tuple[str, ...]]]:
        counts_by_capability: dict[str, dict[str, int]] = {}
        blockers_by_capability: dict[str, tuple[str, ...]] = {}
        state = self.autonomy_state.snapshot()
        for capability, spec in CAPABILITY_SPECS.items():
            counts = {
                surface: self.surface_counts[surface]
                for surface in spec.count_surfaces
            }
            if capability == "cycle_runtime":
                for status in ("started", "completed", "failed", "stopped", "aborted"):
                    counts[f"cycle_status_{status}"] = self.metrics[
                        f"cycle_status_{status}"
                    ]
                counts.update({
                    "autonomy_state_transition_count": state.transition_count,
                    "autonomy_state_cycles_completed": state.cycles_completed,
                    "autonomy_state_planner_claims_dispatched": (
                        state.planner_claims_dispatched
                    ),
                    "autonomy_state_worker_assignments_dispatched": (
                        state.worker_assignments_dispatched
                    ),
                    "autonomy_state_auto_merges_completed": (
                        state.auto_merges_completed
                    ),
                })
            elif capability == "executor":
                for status in ("accepted", "rejected"):
                    counts[f"executor_results_{status}"] = self.metrics[
                        f"executor_results_{status}"
                    ]
                counts["executor_drain_completed"] = self.metrics[
                    "executor_drain_completed"
                ]
                for name in ("attempted", "succeeded", "failed"):
                    counts[f"executor_drain_{name}"] = self.metrics[
                        f"executor_drain_{name}"
                    ]
            elif capability == "finding_funnel":
                counts["raw_unique_fingerprints"] = len(self.raw_fingerprints)
                counts["ai_consensus_true_positive"] = self.metrics[
                    "ai_consensus_true_positive"
                ]
                counts["unique_promoted"] = len(self.promoted_fingerprints)
            elif capability == "fixture_calibration":
                passed = self.metrics["fixture_suites_passed"]
                counts["fixture_suites_passed"] = passed
                counts["fixture_suites_failed"] = (
                    self.metrics["fixture_suites"] - passed
                )
                counts["judge_rows"] = self.surface_counts["calibration_judge"]
                counts["adapter_rows"] = self.surface_counts[
                    "calibration_adapter_reports"
                ]
            elif capability == "pre_merge_perimeter":
                counts["premerge_decisions"] = self.surface_counts[
                    "auto_merge_decisions"
                ]
                counts["premerge_stages"] = self.metrics["premerge_stages"]
                counts["premerge_merged"] = self.metrics[
                    "premerge_decision_merged"
                ]
                for decision in ("eligible", "blocked", "failed", "merged"):
                    counts[f"premerge_decision_{decision}"] = self.metrics[
                        f"premerge_decision_{decision}"
                    ]
            elif capability == "enterprise_readiness":
                valid = self.metrics["readiness_valid"]
                counts["readiness_valid"] = valid
                counts["readiness_invalid"] = (
                    self.surface_counts["enterprise_readiness_claims"] - valid
                )
            elif capability == "autonomy_unlock":
                from .autonomy_unlock import ACCEPTANCE_EVENT_TYPES

                for event_type in ACCEPTANCE_EVENT_TYPES:
                    counts[f"acceptance_{event_type}"] = (
                        self.acceptance_event_counts[event_type]
                    )
                counts["unlock_verdict_valid"] = self.acceptance_unlock_counts[
                    "valid"
                ]
                counts["unlock_verdict_invalid"] = self.acceptance_unlock_counts[
                    "invalid"
                ]
                unlock_counts, unlock_blocker = _stream_unlock_verdict_counts(
                    self,
                    repo_root=repo_root,
                    target_sha=target_sha,
                )
                counts.update(unlock_counts)
            else:  # pragma: no cover - roster is exhaustive above
                unlock_blocker = None
            blockers: set[str] = set()
            if capability in self.count_rejected:
                counts = {
                    surface: self.surface_counts[surface]
                    for surface in spec.count_surfaces
                }
                counts["count_rejected"] = 1
                blockers.add(f"count_rejected:{capability}")
            if capability == "autonomy_unlock" and unlock_blocker:
                blockers.add(unlock_blocker)
            counts_by_capability[capability] = counts
            blockers_by_capability[capability] = tuple(sorted(blockers))
        return counts_by_capability, blockers_by_capability


def _load_counted_rows(
    *,
    store: Any,
    repo_identity: str,
    state_commit: str,
    snapshot_object_id: str,
    repo_root: Path,
    target_sha: str,
) -> tuple[
    dict[str, _NativeSummary],
    dict[str, dict[str, int]],
    dict[str, tuple[str, ...]],
]:
    """Verify the full immutable snapshot and project evidence in one pass."""
    accumulator = _verify_snapshot_and_collect_evidence(
        store=store,
        repo_identity=repo_identity,
        state_commit=state_commit,
        expected_snapshot_object_id=snapshot_object_id,
    )
    counts, blockers = accumulator.capability_counts(
        repo_root=repo_root,
        target_sha=target_sha,
    )
    return accumulator.native_summaries(), counts, blockers


def _integer(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _capability_safe_counts(
    capability: str,
    rows_by_surface: Mapping[str, tuple[Mapping[str, Any], ...]],
) -> dict[str, int]:
    """Return native, non-overlapping diagnostic counts for one capability."""
    spec = CAPABILITY_SPECS[capability]
    counts = {
        name: len(rows_by_surface.get(name, ()))
        for name in spec.count_surfaces
    }
    if capability == "cycle_runtime":
        cycles: list[Mapping[str, Any]] = []
        for raw in rows_by_surface.get("cycles", ()):
            try:
                cycles.append(_upcast_cycle_row(raw))
            except Exception:  # noqa: BLE001 - diagnostics count the readable row
                cycles.append(raw)
        for status in ("started", "completed", "failed", "stopped", "aborted"):
            counts[f"cycle_status_{status}"] = sum(
                row.get("status") == status for row in cycles
            )
        state = _fold_autonomy_state_rows(
            rows_by_surface.get("autonomy_state", ()),
        )
        counts.update({
            "autonomy_state_transition_count": state.transition_count,
            "autonomy_state_cycles_completed": state.cycles_completed,
            "autonomy_state_planner_claims_dispatched": (
                state.planner_claims_dispatched
            ),
            "autonomy_state_worker_assignments_dispatched": (
                state.worker_assignments_dispatched
            ),
            "autonomy_state_auto_merges_completed": (
                state.auto_merges_completed
            ),
        })
    elif capability == "executor":
        results = rows_by_surface.get("agent_invocation_results", ())
        counts["executor_results_accepted"] = sum(
            row.get("status") == "accepted" for row in results
        )
        counts["executor_results_rejected"] = sum(
            row.get("status") == "rejected" for row in results
        )
        drains = tuple(
            row
            for row in rows_by_surface.get("tools_governance", ())
            if row.get("kind") == "executor_drain_completed"
        )
        counts["executor_drain_completed"] = len(drains)
        for field in ("attempted", "succeeded", "failed"):
            counts[f"executor_drain_{field}"] = sum(
                _integer((row.get("details") or {}).get(field))
                if isinstance(row.get("details"), dict)
                else 0
                for row in drains
            )
    elif capability == "finding_funnel":
        raw = rows_by_surface.get("raw_findings", ())
        counts["raw_unique_fingerprints"] = len({
            str(row.get("finding_fingerprint"))
            for row in raw
            if row.get("finding_fingerprint")
        })
        counts["ai_consensus_true_positive"] = sum(
            row.get("source_type") == "ai_consensus"
            and row.get("verdict") == "true_positive"
            for row in rows_by_surface.get("operator_feedback", ())
        )
        counts["unique_promoted"] = len({
            str(row.get("finding_fingerprint"))
            for row in rows_by_surface.get("promotions", ())
            if row.get("finding_fingerprint")
        })
    elif capability == "fixture_calibration":
        suites = tuple(
            row
            for row in rows_by_surface.get("agent_eval_fixture_runs", ())
            if row.get("row_type") == "fixture_run_suite"
        )
        passed = sum(
            row.get("passed") is True and row.get("actual_status") == "pass"
            for row in suites
        )
        counts["fixture_suites_passed"] = passed
        counts["fixture_suites_failed"] = len(suites) - passed
        counts["judge_rows"] = len(rows_by_surface.get("calibration_judge", ()))
        counts["adapter_rows"] = len(
            rows_by_surface.get("calibration_adapter_reports", ()),
        )
    elif capability == "pre_merge_perimeter":
        decisions = rows_by_surface.get("auto_merge_decisions", ())
        counts["premerge_decisions"] = len(decisions)
        counts["premerge_stages"] = sum(bool(row.get("stage")) for row in decisions)
        counts["premerge_merged"] = sum(
            row.get("decision") == "merged" for row in decisions
        )
        for decision in ("eligible", "blocked", "failed", "merged"):
            counts[f"premerge_decision_{decision}"] = sum(
                row.get("decision") == decision for row in decisions
            )
    elif capability == "enterprise_readiness":
        claims = rows_by_surface.get("enterprise_readiness_claims", ())
        valid = sum(_enterprise_readiness_v2_terminal(row) for row in claims)
        counts["readiness_valid"] = valid
        counts["readiness_invalid"] = len(claims) - valid
    elif capability == "autonomy_unlock":
        from .autonomy_unlock import ACCEPTANCE_EVENT_TYPES

        acceptance = rows_by_surface.get("enterprise_acceptance_events", ())
        for event_type in ACCEPTANCE_EVENT_TYPES:
            counts[f"acceptance_{event_type}"] = sum(
                row.get("event_type") == event_type for row in acceptance
            )
        verdicts = rows_by_surface.get("enterprise_autonomy_unlock_events", ())
        counts["unlock_verdict_valid"] = sum(
            row.get("valid") is True for row in verdicts
        )
        counts["unlock_verdict_invalid"] = sum(
            row.get("valid") is not True for row in verdicts
        )
    return counts


def _capability_counts_with_blocker(
    capability: str,
    rows_by_surface: Mapping[str, tuple[Mapping[str, Any], ...]],
) -> tuple[dict[str, int], str | None]:
    """Keep malformed diagnostic payloads from authorizing or crashing status."""
    try:
        return _capability_safe_counts(capability, rows_by_surface), None
    except Exception:  # noqa: BLE001 - diagnostic parsing is non-authorizing
        spec = CAPABILITY_SPECS[capability]
        counts = {
            name: len(rows_by_surface.get(name, ()))
            for name in spec.count_surfaces
        }
        counts["count_rejected"] = 1
        return counts, f"count_rejected:{capability}"


_UNLOCK_REQUIREMENT_FIELDS: Mapping[str, frozenset[str]] = MappingProxyType({
    "L1": frozenset({"observe_successes"}),
    "L2": frozenset({
        "observe_successes",
        "l1_autonomous_successes",
        "l2_supervised_successes",
    }),
    "L3": frozenset({
        "observe_successes",
        "l1_autonomous_successes",
        "l2_supervised_successes",
        "l2_autonomous_successes",
        "l3_approval_successes",
        "rollback_successes",
    }),
})


def _valid_unlock_policy_for_counts(policy: Mapping[str, Any]) -> bool:
    version = policy.get("schema_version")
    violation_limit = policy.get("critical_violation_limit")
    requirements = policy.get("lane_requirements")
    if (
        policy.get("$schema") != "aria/autonomy-unlock-policy/v1"
        or not isinstance(version, int)
        or isinstance(version, bool)
        or version != 1
        or not isinstance(violation_limit, int)
        or isinstance(violation_limit, bool)
        or violation_limit != 0
        or not isinstance(requirements, dict)
        or set(requirements) != set(_UNLOCK_REQUIREMENT_FIELDS)
    ):
        return False
    for lane, expected_fields in _UNLOCK_REQUIREMENT_FIELDS.items():
        lane_requirements = requirements.get(lane)
        if (
            not isinstance(lane_requirements, dict)
            or set(lane_requirements) != expected_fields
            or any(
                not isinstance(value, int)
                or isinstance(value, bool)
                or value <= 0
                for value in lane_requirements.values()
            )
        ):
            return False
    return True


def _unlock_verdict_counts(
    rows: tuple[Mapping[str, Any], ...],
    *,
    repo_root: Path,
    target_sha: str,
) -> tuple[dict[str, int], str | None]:
    from .autonomy_unlock import verdict_from_rows

    policy, blocker = _unlock_policy_at_target(repo_root, target_sha)
    if policy is None:
        return ({"autonomy_unlock_policy_available": 0}, blocker)
    accepted_rows = [dict(row) for row in rows]
    counts: dict[str, int] = {"autonomy_unlock_policy_available": 1}
    try:
        for lane in ("L1", "L2", "L3"):
            verdict = verdict_from_rows(accepted_rows, lane=lane, policy=policy)
            counts[f"autonomy_unlock_{lane.lower()}_valid"] = int(verdict.valid)
            if lane == "L3":
                counts.update({
                    f"acceptance_{key}": value
                    for key, value in verdict.counts.items()
                })
    except Exception:  # noqa: BLE001 - malformed audit rows are nonproof
        return (
            {"autonomy_unlock_policy_available": 1, "count_rejected": 1},
            "count_rejected:autonomy_unlock",
        )
    return counts, None


def _unlock_policy_at_target(
    repo_root: Path,
    target_sha: str,
) -> tuple[dict[str, Any] | None, str | None]:
    policy_path = "docs/aria/policy/autonomy-unlock.json"
    try:
        entry = _git_tree_entry(repo_root, target_sha, policy_path)
        if entry is None or entry[1] not in {"100644", "100755"} or entry[2] != "blob":
            raise RuntimeError("autonomy_unlock_policy_unavailable")
        payload = _read_git_blob_bounded(
            repo_root,
            entry[3],
            max_bytes=_MAX_POLICY_BLOB_BYTES,
            too_large="autonomy_unlock_policy_too_large",
            unavailable="autonomy_unlock_policy_unavailable",
        )
    except RuntimeError as exc:
        blocker = (
            "autonomy_unlock_policy_too_large"
            if str(exc) == "autonomy_unlock_policy_too_large"
            else "autonomy_unlock_policy_unavailable"
        )
        return None, blocker
    try:
        text = payload.decode("utf-8")
        from .ledger import json_nesting_within_limit

        if not json_nesting_within_limit(text):
            raise ValueError("json_nesting_limit_exceeded")
        policy = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        return None, "autonomy_unlock_policy_invalid"
    if not isinstance(policy, dict) or not _valid_unlock_policy_for_counts(policy):
        return None, "autonomy_unlock_policy_invalid"
    return policy, None


def _stream_unlock_verdict_counts(
    accumulator: _StreamingEvidenceAccumulator,
    *,
    repo_root: Path,
    target_sha: str,
) -> tuple[dict[str, int], str | None]:
    policy, blocker = _unlock_policy_at_target(repo_root, target_sha)
    if policy is None:
        return {"autonomy_unlock_policy_available": 0}, blocker
    event_counts = {
        "observe_successes": accumulator.acceptance_success_event_counts[
            "observe_success"
        ],
        "l1_autonomous_successes": accumulator.acceptance_success_event_counts[
            "l1_autonomous_success"
        ],
        "l2_supervised_successes": accumulator.acceptance_success_event_counts[
            "l2_supervised_success"
        ],
        "l2_autonomous_successes": accumulator.acceptance_success_event_counts[
            "l2_autonomous_success"
        ],
        "l3_approval_successes": accumulator.acceptance_success_event_counts[
            "l3_approval_success"
        ],
        "rollback_successes": accumulator.acceptance_success_event_counts[
            "rollback_success"
        ],
        "critical_violations": accumulator.metrics[
            "acceptance_critical_violations"
        ],
    }
    stamps = sorted(accumulator.acceptance_success_stamps)
    continuity_valid = not accumulator.acceptance_success_undateable and all(
        later - earlier <= timedelta(hours=72)
        for earlier, later in zip(stamps, stamps[1:])
    )
    counts: dict[str, int] = {"autonomy_unlock_policy_available": 1}
    try:
        requirements = policy["lane_requirements"]
        for lane in ("L1", "L2", "L3"):
            valid = (
                event_counts["critical_violations"] == 0
                and continuity_valid
                and all(
                    event_counts.get(key, 0) >= required
                    for key, required in requirements[lane].items()
                )
            )
            counts[f"autonomy_unlock_{lane.lower()}_valid"] = int(valid)
        counts.update({
            f"acceptance_{key}": value
            for key, value in event_counts.items()
        })
    except Exception:  # noqa: BLE001 - validated policy still fails closed
        return (
            {"autonomy_unlock_policy_available": 1, "count_rejected": 1},
            "count_rejected:autonomy_unlock",
        )
    return counts, None


def _policy_at_target(
    repo_root: Path,
    target_sha: str,
) -> tuple[dict[str, Any] | None, str | None]:
    policy_path = "docs/aria/policy/autonomy-closure-findings.json"
    try:
        entry = _git_tree_entry(repo_root, target_sha, policy_path)
        if entry is None or entry[1] not in {"100644", "100755"} or entry[2] != "blob":
            raise RuntimeError("operator_prerequisite_policy_unavailable")
        payload = _read_git_blob_bounded(
            repo_root,
            entry[3],
            max_bytes=_MAX_POLICY_BLOB_BYTES,
            too_large="operator_prerequisite_policy_too_large",
            unavailable="operator_prerequisite_policy_unavailable",
        )
    except RuntimeError as exc:
        blocker = (
            "operator_prerequisite_policy_too_large"
            if str(exc) == "operator_prerequisite_policy_too_large"
            else "operator_prerequisite_policy_unavailable"
        )
        return None, blocker
    try:
        text = payload.decode("utf-8")
        from .ledger import json_nesting_within_limit

        if not json_nesting_within_limit(text):
            raise ValueError("json_nesting_limit_exceeded")
        policy = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        return None, "operator_prerequisite_policy_invalid"
    if not isinstance(policy, dict):
        return None, "operator_prerequisite_policy_invalid"
    return policy, None


def _with_capability_blocker(
    evidence: CapabilityEvidence,
    blocker: str,
    *,
    state: EvidenceState | None = None,
) -> CapabilityEvidence:
    return CapabilityEvidence(
        state=state or evidence.state,
        counts=evidence.counts,
        blockers=tuple(sorted({*evidence.blockers, blocker})),
        evidence_refs=evidence.evidence_refs,
        proof_cardinality=evidence.proof_cardinality,
    )


def _mode_a_signed_readiness_live_proven(
    evidence: CapabilityEvidence,
) -> bool:
    signed_contracts = {
        (
            contract.surface,
            contract.proof_kind,
            contract.schema_id,
            version,
        )
        for contract in CAPABILITY_SPECS["enterprise_readiness"].contracts
        if contract.proof_kind == "live"
        and contract.schema_id == "aria/enterprise-readiness-claim/v3"
        for version in contract.schema_versions
        if version == 3
    }
    signed_cardinality = sum(
        evidence.proof_cardinality.get(
            _proof_cardinality_key(surface, proof_kind, schema_id, version),
            0,
        )
        for surface, proof_kind, schema_id, version in signed_contracts
    )
    return (
        evidence.state == "live_proven"
        and bool(signed_contracts)
        and signed_cardinality == 1
    )


def _valid_policy_anchor(
    value: Any,
    *,
    finding_id: str,
    repo_root: Path,
    target_sha: str,
    entry_cache: dict[str, str | None],
    blob_cache: dict[str, str],
) -> bool:
    if not isinstance(value, str) or value.count("#") != 1:
        return False
    raw_path, anchor = value.split("#", 1)
    try:
        normalized_path = normalize_surface_relative_path(raw_path)
    except ValueError:
        return False
    if anchor != finding_id or normalized_path != raw_path:
        return False
    if raw_path not in entry_cache:
        try:
            entry = _git_tree_entry(repo_root, target_sha, raw_path)
        except (RuntimeError, ValueError, UnicodeError, OSError):
            return False
        entry_cache[raw_path] = (
            entry[3]
            if entry is not None
            and entry[1] in {"100644", "100755"}
            and entry[2] == "blob"
            else None
        )
    object_id = entry_cache[raw_path]
    if object_id is None:
        return False
    text = blob_cache.get(object_id)
    if text is None:
        try:
            text = _read_git_blob_bounded(
                repo_root,
                object_id,
                max_bytes=_MAX_POLICY_BLOB_BYTES,
                too_large="operator_prerequisite_policy_invalid",
                unavailable="operator_prerequisite_policy_invalid",
            ).decode("utf-8")
        except (RuntimeError, UnicodeDecodeError):
            return False
        blob_cache[object_id] = text
    heading = f"## {finding_id}"
    return any(
        line == heading or line.startswith(f"{heading} ")
        for line in re.split(r"\r\n|\r|\n", text)
    )


def _valid_operator_policy_shape(
    policy: Mapping[str, Any],
    *,
    repo_root: Path,
    target_sha: str,
) -> bool:
    """Validate the complete immutable v1 policy, not only its metadata row."""
    if set(policy) != {"$schema", "schema_version", "policy_id", "entries"}:
        return False
    version = policy.get("schema_version")
    entries = policy.get("entries")
    if (
        policy.get("$schema") != "aria/autonomy-closure-findings/v1"
        or not isinstance(version, int)
        or isinstance(version, bool)
        or version != 1
        or policy.get("policy_id") != "aria-end-to-end-autonomy-closure"
        or not isinstance(entries, list)
        or not entries
    ):
        return False
    required_keys = {
        "task_id",
        "finding_id",
        "owner_task",
        "required_predicate",
        "closure_mode",
        "review_anchor",
        "closing_sha_rule",
        "regression_test_refs",
    }
    optional_keys = {
        "operator_prerequisite",
        "narrative_anchor",
        "historical_fix_shas",
    }
    task_ids: set[str] = set()
    finding_ids: set[str] = set()
    anchor_entries: dict[str, str | None] = {}
    anchor_blobs: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            return False
        keys = set(entry)
        if not required_keys.issubset(keys) or not keys.issubset(
            required_keys | optional_keys,
        ):
            return False
        task_id = entry.get("task_id")
        finding_id = entry.get("finding_id")
        owner_task = entry.get("owner_task")
        predicate = entry.get("required_predicate")
        if (
            not isinstance(task_id, str)
            or not task_id
            or task_id in task_ids
            or not isinstance(finding_id, str)
            or not finding_id
            or re.search(r"PLACEHOLDER|TBD|TODO", finding_id, re.IGNORECASE)
            or finding_id in finding_ids
            or not isinstance(owner_task, str)
            or _OWNER_TASK.fullmatch(owner_task) is None
            or not isinstance(predicate, str)
            or _REQUIRED_PREDICATE.fullmatch(predicate) is None
            or entry.get("closure_mode") not in {
                "historical_main",
                "task_commit",
                "task_commit_and_live",
            }
            or entry.get("closing_sha_rule") not in {
                "last_historical_fix",
                "task_commit",
            }
        ):
            return False
        task_ids.add(task_id)
        finding_ids.add(finding_id)
        if not _valid_policy_anchor(
            entry.get("review_anchor"),
            finding_id=finding_id,
            repo_root=repo_root,
            target_sha=target_sha,
            entry_cache=anchor_entries,
            blob_cache=anchor_blobs,
        ):
            return False
        if "narrative_anchor" in entry and not _valid_policy_anchor(
            entry["narrative_anchor"],
            finding_id=finding_id,
            repo_root=repo_root,
            target_sha=target_sha,
            entry_cache=anchor_entries,
            blob_cache=anchor_blobs,
        ):
            return False
        refs = entry.get("regression_test_refs")
        if not isinstance(refs, list) or not refs:
            return False
        try:
            normalized_refs = [
                normalize_surface_relative_path(ref)
                for ref in refs
                if isinstance(ref, str)
            ]
        except ValueError:
            return False
        if (
            len(normalized_refs) != len(refs)
            or any(
                _REGRESSION_TEST_REF.search(ref) is None
                or normalized != ref
                for ref, normalized in zip(refs, normalized_refs, strict=True)
            )
        ):
            return False
        for ref in refs:
            if ref not in anchor_entries:
                try:
                    regression_entry = _git_tree_entry(
                        repo_root,
                        target_sha,
                        ref,
                    )
                except (RuntimeError, ValueError, UnicodeError, OSError):
                    return False
                anchor_entries[ref] = (
                    regression_entry[3]
                    if regression_entry is not None
                    and regression_entry[1] in {"100644", "100755"}
                    and regression_entry[2] == "blob"
                    else None
                )
            if anchor_entries[ref] is None:
                return False
        historical = entry.get("historical_fix_shas", [])
        if (
            not isinstance(historical, list)
            or any(
                not isinstance(sha, str) or _FULL_SHA.fullmatch(sha) is None
                for sha in historical
            )
        ):
            return False
        if "operator_prerequisite" in entry:
            metadata = entry["operator_prerequisite"]
            if (
                not isinstance(metadata, dict)
                or set(metadata) != {"capability", "blocker"}
                or not all(
                    isinstance(metadata.get(key), str) and metadata[key]
                    for key in ("capability", "blocker")
                )
            ):
                return False
    return (
        len(entries) == len(_EXPECTED_CLOSURE_SCOPE)
        and finding_ids == _EXPECTED_CLOSURE_SCOPE
    )


def _apply_operator_prerequisites(
    *,
    capabilities: Mapping[str, CapabilityEvidence],
    repo_root: str | Path,
    target_sha: str,
) -> dict[str, CapabilityEvidence]:
    """Apply target-tree operator metadata without consulting registry state."""
    updated = dict(capabilities)
    readiness = updated.get("enterprise_readiness")
    if readiness is None:
        return updated
    policy, policy_blocker = _policy_at_target(
        Path(repo_root).resolve(),
        target_sha,
    )
    if policy is None:
        updated["enterprise_readiness"] = _with_capability_blocker(
            readiness,
            policy_blocker or "operator_prerequisite_policy_unavailable",
            state="operator_blocked",
        )
        return updated
    resolved_repo_root = Path(repo_root).resolve()
    if not _valid_operator_policy_shape(
        policy,
        repo_root=resolved_repo_root,
        target_sha=target_sha,
    ):
        updated["enterprise_readiness"] = _with_capability_blocker(
            readiness,
            "operator_prerequisite_policy_invalid",
            state="operator_blocked",
        )
        return updated
    entries = policy["entries"]
    finding_ids = tuple(
        entry.get("finding_id")
        for entry in entries
        if isinstance(entry, dict)
    )
    if (
        len(finding_ids) != len(entries)
        or any(not isinstance(finding_id, str) for finding_id in finding_ids)
        or len(set(finding_ids)) != len(finding_ids)
    ):
        updated["enterprise_readiness"] = _with_capability_blocker(
            readiness,
            "operator_prerequisite_policy_invalid",
            state="operator_blocked",
        )
        return updated
    metadata_owners = tuple(
        entry
        for entry in entries
        if isinstance(entry, dict)
        and entry.get("operator_prerequisite") is not None
    )
    if (
        len(metadata_owners) != 1
        or metadata_owners[0].get("finding_id") != "ORPHAN-MEDIUM-789"
    ):
        updated["enterprise_readiness"] = _with_capability_blocker(
            readiness,
            "operator_prerequisite_policy_invalid",
            state="operator_blocked",
        )
        return updated
    owner = next(
        (
            entry
            for entry in entries
            if isinstance(entry, dict)
            and entry.get("finding_id") == "ORPHAN-MEDIUM-789"
        ),
        None,
    )
    expected_metadata = {
        "capability": "enterprise_readiness",
        "blocker": "github_app_mode_a_unconfigured",
    }
    if (
        owner is None
        or owner.get("required_predicate")
        != "mode_a_signed_readiness_live_proven"
        or owner.get("operator_prerequisite") != expected_metadata
    ):
        updated["enterprise_readiness"] = _with_capability_blocker(
            readiness,
            "operator_prerequisite_policy_invalid",
            state="operator_blocked",
        )
        return updated
    if not _mode_a_signed_readiness_live_proven(readiness):
        updated["enterprise_readiness"] = _with_capability_blocker(
            readiness,
            "github_app_mode_a_unconfigured",
            state="operator_blocked",
        )
    return updated


def derive_autonomy_evidence_status(
    *,
    base_dir: str | Path,
    repo_root: str | Path,
    target_sha: str | None = None,
) -> AutonomyEvidenceStatus:
    """Derive target-bound evidence from one unchanged published state tip."""
    from .state_store import StateStoreError, open_state_store, tools_root
    from .tool_registry import ensure_tools_dir_readonly

    repository = _resolve_repository(repo_root)
    evaluated_target = _resolve_target_sha(repository, target_sha)
    evaluator_blocker = _evaluator_definition_blocker(
        repository,
        evaluated_target,
    ) or _evaluator_worktree_blocker(repository)
    if evaluator_blocker is not None:
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker=evaluator_blocker,
            repo_root=repository,
        )
    tools_dir = ensure_tools_dir_readonly(base_dir)
    if tools_dir is None:
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker="state_tools_unavailable",
            repo_root=repository,
        )
    try:
        store = open_state_store(
            repository,
            store_dir=tools_dir.parent,
        )
    except StateStoreError as exc:
        blocker = "state_store_not_open" if "state_store_not_open" in str(exc) else (
            "state_store_unavailable"
        )
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker=blocker,
            repo_root=repository,
        )
    if tools_root(store).resolve() != tools_dir.resolve():
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker="state_tools_root_mismatch",
            repo_root=repository,
        )

    try:
        expected_identity = _bounded_repository_identity(repository)
    except (OSError, RuntimeError, ValueError):
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker="state_repository_identity_unavailable",
            repo_root=repository,
        )
    before = _capture_state_admission(store=store, repo_identity=expected_identity)
    if before.blockers:
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker=before.blockers,
            repo_root=repository,
        )

    from .ledger import LedgerIntegrityError

    try:
        native_summaries, counts_by_capability, count_blockers = _load_counted_rows(
            store=store,
            repo_identity=expected_identity,
            state_commit=before.state_commit or "",
            snapshot_object_id=before.snapshot_object_id or "",
            repo_root=repository,
            target_sha=evaluated_target,
        )
    except LedgerIntegrityError:
        raise
    except RuntimeError as exc:
        blocker = str(exc)
        if not blocker.startswith(("state_commit_", "state_snapshot_")):
            blocker = "state_commit_surface_unavailable"
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker=blocker,
            repo_root=repository,
        )
    after = _capture_state_admission(store=store, repo_identity=expected_identity)
    if before != after:
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker="state_store_changed_during_read",
            repo_root=repository,
        )
    if after.blockers:
        return _unavailable_status(
            target_sha=evaluated_target,
            blocker=after.blockers,
            repo_root=repository,
        )

    capabilities: dict[str, CapabilityEvidence] = {}
    for capability in CAPABILITY_SPECS:
        evidence = _derive_capability_evidence(
            capability=capability,
            rows_by_surface={},
            repo_root=repository,
            target_sha=evaluated_target,
            state_commit=before.state_commit or "",
            _native_summary=native_summaries[capability],
        )
        capabilities[capability] = CapabilityEvidence(
            state="declared" if count_blockers[capability] else evidence.state,
            counts=counts_by_capability[capability],
            blockers=tuple(sorted({
                *evidence.blockers,
                *count_blockers[capability],
            })),
            evidence_refs=(
                () if count_blockers[capability] else evidence.evidence_refs
            ),
            proof_cardinality=(
                {} if count_blockers[capability] else evidence.proof_cardinality
            ),
        )
    capabilities = _apply_operator_prerequisites(
        capabilities=capabilities,
        repo_root=repository,
        target_sha=evaluated_target,
    )
    return AutonomyEvidenceStatus(
        target_sha=evaluated_target,
        derived_at=_derived_at(),
        overall_state="declared",
        blockers=(),
        capabilities=capabilities,
    )


__all__ = [
    "AutonomyEvidenceStatus",
    "CAPABILITY_AUTHORITY_PATHS",
    "CAPABILITY_SPECS",
    "CapabilityEvidence",
    "CapabilitySpec",
    "EvidenceContract",
    "EvidenceRef",
    "EvidenceState",
    "derive_autonomy_evidence_status",
]
