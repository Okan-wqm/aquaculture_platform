#!/usr/bin/env bash
# Root-owned production host control plane: one lock, one immutable source
# publisher, and one exact verification path for deploy, capacity, DR, and
# post-deploy consumers.

set +x
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# BEGIN control-plane-ghcr-credential-demotion
# The remote payload exports its bounded entrypoint environment before this
# exact-SHA helper starts. Keep the package-read credential shell-local while
# source verification, publication, DR checks, and lock acquisition spawn
# children; restore it only for the final entrypoint exec below.
AQUA_CONTROL_PLANE_GHCR_TOKEN_PRESENT=false
AQUA_CONTROL_PLANE_GHCR_TOKEN_MATERIAL=
if [ "${GHCR_TOKEN+x}" = x ]; then
  AQUA_CONTROL_PLANE_GHCR_TOKEN_PRESENT=true
  AQUA_CONTROL_PLANE_GHCR_TOKEN_MATERIAL=${GHCR_TOKEN}
  unset GHCR_TOKEN
fi
if ! export -n AQUA_CONTROL_PLANE_GHCR_TOKEN_PRESENT \
  AQUA_CONTROL_PLANE_GHCR_TOKEN_MATERIAL 2>/dev/null; then
  builtin printf 'FATAL: GHCR credential demotion failed.\n' >&2
  exit 2
fi
# END control-plane-ghcr-credential-demotion

readonly AQUA_PRODUCTION_CONTROL_ROOT_DEFAULT=/var/lib/aqua/deploy
readonly AQUA_PRODUCTION_CONTROL_LOCK_NAME=control-plane.lock
readonly AQUA_PRODUCTION_CONTROL_LOCK_DEFAULT=/var/lib/aqua/deploy/control-plane.lock
readonly AQUA_PRODUCTION_SOURCES_ROOT_DEFAULT=/var/lib/aqua/deploy/sources
readonly AQUA_PRODUCTION_DR_STATE_ROOT_DEFAULT=/var/lib/aqua/deploy/dr-bootstrap
readonly AQUA_PRODUCTION_RELEASES_ROOT_DEFAULT=/var/lib/aqua/deploy/releases
readonly AQUA_PRODUCTION_SOURCE_FORMAT=aqua-production-host-runtime-v1
readonly AQUA_PRODUCTION_DOCKER_MAX_CONTAINERS=1024
readonly AQUA_PRODUCTION_DOCKER_PS_MAX_BYTES=$(((AQUA_PRODUCTION_DOCKER_MAX_CONTAINERS + 1) * 65))
readonly AQUA_PRODUCTION_DOCKER_INSPECT_MAX_BYTES=33554432
readonly AQUA_PRODUCTION_DOCKER_CAPTURE_TIMEOUT_SECONDS=30
readonly AQUA_PRODUCTION_DOCKER_CAPTURE_KILL_SECONDS=5

aqua_control_plane_die() {
  printf 'FATAL: %s\n' "$*" >&2
  return 2
}

aqua_control_plane_initialize_paths() {
  if [ -n "${AQUA_CONTROL_PLANE_TEST_ROOT:-}" ]; then
    [ "${NODE_ENV:-}" = test ] || \
      aqua_control_plane_die 'AQUA_CONTROL_PLANE_TEST_ROOT is accepted only under NODE_ENV=test.' || return
    case "${AQUA_CONTROL_PLANE_TEST_ROOT}" in
      /tmp/?*) ;;
      *) aqua_control_plane_die 'AQUA_CONTROL_PLANE_TEST_ROOT must be below /tmp.' || return ;;
    esac
    case "${AQUA_CONTROL_PLANE_TEST_ROOT}" in
      *//* | */./* | */. | */../* | */.. | */)
        aqua_control_plane_die 'AQUA_CONTROL_PLANE_TEST_ROOT is not canonical.' || return
        ;;
    esac
    [[ "${AQUA_CONTROL_PLANE_TEST_ROOT}" =~ ^/tmp/[A-Za-z0-9._/-]+$ ]] || \
      aqua_control_plane_die 'AQUA_CONTROL_PLANE_TEST_ROOT contains unsafe characters.' || return
    AQUA_CONTROL_PLANE_ROOT=${AQUA_CONTROL_PLANE_TEST_ROOT}
    AQUA_CONTROL_PLANE_EXPECTED_UID=${EUID}
  else
    [ "${EUID}" -eq 0 ] || \
      aqua_control_plane_die 'Production host control-plane operations require root.' || return
    AQUA_CONTROL_PLANE_ROOT=${AQUA_PRODUCTION_CONTROL_ROOT_DEFAULT}
    AQUA_CONTROL_PLANE_EXPECTED_UID=0
  fi
  if [ -n "${AQUA_CONTROL_PLANE_TEST_ROOT:-}" ]; then
    AQUA_CONTROL_PLANE_LOCK_PATH="${AQUA_CONTROL_PLANE_ROOT}/${AQUA_PRODUCTION_CONTROL_LOCK_NAME}"
    AQUA_CONTROL_PLANE_SOURCES_ROOT="${AQUA_CONTROL_PLANE_ROOT}/sources"
    AQUA_CONTROL_PLANE_DR_STATE_ROOT="${AQUA_CONTROL_PLANE_ROOT}/dr-bootstrap"
    AQUA_CONTROL_PLANE_RELEASES_ROOT="${AQUA_CONTROL_PLANE_ROOT}/releases"
  else
    AQUA_CONTROL_PLANE_LOCK_PATH=${AQUA_PRODUCTION_CONTROL_LOCK_DEFAULT}
    AQUA_CONTROL_PLANE_SOURCES_ROOT=${AQUA_PRODUCTION_SOURCES_ROOT_DEFAULT}
    AQUA_CONTROL_PLANE_DR_STATE_ROOT=${AQUA_PRODUCTION_DR_STATE_ROOT_DEFAULT}
    AQUA_CONTROL_PLANE_RELEASES_ROOT=${AQUA_PRODUCTION_RELEASES_ROOT_DEFAULT}
  fi
  export AQUA_CONTROL_PLANE_ROOT AQUA_CONTROL_PLANE_LOCK_PATH
  export AQUA_CONTROL_PLANE_SOURCES_ROOT AQUA_CONTROL_PLANE_DR_STATE_ROOT
  export AQUA_CONTROL_PLANE_RELEASES_ROOT
}

aqua_control_plane_require_safe_directory() {
  [ "$#" -eq 2 ] || return 64
  local path=$1
  local required_mode=$2
  [ -d "${path}" ] && [ ! -L "${path}" ] || \
    aqua_control_plane_die "Unsafe control-plane directory: ${path}" || return
  [ "$(/usr/bin/stat -Lc '%u' -- "${path}")" = "${AQUA_CONTROL_PLANE_EXPECTED_UID}" ] || \
    aqua_control_plane_die "Control-plane directory has the wrong owner: ${path}" || return
  [ "$(/usr/bin/stat -Lc '%a' -- "${path}")" = "${required_mode}" ] || \
    aqua_control_plane_die "Control-plane directory has the wrong mode: ${path}" || return
}

aqua_control_plane_ensure_root() {
  aqua_control_plane_initialize_paths || return
  /usr/bin/python3 - \
    "${AQUA_CONTROL_PLANE_ROOT}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" \
    "${AQUA_CONTROL_PLANE_TEST_ROOT:+test}" <<'PY'
import os
import pathlib
import stat
import sys

path = pathlib.PurePosixPath(sys.argv[1])
expected_uid = int(sys.argv[2])
test_mode = sys.argv[3] == "test"
if not path.is_absolute() or str(path) == "/":
    raise SystemExit("control-plane root must be a non-root absolute path")
current = pathlib.Path("/")
parts = path.parts[1:]
for index, part in enumerate(parts):
    current = current / part
    try:
        info = os.lstat(current)
    except FileNotFoundError:
        os.mkdir(current, 0o700)
        info = os.lstat(current)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"control-plane path component is not a real directory: {current}")
    is_root = index == len(parts) - 1

    # Production trusts only the fixed root-owned, non-writable /var/lib/aqua
    # ancestry. Tests use an equivalent owner-pinned ancestry below /tmp; the
    # sticky /tmp boundary itself is the sole intentional exception.
    trusted_test_boundary = test_mode and current == pathlib.Path("/tmp")
    if current != pathlib.Path("/") and not trusted_test_boundary:
        if info.st_uid != expected_uid:
            label = "root" if is_root else "parent"
            raise SystemExit(f"control-plane {label} owner mismatch: {current}")
        if not is_root and info.st_mode & 0o022:
            raise SystemExit(f"control-plane parent directory is writable: {current}")

    if not is_root:
        continue

    mode = stat.S_IMODE(info.st_mode)
    if mode == 0o700:
        continue
    if mode != 0o755:
        raise SystemExit(f"control-plane root mode mismatch: {current}")

    # /var/lib/aqua/deploy was historically created by mkdir -p under umask
    # 022. Converge only that exact safe legacy shape: a real owner-pinned
    # 0755 directory below a non-writable ancestry. Operate on a no-follow
    # descriptor and prove that the path still names the same inode after the
    # mode transition so an unsafe replacement can never be blessed.
    descriptor = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(before.st_mode)
            or before.st_uid != expected_uid
            or stat.S_IMODE(before.st_mode) != 0o755
            or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)
        ):
            raise SystemExit(f"control-plane legacy root identity changed: {current}")
        os.fchmod(descriptor, 0o700)
        os.fsync(descriptor)
        after = os.fstat(descriptor)
        path_after = os.lstat(current)
        if (
            not stat.S_ISDIR(after.st_mode)
            or after.st_uid != expected_uid
            or stat.S_IMODE(after.st_mode) != 0o700
            or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
            or stat.S_ISLNK(path_after.st_mode)
            or not stat.S_ISDIR(path_after.st_mode)
            or (path_after.st_dev, path_after.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise SystemExit(f"control-plane legacy root convergence failed: {current}")
    finally:
        os.close(descriptor)
PY
  aqua_control_plane_require_safe_directory "${AQUA_CONTROL_PLANE_ROOT}" 700 || return

  if [ ! -e "${AQUA_CONTROL_PLANE_SOURCES_ROOT}" ] && \
     [ ! -L "${AQUA_CONTROL_PLANE_SOURCES_ROOT}" ]; then
    /usr/bin/mkdir -m 0700 -- "${AQUA_CONTROL_PLANE_SOURCES_ROOT}"
    /usr/bin/sync -f "${AQUA_CONTROL_PLANE_ROOT}"
  fi
  aqua_control_plane_require_safe_directory "${AQUA_CONTROL_PLANE_SOURCES_ROOT}" 700
}

aqua_control_plane_prepare_releases_root() {
  [ "$#" -eq 1 ] || return 64
  local create_if_missing=$1
  case "${create_if_missing}" in
    true | false) ;;
    *) aqua_control_plane_die 'Release-root creation policy must be true or false.' || return ;;
  esac
  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || \
    aqua_control_plane_die 'Preparing the release root requires the exclusive host lock.' || return
  aqua_control_plane_ensure_root || return

  /usr/bin/python3 - \
    "${AQUA_CONTROL_PLANE_RELEASES_ROOT}" "${AQUA_CONTROL_PLANE_ROOT}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${create_if_missing}" <<'RELEASE_ROOT_PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
parent = pathlib.Path(sys.argv[2])
expected_uid = int(sys.argv[3])
create_if_missing = sys.argv[4] == "true"
if path != parent / "releases":
    raise SystemExit("release root path is not canonical")

parent_info = os.lstat(parent)
if (
    stat.S_ISLNK(parent_info.st_mode)
    or not stat.S_ISDIR(parent_info.st_mode)
    or parent_info.st_uid != expected_uid
    or stat.S_IMODE(parent_info.st_mode) != 0o700
):
    raise SystemExit("release root parent is unsafe")

try:
    info = os.lstat(path)
except FileNotFoundError:
    if not create_if_missing:
        raise SystemExit(0)
    parent_descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened_parent = os.fstat(parent_descriptor)
        if (
            not stat.S_ISDIR(opened_parent.st_mode)
            or opened_parent.st_uid != expected_uid
            or stat.S_IMODE(opened_parent.st_mode) != 0o700
            or (opened_parent.st_dev, opened_parent.st_ino)
            != (parent_info.st_dev, parent_info.st_ino)
        ):
            raise SystemExit("release root parent identity changed")
        os.mkdir("releases", 0o700, dir_fd=parent_descriptor)
        os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)
    info = os.lstat(path)

if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
    raise SystemExit("release root is not a real directory")
if info.st_uid != expected_uid:
    raise SystemExit("release root owner mismatch")
mode = stat.S_IMODE(info.st_mode)
if mode not in {0o700, 0o755}:
    raise SystemExit("release root mode is neither 0700 nor exact legacy 0755")

descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(before.st_mode)
        or before.st_uid != expected_uid
        or stat.S_IMODE(before.st_mode) != mode
        or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)
    ):
        raise SystemExit("release root identity changed")
    if mode == 0o755:
        os.fchmod(descriptor, 0o700)
        os.fsync(descriptor)
    after = os.fstat(descriptor)
    path_after = os.lstat(path)
    if (
        not stat.S_ISDIR(after.st_mode)
        or after.st_uid != expected_uid
        or stat.S_IMODE(after.st_mode) != 0o700
        or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
        or stat.S_ISLNK(path_after.st_mode)
        or not stat.S_ISDIR(path_after.st_mode)
        or path_after.st_uid != expected_uid
        or stat.S_IMODE(path_after.st_mode) != 0o700
        or (path_after.st_dev, path_after.st_ino) != (before.st_dev, before.st_ino)
    ):
        raise SystemExit("release root convergence failed")
finally:
    os.close(descriptor)
RELEASE_ROOT_PY
}

aqua_control_plane_require_lock_file() {
  [ -f "${AQUA_CONTROL_PLANE_LOCK_PATH}" ] && \
    [ ! -L "${AQUA_CONTROL_PLANE_LOCK_PATH}" ] || \
    aqua_control_plane_die 'Control-plane lock must be a regular non-symlink file.' || return
  [ "$(/usr/bin/stat -Lc '%u' -- "${AQUA_CONTROL_PLANE_LOCK_PATH}")" = \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" ] || \
    aqua_control_plane_die 'Control-plane lock owner mismatch.' || return
  [ "$(/usr/bin/stat -Lc '%a' -- "${AQUA_CONTROL_PLANE_LOCK_PATH}")" = 600 ] || \
    aqua_control_plane_die 'Control-plane lock mode must be 0600.' || return
  [ "$(/usr/bin/stat -Lc '%h' -- "${AQUA_CONTROL_PLANE_LOCK_PATH}")" = 1 ] || \
    aqua_control_plane_die 'Control-plane lock must have exactly one hard link.' || return
}

aqua_control_plane_validate_lock_fd() {
  [ "$#" -eq 1 ] || return 64
  local fd=$1
  [[ "${fd}" =~ ^([3-9]|[1-9][0-9]+)$ ]] || \
    aqua_control_plane_die 'Inherited control-plane lock FD is invalid.' || return
  [ -e "/proc/${BASHPID}/fd/${fd}" ] || \
    aqua_control_plane_die 'Inherited control-plane lock FD is closed.' || return
  aqua_control_plane_require_lock_file || return
  local path_identity fd_identity
  path_identity=$(/usr/bin/stat -Lc '%d:%i' -- "${AQUA_CONTROL_PLANE_LOCK_PATH}")
  fd_identity=$(/usr/bin/stat -Lc '%d:%i' -- "/proc/${BASHPID}/fd/${fd}")
  [ "${path_identity}" = "${fd_identity}" ] || \
    aqua_control_plane_die 'Control-plane lock path/inherited-FD inode mismatch.' || return
}

aqua_control_plane_lock_acquire() {
  local requested_mode=${1:-exclusive}
  local timeout_seconds=${2:-${AQUA_CONTROL_PLANE_LOCK_TIMEOUT_SECONDS:-900}}
  case "${requested_mode}" in
    exclusive | shared) ;;
    *) aqua_control_plane_die 'Lock mode must be exclusive or shared.' || return ;;
  esac
  [[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]] && [ "${timeout_seconds}" -le 7200 ] || \
    aqua_control_plane_die 'Control-plane lock timeout must be 1..7200 seconds.' || return

  aqua_control_plane_ensure_root || return
  if [ ! -e "${AQUA_CONTROL_PLANE_LOCK_PATH}" ] && \
     [ ! -L "${AQUA_CONTROL_PLANE_LOCK_PATH}" ]; then
    (set -o noclobber; umask 077; : > "${AQUA_CONTROL_PLANE_LOCK_PATH}") 2>/dev/null || true
    /usr/bin/sync -f "${AQUA_CONTROL_PLANE_ROOT}"
  fi
  aqua_control_plane_require_lock_file || return

  local fd=${AQUA_CONTROL_PLANE_LOCK_FD:-}
  local held_mode=${AQUA_CONTROL_PLANE_LOCK_MODE:-}
  if [ -n "${fd}" ]; then
    aqua_control_plane_validate_lock_fd "${fd}" || return
  else
    exec {fd}<>"${AQUA_CONTROL_PLANE_LOCK_PATH}"
    aqua_control_plane_validate_lock_fd "${fd}" || return
  fi

  if [ "${held_mode}" = exclusive ]; then
    requested_mode=exclusive
  fi
  if [ "${requested_mode}" = exclusive ]; then
    /usr/bin/flock --exclusive --timeout "${timeout_seconds}" "${fd}" || \
      aqua_control_plane_die 'Timed out acquiring the production control-plane lock.' || return
    held_mode=exclusive
  else
    /usr/bin/flock --shared --timeout "${timeout_seconds}" "${fd}" || \
      aqua_control_plane_die 'Timed out acquiring the shared production control-plane lock.' || return
    held_mode=shared
  fi

  AQUA_CONTROL_PLANE_LOCK_FD=${fd}
  AQUA_CONTROL_PLANE_LOCK_MODE=${held_mode}
  export AQUA_CONTROL_PLANE_LOCK_FD AQUA_CONTROL_PLANE_LOCK_MODE
  aqua_control_plane_validate_lock_fd "${fd}"
}

aqua_control_plane_lock_assert() {
  [ -n "${AQUA_CONTROL_PLANE_LOCK_FD:-}" ] || \
    aqua_control_plane_die 'Production control-plane lock is not held.' || return
  aqua_control_plane_validate_lock_fd "${AQUA_CONTROL_PLANE_LOCK_FD}" || return
  case "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" in
    exclusive)
      /usr/bin/flock --exclusive --nonblock "${AQUA_CONTROL_PLANE_LOCK_FD}" || \
        aqua_control_plane_die 'Exclusive control-plane lock assertion failed.' || return
      ;;
    shared)
      /usr/bin/flock --shared --nonblock "${AQUA_CONTROL_PLANE_LOCK_FD}" || \
        aqua_control_plane_die 'Shared control-plane lock assertion failed.' || return
      ;;
    *) aqua_control_plane_die 'Control-plane lock mode is missing.' || return ;;
  esac
}

aqua_control_plane_descendant_bundle_proof() {
  [ "$#" -eq 1 ] || return 64
  local predecessor_sha=$1
  : "${PRODUCTION_HOST_BUNDLE_PATH:?PRODUCTION_HOST_BUNDLE_PATH required}"
  : "${PRODUCTION_HOST_BUNDLE_SHA256:?PRODUCTION_HOST_BUNDLE_SHA256 required}"
  : "${PRODUCTION_HOST_MAIN_SHA:?PRODUCTION_HOST_MAIN_SHA required}"
  [[ "${predecessor_sha}" =~ ^[0-9a-f]{40}$ ]] || return 64
  [[ "${PRODUCTION_HOST_MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]] || return 64
  [[ "${PRODUCTION_HOST_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || return 64
  [ "${predecessor_sha}" != "${PRODUCTION_HOST_MAIN_SHA}" ] || \
    aqua_control_plane_die 'A supersession candidate must differ from its predecessor.' || return
  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || \
    aqua_control_plane_die 'Descendant authorization requires the exclusive host lock.' || return

  /usr/bin/python3 - \
    "${PRODUCTION_HOST_BUNDLE_PATH}" "${PRODUCTION_HOST_BUNDLE_SHA256}" \
    "${PRODUCTION_HOST_MAIN_SHA}" "${predecessor_sha}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${AQUA_PRODUCTION_SOURCE_FORMAT}" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import tarfile

bundle_raw, expected_bundle_hash, current_sha, predecessor_sha, expected_uid_raw, expected_format = sys.argv[1:]
bundle = pathlib.Path(bundle_raw)
expected_uid = int(expected_uid_raw)
sha40 = re.compile(r"^[0-9a-f]{40}$")
sha256 = re.compile(r"^[0-9a-f]{64}$")
info = os.lstat(bundle)
if (
    stat.S_ISLNK(info.st_mode)
    or not stat.S_ISREG(info.st_mode)
    or info.st_uid != expected_uid
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o600
    or not 0 < info.st_size <= 536870912
):
    raise SystemExit("production host bundle is unsafe for descendant authorization")
actual_bundle_hash = hashlib.sha256(bundle.read_bytes()).hexdigest()
if actual_bundle_hash != expected_bundle_hash:
    raise SystemExit("production host bundle digest mismatch during descendant authorization")

targets = {
    "metadata/manifest.json": (0o644, 16384),
    "metadata/first-parent-ancestry.tsv": (0o644, 1024 * 41),
}
payloads: dict[str, bytes] = {}
member_count = 0
expanded_bytes = 0
with tarfile.open(bundle, mode="r|gz") as archive:
    for member in archive:
        member_count += 1
        if member_count > 100000:
            raise SystemExit("production host bundle member count is unbounded")
        if member.size < 0:
            raise SystemExit("production host bundle member size is invalid")
        expanded_bytes += member.size
        if expanded_bytes > 2147483648:
            raise SystemExit("production host bundle expanded size is unbounded")
        if member.name not in targets:
            continue
        if member.name in payloads:
            raise SystemExit(f"duplicate descendant proof member: {member.name}")
        expected_mode, maximum_size = targets[member.name]
        if (
            not member.isreg()
            or member.uid != 0
            or member.gid != 0
            or int(member.mtime) != 0
            or member.mode != expected_mode
            or not 0 < member.size <= maximum_size
        ):
            raise SystemExit(f"descendant proof member metadata is invalid: {member.name}")
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit(f"descendant proof member is unreadable: {member.name}")
        payloads[member.name] = extracted.read(maximum_size + 1)
if set(payloads) != set(targets):
    raise SystemExit("descendant proof members are incomplete")

try:
    manifest = json.loads(payloads["metadata/manifest.json"].decode("utf-8", "strict"))
except (UnicodeError, json.JSONDecodeError) as error:
    raise SystemExit("descendant proof manifest is corrupt") from error
ancestry_bytes = payloads["metadata/first-parent-ancestry.tsv"]
if not isinstance(manifest, dict) or (
    manifest.get("format") != expected_format
    or manifest.get("main_sha") != current_sha
    or sha256.fullmatch(str(manifest.get("first_parent_ancestry_hash"))) is None
    or not isinstance(manifest.get("first_parent_ancestry_count"), int)
    or isinstance(manifest.get("first_parent_ancestry_count"), bool)
):
    raise SystemExit("descendant proof manifest identity is invalid")
proof_hash = hashlib.sha256(ancestry_bytes).hexdigest()
if proof_hash != manifest["first_parent_ancestry_hash"]:
    raise SystemExit("descendant proof ancestry hash mismatch")
if not ancestry_bytes.endswith(b"\n") or b"\r" in ancestry_bytes or b"\0" in ancestry_bytes:
    raise SystemExit("descendant proof ancestry is not canonical")
try:
    ancestry = ancestry_bytes.decode("ascii", "strict").splitlines()
except UnicodeDecodeError as error:
    raise SystemExit("descendant proof ancestry is not ASCII") from error
if (
    not 1 <= len(ancestry) <= 1024
    or manifest["first_parent_ancestry_count"] != len(ancestry)
    or ancestry[0] != current_sha
    or len(ancestry) != len(set(ancestry))
    or any(sha40.fullmatch(value) is None for value in ancestry)
):
    raise SystemExit("descendant proof ancestry identity/count is invalid")
if ancestry.count(predecessor_sha) != 1 or ancestry.index(predecessor_sha) == 0:
    raise SystemExit("candidate is not a bounded first-parent descendant of the predecessor")
print(proof_hash)
PY
}

aqua_control_plane_descendant_source_proof() {
  [ "$#" -eq 1 ] || return 64
  local predecessor_sha=$1
  : "${PRODUCTION_HOST_MAIN_SHA:?PRODUCTION_HOST_MAIN_SHA required}"
  [[ "${predecessor_sha}" =~ ^[0-9a-f]{40}$ ]] || return 64
  [[ "${PRODUCTION_HOST_MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]] || return 64
  [ "${predecessor_sha}" != "${PRODUCTION_HOST_MAIN_SHA}" ] || return 1
  aqua_control_plane_lock_assert || return
  local source_root="${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${PRODUCTION_HOST_MAIN_SHA}"
  aqua_control_plane_verify_published_source \
    "${PRODUCTION_HOST_MAIN_SHA}" "${source_root}" || return
  /usr/bin/python3 - \
    "${source_root}/metadata/manifest.json" \
    "${source_root}/metadata/first-parent-ancestry.tsv" \
    "${PRODUCTION_HOST_MAIN_SHA}" "${predecessor_sha}" <<'PY'
import hashlib
import json
import pathlib
import re
import sys

manifest_path, ancestry_path, current_sha, predecessor_sha = sys.argv[1:]
manifest = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
ancestry_bytes = pathlib.Path(ancestry_path).read_bytes()
proof_hash = hashlib.sha256(ancestry_bytes).hexdigest()
ancestry = ancestry_bytes.decode("ascii", "strict").splitlines()
if (
    manifest.get("main_sha") != current_sha
    or manifest.get("first_parent_ancestry_hash") != proof_hash
    or manifest.get("first_parent_ancestry_count") != len(ancestry)
    or not 1 <= len(ancestry) <= 1024
    or ancestry[0] != current_sha
    or len(ancestry) != len(set(ancestry))
    or any(re.fullmatch(r"[0-9a-f]{40}", value) is None for value in ancestry)
    or ancestry.count(predecessor_sha) != 1
    or ancestry.index(predecessor_sha) == 0
):
    raise SystemExit("published source does not prove the requested first-parent descent")
print(proof_hash)
PY
}

aqua_control_plane_guard_release_transaction() {
  [ "$#" -le 1 ] || return 64
  local guard_mode=${1:-guard}
  case "${guard_mode}" in guard|discover) ;; *) return 64 ;; esac
  aqua_control_plane_lock_assert || return
  /usr/bin/python3 - \
    "${AQUA_CONTROL_PLANE_ROOT}/active-release-transaction.json" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" \
    "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" \
    "${AQUA_DEPLOY_TRANSACTION_OWNER_RELEASE_ID:-}" \
    "${AQUA_CONTROL_PLANE_SUPERSESSION_AUTHORIZED:-false}" \
    "${AQUA_DEPLOY_SUPERSEDES_RELEASE_ID:-}" \
    "${AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA:-}" \
    "${AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256:-}" \
    "${PRODUCTION_HOST_MAIN_SHA:-}" \
    "${guard_mode}" <<'RELEASE_TRANSACTION_GUARD_PY'
import datetime
import json
import os
import pathlib
import re
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
lock_mode = sys.argv[3]
owner_release_id = sys.argv[4]
supersession_authorized = sys.argv[5]
supersedes_release_id = sys.argv[6]
supersedes_candidate_sha = sys.argv[7]
supersession_proof = sys.argv[8]
successor_sha = sys.argv[9]
guard_mode = sys.argv[10]
sha_pattern = re.compile(r"^[0-9a-f]{40}$")
hash_pattern = re.compile(r"^[0-9a-f]{64}$")
release_pattern = re.compile(r"^([0-9a-f]{40})-[0-9]{8}T[0-9]{6}Z$")
service_pattern = re.compile(r"^[a-z0-9][a-z0-9-]*$")
timestamp_pattern = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$"
)
phases = {
    "PREPARED",
    "MUTATION_STARTED",
    "DB_COMPLETE",
    "LIVE_CANDIDATE",
    "LIVE_VERIFIED",
    "FORWARD_REQUIRED",
    "FINALIZING",
    "LEDGER_PROMOTED",
    "ROLLBACK_STARTED",
    "ROLLED_BACK",
    "COMMITTED",
}
keys = {
    "candidate_sha",
    "deploy_services",
    "failure_phase",
    "full_deploy",
    "image_digest_manifest_sha256",
    "migrations_applied",
    "occurred_at",
    "phase",
    "prior_release",
    "release_id",
    "rollback_manifest_sha256",
    "rollback_policy",
    "schema_version",
    "supersedes_candidate_sha",
    "supersedes_release_id",
    "supersession_proof_sha256",
}
legacy_keys = keys - {
    "rollback_policy",
    "supersedes_candidate_sha",
    "supersedes_release_id",
    "supersession_proof_sha256",
}
marker_keys = {
    "image_digest_manifest_sha256",
    "main_sha",
    "promoted_at",
    "release_id",
    "schema_version",
}


try:
    info = os.lstat(path)
except FileNotFoundError:
    raise SystemExit(0)
if (
    stat.S_ISLNK(info.st_mode)
    or not stat.S_ISREG(info.st_mode)
    or info.st_uid != expected_uid
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o400
    or info.st_size <= 0
    or info.st_size > 16384
):
    raise SystemExit("release transaction journal is unsafe")
try:
    document = json.loads(path.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    raise SystemExit("release transaction journal is corrupt") from error
schema_version = document.get("schema_version") if isinstance(document, dict) else None
expected_keys = legacy_keys if schema_version == 1 else keys
if (
    not isinstance(document, dict)
    or schema_version not in {1, 2}
    or set(document) != expected_keys
):
    raise SystemExit("release transaction journal schema is invalid")
candidate_sha = document.get("candidate_sha")
release_id = document.get("release_id")
release_match = release_pattern.fullmatch(str(release_id))
if (
    not isinstance(candidate_sha, str)
    or sha_pattern.fullmatch(candidate_sha) is None
    or release_match is None
    or release_match.group(1) != candidate_sha
    or document.get("phase") not in phases
    or not isinstance(document.get("full_deploy"), bool)
    or hash_pattern.fullmatch(str(document.get("image_digest_manifest_sha256"))) is None
    or hash_pattern.fullmatch(str(document.get("rollback_manifest_sha256"))) is None
):
    raise SystemExit("release transaction journal identity is invalid")
rollback_policy = (
    "ALLOW_ZERO_MIGRATION" if schema_version == 1 else document.get("rollback_policy")
)
stored_supersedes_release_id = document.get("supersedes_release_id")
stored_supersedes_candidate_sha = document.get("supersedes_candidate_sha")
stored_supersession_proof = document.get("supersession_proof_sha256")
if rollback_policy == "ALLOW_ZERO_MIGRATION":
    if any(
        value is not None
        for value in (
            stored_supersedes_release_id,
            stored_supersedes_candidate_sha,
            stored_supersession_proof,
        )
    ):
        raise SystemExit("zero-migration rollback policy has supersession metadata")
elif rollback_policy == "FORWARD_ONLY":
    stored_match = release_pattern.fullmatch(str(stored_supersedes_release_id))
    if (
        stored_match is None
        or stored_match.group(1) != stored_supersedes_candidate_sha
        or sha_pattern.fullmatch(str(stored_supersedes_candidate_sha)) is None
        or stored_supersedes_candidate_sha == candidate_sha
        or hash_pattern.fullmatch(str(stored_supersession_proof)) is None
    ):
        raise SystemExit("forward-only rollback policy metadata is invalid")
else:
    raise SystemExit("release transaction rollback policy is invalid")
services = document.get("deploy_services")
if (
    not isinstance(services, list)
    or not services
    or "db-migrate" not in services
    or len(services) > 64
    or len(services) != len(set(services))
    or any(not isinstance(service, str) or service_pattern.fullmatch(service) is None for service in services)
):
    raise SystemExit("release transaction service scope is invalid")
migrations = document.get("migrations_applied")
if migrations is not None and (not isinstance(migrations, int) or isinstance(migrations, bool) or migrations < 0):
    raise SystemExit("release transaction migration count is invalid")
failure = document.get("failure_phase")
if failure is not None and (
    not isinstance(failure, str)
    or len(failure) > 128
    or re.fullmatch(r"[a-z0-9_-]+", failure) is None
):
    raise SystemExit("release transaction failure phase is invalid")
occurred_at = document.get("occurred_at")
if not isinstance(occurred_at, str) or timestamp_pattern.fullmatch(occurred_at) is None:
    raise SystemExit("release transaction timestamp is invalid")
try:
    datetime.datetime.strptime(occurred_at, "%Y-%m-%dT%H:%M:%SZ")
except ValueError as error:
    raise SystemExit("release transaction timestamp is invalid") from error
prior = document.get("prior_release")
if prior is not None:
    if not isinstance(prior, dict) or set(prior) != marker_keys or prior.get("schema_version") != 1:
        raise SystemExit("release transaction prior release schema is invalid")
    prior_sha = prior.get("main_sha")
    prior_release_id = prior.get("release_id")
    prior_match = release_pattern.fullmatch(str(prior_release_id))
    if (
        not isinstance(prior_sha, str)
        or sha_pattern.fullmatch(prior_sha) is None
        or prior_match is None
        or prior_match.group(1) != prior_sha
        or hash_pattern.fullmatch(str(prior.get("image_digest_manifest_sha256"))) is None
        or not isinstance(prior.get("promoted_at"), str)
        or timestamp_pattern.fullmatch(prior["promoted_at"]) is None
    ):
        raise SystemExit("release transaction prior release identity is invalid")
if document["phase"] in {"COMMITTED", "ROLLED_BACK"}:
    raise SystemExit(0)
if guard_mode == "discover":
    print(
        release_id,
        candidate_sha,
        document["phase"],
        rollback_policy,
        schema_version,
        sep="\t",
    )
    raise SystemExit(0)
if (
    document["phase"] == "FORWARD_REQUIRED"
    and lock_mode == "exclusive"
    and supersession_authorized == "true"
    and supersedes_release_id == release_id
    and supersedes_candidate_sha == candidate_sha
    and hash_pattern.fullmatch(supersession_proof) is not None
    and sha_pattern.fullmatch(successor_sha) is not None
    and successor_sha != candidate_sha
):
    raise SystemExit(0)
if lock_mode != "exclusive" or owner_release_id != release_id:
    raise SystemExit(
        f"release transaction {release_id} is unresolved at phase {document['phase']}"
    )
RELEASE_TRANSACTION_GUARD_PY
}

aqua_control_plane_upgrade_legacy_release_transaction() {
  [ "$#" -eq 2 ] || return 64
  local expected_release_id=$1
  local expected_candidate_sha=$2
  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || \
    aqua_control_plane_die 'Legacy release journal upgrade requires the exclusive host lock.' || return
  /usr/bin/python3 - \
    "${AQUA_CONTROL_PLANE_ROOT}/active-release-transaction.json" \
    "${AQUA_CONTROL_PLANE_ROOT}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" \
    "${expected_release_id}" "${expected_candidate_sha}" <<'PY'
import json
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
expected_uid = int(sys.argv[3])
expected_release_id = sys.argv[4]
expected_candidate_sha = sys.argv[5]
stage_path = root / ".active-release-transaction.legacy-upgrade"


def read_safe(candidate: pathlib.Path) -> tuple[dict, bytes] | None:
    try:
        info = os.lstat(candidate)
    except FileNotFoundError:
        return None
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o400
        or not 0 < info.st_size <= 16384
    ):
        raise SystemExit("legacy release journal upgrade file is unsafe")
    raw = candidate.read_bytes()
    if not raw.endswith(b"\n"):
        raise SystemExit("legacy release journal upgrade file is noncanonical")
    document = json.loads(raw.decode("utf-8"))
    if not isinstance(document, dict):
        raise SystemExit("legacy release journal upgrade document is invalid")
    return document, raw


current_result = read_safe(path)
if current_result is None:
    raise SystemExit("legacy release journal disappeared during upgrade")
current = current_result[0]
if (
    current.get("release_id") != expected_release_id
    or current.get("candidate_sha") != expected_candidate_sha
):
    raise SystemExit("legacy release journal identity changed during upgrade")
if current.get("schema_version") == 2:
    raise SystemExit(0)
if current.get("schema_version") != 1 or current.get("phase") in {"COMMITTED", "ROLLED_BACK"}:
    raise SystemExit("legacy release journal is not an unresolved v1 transaction")
document = {
    **current,
    "rollback_policy": "ALLOW_ZERO_MIGRATION",
    "schema_version": 2,
    "supersedes_candidate_sha": None,
    "supersedes_release_id": None,
    "supersession_proof_sha256": None,
}
payload = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode()
staged = read_safe(stage_path)
if staged is not None:
    if staged[1] != payload:
        raise SystemExit("legacy release journal upgrade staging mismatch")
else:
    descriptor = os.open(
        stage_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o400,
    )
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(descriptor)
os.replace(stage_path, path)
root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(root_fd)
finally:
    os.close(root_fd)
PY
}

aqua_control_plane_prepare_release_recovery() {
  [ "$#" -gt 0 ] || return 64
  local metadata
  local release_id
  local candidate_sha
  local phase
  local rollback_policy
  local schema_version
  local proof_hash
  metadata=$(aqua_control_plane_guard_release_transaction discover) || return
  [ -n "${metadata}" ] || return 0
  IFS=$'\t' read -r release_id candidate_sha phase rollback_policy schema_version <<< "${metadata}"
  if [ "${schema_version}" = 1 ]; then
    aqua_control_plane_upgrade_legacy_release_transaction \
      "${release_id}" "${candidate_sha}" || return
    metadata=$(aqua_control_plane_guard_release_transaction discover) || return
    IFS=$'\t' read -r release_id candidate_sha phase rollback_policy schema_version <<< "${metadata}"
    [ "${schema_version}" = 2 ] || \
      aqua_control_plane_die 'Legacy release journal upgrade did not converge.' || return
  fi
  if [ "${1:-}" = /bin/bash ] && \
    { [ "${2:-}" = scripts/deploy/droplet-up.sh ] || \
      [ "${2:-}" = scripts/deploy/droplet-capacity.sh ]; } && \
    [ "${phase}" = FORWARD_REQUIRED ] && \
    [ "${PRODUCTION_HOST_MAIN_SHA:-}" != "${candidate_sha}" ]; then
    proof_hash=$(aqua_control_plane_descendant_bundle_proof "${candidate_sha}") || return
    AQUA_DEPLOY_ROLLBACK_POLICY=FORWARD_ONLY
    AQUA_DEPLOY_SUPERSEDES_RELEASE_ID=${release_id}
    AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA=${candidate_sha}
    AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256=${proof_hash}
    AQUA_CONTROL_PLANE_SUPERSESSION_AUTHORIZED=true
    export AQUA_DEPLOY_ROLLBACK_POLICY AQUA_DEPLOY_SUPERSEDES_RELEASE_ID
    export AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256
    export AQUA_CONTROL_PLANE_SUPERSESSION_AUTHORIZED
    aqua_control_plane_guard_release_transaction
    return
  fi
  if [ "${1:-}" != /bin/bash ] || \
    { [ "${2:-}" != scripts/deploy/droplet-up.sh ] && \
      [ "${2:-}" != scripts/deploy/droplet-capacity.sh ]; } || \
    [ "${PRODUCTION_HOST_MAIN_SHA:-}" != "${candidate_sha}" ]; then
    aqua_control_plane_die \
      "Release ${release_id} requires exact-candidate recovery from phase ${phase}." || return
  fi
  AQUA_DEPLOY_TRANSACTION_OWNER_RELEASE_ID=${release_id}
  AQUA_DEPLOY_RECOVERY_ONLY=true
  export AQUA_DEPLOY_TRANSACTION_OWNER_RELEASE_ID AQUA_DEPLOY_RECOVERY_ONLY
  if [ "${2:-}" = scripts/deploy/droplet-capacity.sh ]; then
    AQUA_CONTROL_PLANE_RECOVER_BEFORE_CHILD=true
    export AQUA_CONTROL_PLANE_RECOVER_BEFORE_CHILD
  fi
  aqua_control_plane_guard_release_transaction
}

aqua_control_plane_prepare_bootstrap_gc_rollover() {
  [ "$#" -gt 0 ] || return 64
  if [ "${1:-}" != /bin/bash ] || \
    { [ "${2:-}" != scripts/deploy/droplet-up.sh ] && \
      [ "${2:-}" != scripts/deploy/droplet-capacity.sh ]; }; then
    return 0
  fi
  local marker_path="${AQUA_CONTROL_PLANE_ROOT}/current-release.json"
  if [ -L "${marker_path}" ]; then
    aqua_control_plane_die 'Current-release marker symlink blocks bootstrap rollover.' || return
  fi
  [ ! -e "${marker_path}" ] || return 0

  local unresolved
  unresolved=$(aqua_control_plane_guard_release_transaction discover) || return
  [ -z "${unresolved}" ] || return 0
  local authority_path="${AQUA_CONTROL_PLANE_ROOT}/bootstrap-image-gc.json"
  if [ ! -e "${authority_path}" ] && [ ! -L "${authority_path}" ]; then
    return 0
  fi
  local metadata
  local state
  local predecessor_sha
  local predecessor_epoch
  metadata=$(
    /usr/bin/python3 - \
      "${authority_path}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" <<'PY'
import datetime
import json
import os
import pathlib
import re
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
info = os.lstat(path)
if (
    stat.S_ISLNK(info.st_mode)
    or not stat.S_ISREG(info.st_mode)
    or info.st_uid != expected_uid
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o400
    or not 0 < info.st_size <= 4096
):
    raise SystemExit("bootstrap GC authority is unsafe")
document = json.loads(path.read_text(encoding="utf-8"))
state = document.get("state")
version = document.get("schema_version")
required = {"claimed_at", "incoming_sha", "schema_version", "state"}
if state == "COMPLETED":
    required.add("completed_at")
if version == 2:
    required.update({"epoch", "predecessor_sha", "supersession_proof_sha256"})
if not isinstance(document, dict) or set(document) != required or version not in {1, 2}:
    raise SystemExit("bootstrap GC authority schema is invalid")
incoming_sha = document.get("incoming_sha")
epoch = 1 if version == 1 else document.get("epoch")
previous = None if version == 1 else document.get("predecessor_sha")
proof = None if version == 1 else document.get("supersession_proof_sha256")
if (
    state not in {"CLAIMED", "COMPLETED"}
    or re.fullmatch(r"[0-9a-f]{40}", str(incoming_sha)) is None
    or not isinstance(epoch, int)
    or isinstance(epoch, bool)
    or not 1 <= epoch <= 1000000
):
    raise SystemExit("bootstrap GC authority identity is invalid")
if epoch == 1:
    if previous is not None or proof is not None:
        raise SystemExit("initial bootstrap GC authority has rollover metadata")
elif (
    re.fullmatch(r"[0-9a-f]{40}", str(previous)) is None
    or previous == incoming_sha
    or re.fullmatch(r"[0-9a-f]{64}", str(proof)) is None
):
    raise SystemExit("bootstrap GC authority rollover metadata is invalid")
for field in {"claimed_at", "completed_at"} & set(document):
    datetime.datetime.strptime(document[field], "%Y-%m-%dT%H:%M:%SZ")
print(state, incoming_sha, epoch, sep="\t")
PY
  ) || return
  IFS=$'\t' read -r state predecessor_sha predecessor_epoch <<< "${metadata}"
  if [ "${predecessor_sha}" = "${PRODUCTION_HOST_MAIN_SHA:-}" ]; then
    [ "${state}" = COMPLETED ] || \
      aqua_control_plane_die 'Markerless bootstrap GC has an incomplete epoch.' || return
    return 0
  fi
  [ "${state}" = COMPLETED ] || \
    aqua_control_plane_die 'Markerless bootstrap GC has an incomplete epoch.' || return
  local proof_hash
  proof_hash=$(aqua_control_plane_descendant_bundle_proof "${predecessor_sha}") || return
  AQUA_CONTROL_PLANE_BOOTSTRAP_ROLLOVER_AUTHORIZED=true
  AQUA_BOOTSTRAP_GC_PREDECESSOR_SHA=${predecessor_sha}
  AQUA_BOOTSTRAP_GC_PREDECESSOR_EPOCH=${predecessor_epoch}
  AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256=${proof_hash}
  export AQUA_CONTROL_PLANE_BOOTSTRAP_ROLLOVER_AUTHORIZED
  export AQUA_BOOTSTRAP_GC_PREDECESSOR_SHA AQUA_BOOTSTRAP_GC_PREDECESSOR_EPOCH
  export AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256
}

aqua_control_plane_guard_dr_state() {
  aqua_control_plane_lock_assert || return
  aqua_control_plane_guard_release_transaction || return
  [ ! -L "${AQUA_CONTROL_PLANE_DR_STATE_ROOT}" ] || \
    aqua_control_plane_die 'PostgreSQL DR state root must not be a symlink.' || return
  [ -e "${AQUA_CONTROL_PLANE_DR_STATE_ROOT}" ] || return 0

  /usr/bin/python3 - \
    "${AQUA_CONTROL_PLANE_DR_STATE_ROOT}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" <<'PY'
import datetime
import json
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
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
    if not isinstance(document, dict) or set(document) != {
        "candidate", "candidate_image_id", "occurred_at", "phase",
        "prior_image_id", "schema_version",
    } or document.get("schema_version") != 1:
        raise SystemExit(f"DR execution journal schema is invalid: {phase_path}")
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
PY
}

aqua_control_plane_verify_material() {
  [ "$#" -eq 4 ] || return 64
  local mode=$1
  local input_path=$2
  local expected_main_sha=$3
  local output_path=$4
  /usr/bin/python3 - "${mode}" "${input_path}" "${expected_main_sha}" "${output_path}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${AQUA_PRODUCTION_SOURCE_FORMAT}" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import tarfile

mode, input_path, expected_main_sha, output_path, expected_uid_raw, expected_format = sys.argv[1:]
expected_uid = int(expected_uid_raw)
sha256_pattern = re.compile(r"^[0-9a-f]{64}$")
sha_object_pattern = re.compile(r"^[0-9a-f]{40,64}$")
safe_path_pattern = re.compile(r"^[^\x00-\x1f\x7f]+$")
migration_pattern = re.compile(r"^apps/[^/]+/src/(?:.+/)?migrations/[0-9][^/]*\.ts$")
legacy_manifest_keys = {
    "assert_service_signals_runtime_hash",
    "check_service_health_runtime_hash",
    "format",
    "main_sha",
    "migration_manifest_hash",
    "nats_config_hash",
    "tracked_file_count",
    "tracked_tree_manifest_hash",
    "tree_hash",
}
current_manifest_keys = legacy_manifest_keys | {
    "first_parent_ancestry_count",
    "first_parent_ancestry_hash",
}
legacy_metadata_files = {
    "metadata/manifest.json": 0o644,
    "metadata/migrations.tsv": 0o644,
    "metadata/tracked-tree.tsv": 0o644,
}
current_metadata_files = {
    **legacy_metadata_files,
    "metadata/first-parent-ancestry.tsv": 0o644,
}
runtime_files = {
    "runtime/assert-service-signals.mjs": 0o644,
    "runtime/check-service-health.mjs": 0o644,
}

def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()

def safe_relative(path: str) -> bool:
    pure = pathlib.PurePosixPath(path)
    return bool(
        path
        and safe_path_pattern.fullmatch(path)
        and not path.startswith("/")
        and "\\" not in path
        and "//" not in path
        and all(part not in {"", ".", ".."} for part in pure.parts)
    )

def parse_tree(value: bytes) -> dict[str, tuple[int, str]]:
    rows: dict[str, tuple[int, str]] = {}
    previous = ""
    for raw_line in value.decode("utf-8", "strict").splitlines():
        parts = raw_line.split("\t")
        if len(parts) != 3:
            raise SystemExit("tracked-tree.tsv contains a malformed row")
        mode_text, file_hash, path = parts
        if mode_text not in {"100644", "100755"} or sha256_pattern.fullmatch(file_hash) is None:
            raise SystemExit(f"tracked-tree.tsv metadata is invalid: {path}")
        if not safe_relative(path) or path <= previous or path in rows:
            raise SystemExit(f"tracked-tree.tsv path order/safety is invalid: {path!r}")
        rows[path] = (int(mode_text[-3:], 8), file_hash)
        previous = path
    if not rows:
        raise SystemExit("tracked-tree.tsv must not be empty")
    return rows

def parse_migrations(value: bytes, tree: dict[str, tuple[int, str]]) -> None:
    rows: list[tuple[str, str]] = []
    previous = ""
    for raw_line in value.decode("utf-8", "strict").splitlines():
        parts = raw_line.split("\t")
        if len(parts) != 2:
            raise SystemExit("migrations.tsv contains a malformed row")
        file_hash, path = parts
        if sha256_pattern.fullmatch(file_hash) is None or path <= previous:
            raise SystemExit("migrations.tsv order/hash is invalid")
        if path not in tree or tree[path][1] != file_hash:
            raise SystemExit(f"migrations.tsv does not bind the tracked file: {path}")
        rows.append((path, file_hash))
        previous = path
    expected = [
        (path, metadata[1])
        for path, metadata in tree.items()
        if migration_pattern.fullmatch(path)
        or path == "apps/db-migrate/src/schema-registry.ts"
    ]
    if rows != expected or not rows:
        raise SystemExit("migrations.tsv is not the exact migration projection")

def parse_first_parent_ancestry(value: bytes, main_sha: str) -> list[str]:
    if not value.endswith(b"\n") or b"\r" in value or b"\0" in value:
        raise SystemExit("first-parent ancestry is not canonically encoded")
    try:
        rows = value.decode("ascii", "strict").splitlines()
    except UnicodeDecodeError as error:
        raise SystemExit("first-parent ancestry is not ASCII") from error
    if not 1 <= len(rows) <= 1024 or rows[0] != main_sha:
        raise SystemExit("first-parent ancestry identity/count is invalid")
    if len(rows) != len(set(rows)):
        raise SystemExit("first-parent ancestry contains duplicate commits")
    if any(re.fullmatch(r"[0-9a-f]{40}", row) is None for row in rows):
        raise SystemExit("first-parent ancestry contains an invalid commit")
    return rows

def expected_directories(files: set[str]) -> set[str]:
    directories: set[str] = set()
    for name in files:
        parent = pathlib.PurePosixPath(name).parent
        while str(parent) not in {"", "."}:
            directories.add(str(parent))
            parent = parent.parent
    return directories

def validate_content(
    files: dict[str, bytes], require_ancestry: bool
) -> tuple[dict, dict[str, tuple[int, str]], dict[str, int]]:
    try:
        manifest = json.loads(files["metadata/manifest.json"].decode("utf-8", "strict"))
    except (KeyError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"bundle manifest is unreadable: {error}") from error
    if not isinstance(manifest, dict):
        raise SystemExit("bundle manifest key set is invalid")
    manifest_key_set = set(manifest)
    if manifest_key_set == current_manifest_keys:
        has_ancestry = True
        selected_metadata_files = current_metadata_files
    elif not require_ancestry and manifest_key_set == legacy_manifest_keys:
        has_ancestry = False
        selected_metadata_files = legacy_metadata_files
    else:
        raise SystemExit("bundle manifest key set is invalid")
    if (
        manifest.get("format") != expected_format
        or manifest.get("main_sha") != expected_main_sha
        or re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("main_sha"))) is None
        or sha_object_pattern.fullmatch(str(manifest.get("tree_hash"))) is None
    ):
        raise SystemExit("bundle manifest identity is invalid")
    for key in manifest_key_set - {
        "first_parent_ancestry_count",
        "format",
        "main_sha",
        "tracked_file_count",
        "tree_hash",
    }:
        if sha256_pattern.fullmatch(str(manifest.get(key))) is None:
            raise SystemExit(f"bundle manifest hash is invalid: {key}")

    tree_bytes = files.get("metadata/tracked-tree.tsv", b"")
    migrations_bytes = files.get("metadata/migrations.tsv", b"")
    if digest_bytes(tree_bytes) != manifest["tracked_tree_manifest_hash"]:
        raise SystemExit("tracked tree manifest hash mismatch")
    if digest_bytes(migrations_bytes) != manifest["migration_manifest_hash"]:
        raise SystemExit("migration manifest hash mismatch")
    if has_ancestry:
        ancestry_bytes = files.get("metadata/first-parent-ancestry.tsv", b"")
        if digest_bytes(ancestry_bytes) != manifest["first_parent_ancestry_hash"]:
            raise SystemExit("first-parent ancestry hash mismatch")
        ancestry = parse_first_parent_ancestry(ancestry_bytes, expected_main_sha)
        if manifest.get("first_parent_ancestry_count") != len(ancestry):
            raise SystemExit("first-parent ancestry count mismatch")
    tree = parse_tree(tree_bytes)
    if manifest.get("tracked_file_count") != len(tree):
        raise SystemExit("tracked file count mismatch")
    parse_migrations(migrations_bytes, tree)

    expected_files = set(selected_metadata_files) | set(runtime_files) | {
        f"repository/{path}" for path in tree
    }
    if set(files) != expected_files:
        raise SystemExit("bundle file membership is not exact")
    for path, (_file_mode, expected_hash) in tree.items():
        if digest_bytes(files[f"repository/{path}"]) != expected_hash:
            raise SystemExit(f"tracked file hash mismatch: {path}")
    nats_path = "repository/infrastructure/docker/nats/nats.conf"
    if nats_path not in files or digest_bytes(files[nats_path]) != manifest["nats_config_hash"]:
        raise SystemExit("NATS configuration hash mismatch")
    if digest_bytes(files["runtime/check-service-health.mjs"]) != manifest["check_service_health_runtime_hash"]:
        raise SystemExit("check-service-health runtime hash mismatch")
    if digest_bytes(files["runtime/assert-service-signals.mjs"]) != manifest["assert_service_signals_runtime_hash"]:
        raise SystemExit("assert-service-signals runtime hash mismatch")
    return manifest, tree, selected_metadata_files

if mode == "bundle":
    archive_path = pathlib.Path(input_path)
    output_root = pathlib.Path(output_path)
    if not archive_path.is_file() or archive_path.is_symlink():
        raise SystemExit("bundle input must be a regular non-symlink file")
    if not output_root.is_dir() or output_root.is_symlink() or any(output_root.iterdir()):
        raise SystemExit("bundle extraction root must be an empty real directory")
    files: dict[str, bytes] = {}
    file_modes: dict[str, int] = {}
    directories: set[str] = set()
    directory_modes: dict[str, int] = {}
    seen: set[str] = set()
    with tarfile.open(archive_path, mode="r:gz") as archive:
        for member in archive:
            name = member.name.rstrip("/")
            if not safe_relative(name) or name in seen:
                raise SystemExit(f"unsafe or duplicate bundle member: {member.name!r}")
            seen.add(name)
            if member.uid != 0 or member.gid != 0 or int(member.mtime) != 0:
                raise SystemExit(f"non-canonical bundle metadata rejected: {name}")
            if member.isdir():
                directories.add(name)
                directory_modes[name] = member.mode
                continue
            if not member.isreg():
                raise SystemExit(f"unsafe bundle member type rejected: {name}")
            extracted = archive.extractfile(member)
            if extracted is None:
                raise SystemExit(f"bundle member could not be read: {name}")
            files[name] = extracted.read()
            file_modes[name] = member.mode
    _manifest, tree, selected_metadata_files = validate_content(files, True)
    expected_files = set(selected_metadata_files) | set(runtime_files) | {
        f"repository/{path}" for path in tree
    }
    if directories != expected_directories(expected_files):
        raise SystemExit("bundle directory membership is not exact")
    if directory_modes != {path: 0o755 for path in directories}:
        raise SystemExit("bundle directory mode map is not exact")
    expected_modes = dict(selected_metadata_files)
    expected_modes.update(runtime_files)
    expected_modes.update({f"repository/{path}": mode for path, (mode, _hash) in tree.items()})
    if file_modes != expected_modes:
        raise SystemExit("bundle file mode map is not exact")
    for directory in sorted(directories, key=lambda value: (value.count("/"), value)):
        (output_root / directory).mkdir(mode=0o755)
    for name in sorted(files):
        target = output_root / name
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, expected_modes[name])
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as output:
                output.write(files[name])
                output.flush()
                os.fsync(output.fileno())
        finally:
            os.close(descriptor)
elif mode == "directory":
    root = pathlib.Path(input_path)
    if not root.is_dir() or root.is_symlink():
        raise SystemExit("published source must be a real directory")
    files: dict[str, bytes] = {}
    file_modes: dict[str, int] = {}
    directories: set[str] = set()
    for current_root, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        current = pathlib.Path(current_root)
        for name in list(directory_names):
            path = current / name
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise SystemExit(f"published source unsafe directory: {path}")
            if info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o555:
                raise SystemExit(f"published source directory ownership/mode mismatch: {path}")
            directories.add(path.relative_to(root).as_posix())
        for name in file_names:
            path = current / name
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                raise SystemExit(f"published source unsafe file: {path}")
            if (
                info.st_uid != expected_uid
                or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) not in {0o444, 0o555}
            ):
                raise SystemExit(f"published source file ownership/mode mismatch: {path}")
            relative = path.relative_to(root).as_posix()
            if not safe_relative(relative):
                raise SystemExit(f"published source path is unsafe: {relative}")
            files[relative] = path.read_bytes()
            file_modes[relative] = stat.S_IMODE(info.st_mode)
    _manifest, tree, selected_metadata_files = validate_content(files, False)
    expected_files = set(selected_metadata_files) | set(runtime_files) | {
        f"repository/{path}" for path in tree
    }
    if directories != expected_directories(expected_files):
        raise SystemExit("published source directory membership is not exact")
    expected_modes = {
        **{path: 0o444 for path in selected_metadata_files},
        **{path: 0o444 for path in runtime_files},
        **{
            f"repository/{path}": 0o555 if mode == 0o755 else 0o444
            for path, (mode, _hash) in tree.items()
        },
    }
    if file_modes != expected_modes:
        raise SystemExit("published source file mode map is not exact")
else:
    raise SystemExit("unknown production-host material verification mode")
PY
}

aqua_control_plane_verify_published_source() {
  [ "$#" -eq 2 ] || return 64
  local source_sha=$1
  local source_root=$2
  [[ "${source_sha}" =~ ^[0-9a-f]{40}$ ]] || \
    aqua_control_plane_die 'Published source SHA must be lowercase 40-hex.' || return
  aqua_control_plane_lock_assert || return
  aqua_control_plane_ensure_root || return
  [ "${source_root}" = "${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${source_sha}" ] || \
    aqua_control_plane_die 'Published source path/SHA mismatch.' || return
  [ -d "${source_root}" ] && [ ! -L "${source_root}" ] || \
    aqua_control_plane_die 'Requested immutable production source is not published.' || return
  [ "$(/usr/bin/stat -Lc '%u' -- "${source_root}")" = "${AQUA_CONTROL_PLANE_EXPECTED_UID}" ] && \
    [ "$(/usr/bin/stat -Lc '%a' -- "${source_root}")" = 555 ] || \
    aqua_control_plane_die 'Published production source root ownership/mode mismatch.' || return
  aqua_control_plane_verify_material directory "${source_root}" \
    "${source_sha}" /dev/null
}

aqua_control_plane_converge_interrupted_source_root() {
  [ "$#" -eq 2 ] || return 64
  local source_sha=$1
  local source_root=$2
  local source_mode

  [[ "${source_sha}" =~ ^[0-9a-f]{40}$ ]] || \
    aqua_control_plane_die 'Interrupted source SHA must be lowercase 40-hex.' || return
  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE}" = exclusive ] || \
    aqua_control_plane_die \
      'Interrupted source convergence requires the exclusive host lock.' || return
  [ "${source_root}" = "${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${source_sha}" ] || \
    aqua_control_plane_die 'Interrupted source path/SHA mismatch.' || return
  [ -d "${source_root}" ] && [ ! -L "${source_root}" ] || \
    aqua_control_plane_die 'Interrupted source root is not a real directory.' || return
  [ "$(/usr/bin/stat -Lc '%u' -- "${source_root}")" = \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" ] || \
    aqua_control_plane_die 'Interrupted source root owner mismatch.' || return

  source_mode=$(/usr/bin/stat -Lc '%a' -- "${source_root}") || return
  if [ "${source_mode}" = 555 ]; then
    return 0
  fi
  [ "${source_mode}" = 755 ] || \
    aqua_control_plane_die \
      'Interrupted source root mode is neither immutable 0555 nor exact publish-stage 0755.' || \
      return

  # Linux requires the moved directory itself to remain owner-writable when a
  # non-root publisher renames it across parents because its `..` entry changes.
  # The exclusive lock prevents any consumer from accepting or using this exact
  # 0755 handoff form during normal publication; interrupted readers reject it.
  # Verify every immutable child before blessing the root, then pin the inode
  # through fchmod/fsync and verify the canonical tree again.
  aqua_control_plane_verify_material directory "${source_root}" \
    "${source_sha}" /dev/null || return
  /usr/bin/python3 - \
    "${source_root}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" <<'SOURCE_ROOT_CONVERGENCE_PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
info = os.lstat(path)
if (
    stat.S_ISLNK(info.st_mode)
    or not stat.S_ISDIR(info.st_mode)
    or info.st_uid != expected_uid
    or stat.S_IMODE(info.st_mode) != 0o755
):
    raise SystemExit("interrupted source root identity changed before convergence")

descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(before.st_mode)
        or before.st_uid != expected_uid
        or stat.S_IMODE(before.st_mode) != 0o755
        or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)
    ):
        raise SystemExit("interrupted source root descriptor identity mismatch")
    os.fchmod(descriptor, 0o555)
    os.fsync(descriptor)
    after = os.fstat(descriptor)
    path_after = os.lstat(path)
    if (
        not stat.S_ISDIR(after.st_mode)
        or after.st_uid != expected_uid
        or stat.S_IMODE(after.st_mode) != 0o555
        or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
        or stat.S_ISLNK(path_after.st_mode)
        or not stat.S_ISDIR(path_after.st_mode)
        or path_after.st_uid != expected_uid
        or stat.S_IMODE(path_after.st_mode) != 0o555
        or (path_after.st_dev, path_after.st_ino) != (before.st_dev, before.st_ino)
    ):
        raise SystemExit("interrupted source root convergence failed")
finally:
    os.close(descriptor)
SOURCE_ROOT_CONVERGENCE_PY
  aqua_control_plane_verify_material directory "${source_root}" \
    "${source_sha}" /dev/null || return
  /usr/bin/sync -f "${AQUA_CONTROL_PLANE_SOURCES_ROOT}"
}

aqua_control_plane_verify_source() {
  : "${PRODUCTION_HOST_MAIN_SHA:?PRODUCTION_HOST_MAIN_SHA required}"
  [[ "${PRODUCTION_HOST_MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]] || \
    aqua_control_plane_die 'PRODUCTION_HOST_MAIN_SHA must be lowercase 40-hex.' || return
  local source_root="${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${PRODUCTION_HOST_MAIN_SHA}"
  aqua_control_plane_verify_published_source \
    "${PRODUCTION_HOST_MAIN_SHA}" "${source_root}" || return
  AQUA_PRODUCTION_SOURCE_ROOT=${source_root}
  AQUA_PRODUCTION_SOURCE_DIR="${source_root}/repository"
  AQUA_CHECK_SERVICE_HEALTH_RUNTIME="${source_root}/runtime/check-service-health.mjs"
  AQUA_ASSERT_SERVICE_SIGNALS_RUNTIME="${source_root}/runtime/assert-service-signals.mjs"
  export AQUA_PRODUCTION_SOURCE_ROOT AQUA_PRODUCTION_SOURCE_DIR
  export AQUA_CHECK_SERVICE_HEALTH_RUNTIME AQUA_ASSERT_SERVICE_SIGNALS_RUNTIME
}

aqua_control_plane_validate_owned_stage() {
  [ "$#" -eq 2 ] || return 64
  local stage_root=$1
  local source_sha=$2

  /usr/bin/python3 - \
    "${stage_root}" "${source_sha}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" <<'PY'
import json
import os
import pathlib
import stat
import sys

root = pathlib.Path(sys.argv[1])
source_sha = sys.argv[2]
expected_uid = int(sys.argv[3])


def require_directory(path: pathlib.Path, modes: set[int]) -> None:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"production source stage directory is unsafe: {path}")
    if info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) not in modes:
        raise SystemExit(f"production source stage directory ownership/mode mismatch: {path}")


require_directory(root, {0o700})
children = {entry.name: entry for entry in root.iterdir()}
if not children:
    raise SystemExit(0)
if set(children) == {"publisher.json.tmp"}:
    partial = children["publisher.json.tmp"]
    partial_info = os.lstat(partial)
    if (
        stat.S_ISLNK(partial_info.st_mode)
        or not stat.S_ISREG(partial_info.st_mode)
        or partial_info.st_uid != expected_uid
        or partial_info.st_nlink != 1
        or stat.S_IMODE(partial_info.st_mode) != 0o400
        or partial_info.st_size > 512
    ):
        raise SystemExit("production source stage partial publisher marker is unsafe")
    raise SystemExit(0)
if set(children) not in ({"publisher.json"}, {"publisher.json", "payload"}):
    raise SystemExit("production source stage contains foreign residue")
marker = children["publisher.json"]
marker_info = os.lstat(marker)
if (
    stat.S_ISLNK(marker_info.st_mode)
    or not stat.S_ISREG(marker_info.st_mode)
    or marker_info.st_uid != expected_uid
    or marker_info.st_nlink != 1
    or stat.S_IMODE(marker_info.st_mode) != 0o400
    or marker_info.st_size > 512
):
    raise SystemExit("production source stage publisher marker is unsafe")
try:
    document = json.loads(marker.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"production source stage publisher marker is corrupt: {error}") from error
if document != {
    "format": "aqua-production-source-stage-v1",
    "main_sha": source_sha,
    "schema_version": 1,
}:
    raise SystemExit("production source stage publisher marker identity mismatch")
payload = children.get("payload")
if payload is None:
    raise SystemExit(0)
require_directory(payload, {0o555, 0o700, 0o755})
for current_root, directory_names, file_names in os.walk(payload, topdown=True, followlinks=False):
    current = pathlib.Path(current_root)
    for name in directory_names:
        require_directory(current / name, {0o555, 0o755})
    for name in file_names:
        path = current / name
        info = os.lstat(path)
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISREG(info.st_mode)
            or info.st_uid != expected_uid
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) not in {0o444, 0o555, 0o644, 0o755}
        ):
            raise SystemExit(f"production source stage file is unsafe: {path}")
PY
}

aqua_control_plane_remove_owned_stage() {
  [ "$#" -eq 3 ] || return 64
  local stage_root=$1
  local source_sha=$2
  local expected_identity=$3

  aqua_control_plane_validate_owned_stage "${stage_root}" "${source_sha}" || return
  [ "$(/usr/bin/stat -Lc '%d:%i' -- "${stage_root}")" = "${expected_identity}" ] || \
    aqua_control_plane_die 'Production source stage identity changed before cleanup.' || return
  /usr/bin/chmod -R u+rwX -- "${stage_root}" || return
  /usr/bin/rm -rf --one-file-system -- "${stage_root}" || return
  [ ! -e "${stage_root}" ] && [ ! -L "${stage_root}" ] || \
    aqua_control_plane_die 'Owned production source stage could not be removed.' || return
  /usr/bin/sync -f "${AQUA_CONTROL_PLANE_SOURCES_ROOT}"
}

aqua_control_plane_recover_source_stage() {
  [ "$#" -eq 1 ] || return 64
  local source_sha=$1
  local stage_path stage_name stage_identity stage_sha

  [[ "${source_sha}" =~ ^[0-9a-f]{40}$ ]] || \
    aqua_control_plane_die 'Production source staging recovery SHA is invalid.' || return
  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE}" = exclusive ] || \
    aqua_control_plane_die 'Production source staging recovery requires the exclusive host lock.' || return
  while IFS= read -r -d '' stage_path; do
    stage_name=${stage_path##*/}
    case "${stage_name}" in
      .source.*)
        [[ "${stage_name}" =~ ^\.source\.([0-9a-f]{40})\.staging$ ]] || \
          aqua_control_plane_die \
            "Unexpected production source staging entry: ${stage_name}" || return
        stage_sha=${BASH_REMATCH[1]}
        stage_identity=$(/usr/bin/stat -Lc '%d:%i' -- "${stage_path}") || return
        aqua_control_plane_remove_owned_stage \
          "${stage_path}" "${stage_sha}" "${stage_identity}" || return
        ;;
    esac
  done < <(/usr/bin/find "${AQUA_CONTROL_PLANE_SOURCES_ROOT}" \
    -mindepth 1 -maxdepth 1 -print0)
}

aqua_control_plane_stage_and_publish_source() (
  [ "$#" -eq 2 ] || return 64
  local source_sha=$1
  local final_root=$2
  local stage_root="${AQUA_CONTROL_PLANE_SOURCES_ROOT}/.source.${source_sha}.staging"
  local payload_root="${stage_root}/payload"
  local stage_identity=''

  cleanup_source_stage() {
    local status=$?
    local cleanup_status=0
    trap - EXIT HUP INT TERM
    set +e
    if [ -n "${stage_identity}" ] && \
       { [ -e "${stage_root}" ] || [ -L "${stage_root}" ]; }; then
      aqua_control_plane_remove_owned_stage \
        "${stage_root}" "${source_sha}" "${stage_identity}"
      cleanup_status=$?
      if [ "${status}" -eq 0 ] && [ "${cleanup_status}" -ne 0 ]; then
        status=${cleanup_status}
      fi
    fi
    exit "${status}"
  }
  trap cleanup_source_stage EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  /usr/bin/mkdir -m 0700 -- "${stage_root}" || return
  stage_identity=$(/usr/bin/stat -Lc '%d:%i' -- "${stage_root}") || return
  /usr/bin/sync -f "${AQUA_CONTROL_PLANE_SOURCES_ROOT}" || return
  /usr/bin/python3 - "${stage_root}" "${source_sha}" <<'PY' || return
import json
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
source_sha = sys.argv[2]
temporary_path = root / "publisher.json.tmp"
marker_path = root / "publisher.json"
payload = (
    json.dumps(
        {
            "format": "aqua-production-source-stage-v1",
            "main_sha": source_sha,
            "schema_version": 1,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    + "\n"
).encode()
descriptor = os.open(
    temporary_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o400,
)
try:
    with os.fdopen(descriptor, "wb", closefd=False) as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
finally:
    os.close(descriptor)
os.replace(temporary_path, marker_path)
directory_descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory_descriptor)
finally:
    os.close(directory_descriptor)
PY
  /usr/bin/mkdir -m 0700 -- "${payload_root}" || return
  /usr/bin/sync -f "${stage_root}" || return

  aqua_control_plane_verify_material bundle "${PRODUCTION_HOST_BUNDLE_PATH}" \
    "${source_sha}" "${payload_root}" || return
  if [ "${AQUA_CONTROL_PLANE_EXPECTED_UID}" -eq 0 ]; then
    /usr/bin/chown -R 0:0 -- "${payload_root}" || return
  fi
  /usr/bin/find "${payload_root}" -type d -exec /usr/bin/chmod 0555 {} + || return
  /usr/bin/find "${payload_root}" -type f -perm /0111 \
    -exec /usr/bin/chmod 0555 {} + || return
  /usr/bin/find "${payload_root}" -type f ! -perm /0111 \
    -exec /usr/bin/chmod 0444 {} + || return
  /usr/bin/find "${payload_root}" -type f -exec /usr/bin/sync -f {} + || return
  /usr/bin/sync -f "${payload_root}" || return

  # Keep only the payload root owner-writable for the cross-parent rename.
  # All descendants are already immutable and the exclusive lock fences every
  # reader until the inode-pinned 0555 convergence below completes.
  /usr/bin/chmod 0755 -- "${payload_root}" || return
  /usr/bin/sync -f "${payload_root}" || return

  aqua_control_plane_lock_assert || return
  [ ! -e "${final_root}" ] && [ ! -L "${final_root}" ] || \
    aqua_control_plane_die 'Production source appeared during locked publication.' || return
  /usr/bin/mv -T -- "${payload_root}" "${final_root}" || return
  aqua_control_plane_converge_interrupted_source_root \
    "${source_sha}" "${final_root}" || return
)

aqua_control_plane_capture_docker_output() {
  [ "$#" -ge 5 ] || return 64
  local output_path=$1
  local maximum_bytes=$2
  local operation=$3
  local docker_timeout_seconds=$4
  shift 4
  local output_size
  local producer_status
  local capture_status
  local -a pipeline_status=()

  [[ "${maximum_bytes}" =~ ^[0-9]+$ ]] && [ "${maximum_bytes}" -gt 0 ] || return 64
  [[ "${docker_timeout_seconds}" =~ ^[0-9]+$ ]] && \
    [ "${docker_timeout_seconds}" -gt 0 ] && \
    [ "${docker_timeout_seconds}" -le 30 ] || return 64
  set +e
  /usr/bin/timeout --signal=TERM \
    --kill-after="${AQUA_PRODUCTION_DOCKER_CAPTURE_KILL_SECONDS}s" \
    "${docker_timeout_seconds}s" "$@" 2>&1 |
    /usr/bin/head -c "$((maximum_bytes + 1))" > "${output_path}"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  producer_status=${pipeline_status[0]:-1}
  capture_status=${pipeline_status[1]:-1}
  output_size=$(/usr/bin/stat -Lc '%s' -- "${output_path}") || return
  if [[ ! "${output_size}" =~ ^[0-9]+$ ]] || [ "${output_size}" -gt "${maximum_bytes}" ]; then
    aqua_control_plane_die \
      "Docker ${operation} output exceeded its ${maximum_bytes}-byte capture bound." || return
  fi
  [ "${capture_status}" -eq 0 ] || \
    aqua_control_plane_die "Docker ${operation} bounded capture failed." || return
  case "${producer_status}" in
    0) ;;
    124 | 137)
      aqua_control_plane_die \
        "Docker ${operation} exceeded its ${docker_timeout_seconds}-second deadline." || return
      ;;
    *) aqua_control_plane_die "Docker ${operation} failed during bounded capture." || return ;;
  esac
}

aqua_control_plane_bound_source_shas() {
  [ "$#" -eq 1 ] || return 64
  local output_file=$1
  local container_ids_file
  local container_inspect_file
  local inspect_size
  local container_id
  local docker_bin=/usr/bin/docker
  local docker_timeout_seconds=${AQUA_PRODUCTION_DOCKER_CAPTURE_TIMEOUT_SECONDS}
  local inspect_max_bytes=${AQUA_PRODUCTION_DOCKER_INSPECT_MAX_BYTES}
  local -a container_ids=()

  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE}" = exclusive ] || \
    aqua_control_plane_die \
      'Production source bind inventory requires the exclusive host lock.' || return
  aqua_control_plane_ensure_root || return

  if [ -n "${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN:-}" ] ||
    [ -n "${AQUA_CONTROL_PLANE_TEST_DOCKER_TIMEOUT_SECONDS:-}" ] ||
    [ -n "${AQUA_CONTROL_PLANE_TEST_DOCKER_INSPECT_MAX_BYTES:-}" ]; then
    if [ "${NODE_ENV:-}" != test ] || [ -z "${AQUA_CONTROL_PLANE_TEST_ROOT:-}" ] ||
      [ -z "${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN:-}" ]; then
      aqua_control_plane_die \
        'Docker test capture controls require the isolated control-plane test root.' || return
    fi
    case "${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN}" in
      /tmp/?*) ;;
      *) aqua_control_plane_die 'Test Docker executable must be below /tmp.' || return ;;
    esac
    if [ ! -f "${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN}" ] ||
      [ -L "${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN}" ] ||
      [ "$(/usr/bin/stat -Lc '%u:%a:%h' -- \
        "${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN}")" != \
        "${AQUA_CONTROL_PLANE_EXPECTED_UID}:755:1" ] ||
      [ "$(/usr/bin/realpath -- "${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN}")" != \
        "${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN}" ]; then
      aqua_control_plane_die 'Test Docker executable is unsafe.' || return
    fi
    docker_bin=${AQUA_CONTROL_PLANE_TEST_DOCKER_BIN}
    if [ -n "${AQUA_CONTROL_PLANE_TEST_DOCKER_TIMEOUT_SECONDS:-}" ]; then
      [[ "${AQUA_CONTROL_PLANE_TEST_DOCKER_TIMEOUT_SECONDS}" =~ ^[1-5]$ ]] || \
        aqua_control_plane_die 'Test Docker timeout must be 1..5 seconds.' || return
      docker_timeout_seconds=${AQUA_CONTROL_PLANE_TEST_DOCKER_TIMEOUT_SECONDS}
    fi
    if [ -n "${AQUA_CONTROL_PLANE_TEST_DOCKER_INSPECT_MAX_BYTES:-}" ]; then
      [[ "${AQUA_CONTROL_PLANE_TEST_DOCKER_INSPECT_MAX_BYTES}" =~ ^[0-9]+$ ]] &&
        [ "${AQUA_CONTROL_PLANE_TEST_DOCKER_INSPECT_MAX_BYTES}" -ge 1024 ] &&
        [ "${AQUA_CONTROL_PLANE_TEST_DOCKER_INSPECT_MAX_BYTES}" -le 1048576 ] || \
        aqua_control_plane_die 'Test Docker inspect bound must be 1024..1048576 bytes.' || return
      inspect_max_bytes=${AQUA_CONTROL_PLANE_TEST_DOCKER_INSPECT_MAX_BYTES}
    fi
  fi

  container_ids_file=$(/usr/bin/mktemp) || return
  container_inspect_file=$(/usr/bin/mktemp) || {
    /usr/bin/rm -f -- "${container_ids_file}"
    return 1
  }
  /usr/bin/chmod 0600 "${container_ids_file}" "${container_inspect_file}" || {
    /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
    return 1
  }

  if [ -n "${AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON:-}" ]; then
    if [ "${NODE_ENV:-}" != test ] || [ -z "${AQUA_CONTROL_PLANE_TEST_ROOT:-}" ]; then
      /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
      aqua_control_plane_die \
        'Test container inventory is accepted only with the isolated test root.' || return
    fi
    case "${AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON}" in
      /tmp/?*) ;;
      *)
        /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
        aqua_control_plane_die 'Test container inventory path must be below /tmp.' || return
        ;;
    esac
    if [ ! -f "${AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON}" ] ||
      [ -L "${AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON}" ] ||
      [ "$(/usr/bin/stat -Lc '%u:%a:%h' -- \
        "${AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON}")" != \
        "${AQUA_CONTROL_PLANE_EXPECTED_UID}:600:1" ]; then
      /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
      aqua_control_plane_die 'Test container inventory file is unsafe.' || return
    fi
    /usr/bin/cp -- "${AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON}" \
      "${container_inspect_file}" || {
      /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
      return 1
    }
  else
    if ! aqua_control_plane_capture_docker_output \
      "${container_ids_file}" "${AQUA_PRODUCTION_DOCKER_PS_MAX_BYTES}" \
      'container inventory' "${docker_timeout_seconds}" \
      "${docker_bin}" ps --all --quiet --no-trunc; then
      /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
      aqua_control_plane_die 'Docker container inventory failed during source retention.' || return
    fi
    if [ -s "${container_ids_file}" ] &&
      [ "$(/usr/bin/tail -c 1 -- "${container_ids_file}" | /usr/bin/od -An -tx1 |
        /usr/bin/tr -d '[:space:]')" != 0a ]; then
      /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
      aqua_control_plane_die \
        'Docker container inventory is not newline-terminated.' || return
    fi
    while IFS= read -r container_id; do
      [ -n "${container_id}" ] || {
        /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
        aqua_control_plane_die 'Docker container inventory contains an empty row.' || return
      }
      [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] || {
        /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
        aqua_control_plane_die 'Docker container inventory contains a non-canonical ID.' || return
      }
      container_ids+=("${container_id}")
      if [ "${#container_ids[@]}" -gt "${AQUA_PRODUCTION_DOCKER_MAX_CONTAINERS}" ]; then
        /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
        aqua_control_plane_die 'Docker container inventory exceeds the retention bound.' || return
      fi
    done < "${container_ids_file}"
    if [ "${#container_ids[@]}" -eq 0 ]; then
      /usr/bin/printf '[]\n' > "${container_inspect_file}"
    elif ! aqua_control_plane_capture_docker_output \
      "${container_inspect_file}" "${inspect_max_bytes}" 'container inspect' \
      "${docker_timeout_seconds}" \
      "${docker_bin}" inspect --type container "${container_ids[@]}"; then
      /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
      aqua_control_plane_die 'Docker container inspect failed during source retention.' || return
    fi
  fi

  inspect_size=$(/usr/bin/stat -Lc '%s' -- "${container_inspect_file}") || {
    /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
    return 1
  }
  if [[ ! "${inspect_size}" =~ ^[0-9]+$ ]] || [ "${inspect_size}" -eq 0 ] ||
    [ "${inspect_size}" -gt "${inspect_max_bytes}" ]; then
    /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
    aqua_control_plane_die 'Docker container inspect payload size is invalid.' || return
  fi

  if ! /usr/bin/python3 - \
    "${container_ids_file}" "${container_inspect_file}" \
    "${AQUA_CONTROL_PLANE_SOURCES_ROOT}" "${output_file}" \
    "${AQUA_CONTROL_PLANE_TEST_CONTAINER_INSPECT_JSON:+test}" <<'BOUND_SOURCE_PY'
import json
import os
import pathlib
import re
import stat
import sys

ids_path, inspect_path, sources_path, output_path, test_mode = sys.argv[1:]
id_pattern = re.compile(r"^[0-9a-f]{64}$")
sha_pattern = re.compile(r"^[0-9a-f]{40}$")
sources_root = pathlib.Path(sources_path)

try:
    expected_ids = [line for line in pathlib.Path(ids_path).read_text(encoding="ascii").splitlines() if line]
    document = json.loads(pathlib.Path(inspect_path).read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"container bind inventory is unreadable or corrupt: {error}") from error
if not isinstance(document, list) or len(document) > 1024:
    raise SystemExit("container inspect document is not a bounded list")
if len(expected_ids) != len(set(expected_ids)) or any(id_pattern.fullmatch(value) is None for value in expected_ids):
    raise SystemExit("expected container ID inventory is invalid")

seen_ids: set[str] = set()
protected: set[str] = set()
for row in document:
    if not isinstance(row, dict):
        raise SystemExit("container inspect row is not an object")
    container_id = row.get("Id")
    mounts = row.get("Mounts")
    if not isinstance(container_id, str) or id_pattern.fullmatch(container_id) is None:
        raise SystemExit("container inspect row has an invalid identity")
    if container_id in seen_ids:
        raise SystemExit("container inspect contains a duplicate identity")
    seen_ids.add(container_id)
    if not isinstance(mounts, list) or len(mounts) > 1024:
        raise SystemExit("container inspect mount inventory is invalid or unbounded")
    for mount in mounts:
        if not isinstance(mount, dict):
            raise SystemExit("container inspect mount row is invalid")
        mount_type = mount.get("Type")
        source = mount.get("Source")
        if not isinstance(mount_type, str):
            raise SystemExit("container inspect mount type is invalid")
        if mount_type != "bind":
            continue
        if not isinstance(source, str) or not source.startswith("/") or "\x00" in source:
            raise SystemExit("container bind source is invalid")
        if os.path.normpath(source) != source or "//" in source:
            raise SystemExit("container bind source is not canonical")
        source_path = pathlib.Path(source)
        try:
            relative = source_path.relative_to(sources_root)
        except ValueError:
            continue
        parts = relative.parts
        if len(parts) < 2 or sha_pattern.fullmatch(parts[0]) is None or parts[1] != "repository":
            raise SystemExit("container bind source under the immutable root has an invalid generation")
        generation = sources_root / parts[0]
        try:
            generation_info = os.lstat(generation)
            source_info = os.lstat(source_path)
        except OSError as error:
            raise SystemExit(f"container bind source is unavailable: {error}") from error
        if stat.S_ISLNK(generation_info.st_mode) or not stat.S_ISDIR(generation_info.st_mode):
            raise SystemExit("container bind source generation is unsafe")
        if stat.S_ISLNK(source_info.st_mode):
            raise SystemExit("container bind source must not be a symlink")
        if pathlib.Path(os.path.realpath(generation)) != generation or pathlib.Path(os.path.realpath(source_path)) != source_path:
            raise SystemExit("container bind source canonical identity mismatch")
        protected.add(parts[0])

if test_mode != "test" and seen_ids != set(expected_ids):
    raise SystemExit("container inspect identities do not exactly match the inventory")
if test_mode == "test" and expected_ids:
    raise SystemExit("test container inventory unexpectedly supplied daemon identities")

destination = pathlib.Path(output_path)
with destination.open("w", encoding="ascii", newline="\n") as output:
    for sha in sorted(protected):
        output.write(f"{sha}\n")
BOUND_SOURCE_PY
  then
    /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
    aqua_control_plane_die 'Docker bind source inventory failed closed.' || return
  fi
  /usr/bin/rm -f -- "${container_ids_file}" "${container_inspect_file}"
}

aqua_control_plane_current_release_source_sha() {
  [ "$#" -eq 0 ] || return 64
  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE}" = exclusive ] || \
    aqua_control_plane_die \
      'Current-release source retention requires the exclusive host lock.' || return
  aqua_control_plane_ensure_root || return

  /usr/bin/python3 - \
    "${AQUA_CONTROL_PLANE_ROOT}/current-release.json" \
    "${AQUA_CONTROL_PLANE_RELEASES_ROOT}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" <<'CURRENT_RELEASE_SOURCE_PY'
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

marker = pathlib.Path(sys.argv[1])
release_root = pathlib.Path(sys.argv[2])
expected_uid = int(sys.argv[3])
sha_pattern = re.compile(r"^[0-9a-f]{40}$")
hash_pattern = re.compile(r"^[0-9a-f]{64}$")
release_pattern = re.compile(r"^([0-9a-f]{40})-[0-9]{8}T[0-9]{6}Z$")


def require_path(
    path: pathlib.Path,
    kind: str,
    exact_mode: int | None = None,
) -> os.stat_result:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(f"current-release retention symlink rejected: {path}")
    if kind == "directory" and not stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"current-release retention directory type mismatch: {path}")
    if kind == "file":
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise SystemExit(f"current-release retention file type/link mismatch: {path}")
    if info.st_uid != expected_uid or info.st_mode & 0o022:
        raise SystemExit(f"current-release retention ownership/mode rejected: {path}")
    if exact_mode is not None and stat.S_IMODE(info.st_mode) != exact_mode:
        raise SystemExit(f"current-release retention exact mode rejected: {path}")
    return info


try:
    marker_info = os.lstat(marker)
except FileNotFoundError:
    raise SystemExit(0)
if stat.S_ISLNK(marker_info.st_mode):
    raise SystemExit("current-release retention marker symlink rejected")
require_path(marker.parent, "directory")
marker_info = require_path(marker, "file", 0o400)
if marker_info.st_size > 8192:
    raise SystemExit("current-release retention marker is unbounded")
try:
    document = json.loads(marker.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    raise SystemExit("current-release retention marker is corrupt") from error
if not isinstance(document, dict) or set(document) != {
    "image_digest_manifest_sha256",
    "main_sha",
    "promoted_at",
    "release_id",
    "schema_version",
}:
    raise SystemExit("current-release retention marker schema is invalid")
if document.get("schema_version") != 1:
    raise SystemExit("current-release retention marker version is invalid")
main_sha = document.get("main_sha")
release_id = document.get("release_id")
manifest_hash = document.get("image_digest_manifest_sha256")
if not isinstance(main_sha, str) or sha_pattern.fullmatch(main_sha) is None:
    raise SystemExit("current-release retention SHA is invalid")
if not isinstance(release_id, str):
    raise SystemExit("current-release retention release identity is invalid")
release_match = release_pattern.fullmatch(release_id)
if release_match is None or release_match.group(1) != main_sha:
    raise SystemExit("current-release retention release identity does not match SHA")
if not isinstance(manifest_hash, str) or hash_pattern.fullmatch(manifest_hash) is None:
    raise SystemExit("current-release retention manifest hash is invalid")
require_path(release_root, "directory")
release_directory = release_root / release_id
require_path(release_directory, "directory")
manifest = release_directory / "image-digests.tsv"
manifest_info = require_path(manifest, "file")
if manifest_info.st_size > 65536:
    raise SystemExit("current-release retention manifest is unbounded")
if hashlib.sha256(manifest.read_bytes()).hexdigest() != manifest_hash:
    raise SystemExit("current-release retention manifest hash mismatch")
print(main_sha)
CURRENT_RELEASE_SOURCE_PY
}

aqua_control_plane_prune_releases() {
  [ "$#" -eq 0 ] || return 64
  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || \
    aqua_control_plane_die 'Release retention requires the exclusive host lock.' || return
  aqua_control_plane_prepare_releases_root false || return
  [ -e "${AQUA_CONTROL_PLANE_RELEASES_ROOT}" ] || return 0
  # Validate the marker's referenced directory and manifest hash before the
  # collector is allowed to make any retention mutation.
  aqua_control_plane_current_release_source_sha >/dev/null || return

  /usr/bin/python3 - \
    "${AQUA_CONTROL_PLANE_RELEASES_ROOT}" "${AQUA_CONTROL_PLANE_ROOT}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" <<'RELEASE_RETENTION_PY'
import datetime
import hashlib
import itertools
import json
import os
import pathlib
import re
import stat
import sys

releases = pathlib.Path(sys.argv[1])
control = pathlib.Path(sys.argv[2])
expected_uid = int(sys.argv[3])
release_pattern = re.compile(r"^([0-9a-f]{40})-([0-9]{8}T[0-9]{6}Z)$")
retiring_pattern = re.compile(r"^\.retiring\.([0-9a-f]{40}-[0-9]{8}T[0-9]{6}Z)$")
sha40 = re.compile(r"^[0-9a-f]{40}$")
sha256 = re.compile(r"^[0-9a-f]{64}$")
maximum_releases = 2048
audit_window = 64


def require_directory(path: pathlib.Path, mode: int | set[int]) -> os.stat_result:
    modes = {mode} if isinstance(mode, int) else mode
    info = os.lstat(path)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != expected_uid
        or stat.S_IMODE(info.st_mode) not in modes
    ):
        raise SystemExit(f"release retention directory is unsafe: {path}")
    return info


def read_control_json(path: pathlib.Path, maximum_size: int) -> dict | None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o400
        or not 0 < info.st_size <= maximum_size
    ):
        raise SystemExit(f"release retention control evidence is unsafe: {path}")
    raw = path.read_bytes()
    if not raw.endswith(b"\n"):
        raise SystemExit(f"release retention control evidence is noncanonical: {path}")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"release retention control evidence is corrupt: {path}") from error
    if not isinstance(document, dict):
        raise SystemExit(f"release retention control evidence is invalid: {path}")
    return document


protected: set[str] = set()
marker = read_control_json(control / "current-release.json", 4096)
if marker is not None:
    if set(marker) != {
        "image_digest_manifest_sha256",
        "main_sha",
        "promoted_at",
        "release_id",
        "schema_version",
    } or marker.get("schema_version") != 1:
        raise SystemExit("release retention current marker schema is invalid")
    marker_id = marker.get("release_id")
    marker_match = release_pattern.fullmatch(str(marker_id))
    if (
        marker_match is None
        or marker_match.group(1) != marker.get("main_sha")
        or sha256.fullmatch(str(marker.get("image_digest_manifest_sha256"))) is None
    ):
        raise SystemExit("release retention current marker identity is invalid")
    try:
        datetime.datetime.strptime(str(marker.get("promoted_at")), "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as error:
        raise SystemExit("release retention current marker timestamp is invalid") from error
    protected.add(str(marker_id))

journal = read_control_json(control / "active-release-transaction.json", 32768)
if journal is not None:
    journal_version = journal.get("schema_version")
    if journal_version not in {1, 2}:
        raise SystemExit("release retention journal schema is invalid")
    for value in (
        journal.get("release_id"),
        (journal.get("prior_release") or {}).get("release_id")
        if isinstance(journal.get("prior_release"), dict)
        else None,
        journal.get("supersedes_release_id") if journal_version == 2 else None,
    ):
        if value is None:
            continue
        if release_pattern.fullmatch(str(value)) is None:
            raise SystemExit("release retention journal reference is invalid")
        protected.add(str(value))

root_info = require_directory(releases, 0o700)
# Materialize at most N+1 names.  Building a list from the complete directory
# lets an oversized release inventory consume memory before the fail-closed
# bound is evaluated.
with os.scandir(releases) as release_stream:
    entries = [
        pathlib.Path(entry.path)
        for entry in itertools.islice(release_stream, maximum_releases + 1)
    ]
if len(entries) > maximum_releases:
    raise SystemExit("release retention inventory is unbounded")


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def validate_transaction(document: object, release_id: str, terminal: bool) -> None:
    if not isinstance(document, dict) or document.get("schema_version") != 2:
        raise SystemExit("release transaction evidence schema is invalid")
    match = release_pattern.fullmatch(release_id)
    if (
        match is None
        or document.get("release_id") != release_id
        or document.get("candidate_sha") != match.group(1)
    ):
        raise SystemExit("release transaction evidence identity is invalid")
    phase = document.get("phase")
    if terminal and phase not in {"COMMITTED", "ROLLED_BACK"}:
        raise SystemExit("release terminal evidence is not terminal")
    if not terminal and phase != "FORWARD_REQUIRED":
        raise SystemExit("superseded release evidence is not forward-required")


def validate_evidence(path: pathlib.Path, release_id: str, kind: str) -> None:
    info = os.lstat(path)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o400
        or not 0 < info.st_size <= 32768
    ):
        raise SystemExit(f"release evidence file is unsafe: {path}")
    raw = path.read_bytes()
    if not raw.endswith(b"\n"):
        raise SystemExit(f"release evidence file is noncanonical: {path}")
    document = json.loads(raw.decode("utf-8"))
    if kind == "terminal":
        if not isinstance(document, dict) or set(document) != {
            "schema_version",
            "terminal_transaction",
            "terminal_transaction_sha256",
        } or document.get("schema_version") != 1:
            raise SystemExit("release terminal evidence wrapper is invalid")
        transaction = document.get("terminal_transaction")
        validate_transaction(transaction, release_id, True)
        if hashlib.sha256(canonical_json_bytes(transaction)).hexdigest() != document.get(
            "terminal_transaction_sha256"
        ):
            raise SystemExit("release terminal evidence hash mismatch")
    else:
        expected = {
            "schema_version",
            "successor_candidate_sha",
            "successor_release_id",
            "superseded_transaction",
            "superseded_transaction_sha256",
            "supersession_proof_sha256",
        }
        if not isinstance(document, dict) or set(document) != expected or document.get("schema_version") != 1:
            raise SystemExit("superseded release evidence wrapper is invalid")
        transaction = document.get("superseded_transaction")
        validate_transaction(transaction, release_id, False)
        successor_id = document.get("successor_release_id")
        successor_match = release_pattern.fullmatch(str(successor_id))
        if (
            successor_match is None
            or successor_match.group(1) != document.get("successor_candidate_sha")
            or sha256.fullmatch(str(document.get("supersession_proof_sha256"))) is None
            or hashlib.sha256(canonical_json_bytes(transaction)).hexdigest()
            != document.get("superseded_transaction_sha256")
        ):
            raise SystemExit("superseded release evidence identity/hash is invalid")


allowed_files = {
    "image-digests.tsv": {0o600, 0o644},
    "immutable-images.override.yml": {0o600},
    "capacity-snapshot.json": {0o600},
    "rollback-images.tsv": {0o600, 0o644},
    "rollback-images.sha256": {0o600, 0o644},
    "release-transaction-terminal.json": {0o400},
    "superseded-transaction.json": {0o400},
    ".release-transaction-terminal.json.staging": {0o400},
    ".superseded-transaction.json.staging": {0o400},
}
stage_file_pattern = re.compile(r"^\.(?:image-digests|immutable-images)\.[A-Za-z0-9_-]{6,32}\.tmp$")
rollback_stage_pattern = re.compile(r"^\.rollback-state\.[A-Za-z0-9]{6}$")
snapshots: dict[str, dict[str, tuple[int, int, int, int, int, int]]] = {}
eligibility: dict[str, bool] = {}
normal_names: list[str] = []
retiring_names: list[str] = []


def validate_release_tree(entry: pathlib.Path, release_id: str) -> tuple[dict[str, tuple[int, int, int, int, int, int]], bool]:
    root_entry_info = require_directory(entry, {0o700, 0o755})
    snapshot: dict[str, tuple[int, int, int, int, int, int]] = {
        "": (
            root_entry_info.st_dev,
            root_entry_info.st_ino,
            root_entry_info.st_mode,
            root_entry_info.st_uid,
            root_entry_info.st_nlink,
            root_entry_info.st_size,
        )
    }
    top_names = list(entry.iterdir())
    if len(top_names) > 24:
        raise SystemExit(f"release retention entry inventory is unbounded: {release_id}")
    has_terminal = False
    has_superseded = False
    has_rollback_authority = False
    for child in top_names:
        info = os.lstat(child)
        relative = child.name
        if stat.S_ISLNK(info.st_mode) or info.st_uid != expected_uid:
            raise SystemExit(f"release retention entry is unsafe: {child}")
        if stat.S_ISDIR(info.st_mode):
            if child.name != "rollback-state" and rollback_stage_pattern.fullmatch(child.name) is None:
                raise SystemExit(f"release retention directory is unexpected: {child}")
            if stat.S_IMODE(info.st_mode) != 0o700:
                raise SystemExit(f"release retention nested directory mode is invalid: {child}")
            has_rollback_authority = True
            nested = list(child.iterdir())
            if len(nested) > 2:
                raise SystemExit(f"release rollback inventory is unbounded: {child}")
            nested_names = {value.name for value in nested}
            if not nested_names <= {"rollback-images.tsv", "rollback-images.sha256"}:
                raise SystemExit(f"release rollback entry is unexpected: {child}")
            for nested_child in nested:
                nested_info = os.lstat(nested_child)
                if (
                    stat.S_ISLNK(nested_info.st_mode)
                    or not stat.S_ISREG(nested_info.st_mode)
                    or nested_info.st_uid != expected_uid
                    or nested_info.st_nlink != 1
                    or stat.S_IMODE(nested_info.st_mode) != 0o600
                    or nested_info.st_size > 1048576
                ):
                    raise SystemExit(f"release rollback file is unsafe: {nested_child}")
                nested_relative = f"{relative}/{nested_child.name}"
                snapshot[nested_relative] = (
                    nested_info.st_dev,
                    nested_info.st_ino,
                    nested_info.st_mode,
                    nested_info.st_uid,
                    nested_info.st_nlink,
                    nested_info.st_size,
                )
        elif stat.S_ISREG(info.st_mode):
            modes = allowed_files.get(child.name)
            if modes is None and stage_file_pattern.fullmatch(child.name) is not None:
                modes = {0o600}
            if (
                modes is None
                or stat.S_IMODE(info.st_mode) not in modes
                or info.st_nlink != 1
                or info.st_size > 1048576
            ):
                raise SystemExit(f"release retention file is unexpected or unsafe: {child}")
            if child.name == "release-transaction-terminal.json":
                validate_evidence(child, release_id, "terminal")
                has_terminal = True
            elif child.name == "superseded-transaction.json":
                validate_evidence(child, release_id, "superseded")
                has_superseded = True
            elif child.name in {"rollback-images.tsv", "rollback-images.sha256"}:
                has_rollback_authority = True
        else:
            raise SystemExit(f"release retention special file is forbidden: {child}")
        snapshot[relative] = (
            info.st_dev,
            info.st_ino,
            info.st_mode,
            info.st_uid,
            info.st_nlink,
            info.st_size,
        )
    pre_journal = not has_rollback_authority and not has_terminal and not has_superseded
    return snapshot, has_terminal or has_superseded or pre_journal


for entry in entries:
    match = release_pattern.fullmatch(entry.name)
    retiring_match = retiring_pattern.fullmatch(entry.name)
    if match is None and retiring_match is None:
        raise SystemExit(f"unexpected release retention entry: {entry.name}")
    release_id = entry.name if match is not None else retiring_match.group(1)
    snapshot, eligible = validate_release_tree(entry, release_id)
    snapshots[entry.name] = snapshot
    # The atomic `.retiring.<release-id>` rename is itself the durable deletion
    # decision. A power cut may leave only a safe subset of the original tree
    # (including after its terminal evidence was already unlinked), so re-entry
    # validates the remaining allowlisted bytes but must not re-litigate the
    # pre-rename eligibility decision.
    eligibility[entry.name] = True if retiring_match is not None else eligible
    if match is not None:
        normal_names.append(entry.name)
    else:
        retiring_names.append(entry.name)

newest = sorted(
    normal_names,
    key=lambda name: (release_pattern.fullmatch(name).group(2), name),
    reverse=True,
)[:audit_window]
protected.update(newest)
for retiring_name in retiring_names:
    original = retiring_pattern.fullmatch(retiring_name).group(1)
    if original in protected or not eligibility[retiring_name]:
        raise SystemExit(f"protected or unproven retiring release residue: {original}")


def verify_snapshot(directory_fd: int, snapshot: dict[str, tuple[int, int, int, int, int, int]]) -> None:
    current: set[str] = set()

    def walk(fd: int, prefix: str) -> None:
        for name in os.listdir(fd):
            relative = f"{prefix}/{name}" if prefix else name
            current.add(relative)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            expected = snapshot.get(relative)
            actual = (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink, info.st_size)
            if expected != actual or stat.S_ISLNK(info.st_mode):
                raise SystemExit(f"release retention identity changed: {relative}")
            if stat.S_ISDIR(info.st_mode):
                child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    walk(child_fd, relative)
                finally:
                    os.close(child_fd)

    walk(directory_fd, "")
    if current != set(snapshot) - {""}:
        raise SystemExit("release retention tree membership changed")


def clear_directory(fd: int) -> None:
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                clear_directory(child_fd)
            finally:
                os.close(child_fd)
            os.rmdir(name, dir_fd=fd)
        elif stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
            os.unlink(name, dir_fd=fd)
        else:
            raise SystemExit(f"release retention deletion encountered unsafe entry: {name}")
    os.fsync(fd)


root_fd = os.open(releases, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    opened_root = os.fstat(root_fd)
    if (opened_root.st_dev, opened_root.st_ino) != (root_info.st_dev, root_info.st_ino):
        raise SystemExit("release retention root identity changed")

    def delete_retiring(retiring_name: str) -> None:
        directory_fd = os.open(
            retiring_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=root_fd,
        )
        try:
            root_expected = snapshots[retiring_name][""]
            root_actual_info = os.fstat(directory_fd)
            root_actual = (
                root_actual_info.st_dev,
                root_actual_info.st_ino,
                root_actual_info.st_mode,
                root_actual_info.st_uid,
                root_actual_info.st_nlink,
                root_actual_info.st_size,
            )
            if root_actual != root_expected:
                raise SystemExit("retiring release identity changed")
            verify_snapshot(directory_fd, snapshots[retiring_name])
            clear_directory(directory_fd)
        finally:
            os.close(directory_fd)
        os.rmdir(retiring_name, dir_fd=root_fd)
        os.fsync(root_fd)

    for retiring_name in sorted(retiring_names):
        delete_retiring(retiring_name)

    candidates = [
        name
        for name in normal_names
        if name not in protected and eligibility[name]
    ]
    for name in sorted(candidates):
        retiring_name = f".retiring.{name}"
        directory_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        try:
            verify_snapshot(directory_fd, snapshots[name])
        finally:
            os.close(directory_fd)
        os.rename(name, retiring_name, src_dir_fd=root_fd, dst_dir_fd=root_fd)
        os.fsync(root_fd)
        snapshots[retiring_name] = snapshots.pop(name)
        delete_retiring(retiring_name)

    remaining = len(os.listdir(root_fd))
    if remaining > 128:
        raise SystemExit(f"release retention cannot safely reach its bound: remaining={remaining}")
finally:
    os.close(root_fd)
RELEASE_RETENTION_PY
}

aqua_control_plane_prune_sources() {
  [ "$#" -eq 1 ] || return 64
  local protected_sha=$1
  [[ "${protected_sha}" =~ ^[0-9a-f]{40}$ ]] || \
    aqua_control_plane_die 'Retention-protected source SHA must be lowercase 40-hex.' || return
  aqua_control_plane_lock_assert || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE}" = exclusive ] || \
    aqua_control_plane_die 'Production source retention requires the exclusive host lock.' || return
  aqua_control_plane_ensure_root || return

  local protected_root="${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${protected_sha}"
  aqua_control_plane_verify_published_source \
    "${protected_sha}" "${protected_root}" || return

  local protected_sources_file
  local current_release_sha
  local bound_sha
  local transaction_sha
  local -A protected_sources=(["${protected_sha}"]=true)
  current_release_sha=$(aqua_control_plane_current_release_source_sha) || return
  if [ -n "${current_release_sha}" ]; then
    [[ "${current_release_sha}" =~ ^[0-9a-f]{40}$ ]] || \
      aqua_control_plane_die 'Current-release retention SHA is invalid.' || return
    protected_sources["${current_release_sha}"]=true
    aqua_control_plane_verify_published_source \
      "${current_release_sha}" \
      "${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${current_release_sha}" || return
  fi
  protected_sources_file=$(/usr/bin/mktemp) || return
  if ! aqua_control_plane_bound_source_shas "${protected_sources_file}"; then
    /usr/bin/rm -f -- "${protected_sources_file}"
    return 1
  fi
  while IFS= read -r bound_sha; do
    [[ "${bound_sha}" =~ ^[0-9a-f]{40}$ ]] || {
      /usr/bin/rm -f -- "${protected_sources_file}"
      aqua_control_plane_die 'Protected bind source SHA is invalid.' || return
    }
    protected_sources["${bound_sha}"]=true
    aqua_control_plane_verify_published_source \
      "${bound_sha}" "${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${bound_sha}" || {
      /usr/bin/rm -f -- "${protected_sources_file}"
      return 1
    }
  done < "${protected_sources_file}"
  /usr/bin/rm -f -- "${protected_sources_file}"

  protected_sources_file=$(/usr/bin/mktemp) || return
  if ! /usr/bin/python3 - \
    "${AQUA_CONTROL_PLANE_ROOT}/active-release-transaction.json" \
    > "${protected_sources_file}" <<'TRANSACTION_SOURCE_SHAS_PY'
import json
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
try:
    document = json.loads(path.read_text(encoding="utf-8"))
except FileNotFoundError:
    raise SystemExit(0)
sha = re.compile(r"^[0-9a-f]{40}$")
values = [document.get("candidate_sha"), document.get("supersedes_candidate_sha")]
prior = document.get("prior_release")
if isinstance(prior, dict):
    values.append(prior.get("main_sha"))
seen: set[str] = set()
for value in values:
    if value is None or value in seen:
        continue
    if not isinstance(value, str) or sha.fullmatch(value) is None:
        raise SystemExit("release transaction source SHA is invalid")
    seen.add(value)
    print(value)
TRANSACTION_SOURCE_SHAS_PY
  then
    /usr/bin/rm -f -- "${protected_sources_file}"
    return 1
  fi
  while IFS= read -r transaction_sha; do
    [ -n "${transaction_sha}" ] || continue
    [[ "${transaction_sha}" =~ ^[0-9a-f]{40}$ ]] || \
      aqua_control_plane_die 'Release-transaction protected source SHA is invalid.' || return
    protected_sources["${transaction_sha}"]=true
    if [ -e "${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${transaction_sha}" ] || \
      [ -L "${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${transaction_sha}" ]; then
      aqua_control_plane_verify_published_source \
        "${transaction_sha}" "${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${transaction_sha}" || return
    fi
  done < "${protected_sources_file}"
  /usr/bin/rm -f -- "${protected_sources_file}"

  local -a source_entries=()
  local source_path source_name
  while IFS= read -r -d '' source_path; do
    source_entries+=("${source_path}")
  done < <(/usr/bin/find "${AQUA_CONTROL_PLANE_SOURCES_ROOT}" \
    -mindepth 1 -maxdepth 1 -print0)

  for source_path in "${source_entries[@]}"; do
    source_name=${source_path##*/}
    [[ "${source_name}" =~ ^[0-9a-f]{40}$ ]] || \
      aqua_control_plane_die \
        "Unexpected production source retention entry: ${source_name}" || return
    aqua_control_plane_verify_published_source \
      "${source_name}" "${source_path}" || return
    if [[ -n "${protected_sources[${source_name}]+present}" ]]; then
      continue
    fi
    if ! /usr/bin/chmod -R u+rwX -- "${source_path}" || \
       ! /usr/bin/rm -rf --one-file-system -- "${source_path}" || \
       [ -e "${source_path}" ] || [ -L "${source_path}" ]; then
      aqua_control_plane_die \
        "Verified obsolete production source could not be removed: ${source_name}" || return
    fi
    /usr/bin/sync -f "${AQUA_CONTROL_PLANE_SOURCES_ROOT}"
  done
}

aqua_control_plane_publish_bundle() {
  : "${PRODUCTION_HOST_BUNDLE_PATH:?PRODUCTION_HOST_BUNDLE_PATH required}"
  : "${PRODUCTION_HOST_BUNDLE_SHA256:?PRODUCTION_HOST_BUNDLE_SHA256 required}"
  : "${PRODUCTION_HOST_MAIN_SHA:?PRODUCTION_HOST_MAIN_SHA required}"
  case "${PRODUCTION_HOST_BUNDLE_PATH}" in
    /*) ;;
    *) aqua_control_plane_die 'PRODUCTION_HOST_BUNDLE_PATH must be absolute.' || return ;;
  esac
  [[ "${PRODUCTION_HOST_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || \
    aqua_control_plane_die 'PRODUCTION_HOST_BUNDLE_SHA256 must be lowercase 64-hex.' || return
  [[ "${PRODUCTION_HOST_MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]] || \
    aqua_control_plane_die 'PRODUCTION_HOST_MAIN_SHA must be lowercase 40-hex.' || return
  aqua_control_plane_lock_assert || return
  [ -f "${PRODUCTION_HOST_BUNDLE_PATH}" ] && [ ! -L "${PRODUCTION_HOST_BUNDLE_PATH}" ] || \
    aqua_control_plane_die 'Production host bundle must be a regular non-symlink file.' || return
  [ "$(/usr/bin/stat -Lc '%u:%a:%h' -- "${PRODUCTION_HOST_BUNDLE_PATH}")" = \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}:600:1" ] || \
    aqua_control_plane_die \
      'Production host bundle must be owner-pinned, mode 0600, and single-linked.' || return
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE}" = exclusive ] || \
    aqua_control_plane_die 'Publishing a production source requires the exclusive host lock.' || return
  aqua_control_plane_guard_dr_state || return

  local actual_bundle_hash
  actual_bundle_hash=$(/usr/bin/sha256sum --binary "${PRODUCTION_HOST_BUNDLE_PATH}" | \
    /usr/bin/awk '{print $1}')
  [ "${actual_bundle_hash}" = "${PRODUCTION_HOST_BUNDLE_SHA256}" ] || \
    aqua_control_plane_die 'Production host bundle digest mismatch.' || return

  local final_root="${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${PRODUCTION_HOST_MAIN_SHA}"
  aqua_control_plane_recover_source_stage "${PRODUCTION_HOST_MAIN_SHA}" || return
  if [ -e "${final_root}" ] || [ -L "${final_root}" ]; then
    aqua_control_plane_converge_interrupted_source_root \
      "${PRODUCTION_HOST_MAIN_SHA}" "${final_root}" || return
    aqua_control_plane_verify_source || return
    aqua_control_plane_prune_sources "${PRODUCTION_HOST_MAIN_SHA}"
    return
  fi

  aqua_control_plane_stage_and_publish_source \
    "${PRODUCTION_HOST_MAIN_SHA}" "${final_root}" || return
  aqua_control_plane_verify_source || return
  aqua_control_plane_prune_sources "${PRODUCTION_HOST_MAIN_SHA}"
}

aqua_control_plane_restore_child_ghcr_credential() {
  [ "$#" -gt 0 ] || return 64
  [ "${AQUA_CONTROL_PLANE_GHCR_TOKEN_PRESENT}" = true ] || return 0
  GHCR_TOKEN=${AQUA_CONTROL_PLANE_GHCR_TOKEN_MATERIAL}
  export GHCR_TOKEN
  AQUA_CONTROL_PLANE_GHCR_TOKEN_MATERIAL=
  AQUA_CONTROL_PLANE_GHCR_TOKEN_PRESENT=false
  if ! export -n AQUA_CONTROL_PLANE_GHCR_TOKEN_MATERIAL \
    AQUA_CONTROL_PLANE_GHCR_TOKEN_PRESENT 2>/dev/null; then
    unset GHCR_TOKEN
    return 2
  fi
}

aqua_control_plane_run() {
  local command=${1:-}
  shift || true
  case "${command}" in
    publish)
      [ "$#" -eq 0 ] || aqua_control_plane_die 'publish accepts no arguments.' || return
      aqua_control_plane_lock_acquire exclusive || return
      aqua_control_plane_publish_bundle || return
      printf '%s\n' "${AQUA_PRODUCTION_SOURCE_DIR}"
      ;;
    lock-exec | hydrate-exec | shared-exec)
      [ "${1:-}" = -- ] || aqua_control_plane_die "${command} requires -- before the child command." || return
      shift
      [ "$#" -gt 0 ] || aqua_control_plane_die "${command} requires a child command." || return
      if [ "${command}" != shared-exec ]; then
        aqua_control_plane_lock_acquire exclusive || return
        aqua_control_plane_prepare_release_recovery "$@" || return
        aqua_control_plane_prepare_bootstrap_gc_rollover "$@" || return
        aqua_control_plane_publish_bundle || return
      else
        aqua_control_plane_lock_acquire shared || return
        aqua_control_plane_guard_dr_state || return
        aqua_control_plane_verify_source || return
      fi
      aqua_control_plane_lock_assert || return
      cd "${AQUA_PRODUCTION_SOURCE_DIR}"
      if [ "${AQUA_CONTROL_PLANE_RECOVER_BEFORE_CHILD:-false}" = true ]; then
        /bin/bash scripts/deploy/droplet-up.sh || return
        unset AQUA_CONTROL_PLANE_RECOVER_BEFORE_CHILD
        unset AQUA_DEPLOY_RECOVERY_ONLY AQUA_DEPLOY_TRANSACTION_OWNER_RELEASE_ID
        aqua_control_plane_guard_release_transaction || return
      fi
      # BEGIN control-plane-ghcr-credential-handoff
      # No external child may run between this builtin-only restoration and
      # exec. droplet-up immediately demotes the value again and exposes it
      # only through Docker login stdin.
      aqua_control_plane_restore_child_ghcr_credential "$@" || return
      exec "$@"
      # END control-plane-ghcr-credential-handoff
      ;;
    *)
      aqua_control_plane_die \
        'Usage: production-host-control-plane.sh <publish|lock-exec|hydrate-exec|shared-exec> [-- command ...]'
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  aqua_control_plane_run "$@"
fi
