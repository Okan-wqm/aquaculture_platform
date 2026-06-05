"""Ledger-bound enterprise readiness proof closure.

Enterprise readiness is derived from typed, append-only proof ledgers.
Callers may submit observations such as workflow conclusions, CAS lease
epochs, content hashes, or DLP finding counts; they may not submit a
boolean that asserts a proof passed.  The closure verifier re-reads the
hash-chained ledgers and derives the final verdict from row type,
PR/head/ref binding, freshness, and content-addressed evidence.
"""
from __future__ import annotations

import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from .ledger import append_jsonl, load_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


ProofType = Literal[
    "cas",
    "branch_protection",
    "workflow_run",
    "artifact",
    "rollback",
    "retention",
    "dlp",
    "token",
    "waiver",
]

READINESS_CLAIMS_RELATIVE = ("enterprise", "readiness-claims.jsonl")
REMOTE_CAS_PROOFS_RELATIVE = ("enterprise", "remote-cas-proofs.jsonl")
BRANCH_PROTECTION_PROOFS_RELATIVE = ("enterprise", "branch-protection-proofs.jsonl")
WORKFLOW_RUN_PROOFS_RELATIVE = ("enterprise", "workflow-run-proofs.jsonl")
ARTIFACT_PROOFS_RELATIVE = ("enterprise", "artifact-proofs.jsonl")
ROLLBACK_PROOFS_RELATIVE = ("enterprise", "rollback-proofs.jsonl")
RETENTION_PROOFS_RELATIVE = ("enterprise", "retention-proofs.jsonl")
DLP_PROOFS_RELATIVE = ("enterprise", "dlp-proofs.jsonl")
TOKEN_PROOFS_RELATIVE = ("enterprise", "token-proofs.jsonl")
WAIVERS_RELATIVE = ("enterprise", "waivers.jsonl")

REQUIRED_PROOF_TYPES: tuple[ProofType, ...] = (
    "cas",
    "branch_protection",
    "workflow_run",
    "artifact",
    "rollback",
    "retention",
    "dlp",
    "token",
)

REQUIRED_READINESS_FIELDS: tuple[str, ...] = (
    "readiness_claim_id",
    "pr_number",
    "target_ref",
    "head_sha",
)

_PROOF_PATHS: dict[ProofType, tuple[str, ...]] = {
    "cas": REMOTE_CAS_PROOFS_RELATIVE,
    "branch_protection": BRANCH_PROTECTION_PROOFS_RELATIVE,
    "workflow_run": WORKFLOW_RUN_PROOFS_RELATIVE,
    "artifact": ARTIFACT_PROOFS_RELATIVE,
    "rollback": ROLLBACK_PROOFS_RELATIVE,
    "retention": RETENTION_PROOFS_RELATIVE,
    "dlp": DLP_PROOFS_RELATIVE,
    "token": TOKEN_PROOFS_RELATIVE,
    "waiver": WAIVERS_RELATIVE,
}

_BOOLEAN_ASSERTION_KEYS: frozenset[str] = frozenset({
    "approved",
    "clean",
    "green",
    "ok",
    "pass",
    "passed",
    "proof",
    "protected",
    "ready",
    "success",
    "valid",
    "validated",
    "verified",
})

_READINESS_INLINE_PROOF_KEYS: frozenset[str] = frozenset({
    "remote_cas_proof",
    "branch_protection_proof",
    "workflow_run_proof",
    "artifact_proof",
    "rollback_proof",
    "retention_proof",
    "dlp_proof",
    "token_proof",
    "waiver_proof",
    "waiver_ledger",
})

_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class EnterpriseReadinessVerdict:
    valid: bool
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)
    proof_refs: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class PrReadinessVerdict:
    valid: bool
    pr_number: int | None
    target_ref: str | None
    head_sha: str | None
    lease_id: str | None
    epoch: int | None
    expires_at: str | None
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class _ReadinessContext:
    pr_number: int
    target_ref: str
    head_sha: str
    repository: str | None = None
    head_ref: str | None = None
    readiness_claim_id: str | None = None
    workflow_run_ids: tuple[str, ...] = ()
    artifact_hashes: dict[str, str] = field(default_factory=dict)
    waiver_ids: tuple[str, ...] = ()
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def readiness_claims_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*READINESS_CLAIMS_RELATIVE)


def readiness_proof_path(
    proof_type: ProofType,
    *,
    base_dir: str | Path | None = None,
) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*_PROOF_PATHS[_canonical_proof_type(proof_type)])


def evaluate_enterprise_readiness_claim(claim: dict[str, Any]) -> EnterpriseReadinessVerdict:
    reasons: list[str] = []
    failures: list[str] = []
    _validate_readiness_claim_shape(claim, reasons, failures)
    return _verdict(reasons, failures)


def assert_enterprise_readiness_claim(claim: dict[str, Any]) -> EnterpriseReadinessVerdict:
    verdict = evaluate_enterprise_readiness_claim(claim)
    if not verdict.valid:
        raise GovernanceError(
            "enterprise_readiness_claim_rejected: " + "; ".join(verdict.reasons)
        )
    return verdict


def evaluate_pr_readiness_claim(claim: dict[str, Any]) -> PrReadinessVerdict:
    reasons: list[str] = []
    failures: list[str] = []
    pr_number = claim.get("pr_number")
    if not isinstance(pr_number, int) or pr_number <= 0:
        reasons.append("pr_number_required")
        failures.append("pr_readiness_binding_required")
    proof = claim.get("remote_cas_proof") or claim.get("cas_proof") or claim
    if not isinstance(proof, dict):
        reasons.append("remote_cas_proof_required")
        failures.append("remote_cas_proof_required")
        return PrReadinessVerdict(
            valid=False,
            pr_number=pr_number if isinstance(pr_number, int) else None,
            target_ref=None,
            head_sha=None,
            lease_id=None,
            epoch=None,
            expires_at=None,
            failure_classes=tuple(sorted(set(failures))),
            reasons=tuple(reasons),
        )
    _reject_boolean_assertions(proof, reasons, failures, prefix="remote_cas")
    target_ref = _first_str(proof, "target_ref", "base_ref")
    head_sha = _first_str(proof, "head_sha", "observed_head_sha")
    lease_id = _first_str(proof, "lease_id", "cas_lease_id")
    epoch = proof.get("epoch", proof.get("lease_epoch"))
    expires_at = _first_str(proof, "expires_at", "lease_expires_at")
    if _first_str(proof, "state", "lease_state") != "fresh":
        reasons.append("remote_cas_proof_not_fresh")
        failures.append("remote_cas_proof_required")
    if not target_ref:
        reasons.append("remote_cas_target_ref_required")
        failures.append("remote_cas_binding_required")
    if not head_sha or not _is_full_git_sha(head_sha):
        reasons.append("remote_cas_head_sha_must_be_full_git_sha")
        failures.append("remote_cas_binding_required")
    if not lease_id:
        reasons.append("remote_cas_lease_id_required")
        failures.append("remote_cas_binding_required")
    if not isinstance(epoch, int) or epoch < 0:
        reasons.append("remote_cas_epoch_required")
        failures.append("remote_cas_binding_required")
    if not expires_at:
        reasons.append("remote_cas_expiry_required")
        failures.append("remote_cas_binding_required")
    elif not _expiry_is_future(expires_at, datetime.now(timezone.utc)):
        reasons.append("remote_cas_expiry_must_be_future")
        failures.append("remote_cas_binding_required")
    return PrReadinessVerdict(
        valid=not failures,
        pr_number=pr_number if isinstance(pr_number, int) else None,
        target_ref=target_ref,
        head_sha=head_sha,
        lease_id=lease_id,
        epoch=epoch if isinstance(epoch, int) else None,
        expires_at=expires_at,
        failure_classes=tuple(sorted(set(failures))),
        reasons=tuple(reasons),
    )


def record_enterprise_readiness_claim(
    claim: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    assert_enterprise_readiness_claim(claim)
    row = {
        "$schema": "aria/enterprise-readiness-claim/v1",
        "schema_version": 1,
        "claim_row_id": _new_id("erc"),
        "recorded_at": utc_now(),
        **dict(claim),
    }
    return append_jsonl(readiness_claims_path(base_dir), row)


def append_readiness_proof(
    proof_type: ProofType,
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    canonical = _canonical_proof_type(proof_type)
    row = _typed_proof_row(canonical, proof)
    reasons: list[str] = []
    failures: list[str] = []
    _validate_row_type(canonical, row, reasons, failures)
    if failures:
        raise GovernanceError(
            f"enterprise_readiness_{canonical}_proof_rejected: "
            + "; ".join(reasons)
        )
    return append_jsonl(readiness_proof_path(canonical, base_dir=base_dir), row)


def record_remote_cas_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("cas", proof, base_dir=base_dir)


def record_branch_protection_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("branch_protection", proof, base_dir=base_dir)


def record_workflow_run_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("workflow_run", proof, base_dir=base_dir)


def record_artifact_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("artifact", proof, base_dir=base_dir)


def record_rollback_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("rollback", proof, base_dir=base_dir)


def record_retention_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("retention", proof, base_dir=base_dir)


def record_dlp_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("dlp", proof, base_dir=base_dir)


def record_token_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("token", proof, base_dir=base_dir)


def record_waiver(
    waiver: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return append_readiness_proof("waiver", waiver, base_dir=base_dir)


def consume_waiver(
    waiver_id: str,
    *,
    readiness_claim_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not waiver_id.strip():
        raise GovernanceError("waiver_id_required")
    if not readiness_claim_id.strip():
        raise GovernanceError("readiness_claim_id_required")
    return append_readiness_proof(
        "waiver",
        {
            "waiver_id": waiver_id,
            "state": "consumed",
            "consumed_by_readiness_claim_id": readiness_claim_id,
        },
        base_dir=base_dir,
    )


def verify_enterprise_readiness(
    *,
    pr_number: int,
    adapter: Any | None = None,
    readiness_claim_id: str | None = None,
    base_dir: str | Path | None = None,
    repository: str | None = None,
    target_ref: str | None = None,
    head_ref: str | None = None,
    head_sha: str | None = None,
    workflow_run_ids: list[int | str] | tuple[int | str, ...] | None = None,
    artifact_hashes: dict[str, str] | list[str] | tuple[str, ...] | None = None,
    waiver_ids: list[str] | tuple[str, ...] | None = None,
    now: datetime | None = None,
) -> EnterpriseReadinessVerdict:
    root = ensure_tools_dir(base_dir)
    reasons: list[str] = []
    failures: list[str] = []
    claim: dict[str, Any] | None = None
    if readiness_claim_id:
        claim = _find_claim(root, readiness_claim_id)
        if claim is None:
            raise GovernanceError(f"enterprise_readiness_claim_not_found:{readiness_claim_id}")
        if claim.get("pr_number") != pr_number:
            raise GovernanceError(
                f"enterprise_readiness_pr_mismatch: "
                f"claim={claim.get('pr_number')!r} actual={pr_number!r}"
            )
        _validate_readiness_claim_shape(claim, reasons, failures)
        repository = repository or _first_str(claim, "repository", "repo_full_name")
        target_ref = target_ref or _first_str(claim, "target_ref", "base_ref")
        head_ref = head_ref or _first_str(claim, "head_ref", "source_ref")
        head_sha = head_sha or _first_str(claim, "head_sha")
        workflow_run_ids = workflow_run_ids or claim.get("workflow_run_ids")
        artifact_hashes = artifact_hashes or claim.get("artifact_hashes")
        waiver_ids = waiver_ids or claim.get("waiver_ids")
        _validate_claim_runtime_binding(
            claim,
            repository=repository,
            target_ref=target_ref,
            head_ref=head_ref,
            head_sha=head_sha,
            reasons=reasons,
            failures=failures,
        )

    live_pr = _load_live_pr(adapter, pr_number) if adapter is not None else {}
    if live_pr:
        repository = repository or _first_str(live_pr, "repository", "repo_full_name")
        live_head = _first_str(live_pr, "head_sha", "headRefOid", "head")
        live_target = _first_str(live_pr, "base_branch", "baseRefName", "base", "target_ref")
        live_head_ref = _first_str(live_pr, "head_ref", "headRefName", "source_ref")
        head_ref = head_ref or live_head_ref
        if head_sha and live_head and head_sha != live_head:
            reasons.append("readiness_live_head_sha_mismatch")
            failures.append("readiness_live_binding_required")
        head_sha = head_sha or live_head
        if target_ref and live_target and _normalize_ref(target_ref) != _normalize_ref(live_target):
            reasons.append("readiness_live_target_ref_mismatch")
            failures.append("readiness_live_binding_required")
        target_ref = target_ref or live_target
    elif adapter is not None:
        reasons.append("readiness_live_pr_missing")
        failures.append("readiness_live_binding_required")

    ctx = _build_context(
        pr_number=pr_number,
        repository=repository,
        target_ref=target_ref,
        head_ref=head_ref,
        head_sha=head_sha,
        readiness_claim_id=readiness_claim_id,
        workflow_run_ids=workflow_run_ids,
        artifact_hashes=artifact_hashes,
        waiver_ids=waiver_ids,
        now=now,
        reasons=reasons,
        failures=failures,
    )
    if ctx is None:
        return _verdict(reasons, failures)

    proof_refs: dict[str, str] = {}
    for proof_type in REQUIRED_PROOF_TYPES:
        _verify_required_proof(root, proof_type, ctx, reasons, failures, proof_refs)
    _verify_waiver_ledger(root, ctx, reasons, failures, proof_refs)
    return _verdict(reasons, failures, proof_refs)


def evaluate_enterprise_readiness(
    *,
    base_dir: str | Path | None = None,
    pr_number: int,
    repository: str | None = None,
    target_ref: str,
    head_sha: str,
    head_ref: str | None = None,
    readiness_claim_id: str | None = None,
    workflow_run_ids: list[int | str] | tuple[int | str, ...] | None = None,
    artifact_hashes: dict[str, str] | list[str] | tuple[str, ...] | None = None,
    waiver_ids: list[str] | tuple[str, ...] | None = None,
    now: datetime | None = None,
) -> EnterpriseReadinessVerdict:
    return verify_enterprise_readiness(
        pr_number=pr_number,
        base_dir=base_dir,
        repository=repository,
        target_ref=target_ref,
        head_ref=head_ref,
        head_sha=head_sha,
        readiness_claim_id=readiness_claim_id,
        workflow_run_ids=workflow_run_ids,
        artifact_hashes=artifact_hashes,
        waiver_ids=waiver_ids,
        now=now,
    )


def _typed_proof_row(proof_type: ProofType, proof: dict[str, Any]) -> dict[str, Any]:
    return {
        "$schema": f"aria/enterprise-readiness/{proof_type}/v1",
        "schema_version": 1,
        "proof_row_id": _new_id("erp"),
        "proof_type": proof_type,
        "recorded_at": utc_now(),
        **dict(proof),
    }


def _validate_readiness_claim_shape(
    claim: dict[str, Any],
    reasons: list[str],
    failures: list[str],
) -> None:
    for key in REQUIRED_READINESS_FIELDS:
        if claim.get(key) in (None, "", [], {}):
            reasons.append(f"missing_required_readiness_field:{key}")
            failures.append("readiness_claim_incomplete")
    if not isinstance(claim.get("pr_number"), int) or claim.get("pr_number") <= 0:
        reasons.append("readiness_claim_pr_number_invalid")
        failures.append("readiness_claim_incomplete")
    head_sha = _first_str(claim, "head_sha")
    if head_sha and not _is_full_git_sha(head_sha):
        reasons.append("readiness_claim_head_sha_must_be_full_git_sha")
        failures.append("readiness_claim_incomplete")
    for key in _READINESS_INLINE_PROOF_KEYS:
        if key in claim:
            reasons.append(f"readiness_claim_inline_proof_not_allowed:{key}")
            failures.append("readiness_claim_not_ledger_bound")
    _reject_boolean_assertions(claim, reasons, failures, prefix="readiness_claim")


def _validate_row_type(
    proof_type: ProofType,
    row: dict[str, Any],
    reasons: list[str],
    failures: list[str],
) -> None:
    if row.get("proof_type") != proof_type:
        reasons.append(f"{proof_type}_proof_type_mismatch")
        failures.append(f"{proof_type}_proof_malformed")
    _reject_boolean_assertions(row, reasons, failures, prefix=proof_type)
    _validate_common_binding(row, proof_type, reasons, failures)
    validator = {
        "cas": _validate_cas_fields,
        "branch_protection": _validate_branch_protection_fields,
        "workflow_run": _validate_workflow_run_fields,
        "artifact": _validate_artifact_fields,
        "rollback": _validate_rollback_fields,
        "retention": _validate_retention_fields,
        "dlp": _validate_dlp_fields,
        "token": _validate_token_fields,
        "waiver": _validate_waiver_fields,
    }[proof_type]
    validator(row, reasons, failures)


def _validate_common_binding(
    row: dict[str, Any],
    proof_type: ProofType,
    reasons: list[str],
    failures: list[str],
) -> None:
    if proof_type == "waiver":
        return
    if not isinstance(row.get("pr_number"), int) or row.get("pr_number") <= 0:
        reasons.append(f"{proof_type}_pr_number_required")
        failures.append(f"{proof_type}_proof_binding_required")
    if not _first_str(row, "target_ref", "base_ref"):
        reasons.append(f"{proof_type}_target_ref_required")
        failures.append(f"{proof_type}_proof_binding_required")
    head_sha = _first_str(row, "head_sha", "observed_head_sha")
    if not head_sha or not _is_full_git_sha(head_sha):
        reasons.append(f"{proof_type}_head_sha_must_be_full_git_sha")
        failures.append(f"{proof_type}_proof_binding_required")


def _validate_cas_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    if _first_str(row, "state", "lease_state") != "fresh":
        reasons.append("cas_proof_not_fresh")
        failures.append("cas_proof_required")
    if not _first_str(row, "lease_id", "cas_lease_id"):
        reasons.append("cas_lease_id_required")
        failures.append("cas_proof_required")
    epoch = row.get("epoch", row.get("lease_epoch"))
    if not isinstance(epoch, int) or epoch < 0:
        reasons.append("cas_epoch_required")
        failures.append("cas_proof_required")
    expires_at = _first_str(row, "expires_at", "lease_expires_at")
    if not expires_at:
        reasons.append("cas_expires_at_required")
        failures.append("cas_proof_required")
    elif not _parse_time(expires_at):
        reasons.append("cas_expires_at_invalid")
        failures.append("cas_proof_required")


def _validate_branch_protection_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    checks = row.get("required_status_checks", row.get("required_checks"))
    if not isinstance(checks, list) or not checks or not all(isinstance(item, str) and item.strip() for item in checks):
        reasons.append("branch_protection_required_status_checks_required")
        failures.append("branch_protection_required")
    review_count = row.get("required_approving_review_count", row.get("required_reviews"))
    if review_count is not None and (not isinstance(review_count, int) or review_count < 0):
        reasons.append("branch_protection_review_count_invalid")
        failures.append("branch_protection_required")
    _require_strong_hash(row, "snapshot_hash", reasons, failures, "branch_protection")
    _require_strong_hash(row, "source_ledger_hash", reasons, failures, "branch_protection")


def _validate_workflow_run_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    run_id = row.get("workflow_run_id", row.get("run_id"))
    if not _positive_intish(run_id):
        reasons.append("workflow_run_id_required")
        failures.append("workflow_run_proof_required")
    if _first_str(row, "status") != "completed":
        reasons.append("workflow_run_status_must_be_completed")
        failures.append("workflow_run_proof_required")
    if _first_str(row, "conclusion") != "success":
        reasons.append("workflow_run_conclusion_must_be_success")
        failures.append("workflow_run_proof_required")
    _require_strong_hash(row, "source_ledger_hash", reasons, failures, "workflow_run")


def _validate_artifact_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    if not _first_str(row, "artifact_path", "path", "artifact_name"):
        reasons.append("artifact_path_required")
        failures.append("artifact_hashes_untrusted")
    _require_strong_hash(row, "artifact_hash", reasons, failures, "artifact")
    _require_strong_hash(row, "source_ledger_hash", reasons, failures, "artifact")


def _validate_rollback_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    if not _first_str(row, "rollback_plan_ref", "rollback_proof_id", "rollback_id"):
        reasons.append("rollback_plan_ref_required")
        failures.append("rollback_proof_required")
    if _first_str(row, "status") not in {"available", "exercised", "ready", "verified"}:
        reasons.append("rollback_status_not_ready")
        failures.append("rollback_proof_required")
    _require_strong_hash(row, "artifact_hash", reasons, failures, "rollback")
    _require_strong_hash(row, "source_ledger_hash", reasons, failures, "rollback")


def _validate_retention_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    days = row.get("retention_days")
    if not isinstance(days, int) or days < 30:
        reasons.append("retention_days_minimum_not_met")
        failures.append("retention_proof_required")
    if _first_str(row, "status") not in {"active", "configured", "retained"}:
        reasons.append("retention_status_not_active")
        failures.append("retention_proof_required")
    retained_until = _first_str(row, "retained_until", "expires_at")
    if retained_until and not _parse_time(retained_until):
        reasons.append("retention_expiry_invalid")
        failures.append("retention_proof_required")
    _require_strong_hash(row, "artifact_hash", reasons, failures, "retention")
    _require_strong_hash(row, "source_ledger_hash", reasons, failures, "retention")


def _validate_dlp_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    if not _first_str(row, "scanner", "scanner_id"):
        reasons.append("dlp_scanner_required")
        failures.append("dlp_proof_required")
    findings = row.get("findings_count", row.get("high_risk_findings"))
    if not isinstance(findings, int) or findings != 0:
        reasons.append("dlp_findings_must_be_zero")
        failures.append("dlp_proof_required")
    _require_strong_hash(row, "artifact_hash", reasons, failures, "dlp")
    _require_strong_hash(row, "source_ledger_hash", reasons, failures, "dlp")


def _validate_token_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    if _contains_raw_token(row):
        reasons.append("token_proof_contains_raw_token_material")
        failures.append("token_proof_required")
    if not _first_str(row, "token_subject", "subject"):
        reasons.append("token_subject_required")
        failures.append("token_proof_required")
    scopes = row.get("scopes")
    if not isinstance(scopes, list) or not scopes or not all(isinstance(item, str) and item.strip() for item in scopes):
        reasons.append("token_scopes_required")
        failures.append("token_proof_required")
    elif any(_scope_is_privileged(scope) for scope in scopes):
        reasons.append("token_scopes_must_be_read_only")
        failures.append("token_proof_required")
    expires_at = _first_str(row, "expires_at", "lease_expires_at")
    if not expires_at:
        reasons.append("token_expires_at_required")
        failures.append("token_proof_required")
    elif not _parse_time(expires_at):
        reasons.append("token_expires_at_invalid")
        failures.append("token_proof_required")
    if not (
        _is_sha256_digest(_first_str(row, "token_hash"))
        or _is_sha256_digest(_first_str(row, "source_ledger_hash"))
    ):
        reasons.append("token_hash_or_source_ledger_hash_required")
        failures.append("token_proof_required")


def _validate_waiver_fields(row: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    if not _first_str(row, "waiver_id"):
        reasons.append("waiver_id_required")
        failures.append("waiver_ledger_not_green")
    state = _first_str(row, "state") or "open"
    if state not in {"open", "consumed", "closed"}:
        reasons.append("waiver_state_invalid")
        failures.append("waiver_ledger_not_green")
    expires_at = _first_str(row, "expires_at")
    if state == "open" and not expires_at:
        reasons.append("open_waiver_expires_at_required")
        failures.append("waiver_ledger_not_green")
    elif expires_at and not _parse_time(expires_at):
        reasons.append("waiver_expires_at_invalid")
        failures.append("waiver_ledger_not_green")


def _verify_required_proof(
    root: Path,
    proof_type: ProofType,
    ctx: _ReadinessContext,
    reasons: list[str],
    failures: list[str],
    proof_refs: dict[str, str],
) -> None:
    rows = _load_proof_rows(root, proof_type)
    matches = [row for row in rows if _row_matches_context(row, ctx)]
    if proof_type == "workflow_run" and ctx.workflow_run_ids:
        for run_id in ctx.workflow_run_ids:
            row = next((item for item in reversed(matches) if str(item.get("workflow_run_id", item.get("run_id", ""))) == run_id), None)
            if row is None:
                _append_missing_or_mismatch_reason(rows, proof_type, ctx, reasons, failures, suffix=f":{run_id}")
                continue
            _verify_matched_row(proof_type, row, ctx, reasons, failures, proof_refs)
        return
    if proof_type == "artifact" and ctx.artifact_hashes:
        for artifact_key, artifact_hash in ctx.artifact_hashes.items():
            row = next(
                (
                    item for item in reversed(matches)
                    if str(item.get("artifact_hash") or item.get("sha256") or "") == artifact_hash
                    and (
                        artifact_key == artifact_hash
                        or str(item.get("artifact_path") or item.get("path") or item.get("artifact_name") or "") == artifact_key
                    )
                ),
                None,
            )
            if row is None:
                _append_missing_or_mismatch_reason(rows, proof_type, ctx, reasons, failures, suffix=f":{artifact_key}")
                continue
            _verify_matched_row(proof_type, row, ctx, reasons, failures, proof_refs)
        return
    row = matches[-1] if matches else None
    if row is None:
        _append_missing_or_mismatch_reason(rows, proof_type, ctx, reasons, failures)
        return
    _verify_matched_row(proof_type, row, ctx, reasons, failures, proof_refs)


def _verify_matched_row(
    proof_type: ProofType,
    row: dict[str, Any],
    ctx: _ReadinessContext,
    reasons: list[str],
    failures: list[str],
    proof_refs: dict[str, str],
) -> None:
    before = len(failures)
    _validate_row_type(proof_type, row, reasons, failures)
    if proof_type == "cas":
        expires_at = _first_str(row, "expires_at", "lease_expires_at")
        if expires_at and not _expiry_is_future(expires_at, ctx.now):
            reasons.append("cas_proof_stale")
            failures.append("cas_proof_required")
    if proof_type == "token":
        expires_at = _first_str(row, "expires_at", "lease_expires_at")
        if expires_at and not _expiry_is_future(expires_at, ctx.now):
            reasons.append("token_lease_expired")
            failures.append("token_proof_required")
    if proof_type == "waiver":
        expires_at = _first_str(row, "expires_at")
        if _first_str(row, "state") == "open" and expires_at and not _expiry_is_future(expires_at, ctx.now):
            reasons.append("waiver_ledger_has_open_expired_rows")
            failures.append("waiver_ledger_not_green")
    if len(failures) == before:
        proof_refs[proof_type] = str(row.get("ledger_hash") or "")


def _verify_waiver_ledger(
    root: Path,
    ctx: _ReadinessContext,
    reasons: list[str],
    failures: list[str],
    proof_refs: dict[str, str],
) -> None:
    rows = _load_proof_rows(root, "waiver")
    for row in rows:
        if not _waiver_relevant(row, ctx):
            continue
        _verify_matched_row("waiver", row, ctx, reasons, failures, proof_refs)
    for waiver_id in ctx.waiver_ids:
        row = next((item for item in reversed(rows) if str(item.get("waiver_id") or "") == waiver_id and _waiver_relevant(item, ctx)), None)
        if row is None:
            reasons.append(f"waiver_id_not_ledger_bound:{waiver_id}")
            failures.append("waiver_ledger_not_green")


def _append_missing_or_mismatch_reason(
    rows: list[dict[str, Any]],
    proof_type: ProofType,
    ctx: _ReadinessContext,
    reasons: list[str],
    failures: list[str],
    *,
    suffix: str = "",
) -> None:
    if any(_row_same_pr_or_claim(row, ctx) for row in rows):
        reasons.append(f"{proof_type}_proof_wrong_pr_head_or_ref{suffix}")
    else:
        reasons.append(f"{proof_type}_proof_missing{suffix}")
    failures.append(_failure_class_for(proof_type))


def _failure_class_for(proof_type: ProofType) -> str:
    return {
        "artifact": "artifact_hashes_untrusted",
        "branch_protection": "branch_protection_required",
        "cas": "cas_proof_required",
        "dlp": "dlp_proof_required",
        "retention": "retention_proof_required",
        "rollback": "rollback_proof_required",
        "token": "token_proof_required",
        "waiver": "waiver_ledger_not_green",
        "workflow_run": "workflow_run_proof_required",
    }[proof_type]


def _load_proof_rows(root: Path, proof_type: ProofType) -> list[dict[str, Any]]:
    return load_jsonl(root.joinpath(*_PROOF_PATHS[proof_type]), verify=True)


def _find_claim(root: Path, readiness_claim_id: str) -> dict[str, Any] | None:
    rows = load_jsonl(root.joinpath(*READINESS_CLAIMS_RELATIVE), verify=True)
    return next(
        (
            row for row in reversed(rows)
            if str(row.get("readiness_claim_id") or row.get("claim_id") or "") == readiness_claim_id
        ),
        None,
    )


def _build_context(
    *,
    pr_number: int,
    repository: str | None,
    target_ref: str | None,
    head_ref: str | None,
    head_sha: str | None,
    readiness_claim_id: str | None,
    workflow_run_ids: list[int | str] | tuple[int | str, ...] | Any,
    artifact_hashes: dict[str, str] | list[str] | tuple[str, ...] | Any,
    waiver_ids: list[str] | tuple[str, ...] | Any,
    now: datetime | None,
    reasons: list[str],
    failures: list[str],
) -> _ReadinessContext | None:
    context_failed = False
    if not isinstance(pr_number, int) or pr_number <= 0:
        reasons.append("readiness_pr_number_required")
        failures.append("readiness_context_invalid")
        context_failed = True
    if not target_ref:
        reasons.append("readiness_target_ref_required")
        failures.append("readiness_context_invalid")
        context_failed = True
    if not head_sha or not _is_full_git_sha(head_sha):
        reasons.append("readiness_head_sha_must_be_full_git_sha")
        failures.append("readiness_context_invalid")
        context_failed = True
    if context_failed:
        return None
    return _ReadinessContext(
        pr_number=pr_number,
        repository=repository,
        target_ref=str(target_ref),
        head_ref=head_ref,
        head_sha=str(head_sha),
        readiness_claim_id=readiness_claim_id,
        workflow_run_ids=_normalise_id_tuple(workflow_run_ids),
        artifact_hashes=_normalise_artifact_hashes(artifact_hashes),
        waiver_ids=_normalise_id_tuple(waiver_ids),
        now=(now or datetime.now(timezone.utc)).astimezone(timezone.utc),
    )


def _validate_claim_runtime_binding(
    claim: dict[str, Any],
    *,
    repository: str | None,
    target_ref: str | None,
    head_ref: str | None,
    head_sha: str | None,
    reasons: list[str],
    failures: list[str],
) -> None:
    claim_repository = _first_str(claim, "repository", "repo_full_name")
    if repository and claim_repository and claim_repository != repository:
        reasons.append("readiness_claim_repository_mismatch")
        failures.append("readiness_claim_runtime_binding_mismatch")
    claim_target = _first_str(claim, "target_ref", "base_ref")
    if target_ref and claim_target and _normalize_ref(claim_target) != _normalize_ref(target_ref):
        reasons.append("readiness_claim_target_ref_mismatch")
        failures.append("readiness_claim_runtime_binding_mismatch")
    claim_head_ref = _first_str(claim, "head_ref", "source_ref")
    if head_ref and claim_head_ref and _normalize_ref(claim_head_ref) != _normalize_ref(head_ref):
        reasons.append("readiness_claim_head_ref_mismatch")
        failures.append("readiness_claim_runtime_binding_mismatch")
    claim_head_sha = _first_str(claim, "head_sha")
    if head_sha and claim_head_sha and claim_head_sha != head_sha:
        reasons.append("readiness_claim_head_sha_mismatch")
        failures.append("readiness_claim_runtime_binding_mismatch")


def _row_matches_context(row: dict[str, Any], ctx: _ReadinessContext) -> bool:
    if int(row.get("pr_number") or 0) != ctx.pr_number:
        return False
    if ctx.readiness_claim_id and str(row.get("readiness_claim_id") or "") != ctx.readiness_claim_id:
        return False
    if ctx.repository and _first_str(row, "repository", "repo_full_name") and _first_str(row, "repository", "repo_full_name") != ctx.repository:
        return False
    row_head = _first_str(row, "head_sha", "observed_head_sha")
    if row_head != ctx.head_sha:
        return False
    row_target = _first_str(row, "target_ref", "base_ref")
    if _normalize_ref(row_target) != _normalize_ref(ctx.target_ref):
        return False
    row_head_ref = _first_str(row, "head_ref", "source_ref")
    if ctx.head_ref and row_head_ref and _normalize_ref(row_head_ref) != _normalize_ref(ctx.head_ref):
        return False
    return True


def _row_same_pr_or_claim(row: dict[str, Any], ctx: _ReadinessContext) -> bool:
    if ctx.readiness_claim_id and str(row.get("readiness_claim_id") or "") == ctx.readiness_claim_id:
        return True
    if int(row.get("pr_number") or 0) == ctx.pr_number:
        return True
    return False


def _waiver_relevant(row: dict[str, Any], ctx: _ReadinessContext) -> bool:
    waiver_id = str(row.get("waiver_id") or "")
    if waiver_id and waiver_id in ctx.waiver_ids:
        return True
    row_claim = str(row.get("readiness_claim_id") or row.get("consumed_by_readiness_claim_id") or "")
    if ctx.readiness_claim_id and row_claim == ctx.readiness_claim_id:
        return True
    if int(row.get("pr_number") or 0) == ctx.pr_number:
        return True
    return not row.get("pr_number") and not row_claim


def _load_live_pr(adapter: Any, pr_number: int) -> dict[str, Any]:
    if not hasattr(adapter, "get_pr"):
        raise GovernanceError("enterprise_readiness_adapter_get_pr_required")
    live_pr = adapter.get_pr(pr_number)
    return live_pr if isinstance(live_pr, dict) else {}


def _require_strong_hash(
    row: dict[str, Any],
    key: str,
    reasons: list[str],
    failures: list[str],
    prefix: str,
) -> None:
    aliases = {
        "artifact_hash": ("artifact_hash", "sha256"),
        "snapshot_hash": ("snapshot_hash", "snapshot_sha256", "protection_snapshot_hash"),
    }
    value = _first_str(row, *aliases.get(key, (key,)))
    if not _is_sha256_digest(value):
        reasons.append(f"{prefix}_{key}_must_be_sha256")
        failures.append(_failure_class_for(_failure_type(prefix)))


def _failure_type(prefix: str) -> ProofType:
    return "branch_protection" if prefix == "branch_protection" else prefix  # type: ignore[return-value]


def _reject_boolean_assertions(
    value: Any,
    reasons: list[str],
    failures: list[str],
    *,
    prefix: str,
    path: str = "",
) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            dotted = f"{path}.{key}" if path else str(key)
            if key in _BOOLEAN_ASSERTION_KEYS and isinstance(item, bool):
                reasons.append(f"{prefix}_caller_asserted_boolean_proof:{dotted}")
                failures.append("caller_asserted_boolean_proof")
            else:
                _reject_boolean_assertions(item, reasons, failures, prefix=prefix, path=dotted)
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            _reject_boolean_assertions(item, reasons, failures, prefix=prefix, path=f"{path}[{idx}]")


def _contains_raw_token(value: Any) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in {"token", "gh_token", "access_token", "secret", "password"}:
                return True
            if _contains_raw_token(item):
                return True
    elif isinstance(value, list):
        return any(_contains_raw_token(item) for item in value)
    return False


def _scope_is_privileged(scope: str) -> bool:
    lowered = scope.strip().lower()
    if lowered in {"repo", "*", "admin", "admin:repo_hook"}:
        return True
    return any(token in lowered for token in (":write", "write:", "admin", "delete"))


def _canonical_proof_type(proof_type: str) -> ProofType:
    aliases = {
        "remote_cas": "cas",
        "branch": "branch_protection",
        "branch_protection_proof": "branch_protection",
        "workflow": "workflow_run",
    }
    canonical = aliases.get(proof_type, proof_type)
    if canonical not in _PROOF_PATHS:
        raise GovernanceError(f"unknown_enterprise_readiness_proof_type:{proof_type}")
    return canonical  # type: ignore[return-value]


def _first_str(row: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _positive_intish(value: Any) -> bool:
    if isinstance(value, int):
        return value > 0
    if isinstance(value, str) and value.isdigit():
        return int(value) > 0
    return False


def _normalise_id_tuple(values: Any) -> tuple[str, ...]:
    if not isinstance(values, (list, tuple)):
        return ()
    return tuple(str(value) for value in values if str(value).strip())


def _normalise_artifact_hashes(values: Any) -> dict[str, str]:
    if isinstance(values, dict):
        return {str(key): str(value) for key, value in values.items()}
    if isinstance(values, (list, tuple)):
        return {str(value): str(value) for value in values}
    return {}


def _normalize_ref(ref: str | None) -> str:
    value = (ref or "").strip()
    if not value:
        return ""
    if value.startswith("refs/"):
        return value
    return f"refs/heads/{value}"


def _is_full_git_sha(value: str) -> bool:
    return bool(_GIT_SHA_RE.fullmatch(value))


def _is_sha256_digest(value: str) -> bool:
    return bool(_SHA256_RE.fullmatch(value))


def _parse_time(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _expiry_is_future(value: str, now: datetime) -> bool:
    parsed = _parse_time(value)
    if parsed is None:
        return False
    return parsed > now.astimezone(timezone.utc)


def _new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(8)}"


def _verdict(
    reasons: list[str],
    failures: list[str],
    proof_refs: dict[str, str] | None = None,
) -> EnterpriseReadinessVerdict:
    return EnterpriseReadinessVerdict(
        valid=not failures,
        failure_classes=tuple(sorted(set(failures))),
        reasons=tuple(reasons),
        proof_refs=dict(proof_refs or {}),
    )


__all__ = [
    "ARTIFACT_PROOFS_RELATIVE",
    "BRANCH_PROTECTION_PROOFS_RELATIVE",
    "DLP_PROOFS_RELATIVE",
    "EnterpriseReadinessVerdict",
    "PrReadinessVerdict",
    "ProofType",
    "READINESS_CLAIMS_RELATIVE",
    "REMOTE_CAS_PROOFS_RELATIVE",
    "REQUIRED_PROOF_TYPES",
    "REQUIRED_READINESS_FIELDS",
    "RETENTION_PROOFS_RELATIVE",
    "ROLLBACK_PROOFS_RELATIVE",
    "TOKEN_PROOFS_RELATIVE",
    "WAIVERS_RELATIVE",
    "WORKFLOW_RUN_PROOFS_RELATIVE",
    "append_readiness_proof",
    "assert_enterprise_readiness_claim",
    "consume_waiver",
    "evaluate_enterprise_readiness",
    "evaluate_enterprise_readiness_claim",
    "evaluate_pr_readiness_claim",
    "readiness_claims_path",
    "readiness_proof_path",
    "record_artifact_proof",
    "record_branch_protection_proof",
    "record_dlp_proof",
    "record_enterprise_readiness_claim",
    "record_remote_cas_proof",
    "record_retention_proof",
    "record_rollback_proof",
    "record_token_proof",
    "record_waiver",
    "record_workflow_run_proof",
    "verify_enterprise_readiness",
]
