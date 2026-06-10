"""Operational burn-in proof primitives for ARIA observe mode."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from .artifact_safety import (
    DeclaredArtifactRef,
    SECRET_PATTERNS,
    read_safe_artifact,
    safe_finalize_artifact,
    scrub_text,
)
from .autonomy_state import AutonomyStateReducer
from .cycle import run_enterprise_cycle
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


REPORT_NAME = "autonomy-burn-in-report.json"
EVIDENCE_NAME = "evidence-bundle.json"
MANIFEST_NAME = "proof-manifest-v2.json"
_HASH_RE = re.compile(r"sha256:[0-9a-f]{64}")
_GIT_SHA_RE = re.compile(r"[0-9a-f]{40}")


def _sha256(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _git(workspace_root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=workspace_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise GovernanceError(
            f"burn_in_git_failed:{' '.join(args)}:{completed.stderr.strip()}"
        )
    return completed.stdout.strip()


def _resolve_target_sha(workspace_root: Path, target_ref: str) -> str:
    ref = target_ref.strip()
    if not ref:
        raise GovernanceError("burn_in_target_ref_required")
    return _git(workspace_root, "rev-parse", ref)


def _artifact_json(root: Path, relative_path: str, payload: dict[str, Any]) -> dict[str, Any]:
    raw = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    artifact = safe_finalize_artifact(
        raw,
        DeclaredArtifactRef(
            path=relative_path,
            root=root,
            purpose="burn_in",
            max_bytes=2 * 1024 * 1024,
        ),
    )
    return {
        "path": artifact.path.as_posix(),
        "size": artifact.size,
        "sha256": artifact.digest,
    }


def _dlp_result_for_bytes(raw: bytes) -> dict[str, Any]:
    text = raw.decode("utf-8", errors="replace")
    clean = scrub_text(text) == text
    return {
        "scanner": "aria_kernel.artifact_safety.scrub_text",
        "scanner_version": 1,
        "scanner_policy_hash": _sha256("|".join(pattern.pattern for pattern in SECRET_PATTERNS).encode("utf-8")),
        "result": "clean" if clean else "blocked",
        "scanned_at": utc_now(),
        "content_type": "application/json",
    }


def _manifest_artifact_entry(root: Path, relative_path: str) -> dict[str, Any]:
    artifact = read_safe_artifact(
        relative_path,
        root=root,
        purpose="burn_in",
        max_bytes=2 * 1024 * 1024,
    )
    dlp = _dlp_result_for_bytes(artifact.content)
    if dlp["result"] != "clean":
        raise GovernanceError(f"burn_in_artifact_dlp_blocked:{relative_path}")
    return {
        "path": relative_path,
        "sealed_file_path": artifact.path.as_posix(),
        "size": artifact.size,
        "sha256": artifact.digest,
        "dlp": dlp,
    }


def _fallback_hash(label: str, value: str) -> str:
    return _sha256(f"{label}:{value}".encode("utf-8"))


def _workflow_hash(workspace_root: Path, target_sha: str) -> str:
    explicit = os.environ.get("GITHUB_WORKFLOW_SHA")
    if explicit:
        return explicit
    workflow = workspace_root / ".github" / "workflows" / "aria-operational-proof.yml"
    if workflow.is_file():
        return _sha256(workflow.read_bytes())
    return _fallback_hash("local-workflow", target_sha)


def run_observe_burn_in(
    *,
    tools_dir: str | Path | None,
    workspace_root: str | Path,
    workspace_base: str | Path,
    target_ref: str,
    cycles: int,
    min_valid_cycles: int,
    output_dir: str | Path,
) -> dict[str, Any]:
    """Run a deterministic observe-mode burn-in and seal proof artifacts."""
    if cycles <= 0:
        raise GovernanceError("burn_in_cycles_must_be_positive")
    if min_valid_cycles <= 0:
        raise GovernanceError("burn_in_min_valid_cycles_must_be_positive")
    if min_valid_cycles > cycles:
        raise GovernanceError("burn_in_min_valid_cycles_exceeds_cycles")

    tools_root = ensure_tools_dir(tools_dir)
    workspace = Path(workspace_root).resolve(strict=True)
    workspace_base_path = Path(workspace_base).resolve()
    workspace_base_path.mkdir(parents=True, exist_ok=True)
    out = Path(output_dir).resolve()
    try:
        relative_out = out.relative_to(tools_root.resolve())
    except ValueError as exc:
        raise GovernanceError("burn_in_output_dir_must_be_under_tools_dir") from exc
    out.mkdir(parents=True, exist_ok=True)

    target_sha = _resolve_target_sha(workspace, target_ref)
    head_sha = _git(workspace, "rev-parse", "HEAD")
    if head_sha != target_sha:
        raise GovernanceError("burn_in_target_sha_mismatch")

    cycle_rows: list[dict[str, Any]] = []
    for index in range(1, cycles + 1):
        cycle_id = f"burn-in-{index:04d}"
        started_at = utc_now()
        status = "invalid"
        cycle_result: dict[str, Any] = {}
        error: str | None = None
        try:
            cycle_result = run_enterprise_cycle(
                workspace_root=workspace,
                workspace_base=workspace_base_path,
                base_dir=tools_root,
                cycle_id=cycle_id,
                discovery_only=True,
                snapshot_mode="committed",
            )
            head_after = _git(workspace, "rev-parse", "HEAD")
            status = (
                "valid"
                if cycle_result.get("status") == "completed" and head_after == target_sha
                else "invalid"
            )
        except Exception as exc:  # noqa: BLE001 - evidence must record failed cycles.
            head_after = _git(workspace, "rev-parse", "HEAD")
            error = scrub_text(f"{type(exc).__name__}: {exc}")
        AutonomyStateReducer.transition(
            tools_root,
            cycle_id=cycle_id,
            phase="cycle_completed",
            status="ok" if status == "valid" else "failed",
            profile="observe",
            details={
                "burn_in": True,
                "target_sha": target_sha,
                "head_after": head_after,
                "workspace_base": workspace_base_path.as_posix(),
            },
        )
        cycle_rows.append(
            {
                "cycle_id": cycle_id,
                "index": index,
                "status": status,
                "target_sha": target_sha,
                "head_after": head_after,
                "started_at": started_at,
                "completed_at": utc_now(),
                "cycle_result_hash": _sha256(
                    json.dumps(cycle_result, sort_keys=True, default=str).encode("utf-8")
                ),
                "error": error,
            }
        )

    valid_cycles = sum(1 for row in cycle_rows if row.get("status") == "valid")
    accepted = valid_cycles >= min_valid_cycles
    conditions = {
        "target_sha_bound": head_sha == target_sha,
        "min_valid_cycles_met": accepted,
        "artifact_bundle_sealed": True,
        "dlp_scan_clean": True,
    }
    run_id = os.environ.get("GITHUB_RUN_ID") or os.environ.get("RUN_ID") or f"local-{target_sha[:12]}"
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT") or "1"
    workflow_hash = _workflow_hash(workspace, target_sha)
    contract_hash = os.environ.get("ARIA_WORKFLOW_CONTRACT_HASH")
    if not contract_hash:
        if os.environ.get("GITHUB_ACTIONS") == "true":
            raise GovernanceError("burn_in_workflow_contract_hash_required")
        contract_hash = _fallback_hash("burn-in-contract-v2", workflow_hash)
    upload_name = os.environ.get("ARIA_UPLOAD_ARTIFACT_NAME") or f"aria-operational-proof-{run_id}-{run_attempt}"

    evidence = {
        "$schema": "aria/burn-in-evidence/v1",
        "schema_version": 1,
        "run_id": run_id,
        "target_ref": target_ref,
        "target_sha": target_sha,
        "git_head_sha_at_observe": head_sha,
        "workspace_root": workspace.as_posix(),
        "workspace_base": workspace_base_path.as_posix(),
        "tools_dir": tools_root.as_posix(),
        "output_dir": out.as_posix(),
        "cycle_rows": cycle_rows,
        "recorded_at": utc_now(),
    }
    _artifact_json(tools_root, (relative_out / EVIDENCE_NAME).as_posix(), evidence)

    report = {
        "$schema": "aria/burn-in-report/v1",
        "schema_version": 1,
        "run_id": run_id,
        "target_ref": target_ref,
        "target_sha": target_sha,
        "git_head_sha_at_observe": head_sha,
        "cycle_attempts": cycles,
        "valid_cycles": valid_cycles,
        "acceptance_conditions": conditions,
        "acceptance_verdict": "pass" if accepted else "fail",
        "evidence_bundle": EVIDENCE_NAME,
        "proof_manifest": MANIFEST_NAME,
        "recorded_at": utc_now(),
    }
    _artifact_json(tools_root, (relative_out / REPORT_NAME).as_posix(), report)

    manifest = {
        "$schema": "aria/proof-manifest/v2",
        "schema_version": 2,
        "proof_kind": "operational_burn_in_observe",
        "run_id": run_id,
        "run_attempt": run_attempt,
        "target_ref": target_ref,
        "target_sha": target_sha,
        "git_head_sha": head_sha,
        "workflow_hash": workflow_hash,
        "contract_hash": contract_hash,
        "upload": {
            "name": upload_name,
            "retention_days": int(os.environ.get("ARIA_UPLOAD_RETENTION_DAYS", "365")),
        },
        "artifacts": [
            _manifest_artifact_entry(tools_root, (relative_out / REPORT_NAME).as_posix()),
            _manifest_artifact_entry(tools_root, (relative_out / EVIDENCE_NAME).as_posix()),
        ],
        "recorded_at": utc_now(),
    }
    _artifact_json(tools_root, (relative_out / MANIFEST_NAME).as_posix(), manifest)

    verifier = verify_burn_in_artifact_bundle(out)
    returned_report = dict(report)
    returned_report["proof_manifest_hash"] = verifier["proof_manifest_hash"]
    returned_report["evidence_bundle_hash"] = verifier["evidence_bundle_hash"]
    returned_report["report_hash"] = verifier["report_hash"]

    if not accepted:
        raise GovernanceError("burn_in_acceptance_conditions_failed")
    return returned_report


def verify_burn_in_artifact_bundle(proof_dir: str | Path) -> dict[str, Any]:
    """Verify a burn-in proof directory without trusting reported hashes."""
    root = Path(proof_dir).resolve(strict=True)
    required = (REPORT_NAME, EVIDENCE_NAME, MANIFEST_NAME)
    artifacts: dict[str, bytes] = {}
    hashes: dict[str, str] = {}
    for name in required:
        path = root / name
        if not path.exists():
            raise GovernanceError(f"burn_in_artifact_missing:{name}")
        if not path.is_file():
            raise GovernanceError(f"burn_in_artifact_not_file:{name}")
        raw = path.read_bytes()
        if _dlp_result_for_bytes(raw)["result"] != "clean":
            raise GovernanceError(f"burn_in_artifact_dlp_blocked:{name}")
        artifacts[name] = raw
        hashes[name] = _sha256(raw)

    try:
        report = json.loads(artifacts[REPORT_NAME])
        evidence = json.loads(artifacts[EVIDENCE_NAME])
        manifest = json.loads(artifacts[MANIFEST_NAME])
    except json.JSONDecodeError as exc:
        raise GovernanceError("burn_in_artifact_json_invalid") from exc

    if manifest.get("schema_version") != 2:
        raise GovernanceError("burn_in_proof_manifest_v2_required")
    for field in ("proof_kind", "run_id", "run_attempt", "target_ref", "target_sha", "git_head_sha", "workflow_hash", "contract_hash"):
        if not isinstance(manifest.get(field), str) or not manifest.get(field, "").strip():
            raise GovernanceError(f"burn_in_manifest_required_field_missing:{field}")
    if manifest.get("proof_kind") != "operational_burn_in_observe":
        raise GovernanceError("burn_in_manifest_proof_kind_invalid")
    for field in ("target_sha", "git_head_sha"):
        if not _GIT_SHA_RE.fullmatch(str(manifest.get(field))):
            raise GovernanceError(f"burn_in_manifest_git_sha_invalid:{field}")
    for field in ("workflow_hash", "contract_hash"):
        if not _HASH_RE.fullmatch(str(manifest.get(field))):
            raise GovernanceError(f"burn_in_manifest_hash_invalid:{field}")
    upload = manifest.get("upload")
    if not isinstance(upload, dict):
        raise GovernanceError("burn_in_manifest_upload_required")
    if not isinstance(upload.get("name"), str) or not upload.get("name", "").strip():
        raise GovernanceError("burn_in_manifest_upload_name_required")
    expected_upload_name = f"aria-operational-proof-{manifest['run_id']}-{manifest['run_attempt']}"
    if upload.get("name") != expected_upload_name:
        raise GovernanceError("burn_in_manifest_upload_name_mismatch")
    if not isinstance(upload.get("retention_days"), int) or upload.get("retention_days") <= 0:
        raise GovernanceError("burn_in_manifest_upload_retention_invalid")
    if upload.get("retention_days") != 365:
        raise GovernanceError("burn_in_manifest_upload_retention_mismatch")
    if report.get("target_sha") != evidence.get("target_sha"):
        raise GovernanceError("burn_in_target_sha_mismatch")
    if report.get("target_sha") != manifest.get("target_sha"):
        raise GovernanceError("burn_in_manifest_target_sha_mismatch")
    if evidence.get("git_head_sha_at_observe") != manifest.get("git_head_sha"):
        raise GovernanceError("burn_in_manifest_git_head_mismatch")
    if report.get("acceptance_verdict") != "pass":
        raise GovernanceError("burn_in_acceptance_verdict_not_pass")

    names_by_hash = {
        REPORT_NAME: hashes[REPORT_NAME],
        EVIDENCE_NAME: hashes[EVIDENCE_NAME],
        MANIFEST_NAME: hashes[MANIFEST_NAME],
    }
    manifest_entries = manifest.get("artifacts")
    if not isinstance(manifest_entries, list) or len(manifest_entries) != 2:
        raise GovernanceError("burn_in_manifest_artifacts_incomplete")
    seen: set[str] = set()
    for entry in manifest_entries:
        if not isinstance(entry, dict):
            raise GovernanceError("burn_in_manifest_artifact_invalid")
        path = str(entry.get("path") or "")
        name = Path(path).name
        if name not in names_by_hash:
            raise GovernanceError(f"burn_in_manifest_unexpected_artifact:{path}")
        if name == MANIFEST_NAME:
            raise GovernanceError("burn_in_manifest_self_entry_forbidden")
        if entry.get("sha256") != names_by_hash[name]:
            raise GovernanceError(f"burn_in_manifest_hash_mismatch:{name}")
        dlp = entry.get("dlp", {})
        if dlp.get("result") != "clean":
            raise GovernanceError(f"burn_in_manifest_dlp_not_clean:{name}")
        for dlp_field in ("scanner", "scanner_version", "scanner_policy_hash", "scanned_at", "content_type"):
            if dlp.get(dlp_field) in (None, ""):
                raise GovernanceError(f"burn_in_manifest_dlp_field_missing:{name}:{dlp_field}")
        seen.add(name)
    missing = {REPORT_NAME, EVIDENCE_NAME} - seen
    if missing:
        raise GovernanceError(f"burn_in_manifest_missing:{','.join(sorted(missing))}")
    if not _HASH_RE.fullmatch(hashes[REPORT_NAME]):
        raise GovernanceError("burn_in_report_hash_invalid")
    return {
        "schema_version": 1,
        "status": "ok",
        "report_hash": hashes[REPORT_NAME],
        "evidence_bundle_hash": hashes[EVIDENCE_NAME],
        "proof_manifest_hash": hashes[MANIFEST_NAME],
        "target_sha": report.get("target_sha"),
        "valid_cycles": report.get("valid_cycles"),
    }


__all__ = [
    "EVIDENCE_NAME",
    "MANIFEST_NAME",
    "REPORT_NAME",
    "run_observe_burn_in",
    "verify_burn_in_artifact_bundle",
]
