#!/usr/bin/env bash
# Production deploy filesystem SSoT. Runtime code comes only from a verified
# exact-SHA bundle published by production-host-control-plane.sh; the target
# host's interactive checkout is retained solely as the persistent secret and
# certificate store and is never a Git or executable-code authority.

DEPLOY_CONTROL_ROOT=/var/lib/aqua/deploy
DEPLOY_SOURCE_ROOT=/var/lib/aqua/deploy/sources
DEPLOY_ENV_FILE=/var/aqua-saas/.env
DEPLOY_CERTS_DIR=/var/aqua-saas/certs

deploy_paths_die() {
  printf 'FATAL: %s\n' "$*" >&2
  return 2
}

deploy_require_sha() {
  local sha="$1"

  [[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || deploy_paths_die 'deploy SHA must be lowercase 40-hex.'
}

deploy_source_dir_for_sha() {
  local sha="$1"

  deploy_require_sha "${sha}" || return
  printf '%s/%s\n' "${DEPLOY_SOURCE_ROOT}" "${sha}"
}

configure_deploy_paths() {
  local sha="${1:?configure_deploy_paths requires a SHA}"
  local expected_source_dir

  deploy_require_sha "${sha}" || return
  expected_source_dir=$(deploy_source_dir_for_sha "${sha}") || return

  if [ -n "${DEPLOY_SOURCE_DIR:-}" ] && [ "${DEPLOY_SOURCE_DIR}" != "${expected_source_dir}" ]; then
    deploy_paths_die 'DEPLOY_SOURCE_DIR must be the canonical exact-SHA source directory.'
    return
  fi
  if [ -n "${DEPLOY_CHECKOUT_DIR:-}" ] && \
    [ "${DEPLOY_CHECKOUT_DIR}" != "${expected_source_dir}/repository" ]; then
    deploy_paths_die 'DEPLOY_CHECKOUT_DIR must be the canonical published repository directory.'
    return
  fi
  if [ -n "${PRODUCTION_HOST_MAIN_SHA:-}" ] && \
    [ "${PRODUCTION_HOST_MAIN_SHA}" != "${sha}" ]; then
    deploy_paths_die 'PRODUCTION_HOST_MAIN_SHA must match the requested deploy SHA.'
    return
  fi

  export DEPLOY_SHA="${sha}"
  export PRODUCTION_HOST_MAIN_SHA="${sha}"
  export DEPLOY_SOURCE_DIR="${expected_source_dir}"
  export DEPLOY_CHECKOUT_DIR="${DEPLOY_SOURCE_DIR}/repository"
  export DEPLOY_BUNDLE_METADATA_DIR="${DEPLOY_SOURCE_DIR}/metadata"
  export DEPLOY_RUNTIME_DIR="${DEPLOY_SOURCE_DIR}/runtime"
  export DEPLOY_BUNDLE_MANIFEST="${DEPLOY_BUNDLE_METADATA_DIR}/manifest.json"
  export DEPLOY_ENV_FILE
  export DEPLOY_CERTS_DIR
  # Compose reads interpolation values from the persistent secret file without
  # requiring a mutable .env symlink inside the immutable published source.
  export COMPOSE_ENV_FILES="${DEPLOY_ENV_FILE}"
  # Keep the historic production project identity so all existing named
  # volumes, networks and containers remain attached to `aqua-saas`.
  export COMPOSE_PROJECT_NAME=aqua-saas
}

prepare_deploy_env_file() {
  [ "$#" -le 1 ] || return 64
  local env_file=${1:-${DEPLOY_ENV_FILE}}
  local test_mode=''

  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || {
    deploy_paths_die 'Preparing the production environment file requires the exclusive host lock.'
    return
  }
  aqua_control_plane_guard_dr_state || return
  if [ "${env_file}" != "${DEPLOY_ENV_FILE}" ]; then
    if [ "${NODE_ENV:-}" != test ] || [ -z "${AQUA_CONTROL_PLANE_TEST_ROOT:-}" ]; then
      deploy_paths_die 'A production environment-file override is forbidden.'
      return
    fi
    case "${env_file}" in
      "${AQUA_CONTROL_PLANE_TEST_ROOT}"/*) test_mode=test ;;
      *) deploy_paths_die 'Test environment file must stay below the isolated control-plane root.'; return ;;
    esac
  fi

  /usr/bin/python3 - \
    "${env_file}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${test_mode}" <<'DEPLOY_ENV_FILE_PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
test_mode = sys.argv[3] == "test"
if not path.is_absolute() or path.name != ".env":
    raise SystemExit("production environment file path is not canonical")

current = pathlib.Path("/")
for part in path.parent.parts[1:]:
    current = current / part
    info = os.lstat(current)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"production environment ancestry is unsafe: {current}")
    if test_mode and current == pathlib.Path("/tmp"):
        continue
    if info.st_uid != expected_uid or info.st_mode & 0o022:
        raise SystemExit(f"production environment ancestry ownership/mode rejected: {current}")


def verify_file(expected_mode: int) -> os.stat_result:
    info = os.lstat(path)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != expected_mode
    ):
        raise SystemExit("production environment file ownership/type/mode rejected")
    return info


try:
    info = os.lstat(path)
except FileNotFoundError:
    descriptor = os.open(
        path,
        os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
else:
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_nlink != 1
    ):
        raise SystemExit("production environment file ownership/type/link rejected")
    mode = stat.S_IMODE(info.st_mode)
    if mode == 0o644:
        descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise SystemExit("production environment file identity changed")
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
            after = os.fstat(descriptor)
            if stat.S_IMODE(after.st_mode) != 0o600:
                raise SystemExit("production environment legacy convergence failed")
        finally:
            os.close(descriptor)
    elif mode != 0o600:
        raise SystemExit("production environment file mode is neither 0600 nor exact legacy 0644")

verify_file(0o600)
parent_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent_descriptor)
finally:
    os.close(parent_descriptor)
verify_file(0o600)
DEPLOY_ENV_FILE_PY
}

assert_deploy_source_bundle() {
  local sha="${1:?assert_deploy_source_bundle requires a SHA}"
  local helper

  configure_deploy_paths "${sha}" || return
  helper="${DEPLOY_CHECKOUT_DIR}/scripts/deploy/production-host-control-plane.sh"
  [ -f "${helper}" ] && [ ! -L "${helper}" ] || {
    deploy_paths_die 'published host-control helper is missing or is a symlink.'
    return
  }

  # shellcheck source=scripts/deploy/production-host-control-plane.sh
  source "${helper}"
  aqua_control_plane_verify_source
}

deploy_current_release_marker_io() {
  [ "$#" -eq 5 ] || return 64
  local operation=$1
  local sha=$2
  local release_id=$3
  local manifest_hash=$4
  local occurred_at=$5
  local release_root=${DEPLOY_STATE_ROOT:-/var/lib/aqua/deploy/releases}
  local marker_path="${AQUA_CONTROL_PLANE_ROOT}/current-release.json"

  /usr/bin/python3 - \
    "${operation}" "${marker_path}" "${release_root}" "${release_id}" \
    "${sha}" "${manifest_hash}" "${occurred_at}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" <<'PY'
import datetime
import hashlib
import json
import os
import pathlib
import re
import secrets
import stat
import sys

(
    operation,
    marker_path_raw,
    release_root_raw,
    release_id,
    main_sha,
    manifest_hash,
    occurred_at,
    expected_uid_raw,
) = sys.argv[1:]
expected_uid = int(expected_uid_raw)
marker_path = pathlib.Path(marker_path_raw)
release_root = pathlib.Path(release_root_raw)
sha_pattern = re.compile(r"^[0-9a-f]{40}$")
hash_pattern = re.compile(r"^[0-9a-f]{64}$")
release_pattern = re.compile(r"^([0-9a-f]{40})-([0-9]{8}T[0-9]{6}Z)$")
timestamp_pattern = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$"
)


def require_path(path: pathlib.Path, kind: str, exact_mode: int | None = None) -> os.stat_result:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(f"current-release {kind} symlink rejected: {path}")
    if kind == "directory" and not stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"current-release directory type mismatch: {path}")
    if kind == "file" and not stat.S_ISREG(info.st_mode):
        raise SystemExit(f"current-release file type mismatch: {path}")
    if info.st_uid != expected_uid or info.st_mode & 0o022:
        raise SystemExit(f"current-release ownership/mode rejected: {path}")
    if exact_mode is not None and stat.S_IMODE(info.st_mode) != exact_mode:
        raise SystemExit(f"current-release exact mode rejected: {path}")
    return info


def validate_timestamp(value: object) -> str:
    if not isinstance(value, str) or timestamp_pattern.fullmatch(value) is None:
        raise SystemExit("current-release timestamp is invalid")
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as error:
        raise SystemExit("current-release timestamp is invalid") from error
    return value


def read_marker() -> dict[str, object]:
    require_path(marker_path, "file", 0o400)
    try:
        document = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"current-release marker is unreadable: {error}") from error
    if not isinstance(document, dict) or set(document) != {
        "image_digest_manifest_sha256",
        "main_sha",
        "promoted_at",
        "release_id",
        "schema_version",
    }:
        raise SystemExit("current-release marker schema is invalid")
    if document.get("schema_version") != 1:
        raise SystemExit("current-release marker version is invalid")
    validate_timestamp(document.get("promoted_at"))
    return document


if operation not in {"publish", "read", "verify"}:
    raise SystemExit("current-release operation is invalid")

require_path(marker_path.parent, "directory")
require_path(release_root, "directory")
if operation == "read":
    document = read_marker()
    main_sha = document["main_sha"]
    release_id = document["release_id"]
    manifest_hash = document["image_digest_manifest_sha256"]
if sha_pattern.fullmatch(main_sha) is None or hash_pattern.fullmatch(manifest_hash) is None:
    raise SystemExit("current-release identity is invalid")
release_match = release_pattern.fullmatch(release_id)
if release_match is None or release_match.group(1) != main_sha:
    raise SystemExit("current-release release id does not match the main SHA")
release_directory = release_root / release_id
require_path(release_directory, "directory")
manifest_path = release_directory / "image-digests.tsv"
require_path(manifest_path, "file")
actual_manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
if actual_manifest_hash != manifest_hash:
    raise SystemExit("current-release image manifest hash mismatch")

if operation == "read":
    print(json.dumps(document, sort_keys=True, separators=(",", ":")))
    raise SystemExit(0)
if operation == "verify":
    document = read_marker()
    if document != {
        "image_digest_manifest_sha256": manifest_hash,
        "main_sha": main_sha,
        "promoted_at": document["promoted_at"],
        "release_id": release_id,
        "schema_version": 1,
    }:
        raise SystemExit("current-release marker does not match the requested release")
    raise SystemExit(0)

validate_timestamp(occurred_at)
if marker_path.exists() or marker_path.is_symlink():
    read_marker()
document = {
    "image_digest_manifest_sha256": manifest_hash,
    "main_sha": main_sha,
    "promoted_at": occurred_at,
    "release_id": release_id,
    "schema_version": 1,
}
temporary_path = marker_path.parent / f".current-release.{secrets.token_hex(12)}"
descriptor = os.open(
    temporary_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o400,
)
try:
    payload = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()
    with os.fdopen(descriptor, "wb", closefd=False) as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
finally:
    os.close(descriptor)
try:
    os.replace(temporary_path, marker_path)
    directory_descriptor = os.open(marker_path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
except BaseException:
    try:
        temporary_path.unlink()
    except FileNotFoundError:
        pass
    raise
read_marker()
PY
}

publish_deploy_current_release() {
  [ "$#" -eq 3 ] || return 64
  local sha=$1
  local release_id=$2
  local manifest_hash=$3
  local occurred_at

  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || {
    deploy_paths_die 'Publishing current-release proof requires the exclusive host lock.'
    return
  }
  aqua_control_plane_guard_dr_state || return
  occurred_at=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return
  deploy_current_release_marker_io \
    publish "${sha}" "${release_id}" "${manifest_hash}" "${occurred_at}"
}

assert_deploy_current_release() {
  [ "$#" -eq 3 ] || return 64
  aqua_control_plane_lock_assert || return
  aqua_control_plane_guard_dr_state || return
  deploy_current_release_marker_io verify "$1" "$2" "$3" ''
}

read_deploy_current_release() {
  [ "$#" -eq 0 ] || return 64
  aqua_control_plane_lock_assert || return
  aqua_control_plane_guard_dr_state || return
  deploy_current_release_marker_io read '' '' '' ''
}
