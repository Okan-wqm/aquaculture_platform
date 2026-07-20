#!/usr/bin/env bash
# Produce the complete production-host runtime from one immutable Git commit.
# No byte is read from the caller's working tree: Git object access is isolated,
# the tracked tree is archived first, and standalone Node runtimes are compiled
# from that extracted tree.
# Bundle authority is metadata/manifest.json plus metadata/tracked-tree.tsv.
# Standalone members: runtime/check-service-health.mjs and
# runtime/assert-service-signals.mjs.

set +x
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin
export LC_ALL=C
export TZ=UTC

: "${OUTPUT_PATH:?OUTPUT_PATH required}"
: "${SOURCE_SHA:?SOURCE_SHA required}"

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

[[ "${SOURCE_SHA}" =~ ^[0-9a-f]{40}$ ]] || \
  die 'SOURCE_SHA must be a lowercase 40-character commit SHA.'
case "${OUTPUT_PATH}" in
  /*) ;;
  *) die 'OUTPUT_PATH must be absolute.' ;;
esac
[ ! -e "${OUTPUT_PATH}" ] && [ ! -L "${OUTPUT_PATH}" ] || \
  die 'OUTPUT_PATH must not already exist.'
OUTPUT_PARENT=${OUTPUT_PATH%/*}
[ -d "${OUTPUT_PARENT}" ] && [ ! -L "${OUTPUT_PARENT}" ] || \
  die 'OUTPUT_PATH parent must be an existing non-symlink directory.'

for command_path in \
  /usr/bin/awk /usr/bin/chmod /usr/bin/dirname /usr/bin/env /usr/bin/git \
  /usr/bin/find /usr/bin/gzip /usr/bin/ln /usr/bin/mkdir /usr/bin/mktemp /usr/bin/mv \
  /usr/bin/python3 /usr/bin/rm /usr/bin/sha256sum /usr/bin/tar; do
  [ -x "${command_path}" ] || die "Required system command is unavailable: ${command_path}"
done

SCRIPT_DIR=$(CDPATH= cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [ -n "${PRODUCTION_HOST_REPO_ROOT:-}" ]; then
  case "${PRODUCTION_HOST_REPO_ROOT}" in
    /*) ;;
    *) die 'PRODUCTION_HOST_REPO_ROOT must be absolute.' ;;
  esac
  [ -d "${PRODUCTION_HOST_REPO_ROOT}" ] && [ ! -L "${PRODUCTION_HOST_REPO_ROOT}" ] || \
    die 'PRODUCTION_HOST_REPO_ROOT must be a real directory.'
  REPO_ROOT=$(CDPATH= cd -- "${PRODUCTION_HOST_REPO_ROOT}" && pwd -P)
  [ "${REPO_ROOT}" = "${PRODUCTION_HOST_REPO_ROOT}" ] || \
    die 'PRODUCTION_HOST_REPO_ROOT must be canonical.'
else
  REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd -P)
fi
ESBUILD_PATH="${REPO_ROOT}/node_modules/esbuild/bin/esbuild"
[ -f "${ESBUILD_PATH}" ] && [ ! -L "${ESBUILD_PATH}" ] && [ -x "${ESBUILD_PATH}" ] || \
  die 'node_modules/esbuild/bin/esbuild must be an installed regular executable.'

protected_git() {
  /usr/bin/env -i \
    PATH=/usr/bin:/bin \
    HOME=/nonexistent \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    /usr/bin/git \
      --no-replace-objects \
      -c core.hooksPath=/dev/null \
      -c protocol.allow=never \
      -c advice.detachedHead=false \
      -c tar.umask=0022 \
      -C "${REPO_ROOT}" \
      "$@"
}

RESOLVED_SOURCE_SHA=$(protected_git rev-parse --verify "${SOURCE_SHA}^{commit}")
[ "${RESOLVED_SOURCE_SHA}" = "${SOURCE_SHA}" ] || \
  die 'SOURCE_SHA does not resolve to the exact requested commit.'
TREE_HASH=$(protected_git rev-parse --verify "${SOURCE_SHA}^{tree}")
[[ "${TREE_HASH}" =~ ^[0-9a-f]{40,64}$ ]] || die 'Commit tree hash is invalid.'

STAGING_ROOT=$(/usr/bin/mktemp -d -t aqua-production-host-bundle-XXXXXX)
OUTPUT_STAGE=''
cleanup() {
  status=$?
  trap - EXIT
  cleanup_status=0
  if [ -n "${OUTPUT_STAGE}" ] && [ -e "${OUTPUT_STAGE}" ]; then
    /usr/bin/rm -f -- "${OUTPUT_STAGE}" || cleanup_status=1
  fi
  if ! /usr/bin/rm -rf -- "${STAGING_ROOT}" || [ -e "${STAGING_ROOT}" ]; then
    printf 'FATAL: production-host bundle staging cleanup failed.\n' >&2
    cleanup_status=1
  fi
  if [ "${status}" -eq 0 ] && [ "${cleanup_status}" -ne 0 ]; then
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

RAW_ARCHIVE="${STAGING_ROOT}/tracked-tree.tar"
TREE_LISTING="${STAGING_ROOT}/tracked-tree.git.z"
BUNDLE_ROOT="${STAGING_ROOT}/bundle"
REPOSITORY_ROOT="${BUNDLE_ROOT}/repository"
METADATA_ROOT="${BUNDLE_ROOT}/metadata"
RUNTIME_ROOT="${BUNDLE_ROOT}/runtime"
/usr/bin/mkdir -m 0700 \
  "${BUNDLE_ROOT}" "${REPOSITORY_ROOT}" "${METADATA_ROOT}" "${RUNTIME_ROOT}"

# Carry a bounded, exact first-parent ancestry proof inside the authenticated
# runtime bundle. The host uses this to distinguish a newer protected-main
# descendant from an unrelated, stale, or replayed candidate when an earlier
# release crossed an irreversible migration boundary.
FIRST_PARENT_ANCESTRY="${METADATA_ROOT}/first-parent-ancestry.tsv"
protected_git rev-list --first-parent --max-count=1024 "${SOURCE_SHA}" > \
  "${FIRST_PARENT_ANCESTRY}"
/usr/bin/python3 - "${FIRST_PARENT_ANCESTRY}" "${SOURCE_SHA}" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
source_sha = sys.argv[2]
raw = path.read_bytes()
if not raw.endswith(b"\n") or b"\r" in raw or b"\0" in raw:
    raise SystemExit("first-parent ancestry is not canonically encoded")
rows = raw.decode("ascii", "strict").splitlines()
if not 1 <= len(rows) <= 1024 or rows[0] != source_sha:
    raise SystemExit("first-parent ancestry identity/count is invalid")
if len(rows) != len(set(rows)) or any(re.fullmatch(r"[0-9a-f]{40}", row) is None for row in rows):
    raise SystemExit("first-parent ancestry contains an invalid or duplicate commit")
PY

protected_git ls-tree -r -z --full-tree "${SOURCE_SHA}" > "${TREE_LISTING}"
protected_git archive --format=tar --prefix=repository/ \
  --output="${RAW_ARCHIVE}" "${SOURCE_SHA}"

# Validate the Git tree and archive before extraction. Git can track blobs,
# symlinks, and gitlinks; production runtime material admits regular files only.
/usr/bin/python3 - "${TREE_LISTING}" "${RAW_ARCHIVE}" <<'PY'
import os
import pathlib
import re
import sys
import tarfile

listing_path, archive_path = sys.argv[1:]
records = pathlib.Path(listing_path).read_bytes().split(b"\0")
if records and records[-1] == b"":
    records.pop()
if not records:
    raise SystemExit("tracked tree must not be empty")

expected_files: dict[str, int] = {}
safe_path = re.compile(r"^[^\x00-\x1f\x7f]+$")
for raw_record in records:
    try:
        metadata, raw_path = raw_record.split(b"\t", 1)
        mode, object_type, object_id = metadata.decode("ascii").split(" ")
        path = raw_path.decode("utf-8", "strict")
    except (ValueError, UnicodeDecodeError) as error:
        raise SystemExit(f"malformed Git tree record: {error}") from error
    if mode not in {"100644", "100755"} or object_type != "blob":
        raise SystemExit(f"non-regular tracked entry rejected: {path} ({mode}:{object_type})")
    if not re.fullmatch(r"[0-9a-f]{40,64}", object_id):
        raise SystemExit(f"invalid Git object id for {path}")
    pure = pathlib.PurePosixPath(path)
    if (
        not safe_path.fullmatch(path)
        or path.startswith("/")
        or "\\" in path
        or "//" in path
        or any(part in {"", ".", ".."} for part in pure.parts)
    ):
        raise SystemExit(f"unsafe tracked path rejected: {path!r}")
    if path in expected_files:
        raise SystemExit(f"duplicate tracked path rejected: {path}")
    expected_files[path] = int(mode[-3:], 8)

expected_dirs = {"repository"}
for path in expected_files:
    parent = pathlib.PurePosixPath("repository", path).parent
    while str(parent) not in {"", "."}:
        expected_dirs.add(str(parent))
        if str(parent) == "repository":
            break
        parent = parent.parent

seen: set[str] = set()
actual_files: dict[str, int] = {}
actual_dirs: set[str] = set()
with tarfile.open(archive_path, mode="r:") as archive:
    for member in archive:
        name = member.name.rstrip("/")
        pure = pathlib.PurePosixPath(name)
        if (
            not name
            or not safe_path.fullmatch(name)
            or name.startswith("/")
            or "\\" in name
            or "//" in name
            or any(part in {"", ".", ".."} for part in pure.parts)
        ):
            raise SystemExit(f"unsafe archive member rejected: {member.name!r}")
        if name in seen:
            raise SystemExit(f"duplicate archive member rejected: {name}")
        seen.add(name)
        if member.isdir():
            actual_dirs.add(name)
        elif member.isreg():
            if not name.startswith("repository/"):
                raise SystemExit(f"archive file outside repository prefix: {name}")
            actual_files[name[len("repository/"):]] = member.mode & 0o777
        else:
            raise SystemExit(f"unsafe archive member type rejected: {name}")

if actual_files != expected_files:
    missing = sorted(set(expected_files) - set(actual_files))[:5]
    extra = sorted(set(actual_files) - set(expected_files))[:5]
    raise SystemExit(f"archive/tracked tree mismatch: missing={missing} extra={extra}")
if actual_dirs != expected_dirs:
    missing = sorted(expected_dirs - actual_dirs)[:5]
    extra = sorted(actual_dirs - expected_dirs)[:5]
    raise SystemExit(f"archive directory set mismatch: missing={missing} extra={extra}")
PY

/usr/bin/tar --extract --no-same-owner --no-same-permissions \
  --file "${RAW_ARCHIVE}" --directory "${BUNDLE_ROOT}"

# Bind each extracted byte back to the immutable Git object, not to a worktree.
/usr/bin/python3 - "${TREE_LISTING}" "${REPOSITORY_ROOT}" "${METADATA_ROOT}/tracked-tree.objects.tsv" <<'PY'
import pathlib
import subprocess
import sys

listing_path, repository_root, output_path = sys.argv[1:]
rows = []
for raw_record in pathlib.Path(listing_path).read_bytes().split(b"\0"):
    if not raw_record:
        continue
    metadata, raw_path = raw_record.split(b"\t", 1)
    mode, _object_type, object_id = metadata.decode("ascii").split(" ")
    path = raw_path.decode("utf-8")
    rows.append((path, mode, object_id))
rows.sort()
with pathlib.Path(output_path).open("w", encoding="utf-8", newline="\n") as output:
    for path, mode, object_id in rows:
        extracted = pathlib.Path(repository_root, path)
        if not extracted.is_file() or extracted.is_symlink():
            raise SystemExit(f"extracted tracked path is not a regular file: {path}")
        result = subprocess.run(
            ["/usr/bin/git", "hash-object", "--no-filters", str(extracted)],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            env={
                "PATH": "/usr/bin:/bin",
                "HOME": "/nonexistent",
                "LC_ALL": "C",
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": "/dev/null",
            },
        ).stdout.strip()
        if result != object_id:
            raise SystemExit(f"extracted bytes differ from Git object: {path}")
        extracted.chmod(int(mode[-3:], 8))
        output.write(f"{mode}\t{object_id}\t{path}\n")
PY

# Standalone runtime executables remove the droplet's mutable node_modules from
# the execution trust boundary. Both entrypoints are read from the archive.
[ ! -e "${REPOSITORY_ROOT}/node_modules" ] && \
  [ ! -L "${REPOSITORY_ROOT}/node_modules" ] || \
  die 'The protected tree must not contain a node_modules path.'
/usr/bin/ln --symbolic -- "${REPO_ROOT}/node_modules" "${REPOSITORY_ROOT}/node_modules"
(
  cd "${REPOSITORY_ROOT}"
  "${ESBUILD_PATH}" scripts/deploy/check-service-health.ts \
    --bundle --platform=node --format=esm --target=node22 --packages=bundle \
    --legal-comments=none --log-level=error --preserve-symlinks \
    --outfile="${RUNTIME_ROOT}/check-service-health.mjs"
  "${ESBUILD_PATH}" scripts/deploy/assert-service-signals.ts \
    --bundle --platform=node --format=esm --target=node22 --packages=bundle \
    --legal-comments=none --log-level=error --preserve-symlinks \
    --outfile="${RUNTIME_ROOT}/assert-service-signals.mjs"
)
/usr/bin/rm -- "${REPOSITORY_ROOT}/node_modules"
[ ! -e "${REPOSITORY_ROOT}/node_modules" ] && \
  [ ! -L "${REPOSITORY_ROOT}/node_modules" ] || \
  die 'Ephemeral build-toolchain link cleanup failed.'
/usr/bin/chmod 0644 "${RUNTIME_ROOT}/check-service-health.mjs" \
  "${RUNTIME_ROOT}/assert-service-signals.mjs"

# Generate content hashes and the migration projection from the extracted tree.
/usr/bin/python3 - \
  "${TREE_LISTING}" "${REPOSITORY_ROOT}" "${METADATA_ROOT}/tracked-tree.tsv" \
  "${METADATA_ROOT}/migrations.tsv" <<'PY'
import hashlib
import pathlib
import re
import sys

listing_path, repository_root, tree_output, migration_output = sys.argv[1:]
rows = []
for raw_record in pathlib.Path(listing_path).read_bytes().split(b"\0"):
    if not raw_record:
        continue
    metadata, raw_path = raw_record.split(b"\t", 1)
    mode = metadata.decode("ascii").split(" ", 1)[0]
    path = raw_path.decode("utf-8")
    digest = hashlib.sha256(pathlib.Path(repository_root, path).read_bytes()).hexdigest()
    rows.append((path, mode, digest))
rows.sort()
with pathlib.Path(tree_output).open("w", encoding="utf-8", newline="\n") as output:
    for path, mode, digest in rows:
        output.write(f"{mode}\t{digest}\t{path}\n")

migration_pattern = re.compile(
    r"^apps/[^/]+/src/(?:.+/)?migrations/[0-9][^/]*\.ts$"
)
migrations = [
    (path, digest)
    for path, _mode, digest in rows
    if migration_pattern.fullmatch(path)
    or path == "apps/db-migrate/src/schema-registry.ts"
]
if not migrations:
    raise SystemExit("migration projection must not be empty")
with pathlib.Path(migration_output).open("w", encoding="utf-8", newline="\n") as output:
    for path, digest in migrations:
        output.write(f"{digest}\t{path}\n")
PY
/usr/bin/rm -f -- "${METADATA_ROOT}/tracked-tree.objects.tsv"

/usr/bin/python3 - \
  "${METADATA_ROOT}/manifest.json" "${SOURCE_SHA}" "${TREE_HASH}" \
  "${METADATA_ROOT}/tracked-tree.tsv" "${METADATA_ROOT}/migrations.tsv" \
  "${FIRST_PARENT_ANCESTRY}" \
  "${REPOSITORY_ROOT}/infrastructure/docker/nats/nats.conf" \
  "${RUNTIME_ROOT}/check-service-health.mjs" \
  "${RUNTIME_ROOT}/assert-service-signals.mjs" <<'PY'
import hashlib
import json
import pathlib
import sys

(
    output_path,
    main_sha,
    tree_hash,
    tree_manifest_path,
    migrations_path,
    first_parent_ancestry_path,
    nats_path,
    health_runtime_path,
    signals_runtime_path,
) = sys.argv[1:]

def digest(path: str) -> str:
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

tree_lines = pathlib.Path(tree_manifest_path).read_text(encoding="utf-8").splitlines()
ancestry_lines = pathlib.Path(first_parent_ancestry_path).read_text(encoding="ascii").splitlines()
manifest = {
    "assert_service_signals_runtime_hash": digest(signals_runtime_path),
    "check_service_health_runtime_hash": digest(health_runtime_path),
    "format": "aqua-production-host-runtime-v1",
    "first_parent_ancestry_count": len(ancestry_lines),
    "first_parent_ancestry_hash": digest(first_parent_ancestry_path),
    "main_sha": main_sha,
    "migration_manifest_hash": digest(migrations_path),
    "nats_config_hash": digest(nats_path),
    "tracked_file_count": len(tree_lines),
    "tracked_tree_manifest_hash": digest(tree_manifest_path),
    "tree_hash": tree_hash,
}
pathlib.Path(output_path).write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
/usr/bin/chmod 0644 \
  "${METADATA_ROOT}/manifest.json" "${METADATA_ROOT}/tracked-tree.tsv" \
  "${METADATA_ROOT}/migrations.tsv" "${FIRST_PARENT_ANCESTRY}"
/usr/bin/find "${BUNDLE_ROOT}" -type d -exec /usr/bin/chmod 0755 {} +

# Repack with canonical metadata, ordering, timestamp, owner, and gzip header.
CANONICAL_TAR="${STAGING_ROOT}/production-host-runtime.tar"
/usr/bin/tar --create --format=gnu --sort=name --mtime='@0' \
  --owner=0 --group=0 --numeric-owner \
  --file "${CANONICAL_TAR}" --directory "${BUNDLE_ROOT}" \
  metadata runtime repository
OUTPUT_STAGE=$(/usr/bin/mktemp "${OUTPUT_PARENT}/.production-host-runtime.XXXXXX")
/usr/bin/gzip --no-name --best --stdout "${CANONICAL_TAR}" > "${OUTPUT_STAGE}"
/usr/bin/chmod 0600 "${OUTPUT_STAGE}"
/usr/bin/mv -T -- "${OUTPUT_STAGE}" "${OUTPUT_PATH}"
OUTPUT_STAGE=''

/usr/bin/sha256sum --binary "${OUTPUT_PATH}" | /usr/bin/awk '{print $1}'
