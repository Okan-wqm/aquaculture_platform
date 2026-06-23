from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .ledger_refs import find_row_by_source_ledger_ref, ledger_ref_for_row
from .runtime_artifacts import ArtifactRefV2
from .tool_registry import GovernanceError
from .tool_registry import ensure_tools_dir, utc_now


READINESS_SCHEMA = "aria/enterprise-readiness-claim/v2"
BRANCH_PROTECTION_SCHEMA = "aria/branch-protection-proof/v3"
REQUIRED_MERGE_STATUS_CHECKS: tuple[str, ...] = (
    "sens-enterprise-summary",
    "merge-gate",
    "aria-merge-authority",
)
REQUIRED_DLP_SCANNED_SURFACES: tuple[str, ...] = (
    "diff",
    "prompt",
    "transcript",
    "logs",
    "artifacts",
)
REQUIRED_READINESS_FIELDS: tuple[str, ...] = (
    "$schema",
    "schema_version",
    "claim_row_id",
    "readiness_claim_id",
    "repo",
    "pr_number",
    "target_ref",
    "head_ref",
    "head_sha",
    "workflow_run_ids",
    "artifact_refs",
    "remote_cas_proof",
    "rollback_proof",
    "retention_proof",
    "waiver_ledger",
    "branch_protection_proof",
    "dlp_proof",
    "token_proof",
)
SOURCE_LEDGER_REF_FIELDS: tuple[str, ...] = (
    "surface",
    "ledger_path",
    "row_id",
    "row_type",
    "row_hash",
    "schema_version",
)
DLP_TOKEN_BINDING_FIELDS: tuple[str, ...] = (
    "repo",
    "pr_number",
    "target_ref",
    "head_ref",
    "head_sha",
    "readiness_claim_id",
    "workflow_run_id",
    "artifact_id",
    "artifact_sha256",
    "workflow_hash",
    "contract_hash",
    "network_policy",
    "runtime_write_paths",
)
READINESS_ARTIFACT_SOURCE_SURFACES: frozenset[str] = frozenset({
    "github_actions_artifact",
})


@dataclass(frozen=True)
class EnterpriseReadinessVerdict:
    valid: bool
    failure_classes: tuple[str, ...] = field(default_factory=tuple)
    reasons: tuple[str, ...] = field(default_factory=tuple)


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


def evaluate_enterprise_readiness_claim(claim: dict[str, Any]) -> EnterpriseReadinessVerdict:
    reasons: list[str] = []
    failures: list[str] = []

    for field_name in REQUIRED_READINESS_FIELDS:
        if field_name not in claim or claim.get(field_name) in (None, "", [], {}):
            reasons.append(f"missing_required_readiness_field:{field_name}")
            failures.append("readiness_claim_incomplete")
    if claim.get("$schema") != READINESS_SCHEMA:
        reasons.append("readiness_claim_schema_must_be_v2")
        failures.append("readiness_claim_incomplete")
    if not isinstance(claim.get("schema_version"), int) or claim.get("schema_version") < 2:
        reasons.append("readiness_claim_schema_version_must_be_2")
        failures.append("readiness_claim_incomplete")
    _require_nonempty_str(claim, "claim_row_id", reasons, failures, "readiness_claim_incomplete")
    _require_nonempty_str(claim, "readiness_claim_id", reasons, failures, "readiness_claim_incomplete")
    _require_nonempty_str(claim, "repo", reasons, failures, "readiness_binding_required")
    _require_nonempty_str(claim, "target_ref", reasons, failures, "readiness_binding_required")
    _require_nonempty_str(claim, "head_ref", reasons, failures, "readiness_binding_required")
    if not isinstance(claim.get("pr_number"), int) or claim.get("pr_number") <= 0:
        reasons.append("readiness_pr_number_required")
        failures.append("readiness_binding_required")
    if not isinstance(claim.get("head_sha"), str) or not _is_full_sha(str(claim.get("head_sha"))):
        reasons.append("readiness_head_sha_must_be_full_git_sha")
        failures.append("readiness_binding_required")

    workflow_run_ids = claim.get("workflow_run_ids")
    if not isinstance(workflow_run_ids, list) or not workflow_run_ids:
        reasons.append("workflow_run_ids_must_be_nonempty_list")
        failures.append("workflow_run_ids_untrusted")
    elif any(not _workflow_run_id_valid(item) for item in workflow_run_ids):
        reasons.append("workflow_run_ids_invalid")
        failures.append("workflow_run_ids_untrusted")

    artifact_refs = claim.get("artifact_refs")
    if not isinstance(artifact_refs, list) or not artifact_refs:
        reasons.append("artifact_refs_must_be_nonempty_list")
        failures.append("artifact_refs_untrusted")
    else:
        workflow_ids = {str(item) for item in workflow_run_ids or []}
        for index, ref in enumerate(artifact_refs):
            if not isinstance(ref, dict):
                reasons.append(f"artifact_ref_invalid:{index}")
                failures.append("artifact_refs_untrusted")
                continue
            try:
                artifact = ArtifactRefV2.from_dict(ref)
            except GovernanceError as exc:
                reasons.append(f"artifact_ref_v2_invalid:{index}:{exc}")
                failures.append("artifact_refs_untrusted")
                continue
            if artifact.source_surface not in READINESS_ARTIFACT_SOURCE_SURFACES:
                reasons.append(f"artifact_ref_untrusted_source_surface:{index}:{artifact.source_surface}")
                failures.append("artifact_refs_untrusted")
            if artifact.produced_by_workflow_run_id not in workflow_ids:
                reasons.append(f"artifact_ref_workflow_run_unbound:{index}:{artifact.produced_by_workflow_run_id}")
                failures.append("artifact_refs_untrusted")

    _evaluate_remote_cas(claim, reasons, failures)
    _evaluate_branch_protection(claim, reasons, failures)
    _evaluate_retention_or_rollback(claim, "rollback_proof", "rollback_proof_id", reasons, failures)
    _evaluate_retention_or_rollback(claim, "retention_proof", "retention_proof_id", reasons, failures)
    _evaluate_waiver_ledger(claim, reasons, failures)
    _evaluate_dlp_token(claim, "dlp_proof", reasons, failures)
    _evaluate_dlp_token(claim, "token_proof", reasons, failures)

    return EnterpriseReadinessVerdict(
        valid=not failures,
        failure_classes=tuple(sorted(set(failures))),
        reasons=tuple(reasons),
    )


def evaluate_pr_readiness_claim(claim: dict[str, Any]) -> PrReadinessVerdict:
    _ = claim
    return PrReadinessVerdict(
        valid=False,
        pr_number=None,
        target_ref=None,
        head_sha=None,
        lease_id=None,
        epoch=None,
        expires_at=None,
        failure_classes=("legacy_caller_asserted_readiness_rejected",),
        reasons=("evaluate_pr_readiness_claim_removed_use_verify_enterprise_readiness",),
    )


def assert_enterprise_readiness_claim(claim: dict[str, Any]) -> EnterpriseReadinessVerdict:
    verdict = evaluate_enterprise_readiness_claim(claim)
    if not verdict.valid:
        raise GovernanceError(
            "enterprise_readiness_claim_rejected: " + "; ".join(verdict.reasons)
        )
    return verdict


def record_remote_cas_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    _require_source_ref_on_row(root, proof, "remote_cas_proof")
    row = {"schema_version": 1, "recorded_at": utc_now(), **dict(proof)}
    return append_declared_jsonl(
        root / "enterprise" / "remote-cas-proofs.jsonl",
        row,
        expected_surface="enterprise_remote_cas_proofs",
    )


def _record_enterprise_proof(
    surface: str,
    relative_path: str,
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    _require_source_ref_on_row(root, proof, surface)
    row = {"schema_version": 1, "recorded_at": utc_now(), **dict(proof)}
    return append_declared_jsonl(
        root / relative_path,
        row,
        expected_surface=surface,
    )


def record_branch_protection_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return _record_enterprise_proof(
        "enterprise_branch_protection_proofs",
        "enterprise/branch-protection-proofs.jsonl",
        proof,
        base_dir=base_dir,
    )


def record_rollback_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return _record_enterprise_proof(
        "enterprise_rollback_proofs",
        "enterprise/rollback-proofs.jsonl",
        proof,
        base_dir=base_dir,
    )


def record_workflow_run_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return _record_enterprise_proof(
        "enterprise_workflow_run_proofs",
        "enterprise/workflow-run-proofs.jsonl",
        proof,
        base_dir=base_dir,
    )


def record_artifact_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return _record_enterprise_proof(
        "enterprise_artifact_proofs",
        "enterprise/artifact-proofs.jsonl",
        proof,
        base_dir=base_dir,
    )


def record_retention_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return _record_enterprise_proof(
        "enterprise_retention_proofs",
        "enterprise/retention-proofs.jsonl",
        proof,
        base_dir=base_dir,
    )


def record_dlp_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return _record_enterprise_proof(
        "enterprise_dlp_proofs",
        "enterprise/dlp-proofs.jsonl",
        proof,
        base_dir=base_dir,
    )


def record_token_proof(
    proof: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    return _record_enterprise_proof(
        "enterprise_token_proofs",
        "enterprise/token-proofs.jsonl",
        proof,
        base_dir=base_dir,
    )


def record_waiver(
    waiver: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    _require_source_ref_on_row(root, waiver, "enterprise_waivers")
    state = str(waiver.get("state") or "open")
    waiver_id = str(waiver.get("waiver_id") or "").strip()
    row_type = "waiver_consumed" if state == "consumed" else "waiver_open"
    row_id = (
        f"{waiver_id}:{waiver.get('consumed_by_readiness_claim_id')}"
        if state == "consumed"
        else waiver_id
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "state": "open",
        "row_id": row_id,
        "row_type": row_type,
        **dict(waiver),
    }
    return append_declared_jsonl(
        root / "enterprise" / "waivers.jsonl",
        row,
        expected_surface="enterprise_waivers",
    )


def consume_waiver(
    waiver_id: str,
    *,
    readiness_claim_id: str,
    repo: str,
    pr_number: int,
    target_ref: str,
    head_ref: str,
    head_sha: str,
    previous_open_waiver_ledger_hash: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    if not waiver_id.strip():
        raise GovernanceError("waiver_id_required")
    if not readiness_claim_id.strip():
        raise GovernanceError("readiness_claim_id_required")
    if not _is_sha256_digest(previous_open_waiver_ledger_hash):
        raise GovernanceError("previous_open_waiver_ledger_hash_required")
    rows = load_declared_jsonl(
        root / "enterprise" / "waivers.jsonl",
        expected_surface="enterprise_waivers",
    )
    open_rows = [
        row for row in rows
        if row.get("state", "open") == "open"
        and str(row.get("waiver_id") or "") == waiver_id
        and str(row.get("ledger_hash") or "") == previous_open_waiver_ledger_hash
        and _row_common_matches(
            row,
            {
                "repo": repo,
                "pr_number": pr_number,
                "target_ref": target_ref,
                "head_ref": head_ref,
                "head_sha": head_sha,
                "readiness_claim_id": readiness_claim_id,
            },
        )
    ]
    if len(open_rows) != 1:
        raise GovernanceError("waiver_consume_requires_exact_open_waiver_row")
    open_row = open_rows[0]
    if str(open_row.get("row_type") or "") != "waiver_open":
        raise GovernanceError("waiver_consume_requires_open_waiver_row_type")
    _require_source_ref_on_row(root, open_row, "waiver_open")
    expires_at = open_row.get("expires_at")
    if not isinstance(expires_at, str) or not expires_at.strip():
        raise GovernanceError("waiver_consume_requires_open_waiver_expiry")
    if not _expiry_is_future(expires_at):
        raise GovernanceError("waiver_consume_after_expiry_rejected")
    duplicate = any(
        row.get("state") == "consumed"
        and str(row.get("waiver_id") or "") == waiver_id
        and str(row.get("previous_open_waiver_ledger_hash") or "") == previous_open_waiver_ledger_hash
        for row in rows
    )
    if duplicate:
        raise GovernanceError("waiver_duplicate_consume_rejected")
    return record_waiver(
        {
            "waiver_id": waiver_id,
            "state": "consumed",
            "repo": repo,
            "pr_number": pr_number,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
            "readiness_claim_id": readiness_claim_id,
            "consumed_by_readiness_claim_id": readiness_claim_id,
            "previous_open_waiver_ledger_hash": previous_open_waiver_ledger_hash,
            "source_ledger_ref": source_ledger_ref_from_row(
                surface="enterprise_waivers",
                ledger_path="enterprise/waivers.jsonl",
                row_id=str(open_row.get("waiver_id") or waiver_id),
                row_type="waiver_open",
                row=open_row,
            ),
        },
        base_dir=base_dir,
    )


def record_enterprise_readiness_claim(
    claim: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    assert_enterprise_readiness_claim(claim)
    root = ensure_tools_dir(base_dir)
    _validate_claim_source_refs(root, claim)
    existing = load_declared_jsonl(
        root / "enterprise" / "readiness-claims.jsonl",
        expected_surface="enterprise_readiness_claims",
    )
    readiness_claim_id = str(claim.get("readiness_claim_id") or "")
    if any(str(row.get("readiness_claim_id") or "") == readiness_claim_id for row in existing):
        raise GovernanceError(f"duplicate_readiness_claim_id:{readiness_claim_id}")
    row = {"recorded_at": utc_now(), **dict(claim)}
    row.setdefault("row_id", str(claim.get("claim_row_id") or readiness_claim_id))
    row.setdefault("row_type", "readiness_claim")
    return append_declared_jsonl(
        root / "enterprise" / "readiness-claims.jsonl",
        row,
        expected_surface="enterprise_readiness_claims",
    )


def verify_enterprise_readiness(
    *,
    pr_number: int,
    adapter: Any,
    readiness_claim_id: str,
    base_dir: str | Path | None = None,
) -> EnterpriseReadinessVerdict:
    if not isinstance(readiness_claim_id, str) or not readiness_claim_id.strip():
        raise GovernanceError("readiness_claim_id_required")
    root = ensure_tools_dir(base_dir)
    claims = load_declared_jsonl(
        root / "enterprise" / "readiness-claims.jsonl",
        expected_surface="enterprise_readiness_claims",
    )
    matches = [
        row for row in claims
        if str(row.get("readiness_claim_id") or "") == readiness_claim_id
    ]
    if not matches:
        raise GovernanceError(f"enterprise_readiness_claim_not_found:{readiness_claim_id}")
    if len(matches) > 1:
        raise GovernanceError(f"duplicate_readiness_claim_id:{readiness_claim_id}")
    claim = matches[0]
    if not isinstance(claim.get("ledger_hash"), str):
        raise GovernanceError("readiness_claim_row_missing_ledger_hash")
    if claim.get("pr_number") != pr_number:
        raise GovernanceError(
            f"enterprise_readiness_pr_mismatch: claim={claim.get('pr_number')!r} actual={pr_number!r}"
        )

    verdict = evaluate_enterprise_readiness_claim(claim)
    reasons = list(verdict.reasons)
    failures = list(verdict.failure_classes)

    live_pr = adapter.get_pr(pr_number)
    if not isinstance(live_pr, dict) or not live_pr:
        reasons.append("readiness_live_pr_missing")
        failures.append("readiness_live_binding_required")
        live_pr = {}
    _compare_live_field(live_pr, claim, ("repository", "repo", "repo_full_name"), "repo", "readiness_live_repo_mismatch", reasons, failures)
    _compare_live_field(live_pr, claim, ("base_branch", "baseRefName", "base", "target_ref"), "target_ref", "readiness_live_target_ref_mismatch", reasons, failures)
    _compare_live_field(live_pr, claim, ("head_ref", "headRefName", "head_branch"), "head_ref", "readiness_live_head_ref_mismatch", reasons, failures)
    _compare_live_field(live_pr, claim, ("head_sha", "headRefOid", "head"), "head_sha", "readiness_live_head_sha_mismatch", reasons, failures, require_full_sha=True)

    _verify_cas_ledger(root, claim, reasons, failures)
    _verify_waiver_ledger(root, claim, reasons, failures)
    _verify_branch_protection_ledger(root, claim, reasons, failures)
    _verify_retention_or_rollback_ledger(root, claim, "rollback_proof", "enterprise/rollback-proofs.jsonl", "enterprise_rollback_proofs", "rollback_proof_required", reasons, failures)
    _verify_retention_or_rollback_ledger(root, claim, "retention_proof", "enterprise/retention-proofs.jsonl", "enterprise_retention_proofs", "retention_proof_required", reasons, failures)
    _verify_workflow_run_ledger(root, claim, reasons, failures)
    _verify_artifact_ledger(root, claim, reasons, failures)
    _verify_dlp_token_ledger(root, claim, "dlp_proof", "enterprise/dlp-proofs.jsonl", "enterprise_dlp_proofs", "dlp_proof_required", reasons, failures)
    _verify_dlp_token_ledger(root, claim, "token_proof", "enterprise/token-proofs.jsonl", "enterprise_token_proofs", "token_proof_required", reasons, failures)

    return EnterpriseReadinessVerdict(
        valid=not failures,
        failure_classes=tuple(sorted(set(failures))),
        reasons=tuple(reasons),
    )


def source_ledger_ref_from_row(
    *,
    surface: str,
    ledger_path: str,
    row_id: str,
    row_type: str,
    row: dict[str, Any],
) -> dict[str, Any]:
    return ledger_ref_for_row(
        surface=surface,
        ledger_path=ledger_path,
        row_id=row_id,
        row_type=row_type,
        row=row,
    )


def _evaluate_remote_cas(claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    proof = claim.get("remote_cas_proof")
    if not isinstance(proof, dict):
        reasons.append("remote_cas_proof_required")
        failures.append("remote_cas_proof_required")
        return
    _require_common_binding(claim, proof, "remote_cas", reasons, failures)
    if proof.get("state") != "fresh":
        reasons.append("remote_cas_proof_not_fresh")
        failures.append("remote_cas_proof_required")
    if not isinstance(proof.get("lease_id"), str) or not proof.get("lease_id", "").strip():
        reasons.append("remote_cas_lease_id_required")
        failures.append("remote_cas_binding_required")
    if not isinstance(proof.get("epoch"), int) or proof.get("epoch") < 0:
        reasons.append("remote_cas_epoch_required")
        failures.append("remote_cas_binding_required")
    expires_at = proof.get("expires_at")
    if not isinstance(expires_at, str) or not expires_at.strip():
        reasons.append("remote_cas_expiry_required")
        failures.append("remote_cas_binding_required")
    elif not _expiry_is_future(expires_at):
        reasons.append("remote_cas_expiry_must_be_future")
        failures.append("remote_cas_binding_required")
    _require_source_ledger_ref(proof.get("source_ledger_ref"), "remote_cas", reasons, failures, "remote_cas_proof_required")


def _evaluate_branch_protection(claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    proof = claim.get("branch_protection_proof")
    if not isinstance(proof, dict):
        reasons.append("branch_protection_proof_required")
        failures.append("branch_protection_required")
        return
    _require_common_binding(claim, proof, "branch_protection", reasons, failures)
    if proof.get("$schema") != BRANCH_PROTECTION_SCHEMA:
        reasons.append("branch_protection_proof_schema_must_be_v3")
        failures.append("branch_protection_required")
    if proof.get("valid") is not True:
        reasons.append("branch_protection_proof_invalid")
        failures.append("branch_protection_required")
    if not _is_sha256_digest(str(proof.get("snapshot_hash") or "")):
        reasons.append("branch_protection_snapshot_hash_required")
        failures.append("branch_protection_required")
    checks = proof.get("required_checks")
    exact_checks = proof.get("exact_required_checks")
    if not isinstance(checks, list) or not checks or not all(isinstance(item, str) and item.strip() for item in checks):
        reasons.append("branch_protection_required_checks_required")
        failures.append("branch_protection_required")
    if (
        not isinstance(exact_checks, list)
        or sorted(str(item) for item in exact_checks) != sorted(REQUIRED_MERGE_STATUS_CHECKS)
    ):
        reasons.append("branch_protection_exact_required_checks_mismatch")
        failures.append("branch_protection_required")
    if isinstance(checks, list) and sorted(str(item) for item in checks) != sorted(REQUIRED_MERGE_STATUS_CHECKS):
        reasons.append("branch_protection_required_checks_mismatch")
        failures.append("branch_protection_required")
    for field_name in (
        "signed_commits_required",
        "reviews_required",
        "conversation_resolution_required",
        "force_push_disabled",
        "delete_branch_disabled",
    ):
        if proof.get(field_name) is not True:
            reasons.append(f"branch_protection_{field_name}_required")
            failures.append("branch_protection_required")
    ruleset_ids = proof.get("ruleset_ids")
    if not isinstance(ruleset_ids, list) or not ruleset_ids:
        reasons.append("branch_protection_ruleset_ids_required")
        failures.append("branch_protection_required")
    bypass_actors = proof.get("bypass_actors")
    if bypass_actors not in ([], ()):
        reasons.append("branch_protection_bypass_actors_forbidden")
        failures.append("branch_protection_required")
    _require_source_ledger_ref(proof.get("source_ledger_ref"), "branch_protection", reasons, failures, "branch_protection_required")


def _evaluate_retention_or_rollback(
    claim: dict[str, Any],
    proof_name: str,
    id_key: str,
    reasons: list[str],
    failures: list[str],
) -> None:
    proof = claim.get(proof_name)
    if not isinstance(proof, dict):
        reasons.append(f"{proof_name}_required")
        failures.append(f"{proof_name}_required")
        return
    _require_common_binding(claim, proof, proof_name, reasons, failures)
    if proof.get("validated") is not True:
        reasons.append(f"{proof_name}_not_validated")
        failures.append(f"{proof_name}_required")
    if not isinstance(proof.get(id_key), str) or not str(proof.get(id_key)).strip():
        reasons.append(f"{proof_name}_{id_key}_required")
        failures.append(f"{proof_name}_required")
    for field_name in ("source_uri", "archive_uri"):
        if not isinstance(proof.get(field_name), str) or not proof.get(field_name, "").strip():
            reasons.append(f"{proof_name}_{field_name}_required")
            failures.append(f"{proof_name}_required")
    for field_name in ("source_sha256", "archive_sha256"):
        if not _is_sha256_digest(str(proof.get(field_name) or "")):
            reasons.append(f"{proof_name}_{field_name}_required")
            failures.append(f"{proof_name}_required")
    if proof_name == "retention_proof":
        days = proof.get("retention_days")
        if not isinstance(days, int) or days <= 0:
            reasons.append("retention_days_required")
            failures.append("retention_proof_required")
    _require_source_ledger_ref(proof.get("source_ledger_ref"), proof_name, reasons, failures, f"{proof_name}_required")


def _evaluate_waiver_ledger(claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    waiver = claim.get("waiver_ledger")
    if not isinstance(waiver, dict):
        reasons.append("waiver_ledger_required")
        failures.append("waiver_ledger_not_green")
        return
    if waiver.get("open_expired_waivers"):
        reasons.append("waiver_ledger_has_expired_open_waivers")
        failures.append("waiver_ledger_not_green")
    _require_source_ledger_ref(waiver.get("source_ledger_ref"), "waiver_ledger", reasons, failures, "waiver_ledger_not_green")


def _evaluate_dlp_token(claim: dict[str, Any], proof_name: str, reasons: list[str], failures: list[str]) -> None:
    proof = claim.get(proof_name)
    failure = f"{proof_name}_required"
    if not isinstance(proof, dict):
        reasons.append(f"{proof_name}_required")
        failures.append(failure)
        return
    if proof.get("valid") is not True:
        reasons.append(f"{proof_name}_invalid")
        failures.append(failure)
    proof_id_key = f"{proof_name}_id"
    if not isinstance(proof.get(proof_id_key), str) or not proof.get(proof_id_key, "").strip():
        reasons.append(f"{proof_name}_{proof_id_key}_required")
        failures.append(failure)
    for field_name in DLP_TOKEN_BINDING_FIELDS:
        value = proof.get(field_name)
        if field_name in {"pr_number", "workflow_run_id"}:
            if not _workflow_run_id_valid(value):
                reasons.append(f"{proof_name}_{field_name}_required")
                failures.append(failure)
        elif field_name == "runtime_write_paths":
            if not isinstance(value, list) or not value or not all(isinstance(item, str) and item.strip() for item in value):
                reasons.append(f"{proof_name}_runtime_write_paths_required")
                failures.append(failure)
        elif field_name.endswith("hash") or field_name.endswith("sha256"):
            if not _is_sha256_digest(str(value or "")):
                reasons.append(f"{proof_name}_{field_name}_required")
                failures.append(failure)
        elif not isinstance(value, str) or not value.strip():
            reasons.append(f"{proof_name}_{field_name}_required")
            failures.append(failure)
    _require_common_binding(claim, proof, proof_name, reasons, failures)
    workflow_id = proof.get("workflow_run_id")
    workflow_ids = {str(item) for item in claim.get("workflow_run_ids") or []}
    if _workflow_run_id_valid(workflow_id) and str(workflow_id) not in workflow_ids:
        reasons.append(f"{proof_name}_workflow_run_id_unbound")
        failures.append(failure)
    artifact_id = str(proof.get("artifact_id") or "")
    artifact_sha = str(proof.get("artifact_sha256") or "")
    artifact_matches = {
        (str(ref.get("artifact_id") or ""), str(ref.get("sha256") or ""))
        for ref in (claim.get("artifact_refs") or [])
        if isinstance(ref, dict)
    }
    if artifact_id and _is_sha256_digest(artifact_sha) and (artifact_id, artifact_sha) not in artifact_matches:
        reasons.append(f"{proof_name}_artifact_ref_unbound")
        failures.append(failure)
    if proof_name == "dlp_proof":
        scanner_results = proof.get("scanner_results")
        if not isinstance(scanner_results, dict):
            reasons.append("dlp_proof_scanner_results_required")
            failures.append(failure)
        else:
            if scanner_results.get("status") != "passed":
                reasons.append("dlp_proof_scanner_results_must_pass")
                failures.append(failure)
            surfaces = scanner_results.get("scanned_surfaces")
            if not isinstance(surfaces, list):
                reasons.append("dlp_proof_scanned_surfaces_required")
                failures.append(failure)
            else:
                surface_set = {str(item) for item in surfaces}
                missing = [item for item in REQUIRED_DLP_SCANNED_SURFACES if item not in surface_set]
                if missing:
                    reasons.append("dlp_proof_scanned_surfaces_missing:" + ",".join(missing))
                    failures.append(failure)
            if not _is_sha256_digest(str(scanner_results.get("scanner_output_sha256") or "")):
                reasons.append("dlp_proof_scanner_output_sha256_required")
                failures.append(failure)
    if proof_name == "token_proof":
        if proof.get("token_type") != "github_app_installation_token":
            reasons.append("token_proof_installation_token_required")
            failures.append(failure)
        if proof.get("mutation_token") != "github_app_installation_token":
            reasons.append("token_proof_mutation_token_must_be_github_app_installation_token")
            failures.append(failure)
        for field_name in ("gh_token_fallback", "github_token_fallback", "pat_fallback"):
            if proof.get(field_name) is not False:
                reasons.append(f"token_proof_{field_name}_forbidden")
                failures.append(failure)
    _require_source_ledger_ref(proof.get("source_ledger_ref"), proof_name, reasons, failures, failure)


def _verify_cas_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    cas = claim.get("remote_cas_proof") if isinstance(claim.get("remote_cas_proof"), dict) else {}
    rows = load_declared_jsonl(
        root / "enterprise" / "remote-cas-proofs.jsonl",
        expected_surface="enterprise_remote_cas_proofs",
    )
    match = next(
        (
            row for row in reversed(rows)
            if _row_common_matches(row, claim)
            and str(row.get("lease_id") or "") == str(cas.get("lease_id") or "")
            and int(row.get("epoch") or -1) == int(cas.get("epoch") or -2)
            and str(row.get("expires_at") or "") == str(cas.get("expires_at") or "")
            and str(row.get("state") or "") == "fresh"
            and _source_ref_matches(root, row, cas.get("source_ledger_ref"))
        ),
        None,
    )
    if match is None:
        reasons.append("remote_cas_proof_not_ledger_bound")
        failures.append("remote_cas_proof_required")
    elif not _expiry_is_future(str(match.get("expires_at") or "")):
        reasons.append("remote_cas_ledger_expiry_must_be_future")
        failures.append("remote_cas_proof_required")


def _verify_waiver_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    waiver = claim.get("waiver_ledger")
    if isinstance(waiver, dict):
        try:
            _resolve_source_ref(root, waiver.get("source_ledger_ref"))
        except GovernanceError:
            reasons.append("waiver_ledger_source_ledger_ref_not_bound")
            failures.append("waiver_ledger_not_green")
    rows = load_declared_jsonl(
        root / "enterprise" / "waivers.jsonl",
        expected_surface="enterprise_waivers",
    )
    open_expired = [
        row for row in rows
        if row.get("state", "open") == "open"
        and (
            not isinstance(row.get("expires_at"), str)
            or not _expiry_is_future(str(row.get("expires_at")))
        )
    ]
    if open_expired:
        reasons.append("waiver_ledger_has_open_expired_rows")
        failures.append("waiver_ledger_not_green")
    waiver_ids = claim.get("waiver_ids") or []
    if not waiver_ids:
        return
    if not isinstance(waiver_ids, list):
        reasons.append("waiver_ids_must_be_list")
        failures.append("waiver_ledger_not_green")
        return
    for waiver_id in waiver_ids:
        open_matches = [
            row for row in rows
            if row.get("state", "open") == "open"
            and str(row.get("waiver_id") or "") == str(waiver_id)
            and _row_common_matches(row, claim)
            and _source_ref_matches(root, row, row.get("source_ledger_ref"))
            and str(row.get("row_type") or "") == "waiver_open"
        ]
        consume_matches = [
            row for row in rows
            if row.get("state") == "consumed"
            and str(row.get("waiver_id") or "") == str(waiver_id)
            and _row_common_matches(row, claim)
            and str(row.get("consumed_by_readiness_claim_id") or "") == str(claim.get("readiness_claim_id") or "")
            and any(str(row.get("previous_open_waiver_ledger_hash") or "") == str(open_row.get("ledger_hash") or "") for open_row in open_matches)
            and _source_ref_matches(root, row, row.get("source_ledger_ref"))
            and str(row.get("row_type") or "") == "waiver_consumed"
        ]
        if len(open_matches) != 1:
            reasons.append(f"waiver_id_not_open_ledger_bound:{waiver_id}")
            failures.append("waiver_ledger_not_green")
        if len(consume_matches) != 1:
            reasons.append(f"waiver_id_not_consumed_by_readiness_claim:{waiver_id}")
            failures.append("waiver_ledger_not_green")


def _verify_branch_protection_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    proof = claim.get("branch_protection_proof") if isinstance(claim.get("branch_protection_proof"), dict) else {}
    rows = load_declared_jsonl(
        root / "enterprise" / "branch-protection-proofs.jsonl",
        expected_surface="enterprise_branch_protection_proofs",
    )
    match = next(
        (
            row for row in reversed(rows)
            if _row_common_matches(row, claim)
            and row.get("snapshot_hash") == proof.get("snapshot_hash")
            and row.get("valid") is True
            and _source_ref_matches(root, row, proof.get("source_ledger_ref"))
        ),
        None,
    )
    if match is None:
        reasons.append("branch_protection_proof_not_ledger_bound")
        failures.append("branch_protection_required")


def _verify_retention_or_rollback_ledger(
    root: Path,
    claim: dict[str, Any],
    proof_name: str,
    relative_path: str,
    surface: str,
    failure_class: str,
    reasons: list[str],
    failures: list[str],
) -> None:
    proof = claim.get(proof_name) if isinstance(claim.get(proof_name), dict) else {}
    id_key = "retention_proof_id" if proof_name == "retention_proof" else "rollback_proof_id"
    rows = load_declared_jsonl(root / relative_path, expected_surface=surface)
    match = next(
        (
            row for row in reversed(rows)
            if _row_common_matches(row, claim)
            and str(row.get(id_key) or "") == str(proof.get(id_key) or "")
            and row.get("validated") is True
            and str(row.get("source_uri") or "") == str(proof.get("source_uri") or "")
            and str(row.get("archive_uri") or "") == str(proof.get("archive_uri") or "")
            and str(row.get("source_sha256") or "") == str(proof.get("source_sha256") or "")
            and str(row.get("archive_sha256") or "") == str(proof.get("archive_sha256") or "")
            and _source_ref_matches(root, row, proof.get("source_ledger_ref"))
        ),
        None,
    )
    if match is None:
        reasons.append(f"{proof_name}_not_ledger_bound")
        failures.append(failure_class)
        return
    for uri_key, hash_key in (("source_uri", "source_sha256"), ("archive_uri", "archive_sha256")):
        uri = str(match.get(uri_key) or "")
        expected = str(match.get(hash_key) or "")
        try:
            actual = _sha256_file(_resolve_tools_uri(root, uri))
        except GovernanceError as exc:
            reasons.append(f"{proof_name}_{uri_key}_unreadable:{exc}")
            failures.append(failure_class)
            continue
        if actual != expected:
            reasons.append(f"{proof_name}_{hash_key}_byte_mismatch")
            failures.append(failure_class)


def _verify_workflow_run_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    rows = load_declared_jsonl(
        root / "enterprise" / "workflow-run-proofs.jsonl",
        expected_surface="enterprise_workflow_run_proofs",
    )
    for run_id in [str(item) for item in claim.get("workflow_run_ids") or []]:
        match = next(
            (
                row for row in reversed(rows)
                if str(row.get("workflow_run_id") or row.get("run_id") or "") == run_id
                and _row_common_matches(row, claim)
                and row.get("conclusion") in {"success", "passed", True}
                and isinstance(row.get("ledger_hash"), str)
                and _source_ref_matches(root, row, row.get("source_ledger_ref"))
            ),
            None,
        )
        if match is None:
            reasons.append(f"workflow_run_id_not_ledger_bound:{run_id}")
            failures.append("workflow_run_ids_untrusted")


def _verify_artifact_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    rows = load_declared_jsonl(
        root / "enterprise" / "artifact-proofs.jsonl",
        expected_surface="enterprise_artifact_proofs",
    )
    for ref in claim.get("artifact_refs") or []:
        if not isinstance(ref, dict):
            continue
        match = next(
            (
                row for row in reversed(rows)
                if _row_common_matches(row, claim)
                and str(row.get("artifact_id") or "") == str(ref.get("artifact_id") or "")
                and str(row.get("uri") or "") == str(ref.get("uri") or "")
                and str(row.get("sha256") or "") == str(ref.get("sha256") or "")
                and row.get("schema_version") == ref.get("schema_version")
                and str(row.get("content_type") or "") == str(ref.get("content_type") or "")
                and str(row.get("source_surface") or "") == str(ref.get("source_surface") or "")
                and str(row.get("produced_by_workflow_run_id") or "") == str(ref.get("produced_by_workflow_run_id") or "")
                and str(ref.get("source_surface") or "") in READINESS_ARTIFACT_SOURCE_SURFACES
                and str(ref.get("produced_by_workflow_run_id") or "") in {str(item) for item in claim.get("workflow_run_ids") or []}
                and _source_ref_matches(root, row, row.get("source_ledger_ref"))
            ),
            None,
        )
        if match is None:
            reasons.append(f"artifact_ref_not_ledger_bound:{ref.get('artifact_id')}")
            failures.append("artifact_refs_untrusted")


def _verify_dlp_token_ledger(
    root: Path,
    claim: dict[str, Any],
    proof_name: str,
    relative_path: str,
    surface: str,
    failure_class: str,
    reasons: list[str],
    failures: list[str],
) -> None:
    proof = claim.get(proof_name) if isinstance(claim.get(proof_name), dict) else {}
    proof_id_key = f"{proof_name}_id"
    rows = load_declared_jsonl(root / relative_path, expected_surface=surface)
    match = next(
        (
            row for row in reversed(rows)
            if _row_common_matches(row, claim)
            and row.get("valid") is True
            and str(row.get(proof_id_key) or "") == str(proof.get(proof_id_key) or "")
            and str(row.get("workflow_run_id") or "") == str(proof.get("workflow_run_id") or "")
            and str(row.get("artifact_id") or "") == str(proof.get("artifact_id") or "")
            and str(row.get("artifact_sha256") or "") == str(proof.get("artifact_sha256") or "")
            and str(row.get("workflow_hash") or "") == str(proof.get("workflow_hash") or "")
            and str(row.get("contract_hash") or "") == str(proof.get("contract_hash") or "")
            and str(row.get("network_policy") or "") == str(proof.get("network_policy") or "")
            and row.get("runtime_write_paths") == proof.get("runtime_write_paths")
            and _source_ref_matches(root, row, proof.get("source_ledger_ref"))
        ),
        None,
    )
    if match is None:
        reasons.append(f"{proof_name}_not_ledger_bound")
        failures.append(failure_class)


def _require_common_binding(
    claim: dict[str, Any],
    proof: dict[str, Any],
    prefix: str,
    reasons: list[str],
    failures: list[str],
) -> None:
    for key in ("repo", "pr_number", "target_ref", "head_ref", "head_sha", "readiness_claim_id"):
        if proof.get(key) != claim.get(key):
            reasons.append(f"{prefix}_{key}_mismatch")
            failures.append(f"{prefix}_binding_required")


def _row_common_matches(row: dict[str, Any], claim: dict[str, Any]) -> bool:
    return all(row.get(key) == claim.get(key) for key in ("repo", "pr_number", "target_ref", "head_ref", "head_sha", "readiness_claim_id"))


def _validate_claim_source_refs(root: Path, claim: dict[str, Any]) -> None:
    proof_names = (
        "remote_cas_proof",
        "rollback_proof",
        "retention_proof",
        "waiver_ledger",
        "branch_protection_proof",
        "dlp_proof",
        "token_proof",
    )
    for proof_name in proof_names:
        proof = claim.get(proof_name)
        if isinstance(proof, dict):
            _require_source_ref_on_row(root, proof, proof_name)


def _source_ref_matches(root: Path, row: dict[str, Any], expected_ref: Any) -> bool:
    if not isinstance(row.get("ledger_hash"), str):
        return False
    source_ref = row.get("source_ledger_ref")
    if expected_ref is not None and source_ref != expected_ref:
        return False
    try:
        _resolve_source_ref(root, source_ref)
    except GovernanceError:
        return False
    return True


def _require_source_ref_on_row(root: Path, row: dict[str, Any], label: str) -> None:
    if not _source_ref_valid(row.get("source_ledger_ref")):
        raise GovernanceError(f"{label}_requires_source_ledger_ref")
    _resolve_source_ref(root, row.get("source_ledger_ref"))


def _require_source_ledger_ref(
    ref: Any,
    prefix: str,
    reasons: list[str],
    failures: list[str],
    failure_class: str,
) -> None:
    if not _source_ref_valid(ref):
        reasons.append(f"{prefix}_source_ledger_ref_required")
        failures.append(failure_class)


def _source_ref_valid(ref: Any) -> bool:
    if not isinstance(ref, dict):
        return False
    for key in SOURCE_LEDGER_REF_FIELDS:
        if key not in ref:
            return False
    if not all(isinstance(ref.get(key), str) and ref.get(key, "").strip() for key in ("surface", "ledger_path", "row_id", "row_type", "row_hash")):
        return False
    if not _is_sha256_digest(str(ref.get("row_hash") or "")):
        return False
    return isinstance(ref.get("schema_version"), int) and ref.get("schema_version") > 0


def _resolve_source_ref(root: Path, ref: Any) -> dict[str, Any]:
    if not isinstance(ref, dict):
        raise GovernanceError("source_ledger_ref_required")
    return find_row_by_source_ledger_ref(root, ref)


def _compare_live_field(
    live_pr: dict[str, Any],
    claim: dict[str, Any],
    live_keys: tuple[str, ...],
    claim_key: str,
    reason: str,
    reasons: list[str],
    failures: list[str],
    *,
    require_full_sha: bool = False,
) -> None:
    live_value = next((live_pr.get(key) for key in live_keys if live_pr.get(key)), None)
    if live_value is None:
        reasons.append(reason.replace("_mismatch", "_required"))
        failures.append("readiness_live_binding_required")
        return
    live = str(live_value)
    if require_full_sha and not _is_full_sha(live):
        reasons.append("readiness_live_head_sha_required")
        failures.append("readiness_live_binding_required")
        return
    if live != str(claim.get(claim_key) or ""):
        reasons.append(reason)
        failures.append("readiness_live_binding_required")


def _require_nonempty_str(claim: dict[str, Any], key: str, reasons: list[str], failures: list[str], failure: str) -> None:
    if not isinstance(claim.get(key), str) or not claim.get(key, "").strip():
        reasons.append(f"{key}_required")
        failures.append(failure)


def _workflow_run_id_valid(value: Any) -> bool:
    return (
        isinstance(value, int) and not isinstance(value, bool) and value > 0
        or isinstance(value, str) and value.isdigit() and int(value) > 0
    )


def _resolve_tools_uri(root: Path, uri: str) -> Path:
    if not uri or Path(uri).is_absolute() or uri.startswith("aria-tools/"):
        raise GovernanceError("enterprise_proof_uri_must_be_relative_to_tools_root")
    resolved = (root / uri).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise GovernanceError("enterprise_proof_uri_escapes_tools_root") from exc
    if not resolved.exists() or not resolved.is_file():
        raise GovernanceError("enterprise_proof_uri_missing")
    return resolved


def _sha256_file(path: Path) -> str:
    import hashlib

    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _is_full_sha(value: str) -> bool:
    return len(value) == 40 and all(ch in "0123456789abcdef" for ch in value)


def _is_sha256_digest(value: str) -> bool:
    return (
        value.startswith("sha256:")
        and len(value) == len("sha256:") + 64
        and all(ch in "0123456789abcdef" for ch in value[len("sha256:"):])
    )


def _expiry_is_future(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc) > datetime.now(timezone.utc)


__all__ = [
    "EnterpriseReadinessVerdict",
    "PrReadinessVerdict",
    "READINESS_SCHEMA",
    "REQUIRED_READINESS_FIELDS",
    "SOURCE_LEDGER_REF_FIELDS",
    "assert_enterprise_readiness_claim",
    "consume_waiver",
    "evaluate_enterprise_readiness_claim",
    "evaluate_pr_readiness_claim",
    "record_enterprise_readiness_claim",
    "record_artifact_proof",
    "record_branch_protection_proof",
    "record_dlp_proof",
    "record_remote_cas_proof",
    "record_retention_proof",
    "record_rollback_proof",
    "record_token_proof",
    "record_workflow_run_proof",
    "record_waiver",
    "source_ledger_ref_from_row",
    "verify_enterprise_readiness",
]
