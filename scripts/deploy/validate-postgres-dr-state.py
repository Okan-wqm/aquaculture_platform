#!/usr/bin/env python3
"""Single strict terminal DR receipt reader for every deploy admission path."""
import datetime
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
required_image = sys.argv[3] if len(sys.argv) == 4 else None
matched_image = False
sha40 = re.compile(r"^[0-9a-f]{40}$")
image = re.compile(r"^sha256:[0-9a-f]{64}$")
container_id = re.compile(r"^[0-9a-f]{64}$")
run_key = re.compile(r"^([0-9a-f]{40})-([1-9][0-9]*)-([1-9][0-9]*)$")
timestamp = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$"
)


def require_safe(path: pathlib.Path, directory: bool, mode: int) -> os.stat_result:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(f"DR state symlink rejected: {path}")
    if directory != stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"DR state type mismatch: {path}")
    if not directory:
        if not stat.S_ISREG(info.st_mode):
            raise SystemExit(f"DR state non-regular file rejected: {path}")
        if info.st_nlink != 1:
            raise SystemExit(f"DR state hard-linked file rejected: {path}")
        if info.st_size > 8 * 1024 * 1024:
            raise SystemExit(f"DR state file is unbounded: {path}")
    if info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != mode:
        raise SystemExit(f"DR state ownership/mode rejected: {path}")
    return info


def validate_timestamp(value: object, path: pathlib.Path) -> str:
    if not isinstance(value, str) or timestamp.fullmatch(value) is None:
        raise SystemExit(f"DR execution timestamp is invalid: {path}")
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as error:
        raise SystemExit(f"DR execution timestamp is invalid: {path}") from error
    return value


def read_json(path: pathlib.Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"DR execution artifact is unreadable or corrupt: {path}: {error}") from error


def read_json_stream(path: pathlib.Path) -> list[object]:
    try:
        value = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise SystemExit(f"DR execution artifact is unreadable or corrupt: {path}: {error}") from error
    decoder = json.JSONDecoder()
    offset = 0
    documents: list[object] = []
    try:
        while True:
            while offset < len(value) and value[offset].isspace():
                offset += 1
            if offset == len(value):
                break
            document, offset = decoder.raw_decode(value, offset)
            if isinstance(document, list):
                documents.extend(document)
            else:
                documents.append(document)
    except json.JSONDecodeError as error:
        raise SystemExit(f"DR execution artifact is unreadable or corrupt: {path}: {error}") from error
    return documents


if required_image is not None and image.fullmatch(required_image) is None:
    raise SystemExit("required PostgreSQL image identity is invalid")
require_safe(root, True, 0o700)
for entry in sorted(root.iterdir(), key=lambda value: value.name):
    if entry.name == "postgres-dr-bootstrap.lock":
        require_safe(entry, False, 0o600)
        continue
    require_safe(entry, True, 0o700)
    match = run_key.fullmatch(entry.name)
    if match is None:
        raise SystemExit(f"DR execution directory key is invalid: {entry.name}")
    children = {child.name: child for child in entry.iterdir()}
    if "phase.json" not in children:
        raise SystemExit(f"DR execution journal is missing: {entry / 'phase.json'}")
    for child in children.values():
        require_safe(child, False, 0o400)
    phase_path = entry / "phase.json"
    document = read_json(phase_path)
    version = document.get("schema_version") if isinstance(document, dict) else None
    expected_keys = {"candidate", "candidate_image_id", "occurred_at", "phase", "prior_image_id", "schema_version"}
    if version == 2:
        expected_keys |= {"mode", "recovery_point_sha256"}
    if not isinstance(document, dict) or set(document) != expected_keys or version not in {1, 2}:
        raise SystemExit(f"DR execution journal schema is invalid: {phase_path}")
    if version == 2 and (
        document.get("mode") not in {"healthy_upgrade", "degraded_legacy_recovery"}
        or re.fullmatch(r"[0-9a-f]{64}", str(document.get("recovery_point_sha256"))) is None
    ):
        raise SystemExit(f"DR v2 recovery binding is invalid: {phase_path}")
    candidate = document.get("candidate")
    if not isinstance(candidate, dict) or set(candidate) != {
        "image_digest", "main_sha", "repository", "run_attempt", "run_id",
    }:
        raise SystemExit(f"DR execution candidate is invalid: {phase_path}")
    if (
        candidate.get("repository") != "Okan-wqm/aquaculture_platform"
        or not isinstance(candidate.get("main_sha"), str)
        or sha40.fullmatch(candidate["main_sha"]) is None
        or candidate.get("main_sha") != match.group(1)
        or candidate.get("run_id") != match.group(2)
        or candidate.get("run_attempt") != match.group(3)
        or not isinstance(candidate.get("image_digest"), str)
        or image.fullmatch(candidate["image_digest"]) is None
    ):
        raise SystemExit(f"DR execution candidate/key mismatch: {phase_path}")
    if document.get("phase") not in {"COMMITTED", "ROLLED_BACK"}:
        raise SystemExit(f"DR execution state is unresolved: {phase_path}")
    validate_timestamp(document.get("occurred_at"), phase_path)
    if (
        not isinstance(document.get("prior_image_id"), str)
        or image.fullmatch(document["prior_image_id"]) is None
        or not isinstance(document.get("candidate_image_id"), str)
        or image.fullmatch(document["candidate_image_id"]) is None
    ):
        raise SystemExit(f"DR terminal image identities are invalid: {phase_path}")

    shared_artifacts = {
        "image-attestations.jsonl",
        "image-signature.json",
        "local-candidate.json",
        "phase.json",
        "postgres-forward.override.yml",
        "postgres-rollback.override.yml",
    }
    result_name = "result.json" if document["phase"] == "COMMITTED" else "rollback.json"
    expected_artifacts = shared_artifacts | {result_name}
    if version == 2:
        expected_artifacts.add("recovery-point.json")
        point_path = entry / "recovery-point.json"
        point = read_json(point_path)
        if hashlib.sha256(point_path.read_bytes()).hexdigest() != document["recovery_point_sha256"]:
            raise SystemExit(f"DR recovery point digest mismatch: {point_path}")
        if not isinstance(point, dict) or set(point) != {
            "schema_version", "run_key", "observed_image_id", "baseline_image_id", "data_volume",
            "snapshot_volume", "probe_volume", "snapshot_volume_created_at", "snapshot_sha256", "baseline_config_sha256", "verified_boot",
        } or (
            point.get("schema_version") != 2 or point.get("run_key") != entry.name
            or point.get("baseline_image_id") != document["prior_image_id"]
            or point.get("data_volume") != "aqua-saas_postgres_data"
            or point.get("snapshot_volume") != f"aqua-dr-point-{entry.name}"
            or point.get("probe_volume") != f"aqua-dr-probe-{entry.name}"
            or re.fullmatch(r"[0-9a-f]{64}", str(point.get("snapshot_sha256"))) is None
            or point.get("verified_boot") is not True
        ):
            raise SystemExit(f"DR recovery point contract mismatch: {point_path}")
    if set(children) != expected_artifacts:
        raise SystemExit(
            f"DR execution terminal artifact set is invalid: {entry}; "
            f"expected={sorted(expected_artifacts)} actual={sorted(children)}"
        )

    local_candidate_path = entry / "local-candidate.json"
    local_candidate = read_json(local_candidate_path)
    if not isinstance(local_candidate, dict) or set(local_candidate) != {
        "bootstrap", "build", "image", "materials", "policy",
        "postgres_dr_contract_sha256", "predicate_type", "schema_version", "source",
    }:
        raise SystemExit(f"DR local candidate schema is invalid: {local_candidate_path}")
    source = local_candidate.get("source")
    build = local_candidate.get("build")
    candidate_image = local_candidate.get("image")
    if (
        local_candidate.get("schema_version") != 1
        or local_candidate.get("predicate_type") !=
        "https://github.com/Okan-wqm/aquaculture_platform/attestations/"
        "postgres-dr-bootstrap-candidate/v1"
        or not isinstance(source, dict)
        or source.get("repository") != candidate["repository"]
        or source.get("main_sha") != candidate["main_sha"]
        or not isinstance(build, dict)
        or build.get("run_id") != candidate["run_id"]
        or build.get("run_attempt") != candidate["run_attempt"]
        or not isinstance(candidate_image, dict)
        or candidate_image.get("repository") !=
        "ghcr.io/okan-wqm/aquaculture_platform/postgres"
        or candidate_image.get("digest") != candidate["image_digest"]
        or candidate_image.get("reference") !=
        f"ghcr.io/okan-wqm/aquaculture_platform/postgres@{candidate['image_digest']}"
    ):
        raise SystemExit(f"DR local candidate identity is invalid: {local_candidate_path}")

    signature = read_json_stream(entry / "image-signature.json")
    if not signature or any(not isinstance(value, dict) for value in signature):
        raise SystemExit(f"DR image signature artifact is invalid: {entry}")
    attestations = read_json_stream(entry / "image-attestations.jsonl")
    if not attestations or any(not isinstance(value, dict) for value in attestations):
        raise SystemExit(f"DR image attestation artifact is invalid: {entry}")

    for override_name in (
        "postgres-forward.override.yml", "postgres-rollback.override.yml"
    ):
        try:
            override = (entry / override_name).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise SystemExit(f"DR compose override is corrupt: {entry / override_name}: {error}") from error
        if not override or "services:\n  postgres:\n    image: " not in override:
            raise SystemExit(f"DR compose override schema is invalid: {entry / override_name}")

    result_path = entry / result_name
    result = read_json(result_path)
    if document["phase"] == "COMMITTED":
        if not isinstance(result, dict) or set(result) != {
            "active_container_id", "completed_at", "image_digest", "image_id",
            "main_sha", "prior_image_id", "result", "run_attempt", "run_id",
        }:
            raise SystemExit(f"DR forward result is invalid: {result_path}")
        if (
            result.get("result") != "success"
            or result.get("main_sha") != candidate["main_sha"]
            or result.get("run_id") != candidate["run_id"]
            or result.get("run_attempt") != candidate["run_attempt"]
            or result.get("image_digest") != candidate["image_digest"]
            or result.get("image_id") != document["candidate_image_id"]
            or result.get("prior_image_id") != document["prior_image_id"]
            or not isinstance(result.get("active_container_id"), str)
            or container_id.fullmatch(result["active_container_id"]) is None
        ):
            raise SystemExit(f"DR forward result identity is invalid: {result_path}")
    else:
        if not isinstance(result, dict) or set(result) != {
            "active_container_id", "active_image_id", "candidate_image_id",
            "completed_at", "prior_image_id", "result",
        }:
            raise SystemExit(f"DR rollback result is invalid: {result_path}")
        if (
            result.get("result") != "rollback"
            or result.get("prior_image_id") != document["prior_image_id"]
            or result.get("active_image_id") != document["prior_image_id"]
            or result.get("candidate_image_id") != document["candidate_image_id"]
            or not isinstance(result.get("active_container_id"), str)
            or container_id.fullmatch(result["active_container_id"]) is None
        ):
            raise SystemExit(f"DR rollback result identity is invalid: {result_path}")
    validate_timestamp(result.get("completed_at"), result_path)
    if document["phase"] == "COMMITTED" and result.get("image_id") == required_image:
        matched_image = True

if required_image is not None and not matched_image:
    raise SystemExit("recovery-receipt-missing: no committed result matches the running image")
