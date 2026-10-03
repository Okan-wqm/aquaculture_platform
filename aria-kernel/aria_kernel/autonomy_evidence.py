"""Derived, target-bound ARIA autonomy evidence status.

The status in this module is a read-only projection.  It never creates,
repairs, publishes, or otherwise changes the external ``aria/state`` store.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
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
from .ledger import SEGMENT_OPENED_ROW_TYPE
from .state_snapshot import (
    MAX_SNAPSHOT_JSON_BYTES,
    SNAPSHOT_MAX_INPUT_BYTES,
    SNAPSHOT_MAX_LEDGER_LINE_BYTES,
    SNAPSHOT_MAX_LEDGER_ROWS,
    SNAPSHOT_MAX_SURFACE_BLOB_BYTES,
)
from .state_manifest import normalize_surface_relative_path
from .state_tree_contract import STATE_BOOTSTRAP_EMPTY_MARKERS


EvidenceState = Literal[
    "declared",
    "code_proven",
    "live_proven",
    "operator_blocked",
]
ProofKind = Literal["code", "live"]
RowUpcaster = Callable[[Mapping[str, Any]], Mapping[str, Any]]
TerminalPredicate = Callable[[Mapping[str, Any]], bool]


_LEGACY_KG_SURFACES = frozenset({
    "kg_conventions",
    "kg_anti_patterns",
    "kg_pressure_source_effectiveness",
    "kg_duel_ratings",
    "kg_embeddings",
})
_LEGACY_KG_MIGRATION_BLOCKER = "legacy_kg_canonical_migration_required"


class _LegacyKgCanonicalMigrationRequired(RuntimeError):
    """A published KG ledger needs an operator-governed dual-chain migration."""


_FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
_LEDGER_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
_GIT_OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_OWNER_TASK = re.compile(r"^task-(?:[1-9]|1\d|20a)$")
_REQUIRED_PREDICATE = re.compile(r"^[a-z][a-z0-9_]+$")
_REGRESSION_TEST_REF = re.compile(r"(?:^|/)(?:tests?|[^/]*\.(?:spec|test)\.)")
_ClosurePolicySemantic = tuple[
    str,
    str,
    str,
    str,
    str,
    tuple[str, ...],
]
_EXPECTED_CLOSURE_POLICY_SEMANTICS: Mapping[
    str,
    _ClosurePolicySemantic,
] = MappingProxyType({
    "ORPHAN-HIGH-775": (
        "task-1-orphan-775",
        "task-1",
        "branch_protection_proof_producer_code_proven",
        "task_commit",
        "task_commit",
        ("84404283f64ef15487fac8e7a7d7aa683feeae94",),
    ),
    "ORPHAN-CRITICAL-776": (
        "task-1-orphan-776",
        "task-1",
        "executor_unbound_name_detector_code_proven",
        "historical_main",
        "last_historical_fix",
        ("a16977a968d72a0957b271e3609ff398b6d9c85b",),
    ),
    "ORPHAN-HIGH-777": (
        "task-1-orphan-777",
        "task-1",
        "multi_vendor_model_vocabulary_code_proven",
        "task_commit",
        "task_commit",
        (
            "b2e8ea6241d7b5f6ef5bd212c43cf9f95a4a4585",
            "d7fa539ea03a52ff2cf5e21a9253d4d7cb84f311",
        ),
    ),
    "ORPHAN-HIGH-778": (
        "task-1-orphan-778",
        "task-1",
        "provider_process_boundary_code_proven",
        "task_commit",
        "task_commit",
        (
            "260620fbbcf289c75135b635d970f2134256164c",
            "d7fa539ea03a52ff2cf5e21a9253d4d7cb84f311",
        ),
    ),
    "ORPHAN-HIGH-779": (
        "task-7",
        "task-7",
        "learning_funnel_scheduled_path_live_proven",
        "task_commit_and_live",
        "task_commit",
        ("620683fc9a089790b18bc96b91e0f180fb2c7b63",),
    ),
    "ORPHAN-HIGH-780": (
        "task-1-orphan-780",
        "task-1",
        "workflow_launch_failure_ledger_code_proven",
        "historical_main",
        "last_historical_fix",
        (
            "960b8902b9ec11d5c97dd022c52e38928628f257",
            "b048624cd76054efb4fa7c7a8e67d2ea3b7f76d9",
            "2d9f672d74f559c7163a2e649000cbaa79b259fb",
        ),
    ),
    "ORPHAN-HIGH-781": (
        "task-1-orphan-781",
        "task-1",
        "dispatch_model_identity_code_proven",
        "historical_main",
        "last_historical_fix",
        ("a7f375ec18e81e3ebf3a71d078e7d4b5332cb886",),
    ),
    "ORPHAN-HIGH-782": (
        "task-1-orphan-782",
        "task-1",
        "calibration_reporter_all_exits_code_proven",
        "historical_main",
        "last_historical_fix",
        ("2e9a6929e6a14717aa1725d9511ae0267b3d288c",),
    ),
    "ORPHAN-MEDIUM-783": (
        "task-1-orphan-783",
        "task-1",
        "fixture_phase_result_telemetry_code_proven",
        "historical_main",
        "last_historical_fix",
        ("7a49ebfca19fb175d95cfebac8e9ba8fd19fcacb",),
    ),
    "ORPHAN-HIGH-784": (
        "task-1-orphan-784",
        "task-1",
        "same_cycle_judge_weights_code_proven",
        "historical_main",
        "last_historical_fix",
        ("f19264a48ccb67d989c3db01982904497bb5cf52",),
    ),
    "ORPHAN-MEDIUM-785": (
        "task-1-orphan-785",
        "task-1",
        "judgment_sampler_recency_window_code_proven",
        "historical_main",
        "last_historical_fix",
        ("16f8ba624729a3d427a3d5ff59f784e4cee4dbca",),
    ),
    "ORPHAN-HIGH-786": (
        "task-1-orphan-786",
        "task-1",
        "anchor_sweep_and_drain_topology_code_proven",
        "historical_main",
        "last_historical_fix",
        ("61632372ef765d1dbb0b9cd46673eb98fa2d0815",),
    ),
    "ORPHAN-HIGH-787": (
        "task-1-orphan-787",
        "task-1",
        "auto_promote_token_consumer_hmac_code_proven",
        "historical_main",
        "last_historical_fix",
        ("bd605b5cba516d44e5f879a90ade8adbe6d7b26c",),
    ),
    "ORPHAN-HIGH-788": (
        "task-1-orphan-788",
        "task-1",
        "readiness_workflow_env_binding_code_proven",
        "historical_main",
        "last_historical_fix",
        ("b19fee8b4fd7ee84caa530aa06b76784557ef044",),
    ),
    "ORPHAN-MEDIUM-789": (
        "task-18",
        "task-18",
        "mode_a_signed_readiness_live_proven",
        "task_commit_and_live",
        "task_commit",
        (),
    ),
    "ORPHAN-HIGH-790": (
        "task-1-orphan-790",
        "task-1",
        "agent_refusal_vocabulary_code_proven",
        "historical_main",
        "last_historical_fix",
        ("8daedd72ff6c83460b0631a513e5c1585dac75e4",),
    ),
    "ORPHAN-HIGH-791": (
        "task-1-orphan-791",
        "task-1",
        "authority_date_utc_normalization_code_proven",
        "historical_main",
        "last_historical_fix",
        ("80f92eb6f15520b505bdf6f3b4e6c486784b094b",),
    ),
    "ORPHAN-MEDIUM-792": (
        "task-3",
        "task-3",
        "server_merge_safe_authority_hash_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-001": (
        "task-2",
        "task-2",
        "autonomy_evidence_status_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-002": (
        "task-4",
        "task-4",
        "executor_failure_contract_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-003": (
        "task-5",
        "task-5",
        "three_classified_live_drains",
        "task_commit_and_live",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-004": (
        "task-6",
        "task-6",
        "learning_funnel_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-005": (
        "task-8",
        "task-8",
        "pre_merge_snapshot_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-006": (
        "task-9",
        "task-9",
        "branch_and_file_claim_checks_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-CRITICAL-007": (
        "task-10",
        "task-10",
        "operator_feedback_signature_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-008": (
        "task-11",
        "task-11",
        "budget_and_content_checks_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-CRITICAL-009": (
        "task-12",
        "task-12",
        "seven_pre_merge_checks_live_proven",
        "task_commit_and_live",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-010": (
        "task-13",
        "task-13",
        "rust_observation_shadow_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-011": (
        "task-14",
        "task-14",
        "migration_observation_shadow_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-012": (
        "task-15",
        "task-15",
        "infrastructure_observation_shadow_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-013": (
        "task-16",
        "task-16",
        "workflow_shell_observation_shadow_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-014": (
        "task-17",
        "task-17",
        "whole_repo_observation_and_vertical_slice_live_proven",
        "task_commit_and_live",
        "task_commit",
        (),
    ),
    "ARIA-CRITICAL-015": (
        "task-19",
        "task-19",
        "staged_autonomy_ladder_live_proven",
        "task_commit_and_live",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-016": (
        "task-20a",
        "task-20a",
        "closure_verifier_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
    "ARIA-HIGH-017": (
        "task-5-live-unblock",
        "task-5",
        "state_publish_line_cap_code_proven",
        "task_commit",
        "task_commit",
        (),
    ),
})
_ClosurePolicyReferences = tuple[str, str | None, tuple[str, ...]]
_ORPHAN_REVIEW_ANCHOR_PREFIX = "docs/reviews/orphan-findings.md#"
_ARIA_REVIEW_ANCHOR_PREFIX = (
    "docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md#"
)
_EXPECTED_CLOSURE_POLICY_REFERENCES: Mapping[
    str,
    _ClosurePolicyReferences,
] = MappingProxyType({
    "ORPHAN-HIGH-775": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-775",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-775",
        (
            "aria-kernel/tests/test_readiness_claim_lane.py",
            "aria-kernel/tests/test_workflow_enterprise_preflight.py",
        ),
    ),
    "ORPHAN-CRITICAL-776": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-CRITICAL-776",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-CRITICAL-776",
        ("aria-kernel/tests/test_executor_unbound_names.py",),
    ),
    "ORPHAN-HIGH-777": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-777",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-777",
        (
            "aria-kernel/tests/test_glm_model_admission.py",
            "aria-kernel/tests/test_model_tier_protection.py",
        ),
    ),
    "ORPHAN-HIGH-778": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-778",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-778",
        ("aria-kernel/tests/test_provider_redirect.py",),
    ),
    "ORPHAN-HIGH-779": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-779",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-779",
        (
            "aria-kernel/tests/test_fixture_dir_state_store_layout.py",
            "aria-kernel/tests/test_learning_funnel_scheduled_path.py",
        ),
    ),
    "ORPHAN-HIGH-780": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-780",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-780",
        (
            "aria-kernel/tests/test_workflow_kernel_cli_contract.py",
            "aria-kernel/tests/test_cli_launch_failure_ledger.py",
        ),
    ),
    "ORPHAN-HIGH-781": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-781",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-781",
        ("aria-kernel/tests/test_dispatch_model_stamping.py",),
    ),
    "ORPHAN-HIGH-782": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-782",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-782",
        ("aria-kernel/tests/invariants/v7/test_phase_v7_6_calibration_reporter.py",),
    ),
    "ORPHAN-MEDIUM-783": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-MEDIUM-783",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-MEDIUM-783",
        ("aria-kernel/tests/test_judgment_pipeline_phases.py",),
    ),
    "ORPHAN-HIGH-784": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-784",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-784",
        ("aria-kernel/tests/test_judgment_pipeline_phases.py",),
    ),
    "ORPHAN-MEDIUM-785": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-MEDIUM-785",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-MEDIUM-785",
        ("aria-kernel/tests/test_sampler_recency_window.py",),
    ),
    "ORPHAN-HIGH-786": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-786",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-786",
        (
            "aria-kernel/tests/test_anchor_sweep.py",
            "aria-kernel/tests/test_x1_drain_topology.py",
        ),
    ),
    "ORPHAN-HIGH-787": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-787",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-787",
        (
            "aria-kernel/tests/invariants/v6/test_phase_v6_4_auto_promotion.py",
            "aria-kernel/tests/test_auto_promote_token_verification.py",
        ),
    ),
    "ORPHAN-HIGH-788": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-788",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-788",
        ("aria-kernel/tests/test_workflow_env_binding.py",),
    ),
    "ORPHAN-MEDIUM-789": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-MEDIUM-789",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-MEDIUM-789",
        (
            "aria-kernel/tests/test_workflow_mode_a_transport.py",
            "aria-kernel/tests/test_signed_readiness_snapshot.py",
        ),
    ),
    "ORPHAN-HIGH-790": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-790",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-790",
        ("aria-kernel/tests/test_agent_refusal_vocabulary.py",),
    ),
    "ORPHAN-HIGH-791": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-791",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-HIGH-791",
        ("tests/invariants/aria-doc-runtime-ssot.spec.ts",),
    ),
    "ORPHAN-MEDIUM-792": (
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-MEDIUM-792",
        _ORPHAN_REVIEW_ANCHOR_PREFIX + "ORPHAN-MEDIUM-792",
        (
            "tools/gates/aria-authority-hash.spec.ts",
            "tests/invariants/aria-doc-runtime-ssot.spec.ts",
        ),
    ),
    "ARIA-HIGH-001": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-001",
        None,
        ("aria-kernel/tests/test_autonomy_evidence_status.py",),
    ),
    "ARIA-HIGH-002": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-002",
        None,
        ("aria-kernel/tests/test_executor_failure_classification.py",),
    ),
    "ARIA-HIGH-003": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-003",
        None,
        ("aria-kernel/tests/test_executor_drain_breaker.py",),
    ),
    "ARIA-HIGH-004": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-004",
        None,
        ("aria-kernel/tests/test_promotion_funnel_e2e.py",),
    ),
    "ARIA-HIGH-005": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-005",
        None,
        ("aria-kernel/tests/test_pre_merge_evidence.py",),
    ),
    "ARIA-HIGH-006": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-006",
        None,
        (
            "aria-kernel/tests/test_file_claim_atomic_acquire.py",
            "aria-kernel/tests/test_pre_merge_file_claims.py",
        ),
    ),
    "ARIA-CRITICAL-007": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-CRITICAL-007",
        None,
        ("aria-kernel/tests/test_operator_feedback_signature.py",),
    ),
    "ARIA-HIGH-008": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-008",
        None,
        ("aria-kernel/tests/test_pre_merge_budget_and_content.py",),
    ),
    "ARIA-CRITICAL-009": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-CRITICAL-009",
        None,
        ("aria-kernel/tests/test_pre_merge_consensus_and_coverage.py",),
    ),
    "ARIA-HIGH-010": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-010",
        None,
        ("tools/aria-adapters/rust-runtime-safety-adapter.test.ts",),
    ),
    "ARIA-HIGH-011": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-011",
        None,
        ("tools/aria-adapters/sql-migration-safety-adapter.test.ts",),
    ),
    "ARIA-HIGH-012": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-012",
        None,
        ("tools/aria-adapters/infrastructure-policy-adapter.test.ts",),
    ),
    "ARIA-HIGH-013": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-013",
        None,
        ("tools/aria-adapters/workflow-shell-safety-adapter.test.ts",),
    ),
    "ARIA-HIGH-014": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-014",
        None,
        ("aria-kernel/tests/test_vertical_slice_evidence.py",),
    ),
    "ARIA-CRITICAL-015": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-CRITICAL-015",
        None,
        ("aria-kernel/tests/test_autonomy_stage_progression.py",),
    ),
    "ARIA-HIGH-016": (
        _ARIA_REVIEW_ANCHOR_PREFIX + "ARIA-HIGH-016",
        None,
        ("aria-kernel/tests/test_autonomy_closure.py",),
    ),
    "ARIA-HIGH-017": (
        "docs/reviews/aria/2026-08-23-state-publish-line-cap-regression.md"
        "#ARIA-HIGH-017",
        None,
        (
            "aria-kernel/tests/test_state_snapshot.py",
            "aria-kernel/tests/test_agent_submit_result_e2e.py",
        ),
    ),
})
_EXPECTED_CLOSURE_SCOPE = frozenset(_EXPECTED_CLOSURE_POLICY_SEMANTICS)
_MAX_EVALUATOR_BLOB_BYTES = 2 * 1024 * 1024
# ARIA-HIGH-288 — a proof is bound to the semantic authority its commit
# DECLARES, never to source bytes: a hash over a roster of kernel files reset
# every capability on each storage refactor. The declaration is read from Git
# at the proof's commit and at the target; test_capability_semantic_equivalence
# pins each declared authority to what the fold makes of a frozen corpus, so
# semantics cannot move without a bump and a bump cannot pin itself.
SEMANTIC_AUTHORITY_PATH = "aria-kernel/aria_kernel/data/capability_semantic_authority.json"
_SEMANTIC_AUTHORITY_SCHEMA = "aria/capability-semantic-authority/v1"
_SEMANTIC_AUTHORITY_KEYS = frozenset({
    "$schema",
    "evidence_fold_version",
    "upcaster_set_version",
    "capability_contract_versions",
})
_MAX_SEMANTIC_AUTHORITY_BYTES = 64 * 1024
_MAX_POLICY_BLOB_BYTES = 2 * 1024 * 1024
_MAX_SNAPSHOT_TREE_BYTES = 16 * 1024 * 1024
_MAX_SNAPSHOT_TREE_ENTRIES = 10_000
_MAX_SNAPSHOT_SURFACE_BLOB_BYTES = SNAPSHOT_MAX_SURFACE_BLOB_BYTES
_MAX_SNAPSHOT_INPUT_BYTES = SNAPSHOT_MAX_INPUT_BYTES
_MAX_EVIDENCE_LEDGER_BLOB_BYTES = 64 * 1024 * 1024
_MAX_EVIDENCE_INPUT_BYTES = 80 * 1024 * 1024
_MAX_EVIDENCE_LEDGER_LINE_BYTES = 1024 * 1024
_MAX_EVIDENCE_LEDGER_ROWS = 100_000
# ARIA-HIGH-278 — a carried ledger's verified prefix carries its evidence
# forward as one checkpoint row, so a publish consumes only the rows after
# its newest checkpoint. The publish preamble records a checkpoint once a
# ledger's published prefix runs a stride past its last one: per ledger a
# publish consumes at most one stride plus two publishes' growth, at any age.
EVIDENCE_CHECKPOINT_SURFACE = "evidence_checkpoints"
EVIDENCE_CHECKPOINT_STRIDE_BYTES = 1024 * 1024


def _declared_version(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _parse_semantic_authority(payload: bytes) -> dict[str, Any]:
    """One commit's declared semantic versions, strictly shaped."""
    try:
        declared = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise RuntimeError("git_authority_declaration_invalid") from exc
    versions = (
        declared.get("capability_contract_versions")
        if isinstance(declared, dict) else None
    )
    if (
        not isinstance(declared, dict)
        or set(declared) - {"_doc"} != _SEMANTIC_AUTHORITY_KEYS
        or declared["$schema"] != _SEMANTIC_AUTHORITY_SCHEMA
        or not _declared_version(declared["evidence_fold_version"])
        or not _declared_version(declared["upcaster_set_version"])
        or not isinstance(versions, dict)
        or not versions
        or not all(_declared_version(version) for version in versions.values())
    ):
        raise RuntimeError("git_authority_declaration_invalid")
    return declared


def _semantic_authority(declared: Mapping[str, Any], capability: str) -> str:
    """What a proof of ``capability`` is proven under: every declared version
    its meaning depends on, spelled so the provenance reads without a lookup."""
    version = declared["capability_contract_versions"].get(capability)
    if not _declared_version(version):
        raise RuntimeError("git_authority_declaration_invalid")
    return (
        f"{_SEMANTIC_AUTHORITY_SCHEMA}:{capability}@{version}"
        f":fold@{declared['evidence_fold_version']}"
        f":upcasters@{declared['upcaster_set_version']}"
    )


# The executing kernel's own declaration (SEMANTIC_AUTHORITY_PATH).
_DECLARED_SEMANTICS: dict[str, Any] = _parse_semantic_authority(
    (Path(__file__).resolve().parent / "data" / Path(SEMANTIC_AUTHORITY_PATH).name)
    .read_bytes(),
)
# Bumped whenever how a carried row folds into the projection changes (its
# output on a frozen corpus is pinned per version by
# test_capability_semantic_equivalence, never its source): a checkpoint of
# another fold version is not evidence and is never read. It IS the declared
# fold version, so a fold bump moves every capability's semantic authority by
# construction.
EVIDENCE_CHECKPOINT_FOLD_VERSION: int = _DECLARED_SEMANTICS["evidence_fold_version"]
_EVIDENCE_CHECKPOINT_ROW_TYPE = "evidence_checkpoint"
# ARIA-HIGH-286 — named on every capability that counts a carried claim the
# publish's slice (`_evidence_slice_bytes`) could not reach.
EVIDENCE_REBUILD_BLOCKER = "evidence_checkpoint_rebuild_in_progress"
_MAX_SNAPSHOT_LEDGER_LINE_BYTES = SNAPSHOT_MAX_LEDGER_LINE_BYTES
_MAX_SNAPSHOT_LEDGER_ROWS = SNAPSHOT_MAX_LEDGER_ROWS
_MAX_SNAPSHOT_SURFACE_MATCH_CANDIDATES = 100_000
_MAX_DISTINCT_PROOF_TARGETS_PER_CAPABILITY = 128
_MAX_DISTINCT_PROOF_TARGETS_GLOBAL = 256
_GIT_STREAM_TIMEOUT_SECONDS = 30
# Declared once in state_tree_contract: the publish-time healer judges a
# parent tree by the same marker set this verifier admits, so the two can
# never disagree about what an empty bootstrap tree may carry.
_STATE_BOOTSTRAP_EMPTY_MARKERS = STATE_BOOTSTRAP_EMPTY_MARKERS


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
    """Immutable proof ownership for one capability.

    ``authority_paths`` is the code a capability's proofs are produced and
    judged by; the evaluator runs only from a clean checkout of it. Its bytes
    are not the proof's authority (ARIA-HIGH-288): SEMANTIC_AUTHORITY_PATH is.
    """

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
    # Provenance (ARIA-HIGH-288): the semantic authority the proof was
    # proven under — equal at the evidence commit and the evaluated target.
    semantic_authority: str
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
    f"{_KERNEL}contention_replay.py",
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
            f"{_KERNEL}trailer_scan.py",
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
            # cycle.py is a producer of this surface AND, since the deadline
            # seal, a reader of it: _seal_cycle_on_escape reads its own
            # lifecycle rows to decide whether a terminal row is still owed,
            # so it can never write a second one over an abort path's.
            f"{_KERNEL}cycle.py",
            f"{_KERNEL}runtime_artifacts.py",
            f"{_KERNEL}trailer_scan.py",
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
            f"{_KERNEL}agent_surface.py",
            f"{_KERNEL}genesis_lifecycle.py",
            f"{_KERNEL}context_budget_gate.py",
            f"{_KERNEL}runtime_profile.py",
            f"{_KERNEL}agent_contract.py",
            f"{_KERNEL}agent_compliance.py",
            f"{_KERNEL}implementation_safety.py",
            f"{_KERNEL}agent_genesis.py",
            f"{_KERNEL}evidence_trust.py",
            # The probe bounds, retry and once-per-decision baseline every
            # acceptance-time evidence grade runs through: a change here
            # changes what the executor accepts.
            f"{_KERNEL}evidence_probe.py",
            f"{_KERNEL}canonical_path.py",
            f"{_KERNEL}tool_health.py",
            f"{_KERNEL}ledger_refs.py",
            f"{_KERNEL}planner_dispatch_hook.py",
            f"{_KERNEL}agent_eval.py",
            f"{_KERNEL}bridge_status_ledger.py",
            f"{_KERNEL}circuit_breaker.py",
            f"{_KERNEL}convergence_drainer.py",
            f"{_KERNEL}evidence_validator.py",
            f"{_KERNEL}plan_convergence.py",
            f"{_KERNEL}state_manifest.py",
            # Native runtime attempts: the reservation that binds a managed
            # attempt to a claim lives in budget.py (2026-09-11 integration).
            f"{_KERNEL}budget.py",
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
            f"{_KERNEL}genesis_lifecycle.py",
            f"{_KERNEL}plan_convergence.py",
            # Native runtime attempts (2026-09-11 Codex integration): the
            # attempt reservation reads results to validate the claim's
            # dispatch authority before a managed attempt is bound, and the
            # executor reads the accepted result to reconcile the attempt it
            # ran — both decide, neither merely observes.
            f"{_KERNEL}budget.py",
            "tools/aria-poc/ci_executor.py",
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
        # ARIA-HIGH-190: raw_findings is NOT a count surface. It is the
        # adapters' unbounded pre-dedup stream (57.5 MB live); counting it only
        # fed a display metric, yet it pushed the counted-surface budget over
        # _MAX_EVIDENCE_INPUT_BYTES and failed every cycle publish.
        count_surfaces=(
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
            f"{_KERNEL}fixture_runner.py",
            f"{_KERNEL}genesis_lifecycle.py",
            f"{_KERNEL}readiness.py",
            f"{_KERNEL}shadow_eval_bridge.py",
            f"{_KERNEL}tool_registry.py",
        ),
        contracts=(EvidenceContract(
            surface="agent_eval_fixture_runs",
            proof_kind="live",
            schema_id="aria/agent-eval-fixture-run/v1",
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
            # ADR-0020 — check 12 re-verifies consumed operator requests
            # here, against the allowed-signers file committed on main and
            # read through the hardened anchor reader, and re-checks their
            # signed terms and merged-once proof (review round 2).
            f"{_KERNEL}operator_request_signature.py",
            f"{_KERNEL}operator_feedback_observation.py",
            f"{_KERNEL}operator_request_terms.py",
            f"{_KERNEL}main_anchor.py",
            f"{_KERNEL}expert_review_gate.py",
            f"{_KERNEL}plan_coverage.py",
            f"{_KERNEL}budget.py",
            f"{_KERNEL}cost_budget.py",
            f"{_KERNEL}turn_budget.py",
            # The implementer turn cap the seventh predicate compares evidence
            # against is resolved here (the policy block's ceiling, its
            # validation and the store-bound read); a change to it changes
            # what the perimeter admits, exactly as cost_budget.py does for
            # the dollar caps it resolves from the same policy.
            f"{_KERNEL}turn_budget_policy.py",
            f"{_KERNEL}state_manifest.py",
            ".github/workflows/aria-merge-authority.yml",
        ),
        producer_paths=(
            f"{_KERNEL}auto_merge.py",
            f"{_KERNEL}pre_merge_evidence.py",
            f"{_KERNEL}merge_authority.py",
            f"{_KERNEL}plan_convergence.py",
            f"{_KERNEL}file_claims.py",
            f"{_KERNEL}operator_feedback_signature.py",
            # ADR-0020 — check 12 re-verifies consumed operator requests
            # here, against the allowed-signers file committed on main and
            # read through the hardened anchor reader, and re-checks their
            # signed terms and merged-once proof (review round 2).
            f"{_KERNEL}operator_request_signature.py",
            f"{_KERNEL}operator_feedback_observation.py",
            f"{_KERNEL}operator_request_terms.py",
            f"{_KERNEL}main_anchor.py",
            f"{_KERNEL}expert_review_gate.py",
            f"{_KERNEL}plan_coverage.py",
            f"{_KERNEL}budget.py",
            f"{_KERNEL}cost_budget.py",
            f"{_KERNEL}turn_budget.py",
            f"{_KERNEL}turn_budget_policy.py",
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
            ".github/workflows/aria-merge-runner.yml",
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
            ".github/workflows/aria-merge-runner.yml",
        ),
        authorizing_consumer_paths=(
            f"{_KERNEL}auto_merge_runners.py",
            f"{_KERNEL}readiness_proofs.py",
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
            f"{_KERNEL}merge_authority.py",
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
# ARIA-HIGH-278 — the counted ledgers whose rows fold into a bounded,
# order-free summary (counters, blocker sets, the autonomy-state fold), so a
# verified prefix can be carried forward. Never carried: a contract with an
# authoritative SHA (its witnesses are chosen across all history under a
# cross-capability budget) and the three below.
_UNCARRIED_COUNT_SURFACES: Mapping[str, str] = MappingProxyType({
    "promotions": "every promoted fingerprint is kept to count unique ones",
    "enterprise_acceptance_events": "every row is kept for the unlock verdict",
    "findings": "rewritten in place when a tool's findings need revalidation",
})
_CARRIED_COUNT_SURFACES = frozenset(
    name
    for spec in CAPABILITY_SPECS.values()
    for name in spec.count_surfaces
    if name not in _UNCARRIED_COUNT_SURFACES
    and not any(
        contract.surface == name and contract.authoritative_sha_field is not None
        for owner in CAPABILITY_SPECS.values()
        for contract in owner.contracts
    )
)


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
            schema_key_present = "$schema" in row
            if (
                not isinstance(schema_version, int)
                or isinstance(schema_version, bool)
                or schema_version not in contract.schema_versions
                or (contract.schema_id is None and schema_key_present)
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


def _capability_semantic_authority(
    repo_root: str | Path,
    capability: str,
    commit_sha: str,
) -> str | None:
    """The semantic authority one commit declares for ``capability``.

    None when the commit declares none: a proof from before ARIA-HIGH-288
    (the byte-hash era) is never mapped onto a semantic authority.
    """
    root = Path(repo_root).resolve()
    if not _commit_exists(root, commit_sha):
        raise RuntimeError(f"git_commit_unavailable:{commit_sha}")
    entry = _git_tree_entry(root, commit_sha, SEMANTIC_AUTHORITY_PATH)
    if entry is None:
        return None
    _record, mode, object_type, object_id = entry
    if object_type != "blob" or mode not in {"100644", "100755"}:
        raise RuntimeError("git_authority_tree_invalid")
    try:
        payload = _read_git_blob_bounded(
            root,
            object_id,
            max_bytes=_MAX_SEMANTIC_AUTHORITY_BYTES,
            too_large="git_authority_blob_too_large",
            unavailable="git_authority_blob_unavailable",
        )
    except RuntimeError as exc:
        if str(exc) == "git_authority_blob_too_large":
            raise
        raise RuntimeError("git_authority_blob_unavailable") from exc
    return _semantic_authority(_parse_semantic_authority(payload), capability)


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
    # The semantics this process applies are the ones it loaded; the target
    # must declare the same, or the evaluator would judge it by other rules.
    try:
        executing = _semantic_authority(_DECLARED_SEMANTICS, capability)
        target = _capability_semantic_authority(repo_root, capability, target_sha)
    except RuntimeError as exc:
        named = str(exc)
        if named.startswith("git_authority_"):
            return named
        return f"evaluator_authority_unavailable:{capability}"
    if target is None:
        return f"evaluator_authority_undeclared:{capability}"
    if target != executing:
        return f"evaluator_authority_changed:{capability}"
    return None


def _evaluator_worktree_blocker(repo_root: Path) -> str | None:
    authority_paths = tuple(sorted({
        SEMANTIC_AUTHORITY_PATH,
        *(
            path
            for spec in CAPABILITY_SPECS.values()
            for path in spec.authority_paths
        ),
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
    authority_cache: dict[str, str | None] = {}

    def authority(sha: str) -> str | None:
        if sha not in authority_cache:
            authority_cache[sha] = _capability_semantic_authority(
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
        witness_authority: str | None = None
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
                evidence_authority = authority(evidence_sha)
                target_authority = authority(target_sha)
            except RuntimeError as exc:
                named = str(exc)
                blockers.add(
                    named if named.startswith("git_authority_")
                    else "git_authority_unavailable"
                )
                continue
            if evidence_authority is None:
                # Proven before ARIA-HIGH-288 declared any semantics.
                blockers.add(f"proof_authority_undeclared:{capability}")
                continue
            if evidence_authority != target_authority:
                blockers.add(f"proof_authority_changed:{capability}")
                continue
            if witness is None:
                witness = retained
                witness_authority = evidence_authority
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
        if witness is not None and witness_authority is not None:
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
                semantic_authority=witness_authority,
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


def _legacy_kg_operator_blocked_status(
    *,
    target_sha: str,
    repo_root: Path,
) -> AutonomyEvidenceStatus:
    """Return a non-authorizing status for an outer-hashless KG snapshot.

    A generic ledger-hash backfill rewrites each row and invalidates the KG's
    native ``prev_row_hash`` chain.  Only an operator-governed canonical
    migration may recompute both chains, so readiness and unlock stay closed.
    """
    unavailable = _unavailable_status(
        target_sha=target_sha,
        blocker=_LEGACY_KG_MIGRATION_BLOCKER,
        repo_root=repo_root,
    )
    capabilities = dict(unavailable.capabilities)
    for capability in ("enterprise_readiness", "autonomy_unlock"):
        evidence = capabilities[capability]
        capabilities[capability] = CapabilityEvidence(
            state="operator_blocked",
            counts=evidence.counts,
            blockers=evidence.blockers,
            evidence_refs=(),
            proof_cardinality={},
        )
    return AutonomyEvidenceStatus(
        target_sha=target_sha,
        derived_at=unavailable.derived_at,
        overall_state="operator_blocked",
        blockers=unavailable.blockers,
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
            max_bytes=MAX_SNAPSHOT_JSON_BYTES,
            too_large="state_snapshot_json_too_large",
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


def _carried_family(key: str) -> str | None:
    """The carried ledger family a snapshot claim key feeds, or None."""
    from .ledger import segment_family
    from .state_manifest import surface_key_name

    surface_name = surface_key_name(key)
    family = segment_family(surface_name)
    counted = key == surface_name or family != surface_name
    return family if counted and family in _CARRIED_COUNT_SURFACES else None


def _valid_evidence_checkpoint(row: Mapping[str, Any]) -> bool:
    def count(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and value > 0

    tail = row.get("tail_ledger_hash")
    return (
        row.get("row_type") == _EVIDENCE_CHECKPOINT_ROW_TYPE and row.get("schema_version") == 1
        and all(count(row.get(name)) for name in ("schema_version", "fold_version", "row_count", "size_bytes"))
        and isinstance(row.get("surface_key"), str) and isinstance(row.get("evidence"), dict)
        and isinstance(tail, str) and _LEDGER_HASH.fullmatch(tail) is not None
    )


def _evidence_slice_bytes() -> int:
    """The most carried-ledger bytes one publish folds past its trusted
    checkpoints, at any ledger age (ARIA-HIGH-286): two fifths of the
    evidence-input budget, so it stays under the budget by construction and
    leaves the rest to the uncarried ledgers and the checkpoint ledger.

    A fold-version bump or a store without checkpoints is rebuilt across
    publishes: each preamble records checkpoints over at most half the slice,
    and the commit's verifier folds those plus whole claims on past them
    while the rest lasts. A claim the slice cannot reach is withheld, never
    estimated, and every capability counting it names EVIDENCE_REBUILD_BLOCKER
    until the rebuild reaches it.
    """
    return _MAX_EVIDENCE_INPUT_BYTES * 2 // 5


class _CarriedClaimCursor:
    """One carried claim, streamed from its newest usable trusted checkpoint.

    Rows up to that base are carried by it; later rows whose lines end at or
    before ``stop_bytes`` fold into a tally the caller absorbs once the claim
    verifies, so the fold never runs past the bytes it was charged
    (ARIA-HIGH-286). Every checkpoint on the claim is checked where it sits:
    its byte offset and ledger hash bind the prefix (a rewritten or truncated
    prefix refuses), and inside the fold the tally must equal the evidence it
    records. The base sits at or below every pending checkpoint and the stop
    at or past each one's claimed end, so one stream verifies all of them: a
    pending checkpoint whose row does not end where it claims refuses.
    """

    def __init__(
        self, key: str, family: str, checkpoints: Iterable[tuple[Mapping[str, Any], bool]], size: int,
    ) -> None:
        from .state_manifest import surface_key_name

        listed = tuple(checkpoints)
        floor = min((row["row_count"] for row, trusted in listed if not trusted), default=None)
        base = max(
            (row for row, trusted in listed if trusted and (floor is None or row["row_count"] <= floor)),
            key=lambda row: row["row_count"],
            default=None,
        )
        self.key, self.family, self.surface_name, self.size = key, family, surface_key_name(key), size
        self.base_rows = base["row_count"] if base is not None else 0
        self.base_bytes = base["size_bytes"] if base is not None else 0
        self.tally = _StreamingEvidenceAccumulator()
        if base is not None:
            self.tally.merge_carried(base["evidence"], key)
        self.at: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
        for row, _trusted in listed:
            self.at[row["row_count"]].append(row)
        # Through the newest pending checkpoint; widened to `size` when the
        # publish's slice reaches the claim's end.
        self.stop_bytes = max((row["size_bytes"] for row, trusted in listed if not trusted), default=self.base_bytes)
        # (rows, bytes, ledger hash) the tally has folded through.
        self.frontier: tuple[int, int, str | None] = (
            self.base_rows, self.base_bytes, base["tail_ledger_hash"] if base is not None else None,
        )
        self._row: dict[str, Any] = {}

    @property
    def complete(self) -> bool:
        """The fold reaches the claim's end, so its tally is the claim's evidence."""
        return self.stop_bytes == self.size

    def on_row(self, row: dict[str, Any]) -> None:
        self._row = row

    def on_position(self, row_number: int, line_end: int, ledger_hash: str) -> None:
        folded = self.base_rows < row_number and line_end <= self.stop_bytes
        if folded:
            if row_number - self.base_rows > _MAX_EVIDENCE_LEDGER_ROWS:
                raise RuntimeError(f"state_commit_surface_row_limit_exceeded:{self.surface_name}")
            self.tally.consume(self.family, self._row)
            self.frontier = (row_number, line_end, ledger_hash)
        for checkpoint in self.at.get(row_number, ()):
            if (
                checkpoint["size_bytes"] != line_end
                or checkpoint["tail_ledger_hash"] != ledger_hash
                or (
                    (folded or row_number == self.base_rows)
                    and checkpoint["evidence"] != self.tally.carried_state(self.key)
                )
            ):
                raise RuntimeError(f"state_commit_evidence_checkpoint_mismatch:{self.key}")


def _stream_ledger_blob(
    store_root: Path,
    object_id: str,
    claim: Mapping[str, Any],
    *,
    source: str,
    surface_name: str,
    grandfather: int,
    on_row: Callable[[dict[str, Any]], None],
    on_row_position: Callable[[int, int, str], None] | None = None,
) -> None:
    """Strictly verify one committed ledger blob, feeding its rows."""
    from .ledger import verify_jsonl_chunks

    size = claim["size_bytes"]
    verify_jsonl_chunks(
        _iter_git_output_bounded(
            store_root, "cat-file", "blob", object_id, max_bytes=size, expected_size=size,
            unavailable=f"state_snapshot_surface_unavailable:{surface_name}",
        ),
        source=source, expected_size=size, max_line_bytes=_MAX_SNAPSHOT_LEDGER_LINE_BYTES,
        max_rows=_MAX_SNAPSHOT_LEDGER_ROWS, grandfather_line_prefixes=grandfather,
        expected_surface=surface_name, expected_surface_instance=claim["path"],
        on_row=on_row, on_row_position=on_row_position,
    )


def _carried_claim_cursors(
    *,
    store_root: Path,
    state_commit: str,
    claims: list[tuple[str, Mapping[str, Any], str, str, int, bool]],
    parent_surfaces: Mapping[str, Mapping[str, Any]],
) -> tuple[dict[str, _CarriedClaimCursor], int]:
    """Cursor each carried claim of one commit; return the input they consume.

    The checkpoint rows the parent published are trusted: the parent was
    verified when it was published, and its claim's tail hash binds them, so
    rewriting one refuses here. A row this commit adds is pending and is
    verified by its claim's stream. The input is the checkpoint ledger plus,
    per carried claim, the bytes its cursor folds past its base.

    ARIA-HIGH-286 — every pending checkpoint is folded to; what is left of
    the slice (`_evidence_slice_bytes`) then folds whole claims on to their end,
    in key order, while it lasts. A claim it cannot reach stops at its newest
    checkpoint and is rebuilding: its evidence is withheld, never estimated.
    """
    listed = {key: (claim, object_id, git_path) for key, claim, object_id, git_path, _size, _ in claims}
    families = {
        key: family for key, *_rest, consumed in claims if consumed and (family := _carried_family(key))
    }
    found: dict[str, list[tuple[Mapping[str, Any], bool]]] = defaultdict(list)
    input_bytes = 0
    if EVIDENCE_CHECKPOINT_SURFACE in listed:
        claim, object_id, git_path = listed[EVIDENCE_CHECKPOINT_SURFACE]
        inherited = parent_surfaces.get(EVIDENCE_CHECKPOINT_SURFACE, {})
        inherited_rows = _integer(inherited.get("row_count"))
        rows: list[dict[str, Any]] = []
        tail: list[str] = []
        _stream_ledger_blob(
            store_root, object_id, claim, source=f"{state_commit}:{git_path}",
            surface_name=EVIDENCE_CHECKPOINT_SURFACE, grandfather=inherited_rows, on_row=rows.append,
            on_row_position=lambda number, _end, ledger_hash: (
                tail.append(ledger_hash) if number == inherited_rows else None
            ),
        )
        if inherited_rows and tail != [inherited.get("tail_ledger_hash")]:
            raise RuntimeError("state_commit_evidence_checkpoints_rewritten")
        input_bytes += claim["size_bytes"]
        for number, row in enumerate(rows, start=1):
            key, trusted = row.get("surface_key"), number <= inherited_rows
            if not _valid_evidence_checkpoint(row) or (key not in families and not trusted):
                raise RuntimeError(f"state_commit_evidence_checkpoint_invalid:{key}")
            if row["fold_version"] != EVIDENCE_CHECKPOINT_FOLD_VERSION or key not in families:
                continue
            target = listed[key][0]
            if row["row_count"] > target["row_count"] or row["size_bytes"] > target["size_bytes"]:
                raise RuntimeError(f"state_commit_evidence_checkpoint_mismatch:{key}")
            found[key].append((row, trusted))
    cursors = {
        key: _CarriedClaimCursor(key, family, found[key], listed[key][0]["size_bytes"])
        for key, family in sorted(families.items())
    }
    left = _evidence_slice_bytes() - sum(cursor.stop_bytes - cursor.base_bytes for cursor in cursors.values())
    for cursor in cursors.values():
        if cursor.size - cursor.stop_bytes <= max(left, 0):
            left -= cursor.size - cursor.stop_bytes
            cursor.stop_bytes = cursor.size
    input_bytes += sum(cursor.stop_bytes - cursor.base_bytes for cursor in cursors.values())
    return cursors, input_bytes


def evidence_checkpoints_due(*, store: Any, repo_identity: str, base_head: str) -> list[dict[str, Any]]:
    """The checkpoint rows a publish on ``base_head`` records (ARIA-HIGH-278).

    A read of the parent commit, never of the working tree: a checkpoint
    names a prefix of the parent's verified claim, which every descendant
    keeps (carried ledgers only grow; contention replay appends behind it),
    so a losing lane's checkpoint stays true on the winner's tree. Its
    evidence folds on from the parent's newest checkpoint, and the commit
    that carries it verifies it again.

    ARIA-HIGH-286 — together the rows fold at most half the slice, in key
    order: a checkpoint lands on the last row a claim's share reaches, which
    is its end in steady state and a prefix while a fold-version bump or a
    store without checkpoints is rebuilt, one bounded slice per publish.
    """
    from .state_manifest import surface_key_name

    try:
        snapshot, _object = _read_immutable_snapshot_claim(store.root, base_head)
    except RuntimeError as exc:
        if str(exc) == "state_store_genesis":
            return []
        raise
    surfaces: Mapping[str, Mapping[str, Any]] = snapshot["surfaces"]

    def stream(key: str, on_row: Callable[[dict[str, Any]], None], cursor: Any = None) -> None:
        claim = surfaces[key]
        git_path = _snapshot_surface_git_path(
            store=store, repo_identity=repo_identity, root_kind=claim["root_kind"], relative=claim["path"],
        )
        entry = _git_tree_entry(store.root, base_head, git_path)
        if entry is None or entry[2] != "blob":
            raise RuntimeError(f"state_snapshot_surface_unavailable:{key}")
        _stream_ledger_blob(
            store.root, entry[3], claim, source=f"{base_head}:{git_path}", surface_name=surface_key_name(key),
            grandfather=claim["row_count"], on_row=on_row,
            on_row_position=cursor.on_position if cursor is not None else None,
        )

    recorded: list[dict[str, Any]] = []
    if EVIDENCE_CHECKPOINT_SURFACE in surfaces:
        stream(EVIDENCE_CHECKPOINT_SURFACE, recorded.append)
    newest: dict[str, Mapping[str, Any]] = {}
    for row in recorded:
        if _valid_evidence_checkpoint(row) and row["fold_version"] == EVIDENCE_CHECKPOINT_FOLD_VERSION:
            if row["row_count"] > newest.get(row["surface_key"], {}).get("row_count", 0):
                newest[row["surface_key"]] = row
    due: list[dict[str, Any]] = []
    left = _evidence_slice_bytes() // 2
    for key, claim in sorted(surfaces.items()):
        family, base = _carried_family(key), newest.get(key)
        start = base["size_bytes"] if base else 0
        if family is None or claim["size_bytes"] - start < EVIDENCE_CHECKPOINT_STRIDE_BYTES or left <= 0:
            continue
        cursor = _CarriedClaimCursor(key, family, [(base, True)] if base else (), claim["size_bytes"])
        cursor.stop_bytes = min(claim["size_bytes"], start + left)
        stream(key, cursor.on_row, cursor)
        rows, end, tail = cursor.frontier
        if rows == cursor.base_rows:
            continue  # its next row alone is longer than the slice left
        left -= end - start
        due.append({
            "schema_version": 1,
            "row_type": _EVIDENCE_CHECKPOINT_ROW_TYPE,
            # The fold version is part of the identity: a rebuilt checkpoint
            # at an old one's row is a new row, never a duplicate of it.
            "row_id": f"{_EVIDENCE_CHECKPOINT_ROW_TYPE}:v{EVIDENCE_CHECKPOINT_FOLD_VERSION}:{key}:{rows}",
            "fold_version": EVIDENCE_CHECKPOINT_FOLD_VERSION,
            "surface_key": key,
            "row_count": rows,
            "size_bytes": end,
            "tail_ledger_hash": tail,
            "evidence": cursor.tally.carried_state(key),
        })
    return due


def _verify_snapshot_and_collect_evidence(
    *,
    store: Any,
    repo_identity: str,
    state_commit: str,
    expected_snapshot_object_id: str,
) -> _StreamingEvidenceAccumulator:
    """Verify every snapshot surface, parsing only the evidence ledgers."""
    from .ledger import (
        LedgerIntegrityError,
        LedgerReadLimitError,
        segment_family,
        verify_jsonl_chunks,
    )
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
        # ARIA-HIGH-275 — every segment of a counted family is consumed and
        # counted under the family, so rollover never shrinks the evidence.
        counted_as = segment_family(surface_name)
        consumed = (key == surface_name or counted_as != surface_name) and counted_as in counted_names
        if consumed:
            if observed_size > _MAX_EVIDENCE_LEDGER_BLOB_BYTES:
                raise RuntimeError(
                    f"state_commit_surface_too_large:{surface_name}",
                )
            # ARIA-HIGH-278 — a carried ledger is charged below, for the
            # bytes after its newest trusted checkpoint only.
            if counted_as not in _CARRIED_COUNT_SURFACES:
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

    # ARIA-HIGH-017 — rows inherited from the parent tip are exempt from
    # the per-line cap: the parent is already-published history an
    # append-only chain cannot shrink. A root commit (no parent) or an
    # unreadable parent claim keeps the strict cap for every line and
    # (ARIA-HIGH-278) trusts no checkpoint, so each one is re-verified.
    try:
        parent_snapshot, _parent_object = _read_immutable_snapshot_claim(
            store.root,
            _state_commit_single_parent(store.root, state_commit),
        )
        parent_surfaces = {
            _key: _claim
            for _key, _claim in (parent_snapshot.get("surfaces") or {}).items()
            if isinstance(_claim, dict)
        }
    except Exception:  # noqa: BLE001 — no single readable parent: strict
        parent_surfaces = {}
    grandfather_row_counts: dict[str, int] = {
        _key: _claim["row_count"]
        for _key, _claim in parent_surfaces.items()
        if isinstance(_claim.get("row_count"), int)
    }
    cursors, carried_input = _carried_claim_cursors(
        store_root=store.root, state_commit=state_commit, claims=claims, parent_surfaces=parent_surfaces,
    )
    evidence_total += carried_input
    if evidence_total > _MAX_EVIDENCE_INPUT_BYTES:
        raise RuntimeError("state_commit_evidence_budget_exceeded")

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
        cursor = cursors.get(key)
        if surface.state_class == "ledger":
            try:
                summary = verify_jsonl_chunks(
                    chunks,
                    source=f"{state_commit}:{git_path}",
                    expected_size=size,
                    max_line_bytes=_MAX_SNAPSHOT_LEDGER_LINE_BYTES,
                    # A carried cursor caps the rows it consumes itself.
                    max_rows=(
                        _MAX_EVIDENCE_LEDGER_ROWS
                        if consumed and cursor is None
                        else _MAX_SNAPSHOT_LEDGER_ROWS
                    ),
                    grandfather_line_prefixes=grandfather_row_counts.get(key, 0),
                    expected_surface=surface_name,
                    expected_surface_instance=claim["path"],
                    on_row=(
                        cursor.on_row
                        if cursor is not None
                        else (lambda row, name=segment_family(surface_name): accumulator.consume(
                            name,
                            row,
                        ))
                        if consumed
                        else None
                    ),
                    on_row_position=cursor.on_position if cursor is not None else None,
                )
            except LedgerIntegrityError as exc:
                if (
                    surface_name in _LEGACY_KG_SURFACES
                    and "reason=ledger_hash_missing" in str(exc)
                ):
                    raise _LegacyKgCanonicalMigrationRequired(
                        f"{_LEGACY_KG_MIGRATION_BLOCKER}:{surface_name}",
                    ) from exc
                raise
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
            if cursor is not None and cursor.complete:
                accumulator.merge_carried(cursor.tally.carried_state(key), key)
            elif cursor is not None:
                accumulator.rebuilding.add(cursor.family)
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
    accumulator.evidence_input_bytes = evidence_total
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
        self.promoted_fingerprints: set[str] = set()
        self.autonomy_state = AutonomyStateAccumulator()
        self.acceptance_event_counts: Counter[str] = Counter()
        self.acceptance_unlock_counts: Counter[str] = Counter()
        # ARIA-HIGH-223 — the fields the unlock rule reads, per row, so the
        # streamed verdict is `verdict_from_rows` itself rather than a copy.
        self.acceptance_rows: list[dict[str, Any]] = []
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
        # What the verifier consumed against _MAX_EVIDENCE_INPUT_BYTES.
        self.evidence_input_bytes = 0
        # ARIA-HIGH-286 — carried families with a claim whose evidence this
        # publish's slice could not reach, so none of that claim is counted.
        self.rebuilding: set[str] = set()

    def consume(self, surface: str, row: Mapping[str, Any]) -> None:
        # A segment's opening row is chain structure, never evidence.
        if row.get("row_type") == SEGMENT_OPENED_ROW_TYPE:
            return
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

    def carried_state(self, key: str) -> dict[str, Any]:
        """This projection as an evidence checkpoint carries it (ARIA-HIGH-278).

        Only order-free state is carried. Rows that reached any other field
        (a proof witness, a fingerprint set, acceptance rows) refuse by name,
        so a fold change can never make a summary silently drop evidence.
        """
        if (
            self.promoted_fingerprints or self.acceptance_event_counts or self.acceptance_rows
            or self.distinct_target_budget_exceeded or self.global_distinct_targets
            or self.global_distinct_target_budget_exceeded or any(self.distinct_targets.values())
            or any(by_sha for contracts in self.native_targets.values() for by_sha in contracts.values())
        ):
            raise RuntimeError(f"state_commit_evidence_checkpoint_unmergeable:{key}")

        def nonzero(counter: Mapping[str, int]) -> dict[str, int]:
            return {name: value for name, value in sorted(counter.items()) if value}

        return {
            "ordinal": self.ordinal,
            "surface_counts": nonzero(self.surface_counts),
            "metrics": nonzero(self.metrics),
            "acceptance_unlock_counts": nonzero(self.acceptance_unlock_counts),
            "count_rejected": sorted(self.count_rejected),
            "native_counts": {name: nonzero(c) for name, c in sorted(self.native_counts.items()) if nonzero(c)},
            "native_blockers": {name: sorted(b) for name, b in sorted(self.native_blockers.items()) if b},
            "autonomy_state": asdict(self.autonomy_state),
        }

    def merge_carried(self, state: Mapping[str, Any], key: str) -> None:
        """Add a claim's carried evidence exactly as consuming its rows would:
        each field is a sum or a union, and the autonomy-state fold has one
        claim, so it is set, never combined."""
        from .autonomy_state import AutonomyStateAccumulator

        try:
            folded = AutonomyStateAccumulator(**state["autonomy_state"])
            if folded != AutonomyStateAccumulator():
                if self.autonomy_state != AutonomyStateAccumulator():
                    raise ValueError("autonomy_state_folded_twice")
                self.autonomy_state = folded
            if not set(state["count_rejected"]) <= set(CAPABILITY_SPECS):
                raise ValueError("count_rejected_capability_unknown")
            self.ordinal += state["ordinal"]
            self.surface_counts.update(state["surface_counts"])
            self.metrics.update(state["metrics"])
            self.acceptance_unlock_counts.update(state["acceptance_unlock_counts"])
            self.count_rejected.update(state["count_rejected"])
            for capability, counts in state["native_counts"].items():
                self.native_counts[capability].update(counts)
            for capability, blockers in state["native_blockers"].items():
                self.native_blockers[capability].update(blockers)
        except (AttributeError, KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f"state_commit_evidence_checkpoint_invalid:{key}") from exc

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
                self.acceptance_rows.append({
                    "event_type": row.get("event_type"),
                    "status": row.get("status"),
                    "recorded_at": row.get("recorded_at"),
                })
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
            # ARIA-HIGH-286 — a withheld claim leaves these counts short, so
            # the capability is named as rebuilding, never shown as proven.
            blockers.update(
                f"{EVIDENCE_REBUILD_BLOCKER}:{surface}" for surface in spec.count_surfaces if surface in self.rebuilding
            )
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
    from .autonomy_unlock import unlock_clock, verdict_from_rows

    policy, blocker = _unlock_policy_at_target(repo_root, target_sha)
    if policy is None:
        return ({"autonomy_unlock_policy_available": 0}, blocker)
    accepted_rows = [dict(row) for row in rows]
    counts: dict[str, int] = {"autonomy_unlock_policy_available": 1}
    now = unlock_clock()
    try:
        for lane in ("L1", "L2", "L3"):
            verdict = verdict_from_rows(accepted_rows, lane=lane, now=now, policy=policy)
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
    """The streamed ledger's unlock verdicts, by THE rule (ARIA-HIGH-223).

    This used to carry its own copy of the continuity rule — a literal 72h
    over every pair of success rows, forever, with no clock — so the
    evidence status disagreed with the merge gate in both directions: a late
    row the lane does not count re-locked it, and evidence that stopped
    accruing stayed valid. It now hands the projected rows to
    ``_unlock_verdict_counts``, i.e. ``autonomy_unlock.verdict_from_rows``
    at ``unlock_clock()``.
    """
    return _unlock_verdict_counts(
        tuple(accumulator.acceptance_rows),
        repo_root=repo_root,
        target_sha=target_sha,
    )


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
        expected_semantic = _EXPECTED_CLOSURE_POLICY_SEMANTICS.get(finding_id)
        expected_references = _EXPECTED_CLOSURE_POLICY_REFERENCES.get(finding_id)
        actual_semantic: _ClosurePolicySemantic = (
            task_id,
            owner_task,
            predicate,
            entry["closure_mode"],
            entry["closing_sha_rule"],
            tuple(historical),
        )
        if (
            expected_semantic is None
            or actual_semantic != expected_semantic
            or ("historical_fix_shas" in entry) != bool(expected_semantic[-1])
            or expected_references is None
            or (
                entry["review_anchor"],
                entry.get("narrative_anchor"),
                tuple(refs),
            )
            != expected_references
            or ("narrative_anchor" in entry) != (expected_references[1] is not None)
        ):
            return False
        if entry["closure_mode"] == "historical_main":
            if entry["closing_sha_rule"] != "last_historical_fix" or not historical:
                return False
        elif entry["closing_sha_rule"] != "task_commit":
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
        expected_operator = (
            {
                "capability": "enterprise_readiness",
                "blocker": "github_app_mode_a_unconfigured",
            }
            if finding_id == "ORPHAN-MEDIUM-789"
            else None
        )
        if entry.get("operator_prerequisite") != expected_operator:
            return False
    return (
        len(entries) == len(_EXPECTED_CLOSURE_SCOPE)
        and finding_ids == _EXPECTED_CLOSURE_SCOPE
        and frozenset(_EXPECTED_CLOSURE_POLICY_REFERENCES)
        == _EXPECTED_CLOSURE_SCOPE
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
    except _LegacyKgCanonicalMigrationRequired:
        return _legacy_kg_operator_blocked_status(
            target_sha=evaluated_target,
            repo_root=repository,
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
    "SEMANTIC_AUTHORITY_PATH",
    "derive_autonomy_evidence_status",
]
