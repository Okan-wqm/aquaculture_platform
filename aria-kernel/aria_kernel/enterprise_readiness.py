from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError
from .tool_registry import ensure_tools_dir, utc_now


REQUIRED_READINESS_FIELDS: tuple[str, ...] = (
    "readiness_claim_id",
    "pr_number",
    "target_ref",
    "head_sha",
    "evidence_bundle",
    "workflow_run_ids",
    "artifact_hashes",
    "remote_cas_proof",
    "rollback_proof",
    "retention_proof",
    "waiver_ledger",
    "branch_protection_proof",
    "dlp_proof",
    "token_proof",
)


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
    failure_classes: list[str] = []
    for field_name in REQUIRED_READINESS_FIELDS:
        if field_name not in claim or claim.get(field_name) in (None, "", [], {}):
            reasons.append(f"missing_required_readiness_field:{field_name}")
            failure_classes.append("readiness_claim_incomplete")

    artifact_hashes = claim.get("artifact_hashes")
    if isinstance(artifact_hashes, dict):
        bad_hashes = [
            key for key, value in artifact_hashes.items()
            if not isinstance(value, str) or not _is_sha256_digest(value)
        ]
        if bad_hashes:
            reasons.append(f"artifact_hashes_not_sha256:{sorted(bad_hashes)}")
            failure_classes.append("artifact_hashes_untrusted")
    elif "artifact_hashes" in claim:
        reasons.append("artifact_hashes_must_be_object")
        failure_classes.append("artifact_hashes_untrusted")

    workflow_run_ids = claim.get("workflow_run_ids")
    if isinstance(workflow_run_ids, list):
        bad_run_ids = [
            value for value in workflow_run_ids
            if not (
                isinstance(value, int) and value > 0
                or isinstance(value, str) and value.isdigit() and int(value) > 0
            )
        ]
        if bad_run_ids:
            reasons.append(f"workflow_run_ids_invalid:{bad_run_ids!r}")
            failure_classes.append("workflow_run_ids_untrusted")
    elif "workflow_run_ids" in claim:
        reasons.append("workflow_run_ids_must_be_list")
        failure_classes.append("workflow_run_ids_untrusted")

    remote_cas = claim.get("remote_cas_proof")
    if isinstance(remote_cas, dict):
        cas_verdict = evaluate_pr_readiness_claim(
            {
                "pr_number": claim.get("pr_number"),
                "remote_cas_proof": remote_cas,
            }
        )
        if not cas_verdict.valid:
            reasons.extend(cas_verdict.reasons)
            failure_classes.extend(cas_verdict.failure_classes)

    branch_protection = claim.get("branch_protection_proof")
    if isinstance(branch_protection, dict):
        for field_name in ("target_ref", "snapshot_hash", "source_ledger_hash"):
            value = branch_protection.get(field_name)
            if field_name.endswith("_hash"):
                if not isinstance(value, str) or not _is_sha256_digest(value):
                    reasons.append(f"branch_protection_{field_name}_required")
                    failure_classes.append("branch_protection_required")
            elif not isinstance(value, str) or not value.strip():
                reasons.append(f"branch_protection_{field_name}_required")
                failure_classes.append("branch_protection_required")
        checks = branch_protection.get("required_checks")
        if not isinstance(checks, list) or not checks or not all(isinstance(item, str) and item.strip() for item in checks):
            reasons.append("branch_protection_required_checks_required")
            failure_classes.append("branch_protection_required")
        if branch_protection.get("valid") is not True:
            reasons.append("branch_protection_proof_invalid")
            failure_classes.append("branch_protection_required")

    rollback = claim.get("rollback_proof")
    if isinstance(rollback, dict):
        if rollback.get("validated") is not True:
            reasons.append("rollback_proof_not_validated")
            failure_classes.append("rollback_proof_required")
        for field_name in ("rollback_proof_id", "source_ledger_hash", "artifact_hash"):
            value = rollback.get(field_name)
            if field_name.endswith("hash"):
                if not isinstance(value, str) or not _is_sha256_digest(value):
                    reasons.append(f"rollback_{field_name}_required")
                    failure_classes.append("rollback_proof_required")
            elif not isinstance(value, str) or not value.strip():
                reasons.append(f"rollback_{field_name}_required")
                failure_classes.append("rollback_proof_required")
    elif "rollback_proof" in claim:
        reasons.append("rollback_proof_must_be_object")
        failure_classes.append("rollback_proof_required")

    retention = claim.get("retention_proof")
    if isinstance(retention, dict):
        if retention.get("validated") is not True:
            reasons.append("retention_proof_not_validated")
            failure_classes.append("retention_proof_required")
        days = retention.get("retention_days")
        if not isinstance(days, int) or days <= 0:
            reasons.append("retention_days_required")
            failure_classes.append("retention_proof_required")
        for field_name in ("retention_proof_id", "source_ledger_hash", "artifact_hash"):
            value = retention.get(field_name)
            if field_name.endswith("hash"):
                if not isinstance(value, str) or not _is_sha256_digest(value):
                    reasons.append(f"retention_{field_name}_required")
                    failure_classes.append("retention_proof_required")
            elif not isinstance(value, str) or not value.strip():
                reasons.append(f"retention_{field_name}_required")
                failure_classes.append("retention_proof_required")
    elif "retention_proof" in claim:
        reasons.append("retention_proof_must_be_object")
        failure_classes.append("retention_proof_required")

    waiver_ledger = claim.get("waiver_ledger")
    if isinstance(waiver_ledger, dict):
        if waiver_ledger.get("open_expired_waivers"):
            reasons.append("waiver_ledger_has_expired_open_waivers")
            failure_classes.append("waiver_ledger_not_green")
        ledger_hash = waiver_ledger.get("source_ledger_hash")
        if not isinstance(ledger_hash, str) or not _is_sha256_digest(ledger_hash):
            reasons.append("waiver_ledger_source_hash_required")
            failure_classes.append("waiver_ledger_not_green")

    for proof_name in ("dlp_proof", "token_proof"):
        proof = claim.get(proof_name)
        if isinstance(proof, dict):
            if proof.get("valid") is not True:
                reasons.append(f"{proof_name}_invalid")
                failure_classes.append(f"{proof_name}_required")
            artifact_hash = proof.get("artifact_hash") or proof.get("source_ledger_hash")
            if not isinstance(artifact_hash, str) or not _is_sha256_digest(artifact_hash):
                reasons.append(f"{proof_name}_hash_required")
                failure_classes.append(f"{proof_name}_required")
        elif proof_name in claim:
            reasons.append(f"{proof_name}_must_be_object")
            failure_classes.append(f"{proof_name}_required")

    return EnterpriseReadinessVerdict(
        valid=not failure_classes,
        failure_classes=tuple(sorted(set(failure_classes))),
        reasons=tuple(reasons),
    )


def evaluate_pr_readiness_claim(claim: dict[str, Any]) -> PrReadinessVerdict:
    reasons: list[str] = []
    failure_classes: list[str] = []
    remote_cas = claim.get("remote_cas_proof")
    pr_number = claim.get("pr_number")
    if not isinstance(pr_number, int) or pr_number <= 0:
        reasons.append("pr_number_required")
        failure_classes.append("pr_readiness_binding_required")
    if not isinstance(remote_cas, dict):
        reasons.append("remote_cas_proof_required")
        failure_classes.append("remote_cas_proof_required")
        return PrReadinessVerdict(
            valid=False,
            pr_number=pr_number if isinstance(pr_number, int) else None,
            target_ref=None,
            head_sha=None,
            lease_id=None,
            epoch=None,
            expires_at=None,
            failure_classes=tuple(sorted(set(failure_classes))),
            reasons=tuple(reasons),
        )
    target_ref = remote_cas.get("target_ref")
    head_sha = remote_cas.get("head_sha")
    lease_id = remote_cas.get("lease_id")
    epoch = remote_cas.get("epoch")
    expires_at = remote_cas.get("expires_at")
    if remote_cas.get("state") != "fresh":
        reasons.append("remote_cas_proof_not_fresh")
        failure_classes.append("remote_cas_proof_required")
    if not isinstance(target_ref, str) or not target_ref.strip():
        reasons.append("remote_cas_target_ref_required")
        failure_classes.append("remote_cas_binding_required")
    if not isinstance(head_sha, str) or not _is_full_sha(head_sha):
        reasons.append("remote_cas_head_sha_must_be_full_sha256ish_git_sha")
        failure_classes.append("remote_cas_binding_required")
    if not isinstance(lease_id, str) or not lease_id.strip():
        reasons.append("remote_cas_lease_id_required")
        failure_classes.append("remote_cas_binding_required")
    if not isinstance(epoch, int) or epoch < 0:
        reasons.append("remote_cas_epoch_required")
        failure_classes.append("remote_cas_binding_required")
    if not isinstance(expires_at, str) or not expires_at.strip():
        reasons.append("remote_cas_expiry_required")
        failure_classes.append("remote_cas_binding_required")
    elif not _expiry_is_future(expires_at):
        reasons.append("remote_cas_expiry_must_be_future")
        failure_classes.append("remote_cas_binding_required")
    return PrReadinessVerdict(
        valid=not failure_classes,
        pr_number=pr_number if isinstance(pr_number, int) else None,
        target_ref=target_ref if isinstance(target_ref, str) else None,
        head_sha=head_sha if isinstance(head_sha, str) else None,
        lease_id=lease_id if isinstance(lease_id, str) else None,
        epoch=epoch if isinstance(epoch, int) else None,
        expires_at=expires_at if isinstance(expires_at, str) else None,
        failure_classes=tuple(sorted(set(failure_classes))),
        reasons=tuple(reasons),
    )


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
    row = {"schema_version": 1, "recorded_at": utc_now(), "state": "open", **dict(waiver)}
    return append_declared_jsonl(
        root / "enterprise" / "waivers.jsonl",
        row,
        expected_surface="enterprise_waivers",
    )


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
    return record_waiver(
        {
            "waiver_id": waiver_id,
            "state": "consumed",
            "consumed_by_readiness_claim_id": readiness_claim_id,
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
    row = {"schema_version": 1, "recorded_at": utc_now(), **dict(claim)}
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
    root = ensure_tools_dir(base_dir)
    claims = load_declared_jsonl(
        root / "enterprise" / "readiness-claims.jsonl",
        expected_surface="enterprise_readiness_claims",
    )
    claim = next(
        (
            row for row in reversed(claims)
            if str(row.get("readiness_claim_id") or row.get("claim_id") or "") == readiness_claim_id
        ),
        None,
    )
    if claim is None:
        raise GovernanceError(f"enterprise_readiness_claim_not_found:{readiness_claim_id}")
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
    live_head = str(live_pr.get("head_sha") or live_pr.get("headRefOid") or live_pr.get("head") or "")
    live_target = str(live_pr.get("base_branch") or live_pr.get("baseRefName") or live_pr.get("base") or "")
    claim_head = str(claim.get("head_sha") or "")
    claim_target = str(claim.get("target_ref") or "")
    if not live_head or not _is_full_sha(live_head):
        reasons.append("readiness_live_head_sha_required")
        failures.append("readiness_live_binding_required")
    elif claim_head and live_head != claim_head:
        reasons.append("readiness_live_head_sha_mismatch")
        failures.append("readiness_live_binding_required")
    if not live_target.strip():
        reasons.append("readiness_live_target_ref_required")
        failures.append("readiness_live_binding_required")
    elif claim_target and live_target != claim_target:
        reasons.append("readiness_live_target_ref_mismatch")
        failures.append("readiness_live_binding_required")

    _verify_cas_ledger(root, claim, reasons, failures)
    _verify_waiver_ledger(root, claim, reasons, failures)
    _verify_branch_protection_ledger(root, claim, reasons, failures)
    _verify_rollback_ledger(root, claim, reasons, failures)
    _verify_retention_ledger(root, claim, reasons, failures)
    _verify_workflow_run_ledger(root, claim, reasons, failures)
    _verify_artifact_ledger(root, claim, reasons, failures)
    _verify_simple_proof_ledger(
        root,
        claim,
        "dlp_proof",
        "enterprise/dlp-proofs.jsonl",
        "enterprise_dlp_proofs",
        "dlp_proof_required",
        reasons,
        failures,
    )
    _verify_simple_proof_ledger(
        root,
        claim,
        "token_proof",
        "enterprise/token-proofs.jsonl",
        "enterprise_token_proofs",
        "token_proof_required",
        reasons,
        failures,
    )

    return EnterpriseReadinessVerdict(
        valid=not failures,
        failure_classes=tuple(sorted(set(failures))),
        reasons=tuple(reasons),
    )


def _verify_cas_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    cas = claim.get("remote_cas_proof") if isinstance(claim.get("remote_cas_proof"), dict) else {}
    readiness_claim_id = str(claim.get("readiness_claim_id") or "")
    rows = load_declared_jsonl(
        root / "enterprise" / "remote-cas-proofs.jsonl",
        expected_surface="enterprise_remote_cas_proofs",
    )
    match = next(
        (
            row for row in reversed(rows)
            if str(row.get("lease_id") or "") == str(cas.get("lease_id") or "")
            and str(row.get("head_sha") or "") == str(cas.get("head_sha") or "")
            and str(row.get("target_ref") or "") == str(cas.get("target_ref") or "")
            and int(row.get("pr_number") or 0) == int(claim.get("pr_number") or 0)
            and int(row.get("epoch") or -1) == int(cas.get("epoch") or -2)
            and str(row.get("state") or "") == "fresh"
            and str(row.get("readiness_claim_id") or "") == readiness_claim_id
            and str(row.get("expires_at") or "") == str(cas.get("expires_at") or "")
        ),
        None,
    )
    if match is None or not isinstance(match.get("ledger_hash"), str):
        reasons.append("remote_cas_proof_not_ledger_bound")
        failures.append("remote_cas_proof_required")
    elif not _expiry_is_future(str(match.get("expires_at") or "")):
        reasons.append("remote_cas_ledger_expiry_must_be_future")
        failures.append("remote_cas_proof_required")


def _verify_waiver_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    rows = load_declared_jsonl(
        root / "enterprise" / "waivers.jsonl",
        expected_surface="enterprise_waivers",
    )
    open_expired = [
        row for row in rows
        if row.get("state", "open") == "open"
        and isinstance(row.get("expires_at"), str)
        and not _expiry_is_future(str(row.get("expires_at")))
    ]
    if open_expired:
        reasons.append("waiver_ledger_has_open_expired_rows")
        failures.append("waiver_ledger_not_green")
    waiver_ids = claim.get("waiver_ids") or []
    if isinstance(waiver_ids, list):
        known = {str(row.get("waiver_id")) for row in rows if row.get("waiver_id")}
        missing = [str(item) for item in waiver_ids if str(item) not in known]
        if missing:
            reasons.append(f"waiver_ids_not_ledger_bound:{missing}")
            failures.append("waiver_ledger_not_green")
        readiness_claim_id = str(claim.get("readiness_claim_id") or "")
        unconsumed = [
            str(item) for item in waiver_ids
            if not any(
                str(row.get("waiver_id") or "") == str(item)
                and row.get("state") == "consumed"
                and str(row.get("consumed_by_readiness_claim_id") or "") == readiness_claim_id
                for row in rows
            )
        ]
        if unconsumed:
            reasons.append(f"waiver_ids_not_consumed_by_readiness_claim:{unconsumed}")
            failures.append("waiver_ledger_not_green")


def _verify_branch_protection_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    proof = claim.get("branch_protection_proof") if isinstance(claim.get("branch_protection_proof"), dict) else {}
    rows = load_declared_jsonl(
        root / "enterprise" / "branch-protection-proofs.jsonl",
        expected_surface="enterprise_branch_protection_proofs",
    )
    expected_hash = proof.get("snapshot_hash")
    match = next(
        (
            row for row in reversed(rows)
            if row.get("snapshot_hash") == expected_hash
            and row.get("target_ref") == proof.get("target_ref")
            and row.get("valid") is True
            and str(row.get("readiness_claim_id") or "") == str(claim.get("readiness_claim_id") or "")
            and int(row.get("pr_number") or 0) == int(claim.get("pr_number") or 0)
            and str(row.get("head_sha") or "") == str(claim.get("head_sha") or "")
        ),
        None,
    )
    if match is None or not isinstance(match.get("ledger_hash"), str):
        reasons.append("branch_protection_proof_not_ledger_bound")
        failures.append("branch_protection_required")


def _verify_rollback_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    proof = claim.get("rollback_proof") if isinstance(claim.get("rollback_proof"), dict) else {}
    rows = load_declared_jsonl(
        root / "enterprise" / "rollback-proofs.jsonl",
        expected_surface="enterprise_rollback_proofs",
    )
    match = _find_claim_bound_proof(
        rows,
        claim,
        id_key="rollback_proof_id",
        id_value=str(proof.get("rollback_proof_id") or ""),
        hash_key="artifact_hash",
        hash_value=str(proof.get("artifact_hash") or ""),
    )
    if match is None or match.get("validated") is not True:
        reasons.append("rollback_proof_not_ledger_bound")
        failures.append("rollback_proof_required")


def _verify_retention_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    proof = claim.get("retention_proof") if isinstance(claim.get("retention_proof"), dict) else {}
    rows = load_declared_jsonl(
        root / "enterprise" / "retention-proofs.jsonl",
        expected_surface="enterprise_retention_proofs",
    )
    match = _find_claim_bound_proof(
        rows,
        claim,
        id_key="retention_proof_id",
        id_value=str(proof.get("retention_proof_id") or ""),
        hash_key="artifact_hash",
        hash_value=str(proof.get("artifact_hash") or ""),
    )
    if match is None or match.get("validated") is not True:
        reasons.append("retention_proof_not_ledger_bound")
        failures.append("retention_proof_required")


def _verify_workflow_run_ledger(root: Path, claim: dict[str, Any], reasons: list[str], failures: list[str]) -> None:
    rows = load_declared_jsonl(
        root / "enterprise" / "workflow-run-proofs.jsonl",
        expected_surface="enterprise_workflow_run_proofs",
    )
    run_ids = [str(item) for item in claim.get("workflow_run_ids") or []]
    for run_id in run_ids:
        match = next(
            (
                row for row in reversed(rows)
                if str(row.get("workflow_run_id") or row.get("run_id") or "") == run_id
                and str(row.get("readiness_claim_id") or "") == str(claim.get("readiness_claim_id") or "")
                and int(row.get("pr_number") or 0) == int(claim.get("pr_number") or 0)
                and str(row.get("head_sha") or "") == str(claim.get("head_sha") or "")
                and str(row.get("target_ref") or "") == str(claim.get("target_ref") or "")
                and row.get("conclusion") in {"success", "passed", True}
                and isinstance(row.get("ledger_hash"), str)
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
    artifact_hashes = claim.get("artifact_hashes") if isinstance(claim.get("artifact_hashes"), dict) else {}
    for artifact_path, artifact_hash in artifact_hashes.items():
        match = next(
            (
                row for row in reversed(rows)
                if str(row.get("artifact_path") or row.get("path") or "") == str(artifact_path)
                and str(row.get("artifact_hash") or row.get("sha256") or "") == str(artifact_hash)
                and str(row.get("readiness_claim_id") or "") == str(claim.get("readiness_claim_id") or "")
                and int(row.get("pr_number") or 0) == int(claim.get("pr_number") or 0)
                and str(row.get("head_sha") or "") == str(claim.get("head_sha") or "")
                and isinstance(row.get("ledger_hash"), str)
            ),
            None,
        )
        if match is None:
            reasons.append(f"artifact_hash_not_ledger_bound:{artifact_path}")
            failures.append("artifact_hashes_untrusted")


def _verify_simple_proof_ledger(
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
    rows = load_declared_jsonl(root / relative_path, expected_surface=surface)
    proof_id_key = f"{proof_name}_id"
    match = _find_claim_bound_proof(
        rows,
        claim,
        id_key=proof_id_key,
        id_value=str(proof.get(proof_id_key) or ""),
        hash_key="artifact_hash",
        hash_value=str(proof.get("artifact_hash") or proof.get("source_ledger_hash") or ""),
    )
    if match is None or match.get("valid") is not True:
        reasons.append(f"{proof_name}_not_ledger_bound")
        failures.append(failure_class)


def _find_claim_bound_proof(
    rows: list[dict[str, Any]],
    claim: dict[str, Any],
    *,
    id_key: str,
    id_value: str,
    hash_key: str,
    hash_value: str,
) -> dict[str, Any] | None:
    readiness_claim_id = str(claim.get("readiness_claim_id") or "")
    pr_number = int(claim.get("pr_number") or 0)
    head_sha = str(claim.get("head_sha") or "")
    target_ref = str(claim.get("target_ref") or "")
    for row in reversed(rows):
        if id_value and str(row.get(id_key) or "") != id_value:
            continue
        if hash_value and str(row.get(hash_key) or row.get("source_ledger_hash") or "") != hash_value:
            continue
        if str(row.get("readiness_claim_id") or "") != readiness_claim_id:
            continue
        if int(row.get("pr_number") or 0) != pr_number:
            continue
        if str(row.get("head_sha") or "") != head_sha:
            continue
        if str(row.get("target_ref") or "") != target_ref:
            continue
        if not isinstance(row.get("ledger_hash"), str):
            continue
        return row
    return None


__all__ = [
    "EnterpriseReadinessVerdict",
    "PrReadinessVerdict",
    "REQUIRED_READINESS_FIELDS",
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
    "verify_enterprise_readiness",
]
