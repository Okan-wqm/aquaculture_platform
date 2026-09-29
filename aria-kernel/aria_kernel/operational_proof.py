"""Closed-world, read-only Operational Proof capture and verification.

The proof lane is deliberately not a state writer.  It measures the already
restored ``aria/state`` worktree, packages the fixed burn-in evidence set, and
re-derives every acceptance fact from the downloaded bytes.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from .burn_in import _verify_burn_in_artifact_bundle_at
from .memory_gap import resolve_continuity_reference, store_is_at_published_tip
from .readiness_proofs import scan_paths_for_secrets
from .secure_artifact_io import (
    atomic_write_json_at,
    atomic_write_json_path,
    enumerate_regular_files_at,
    load_json_object_bytes,
    read_regular_file_at,
    read_regular_path,
    secure_directory_fd,
    stable_scan_paths_at,
)
from .state_store import (
    open_state_store,
    state_writer_attestation_path,
    tools_root,
    verify_state_store,
)
from .tool_registry import GovernanceError
from .workflow_contract_registry import (
    WORKFLOW_CONTRACTS,
    workflow_hash,
    workflow_job_contract,
    workflow_job_contract_hash,
)
from .workflow_contracts import verify_workflow_preflight_artifact_bytes
from .workspace import canonical_identity


STATE_SCHEMA = "aria/operational-proof-state/v1"
MANIFEST_SCHEMA = "aria/operational-proof-manifest/v1"
FAILURE_SCHEMA = "aria/operational-proof-failure/v1"
MANIFEST_NAME = "operational-proof-manifest.json"

SUCCESS_FILES: tuple[str, ...] = (
    "workflow-preflight.json",
    "state-store-verification.json",
    "cycles.json",
    "cycle-ledger-summary.json",
    "disallowed-actions.json",
    "manifest-tail-hashes.json",
    "candidate-detection.json",
    "autonomy-burn-in-report.json",
    "evidence-bundle.json",
    "postflight-verification.json",
    MANIFEST_NAME,
)
FAILURE_FILES: tuple[str, ...] = (
    "proof-failure-summary.json",
    "failure-report.json",
)

_STATE_KEYS = {
    "schema_version", "stage", "target_sha", "workflow_run_id",
    "workflow_run_attempt", "valid", "source", "state",
    "writer_attestation", "failure_classes",
}
_SOURCE_KEYS = {"head", "clean"}
_RESTORED_STATE_KEYS = {
    "branch", "reference_kind", "snapshot_id", "manifest_root",
    "verification_valid", "verification_status", "store_head", "remote_tip",
    "remote_tip_readable", "at_remote_tip", "clean", "host_identity_present",
}
_WRITER_KEYS = {"sha256", "size_bytes"}
_MANIFEST_KEYS = {
    "schema_version", "status", "target_sha", "workflow_run_id",
    "workflow_run_attempt", "files", "state_store_verification_hash",
    "postflight_verification_hash", "burn_in_report_hash",
}


@dataclass(frozen=True)
class OperationalProofVerdict:
    valid: bool
    status: str
    target_sha: str
    workflow_run_id: str
    workflow_run_attempt: int
    manifest_hash: str
    files: tuple[str, ...]


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, text=True, capture_output=True, check=True
    ).stdout.strip()


def _sha256(path: Path) -> str:
    return read_regular_path(path).sha256


def _empty_state_record(
    *, stage: str, target_sha: str, workflow_run_id: str,
    workflow_run_attempt: int,
) -> dict[str, Any]:
    return {
        "schema_version": STATE_SCHEMA,
        "stage": stage,
        "target_sha": target_sha,
        "workflow_run_id": workflow_run_id,
        "workflow_run_attempt": workflow_run_attempt,
        "valid": False,
        "source": {"head": None, "clean": False},
        "state": {
            "branch": None,
            "reference_kind": None,
            "snapshot_id": None,
            "manifest_root": None,
            "verification_valid": False,
            "verification_status": None,
            "store_head": None,
            "remote_tip": None,
            "remote_tip_readable": False,
            "at_remote_tip": False,
            "clean": False,
            "host_identity_present": False,
        },
        "writer_attestation": {"sha256": None, "size_bytes": None},
        "failure_classes": [],
    }


def capture_operational_state(
    repo_root: str | Path,
    *,
    stage: Literal["initial", "final"],
    target_sha: str,
    workflow_run_id: str,
    workflow_run_attempt: int,
) -> dict[str, Any]:
    """Measure the restored state without binding, repairing, or publishing it."""

    record = _empty_state_record(
        stage=stage,
        target_sha=target_sha,
        workflow_run_id=workflow_run_id,
        workflow_run_attempt=workflow_run_attempt,
    )
    failures: list[str] = record["failure_classes"]
    repo = Path(repo_root).resolve()
    if not _positive_int(workflow_run_attempt):
        failures.append("workflow_run_attempt_invalid")
    if stage not in {"initial", "final"}:
        failures.append("state_stage_invalid")
        return record

    try:
        head = _git(repo, "rev-parse", "HEAD")
        source_clean = not _git(
            repo, "status", "--porcelain", "--untracked-files=all"
        )
        record["source"] = {"head": head, "clean": source_clean}
        if head != target_sha:
            failures.append("source_head_mismatch")
        if not source_clean:
            failures.append("source_not_clean")
    except Exception:
        failures.append("source_unreadable")

    try:
        store = open_state_store(repo)
        state = record["state"]
        state["branch"] = store.branch
        state["clean"] = not _git(
            store.root, "status", "--porcelain", "--untracked-files=all"
        )
        if not state["clean"]:
            failures.append("state_store_not_clean")

        reference, reference_kind = resolve_continuity_reference(repo)
        state["reference_kind"] = reference_kind
        if reference_kind != "state_branch" or not isinstance(reference, dict):
            failures.append("state_reference_not_published")
        else:
            state["snapshot_id"] = reference.get("snapshot_id")
            state["manifest_root"] = reference.get("manifest_root")

        verification = verify_state_store(store, repo_hash=canonical_identity(repo))
        state["verification_valid"] = verification.get("valid") is True
        state["verification_status"] = verification.get("status")
        if not (
            state["verification_valid"]
            and state["verification_status"] == "ok"
        ):
            failures.append("state_verification_failed")

        descent = store_is_at_published_tip(repo)
        state["store_head"] = descent.head
        state["remote_tip"] = descent.tip or None
        state["remote_tip_readable"] = descent.readable
        state["at_remote_tip"] = descent.proven
        if not descent.readable:
            failures.append("state_remote_tip_unreadable")
        elif not descent.proven or descent.head != descent.tip:
            failures.append("state_not_at_remote_tip")

        identity_path = tools_root(store) / "repo_identity.json"
        state["host_identity_present"] = os.path.lexists(identity_path)
        if state["host_identity_present"]:
            failures.append("state_host_identity_present")

        writer = state_writer_attestation_path(store)
        try:
            writer_snapshot = read_regular_path(writer)
            if writer_snapshot.size_bytes <= 0:
                raise OSError("writer attestation is empty")
            record["writer_attestation"] = {
                "sha256": writer_snapshot.sha256,
                "size_bytes": writer_snapshot.size_bytes,
            }
        except OSError:
            failures.append("state_writer_attestation_unreadable")
    except Exception:
        failures.append("state_store_unreadable")

    record["failure_classes"] = list(dict.fromkeys(failures))
    record["valid"] = not record["failure_classes"]
    return record


def _failure_path_allowed(relative: str) -> bool:
    if relative in FAILURE_FILES:
        return True
    if not relative.startswith("failures/burnin-observe-") or not relative.endswith(".json"):
        return False
    name = relative.removeprefix("failures/burnin-observe-").removesuffix(".json")
    if len(name) != 20 or name[8] != "T" or name[15] != "Z" or name[16] != "-":
        return False
    return name[:8].isdigit() and name[9:15].isdigit() and name[17:].isdigit()


def _enumerate_files(root: Path) -> tuple[tuple[str, ...], list[str]]:
    try:
        with secure_directory_fd(root) as root_fd:
            return enumerate_regular_files_at(root_fd), []
    except GovernanceError:
        return (), ["proof_path_not_regular"]


def _file_records(root: Path, files: tuple[str, ...]) -> list[dict[str, Any]]:
    with secure_directory_fd(root) as root_fd:
        return _file_records_at(root_fd, files)


def _file_records_at(root_fd: int, files: tuple[str, ...]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for relative in files:
        if relative == MANIFEST_NAME:
            continue
        snapshot = read_regular_file_at(root_fd, relative)
        records.append({
            "path": relative,
            "sha256": snapshot.sha256,
            "size_bytes": snapshot.size_bytes,
        })
    return records


def write_operational_proof_manifest(
    proof_root: str | Path,
    *,
    target_sha: str,
    workflow_run_id: str,
    workflow_run_attempt: int,
) -> dict[str, Any]:
    root = Path(proof_root)
    with secure_directory_fd(root, create=True) as root_fd:
        files = enumerate_regular_files_at(root_fd)
        actual_without_manifest = set(files) - {MANIFEST_NAME}
        expected_without_manifest = set(SUCCESS_FILES) - {MANIFEST_NAME}
        if (
            actual_without_manifest != expected_without_manifest
            and not any(
                _failure_path_allowed(relative)
                for relative in actual_without_manifest
            )
        ):
            _write_operational_proof_failure_summary_at(
                root_fd,
                phase="incomplete_preburn_world",
                exit_status=None,
            )
            files = enumerate_regular_files_at(root_fd)
            actual_without_manifest = set(files) - {MANIFEST_NAME}
        authorized_without_manifest = tuple(
            sorted(
                relative
                for relative in actual_without_manifest
                if relative in expected_without_manifest or _failure_path_allowed(relative)
            )
        )
        closed_success = actual_without_manifest == expected_without_manifest
        snapshots = {
            relative: read_regular_file_at(root_fd, relative)
            for relative in authorized_without_manifest
        }
        manifest = {
            "schema_version": MANIFEST_SCHEMA,
            "status": "passed" if closed_success else "failed",
            "target_sha": target_sha,
            "workflow_run_id": workflow_run_id,
            "workflow_run_attempt": workflow_run_attempt,
            "files": [
                {
                    "path": relative,
                    "sha256": snapshots[relative].sha256,
                    "size_bytes": snapshots[relative].size_bytes,
                }
                for relative in authorized_without_manifest
            ],
            "state_store_verification_hash": snapshots.get(
                "state-store-verification.json"
            ).sha256 if "state-store-verification.json" in snapshots else None,
            "postflight_verification_hash": snapshots.get(
                "postflight-verification.json"
            ).sha256 if "postflight-verification.json" in snapshots else None,
            "burn_in_report_hash": snapshots.get(
                "autonomy-burn-in-report.json"
            ).sha256 if "autonomy-burn-in-report.json" in snapshots else None,
        }
        atomic_write_json_at(root_fd, MANIFEST_NAME, manifest)
    if manifest["status"] == "passed":
        verdict = verify_operational_proof_bundle(
            root,
            expected_target_sha=target_sha,
            expected_workflow_run_id=workflow_run_id,
            expected_workflow_run_attempt=workflow_run_attempt,
        )
        if not verdict.valid:
            manifest["status"] = "failed"
            with secure_directory_fd(root) as root_fd:
                atomic_write_json_at(root_fd, MANIFEST_NAME, manifest)
    return manifest


def _write_operational_proof_failure_summary_at(
    root_fd: int,
    *,
    phase: str,
    exit_status: int | None,
) -> dict[str, Any]:
    if not isinstance(phase, str) or not phase:
        raise GovernanceError("operational_proof_failure_phase_invalid")
    if exit_status is not None and (
        not isinstance(exit_status, int)
        or isinstance(exit_status, bool)
        or exit_status < 0
    ):
        raise GovernanceError("operational_proof_failure_exit_status_invalid")
    payload = {
        "schema_version": FAILURE_SCHEMA,
        "status": "failed",
        "phase": phase,
        "exit_status": exit_status,
    }
    atomic_write_json_at(root_fd, "proof-failure-summary.json", payload)
    return payload


def write_operational_proof_failure_summary(
    proof_root: str | Path,
    *,
    phase: str,
    exit_status: int | None,
) -> dict[str, Any]:
    with secure_directory_fd(proof_root, create=True) as root_fd:
        return _write_operational_proof_failure_summary_at(
            root_fd,
            phase=phase,
            exit_status=exit_status,
        )


def scan_operational_proof_for_secrets(
    proof_root: str | Path,
) -> tuple[Path, ...]:
    root = Path(proof_root)
    with secure_directory_fd(root) as root_fd:
        files = enumerate_regular_files_at(root_fd)
        _validate_dlp_file_world(files)
        with stable_scan_paths_at(root_fd, files) as scan_paths:
            findings = scan_paths_for_secrets(scan_paths)
            if findings:
                raise GovernanceError("operational_proof_dlp:secret_pattern_detected")
    return tuple(root / relative for relative in files)


def _validate_dlp_file_world(files: tuple[str, ...]) -> None:
    actual = set(files)
    expected_success = set(SUCCESS_FILES)
    failure_paths = {relative for relative in actual if _failure_path_allowed(relative)}
    bounded_failure = bool(failure_paths) and MANIFEST_NAME in actual and all(
        relative in expected_success or _failure_path_allowed(relative)
        for relative in actual
    )
    if not (actual == expected_success or bounded_failure):
        raise GovernanceError("operational_proof_dlp:invalid_file_world")


def _load_json_bytes(data: bytes) -> dict[str, Any]:
    return load_json_object_bytes(data)


def _canonical_hash(value: object) -> bool:
    return (
        isinstance(value, str) and len(value) == 71
        and value.startswith("sha256:")
        and all(char in "0123456789abcdef" for char in value[7:])
    )


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _state_record_valid(
    record: dict[str, Any], *, stage: str, target_sha: str,
    workflow_run_id: str, workflow_run_attempt: int,
) -> bool:
    if set(record) != _STATE_KEYS:
        return False
    source = record.get("source")
    restored = record.get("state")
    writer = record.get("writer_attestation")
    if not isinstance(source, dict) or set(source) != _SOURCE_KEYS:
        return False
    if not isinstance(restored, dict) or set(restored) != _RESTORED_STATE_KEYS:
        return False
    if not isinstance(writer, dict) or set(writer) != _WRITER_KEYS:
        return False
    size = writer.get("size_bytes")
    return bool(
        record.get("schema_version") == STATE_SCHEMA
        and record.get("stage") == stage
        and record.get("target_sha") == target_sha
        and record.get("workflow_run_id") == workflow_run_id
        and _positive_int(record.get("workflow_run_attempt"))
        and record.get("workflow_run_attempt") == workflow_run_attempt
        and record.get("valid") is True
        and record.get("failure_classes") == []
        and source == {"head": target_sha, "clean": True}
        and restored.get("branch") == "aria/state"
        and restored.get("reference_kind") == "state_branch"
        and isinstance(restored.get("snapshot_id"), str)
        and bool(restored.get("snapshot_id"))
        and _canonical_hash(restored.get("manifest_root"))
        and restored.get("verification_valid") is True
        and restored.get("verification_status") == "ok"
        and isinstance(restored.get("store_head"), str)
        and restored.get("store_head") == restored.get("remote_tip")
        and restored.get("remote_tip_readable") is True
        and restored.get("at_remote_tip") is True
        and restored.get("clean") is True
        and restored.get("host_identity_present") is False
        and _canonical_hash(writer.get("sha256"))
        and isinstance(size, int) and not isinstance(size, bool) and size > 0
    )


def _invalid_verdict(
    *, status: str, target_sha: str, workflow_run_id: str,
    workflow_run_attempt: int, manifest_hash: str = "", files: tuple[str, ...] = (),
) -> OperationalProofVerdict:
    return OperationalProofVerdict(
        False, status, target_sha, workflow_run_id, workflow_run_attempt,
        manifest_hash, files,
    )


def verify_operational_proof_bundle(
    proof_root: str | Path,
    *,
    expected_target_sha: str,
    expected_workflow_run_id: str,
    expected_workflow_run_attempt: int,
) -> OperationalProofVerdict:
    root = Path(proof_root)
    files: tuple[str, ...] = ()
    manifest_hash = ""
    invalid = lambda status: _invalid_verdict(
        status=status, target_sha=expected_target_sha,
        workflow_run_id=expected_workflow_run_id,
        workflow_run_attempt=expected_workflow_run_attempt,
        manifest_hash=manifest_hash, files=files,
    )
    if not _positive_int(expected_workflow_run_attempt):
        return invalid("expected_workflow_run_attempt_invalid")
    try:
        with secure_directory_fd(root):
            pass
    except GovernanceError:
        return invalid("invalid_file_world")
    try:
        with secure_directory_fd(root) as root_fd:
            files = enumerate_regular_files_at(root_fd)
            if set(files) != set(SUCCESS_FILES):
                return invalid("invalid_file_world")
            snapshots = {
                relative: read_regular_file_at(root_fd, relative)
                for relative in files
            }
            manifest_hash = snapshots[MANIFEST_NAME].sha256
            manifest = _load_json_bytes(snapshots[MANIFEST_NAME].data)
            if set(manifest) != _MANIFEST_KEYS:
                return invalid("invalid_manifest_schema")
            if not (
                manifest.get("schema_version") == MANIFEST_SCHEMA
                and manifest.get("status") == "passed"
                and manifest.get("target_sha") == expected_target_sha
                and manifest.get("workflow_run_id") == expected_workflow_run_id
                and _positive_int(manifest.get("workflow_run_attempt"))
                and manifest.get("workflow_run_attempt") == expected_workflow_run_attempt
            ):
                return invalid("manifest_binding_mismatch")

            records = manifest.get("files")
            if not isinstance(records, list) or len(records) != len(SUCCESS_FILES) - 1:
                return invalid("manifest_file_records_invalid")
            expected_record_paths = set(SUCCESS_FILES) - {MANIFEST_NAME}
            seen: set[str] = set()
            for file_record in records:
                if not isinstance(file_record, dict) or set(file_record) != {"path", "sha256", "size_bytes"}:
                    return invalid("manifest_file_record_schema_invalid")
                relative = file_record.get("path")
                size = file_record.get("size_bytes")
                if relative not in expected_record_paths or relative in seen:
                    return invalid("manifest_file_record_path_invalid")
                seen.add(relative)
                if not _canonical_hash(file_record.get("sha256")):
                    return invalid("manifest_file_hash_invalid")
                if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                    return invalid("manifest_file_size_invalid")
                snapshot = snapshots[str(relative)]
                if snapshot.sha256 != file_record["sha256"] or snapshot.size_bytes != size:
                    return invalid("manifest_file_drift")
            if seen != expected_record_paths:
                return invalid("manifest_file_records_incomplete")

            initial_snapshot = snapshots["state-store-verification.json"]
            final_snapshot = snapshots["postflight-verification.json"]
            report_snapshot = snapshots["autonomy-burn-in-report.json"]
            if not (
                manifest.get("state_store_verification_hash") == initial_snapshot.sha256
                and manifest.get("postflight_verification_hash") == final_snapshot.sha256
                and manifest.get("burn_in_report_hash") == report_snapshot.sha256
            ):
                return invalid("manifest_named_hash_mismatch")

            preflight_contract = WORKFLOW_CONTRACTS["aria-operational-proof"]
            preflight_job = workflow_job_contract("aria-operational-proof", "proof")
            if preflight_job is None:
                return invalid("workflow_preflight_invalid")
            source_root = Path(__file__).resolve().parents[2]
            preflight_reasons, _ = verify_workflow_preflight_artifact_bytes(
                snapshots["workflow-preflight.json"].data,
                contract=preflight_contract,
                job_contract=preflight_job,
                workflow_hash=workflow_hash(
                    source_root / preflight_contract.workflow_file
                ),
                contract_hash=workflow_job_contract_hash(
                    "aria-operational-proof", "proof"
                ),
            )
            if preflight_reasons:
                return invalid("workflow_preflight_invalid")

            initial = _load_json_bytes(initial_snapshot.data)
            final = _load_json_bytes(final_snapshot.data)
            if not _state_record_valid(
                initial, stage="initial", target_sha=expected_target_sha,
                workflow_run_id=expected_workflow_run_id,
                workflow_run_attempt=expected_workflow_run_attempt,
            ) or not _state_record_valid(
                final, stage="final", target_sha=expected_target_sha,
                workflow_run_id=expected_workflow_run_id,
                workflow_run_attempt=expected_workflow_run_attempt,
            ):
                return invalid("state_record_invalid")
            equality_paths = (
                ("source", "head"), ("state", "store_head"),
                ("state", "remote_tip"), ("state", "snapshot_id"),
                ("state", "manifest_root"), ("writer_attestation", "sha256"),
                ("writer_attestation", "size_bytes"),
            )
            if any(initial[parent][key] != final[parent][key] for parent, key in equality_paths):
                return invalid("state_immutability_mismatch")

            report = _load_json_bytes(report_snapshot.data)
            evidence = _load_json_bytes(snapshots["evidence-bundle.json"].data)
            for inner in (report, evidence):
                if not (
                    inner.get("base_commit_sha") == expected_target_sha
                    and inner.get("workflow_run_id") == expected_workflow_run_id
                    and _positive_int(inner.get("workflow_run_attempt"))
                    and inner.get("workflow_run_attempt") == expected_workflow_run_attempt
                ):
                    return invalid("inner_binding_mismatch")
            if not (
                report.get("target_ref") == expected_target_sha
                and evidence.get("target_ref") == expected_target_sha
            ):
                return invalid("inner_target_ref_mismatch")
            if report.get("acceptance_verdict") != "passed":
                return invalid("inner_verdict_not_passed")
            _verify_burn_in_artifact_bundle_at(root_fd)
            _validate_dlp_file_world(files)
            with stable_scan_paths_at(root_fd, files) as scan_paths:
                if scan_paths_for_secrets(scan_paths):
                    return invalid("secret_pattern_detected")
    except Exception:
        return invalid("verification_error")

    return OperationalProofVerdict(
        True, "passed", expected_target_sha, expected_workflow_run_id,
        expected_workflow_run_attempt, manifest_hash, files,
    )


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    atomic_write_json_path(path, payload)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 -m aria_kernel.operational_proof")
    commands = parser.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture-state")
    capture.add_argument("--stage", choices=("initial", "final"), required=True)
    capture.add_argument("--repo-root", required=True)
    capture.add_argument("--proof-root", required=True)
    capture.add_argument("--target-sha", required=True)
    capture.add_argument("--workflow-run-id", required=True)
    capture.add_argument("--workflow-run-attempt", type=int, required=True)
    manifest = commands.add_parser("write-manifest")
    manifest.add_argument("--proof-root", required=True)
    manifest.add_argument("--target-sha", required=True)
    manifest.add_argument("--workflow-run-id", required=True)
    manifest.add_argument("--workflow-run-attempt", type=int, required=True)
    failure = commands.add_parser("write-failure-summary")
    failure.add_argument("--proof-root", required=True)
    failure.add_argument("--phase", required=True)
    failure.add_argument("--exit-status", type=int, required=True)
    dlp = commands.add_parser("scan-dlp")
    dlp.add_argument("--proof-root", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--proof-root", required=True)
    verify.add_argument("--expected-target-sha", required=True)
    verify.add_argument("--expected-workflow-run-id", required=True)
    verify.add_argument("--expected-workflow-run-attempt", type=int, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "capture-state":
        record = capture_operational_state(
            args.repo_root, stage=args.stage, target_sha=args.target_sha,
            workflow_run_id=args.workflow_run_id,
            workflow_run_attempt=args.workflow_run_attempt,
        )
        root = Path(args.proof_root)
        filename = (
            "state-store-verification.json" if args.stage == "initial"
            else "postflight-verification.json"
        )
        _write_json(root / filename, record)
        print(json.dumps(record, sort_keys=True))
        return 0 if record["valid"] else 1
    if args.command == "write-manifest":
        manifest = write_operational_proof_manifest(
            args.proof_root, target_sha=args.target_sha,
            workflow_run_id=args.workflow_run_id,
            workflow_run_attempt=args.workflow_run_attempt,
        )
        print(json.dumps(manifest, sort_keys=True))
        return 0 if manifest["status"] == "passed" else 1
    if args.command == "write-failure-summary":
        summary = write_operational_proof_failure_summary(
            args.proof_root,
            phase=args.phase,
            exit_status=args.exit_status,
        )
        print(json.dumps(summary, sort_keys=True))
        return 0
    if args.command == "scan-dlp":
        try:
            paths = scan_operational_proof_for_secrets(args.proof_root)
        except GovernanceError as exc:
            print(json.dumps({"valid": False, "status": str(exc)}, sort_keys=True))
            return 1
        print(json.dumps({"valid": True, "files": [str(path) for path in paths]}, sort_keys=True))
        return 0
    verdict = verify_operational_proof_bundle(
        args.proof_root,
        expected_target_sha=args.expected_target_sha,
        expected_workflow_run_id=args.expected_workflow_run_id,
        expected_workflow_run_attempt=args.expected_workflow_run_attempt,
    )
    print(json.dumps(asdict(verdict), sort_keys=True))
    return 0 if verdict.valid else 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "OperationalProofVerdict",
    "capture_operational_state",
    "scan_operational_proof_for_secrets",
    "verify_operational_proof_bundle",
    "write_operational_proof_failure_summary",
    "write_operational_proof_manifest",
]
