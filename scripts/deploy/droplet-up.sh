#!/usr/bin/env bash
# =============================================================================
# scripts/deploy/droplet-up.sh
#
# Invoked by `.github/workflows/deploy-digitalocean.yml`'s `Deploy to
# DigitalOcean Droplet` job through the protected native OpenSSH helper. Runs
# from a runner-built exact-SHA bundle after host fingerprint verification.
# Extracted from the historical inline `script: |` block because that
# block's `${{ }}` interpolation + bash content crossed GitHub Actions'
# 21,000-char per-expression limit (commit 2c055125+ triggered
# HTTP 422 "Exceeded max expression length 21000" at workflow parse).
#
# Moving the bash out of the YAML:
#   1. Keeps the YAML expression size tiny (the workflow step now only
#      passes env vars and invokes this script).
#   2. Makes the deploy logic unit-testable locally (shellcheck, etc.).
#   3. Lets the script grow without pushing the YAML back over the
#      parser limit.
#
# Required env vars (decoded by the protected stdin payload):
#   DEPLOY_SERVICES   — comma-separated service list ("all" for full)
#   FULL_DEPLOY       — "true" or "false"
#   DEPLOY_SHA        — commit SHA being deployed
#   GHCR_ACTOR        — actor username for GHCR login
#   GHCR_TOKEN        — protected production Environment's package-read token
#   IMAGE_PREFIX      — GHCR image prefix (defaults to this repository)
# =============================================================================

set +x
set -euo pipefail

# BEGIN ghcr-credential-demotion
# The protected payload must export the credential only for the final
# entrypoint hand-off. Demote it before the first external command in this
# script so source verification, lock acquisition, diagnostics, cleanup and
# retry sleeps cannot inherit package authority through their environments.
ghcr_read_token_material=
if [ "${AQUA_DEPLOY_RECOVERY_ONLY:-false}" != true ]; then
  : "${GHCR_TOKEN:?GHCR_TOKEN is required}"
  ghcr_read_token_material=${GHCR_TOKEN}
fi
unset GHCR_TOKEN
# END ghcr-credential-demotion

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
DEPLOY_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=scripts/deploy/deploy-paths.sh
source "${DEPLOY_SCRIPT_DIR}/deploy-paths.sh"
configure_deploy_paths "${DEPLOY_SHA}"
assert_deploy_source_bundle "${DEPLOY_SHA}"
aqua_control_plane_require_node_authority
# `lock-exec` already owns this FD in the normal workflow. Reacquiring the
# inherited open-file description is immediate; direct invocations acquire the
# same authority before any state directory, Docker or secret mutation.
aqua_control_plane_lock_acquire exclusive 300
aqua_control_plane_lock_assert
aqua_control_plane_guard_dr_state
prepare_deploy_env_file
cd "${DEPLOY_CHECKOUT_DIR}"

IMAGE_PREFIX="${IMAGE_PREFIX:-ghcr.io/okan-wqm/aquaculture_platform}"
TAG="${TAG:-${DEPLOY_SHA:-}}"
export TAG
GATEWAY_IMAGE_REF="${IMAGE_PREFIX}/gateway-api:latest"
AQUA_DEPLOY_RECOVERY_ONLY=${AQUA_DEPLOY_RECOVERY_ONLY:-false}
case "${AQUA_DEPLOY_RECOVERY_ONLY}" in true|false) ;; *)
  echo "::error::AQUA_DEPLOY_RECOVERY_ONLY must be true or false." >&2
  exit 2
  ;;
esac
if [ "${AQUA_DEPLOY_RECOVERY_ONLY}" = true ]; then
  DEPLOY_RELEASE_ID=${AQUA_DEPLOY_TRANSACTION_OWNER_RELEASE_ID:?recovery release owner is required}
else
  [ -z "${AQUA_DEPLOY_TRANSACTION_OWNER_RELEASE_ID:-}" ] || {
    echo "::error::A release transaction owner is accepted only for recovery." >&2
    exit 2
  }
  DEPLOY_RELEASE_ID="${DEPLOY_RELEASE_ID:-${DEPLOY_SHA:-unknown}-$(date -u +%Y%m%dT%H%M%SZ)}"
fi
export DEPLOY_RELEASE_ID
DEPLOY_STATE_ROOT="${DEPLOY_STATE_ROOT:-${AQUA_CONTROL_PLANE_RELEASES_ROOT:-/var/lib/aqua/deploy/releases}}"
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-${DEPLOY_STATE_ROOT}/${DEPLOY_RELEASE_ID}}"
export DEPLOY_STATE_DIR
if [ "${DEPLOY_STATE_ROOT}" != "${AQUA_CONTROL_PLANE_RELEASES_ROOT}" ] || \
  [ "${DEPLOY_STATE_DIR}" != "${DEPLOY_STATE_ROOT}/${DEPLOY_RELEASE_ID}" ]; then
  echo "::error::Deploy release state must use the canonical control-plane path." >&2
  exit 2
fi
if [ "${AQUA_DEPLOY_RECOVERY_ONLY}" = true ]; then
  aqua_control_plane_prepare_releases_root false
else
  aqua_control_plane_prepare_releases_root true
fi
/usr/bin/python3 - \
  "${DEPLOY_STATE_ROOT}" "${DEPLOY_STATE_DIR}" "${DEPLOY_RELEASE_ID}" \
  "${DEPLOY_SHA}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" \
  "${AQUA_DEPLOY_RECOVERY_ONLY}" <<'DEPLOY_RELEASE_DIRECTORY_PY'
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
release = pathlib.Path(sys.argv[2])
release_id = sys.argv[3]
main_sha = sys.argv[4]
expected_uid = int(sys.argv[5])
recovery = sys.argv[6] == "true"
release_pattern = re.compile(r"^([0-9a-f]{40})-[0-9]{8}T[0-9]{6}Z$")
match = release_pattern.fullmatch(release_id)
if match is None or match.group(1) != main_sha or release != root / release_id:
    raise SystemExit("deploy release directory identity is invalid")

root_parent = root.parent
parent_info = os.lstat(root_parent)
if (
    stat.S_ISLNK(parent_info.st_mode)
    or not stat.S_ISDIR(parent_info.st_mode)
    or parent_info.st_uid != expected_uid
    or parent_info.st_mode & 0o022
):
    raise SystemExit("deploy release root parent is unsafe")
try:
    root_info = os.lstat(root)
except FileNotFoundError:
    raise SystemExit("deploy release root is missing")
if (
    stat.S_ISLNK(root_info.st_mode)
    or not stat.S_ISDIR(root_info.st_mode)
    or root_info.st_uid != expected_uid
    or stat.S_IMODE(root_info.st_mode) != 0o700
):
    raise SystemExit("deploy release root is unsafe")
try:
    os.lstat(release)
except FileNotFoundError:
    if recovery:
        raise SystemExit("recovery release directory is missing")
    os.mkdir(release, 0o700)
else:
    if not recovery:
        raise SystemExit("deploy release directory already exists")
release_info = os.lstat(release)
if (
    stat.S_ISLNK(release_info.st_mode)
    or not stat.S_ISDIR(release_info.st_mode)
    or release_info.st_uid != expected_uid
    or stat.S_IMODE(release_info.st_mode) != 0o700
):
    raise SystemExit("deploy release directory is unsafe")
root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(root_fd)
finally:
    os.close(root_fd)
DEPLOY_RELEASE_DIRECTORY_PY
ROLLBACK_STATE_DIR="${DEPLOY_STATE_DIR}/rollback-state"
ROLLBACK_MANIFEST="${ROLLBACK_STATE_DIR}/rollback-images.tsv"
ROLLBACK_CHECKSUM="${ROLLBACK_STATE_DIR}/rollback-images.sha256"
export ROLLBACK_STATE_DIR
export ROLLBACK_MANIFEST
export ROLLBACK_CHECKSUM
DEPLOY_IMAGE_DIGESTS_FILE="${DEPLOY_IMAGE_DIGESTS_FILE:-${DEPLOY_STATE_DIR}/image-digests.tsv}"
export DEPLOY_IMAGE_DIGESTS_FILE
DEPLOY_COMPOSE_OVERRIDE_FILE="${DEPLOY_STATE_DIR}/immutable-images.override.yml"
export DEPLOY_COMPOSE_OVERRIDE_FILE

CATALOG_DEPLOY_ENV="${CATALOG_DEPLOY_ENV:-infrastructure/deploy/service-catalog.deploy.vars}"
if [ ! -r "${CATALOG_DEPLOY_ENV}" ]; then
  echo "::error::Missing generated service catalog deploy artifact: ${CATALOG_DEPLOY_ENV}"
  echo "  Run npm run service-catalog:generate and commit the generated artifact."
  exit 1
fi
# shellcheck source=infrastructure/deploy/service-catalog.deploy.vars
. "${CATALOG_DEPLOY_ENV}"
APPLICATION_IMAGE_SERVICES="${CATALOG_APPLICATION_IMAGE_SERVICES:?generated application image services missing}"
APPLICATION_COMPOSE_IMAGE_MAP="${CATALOG_APPLICATION_COMPOSE_IMAGE_MAP:?generated application compose-image map missing}"
SERVICE_DB_ROLES="${CATALOG_SERVICE_DB_ROLE_PREFIXES:?generated service DB role prefixes missing}"

if [ "${AQUA_DEPLOY_RECOVERY_ONLY}" = true ]; then
  mapfile -t AQUA_RECOVERY_METADATA < <(
    /usr/bin/python3 - \
      "${AQUA_CONTROL_PLANE_ROOT}/active-release-transaction.json" \
      "${DEPLOY_RELEASE_ID}" "${DEPLOY_SHA}" <<'DEPLOY_RECOVERY_METADATA_PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
release_id = sys.argv[2]
candidate_sha = sys.argv[3]
document = json.loads(path.read_text(encoding="utf-8"))
if document.get("release_id") != release_id or document.get("candidate_sha") != candidate_sha:
    raise SystemExit("release recovery journal identity mismatch")
print(document["phase"])
print("true" if document["full_deploy"] else "false")
print(" ".join(document["deploy_services"]))
print("unknown" if document["migrations_applied"] is None else document["migrations_applied"])
print(json.dumps(document["prior_release"], sort_keys=True, separators=(",", ":")))
print(document["image_digest_manifest_sha256"])
print(document["rollback_manifest_sha256"])
print(document["rollback_policy"])
print(document["supersedes_release_id"] or "")
print(document["supersedes_candidate_sha"] or "")
print(document["supersession_proof_sha256"] or "")
DEPLOY_RECOVERY_METADATA_PY
  )
  [ "${#AQUA_RECOVERY_METADATA[@]}" -eq 11 ] || {
    echo "::error::Release recovery metadata is incomplete." >&2
    exit 2
  }
  AQUA_RECOVERY_PHASE=${AQUA_RECOVERY_METADATA[0]}
  FULL_DEPLOY=${AQUA_RECOVERY_METADATA[1]}
  DEPLOY_SERVICES=${AQUA_RECOVERY_METADATA[2]}
  AQUA_RECOVERY_MIGRATIONS=${AQUA_RECOVERY_METADATA[3]}
  AQUA_RECOVERY_PRIOR_JSON=${AQUA_RECOVERY_METADATA[4]}
  AQUA_RECOVERY_MANIFEST_HASH=${AQUA_RECOVERY_METADATA[5]}
  AQUA_RECOVERY_ROLLBACK_HASH=${AQUA_RECOVERY_METADATA[6]}
  AQUA_DEPLOY_ROLLBACK_POLICY=${AQUA_RECOVERY_METADATA[7]}
  AQUA_DEPLOY_SUPERSEDES_RELEASE_ID=${AQUA_RECOVERY_METADATA[8]}
  AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA=${AQUA_RECOVERY_METADATA[9]}
  AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256=${AQUA_RECOVERY_METADATA[10]}
  export FULL_DEPLOY DEPLOY_SERVICES
  export AQUA_DEPLOY_ROLLBACK_POLICY AQUA_DEPLOY_SUPERSEDES_RELEASE_ID
  export AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256
fi

AQUA_DEPLOY_ROLLBACK_POLICY=${AQUA_DEPLOY_ROLLBACK_POLICY:-ALLOW_ZERO_MIGRATION}

materialize_deploy_image_digest_manifest() {
  [ "$#" -eq 0 ] || return 64
  : "${DEPLOY_IMAGE_DIGESTS_B64:?DEPLOY_IMAGE_DIGESTS_B64 is required}"
  : "${DEPLOY_SERVICES:?DEPLOY_SERVICES is required}"

  /usr/bin/python3 - \
    "${DEPLOY_IMAGE_DIGESTS_FILE}" "${DEPLOY_COMPOSE_OVERRIDE_FILE}" \
    "${APPLICATION_IMAGE_SERVICES}" "${DEPLOY_SERVICES}" \
    "${IMAGE_PREFIX}" "${APPLICATION_COMPOSE_IMAGE_MAP}" <<'DEPLOY_IMAGE_MANIFEST_PY'
import base64
import binascii
import os
import pathlib
import re
import stat
import sys
import tempfile

destination = pathlib.Path(sys.argv[1])
override_destination = pathlib.Path(sys.argv[2])
catalog_services = sys.argv[3].split()
deploy_services = sys.argv[4].split()
image_prefix = sys.argv[5]
compose_image_tokens = sys.argv[6].split()
encoded = os.environ.get("DEPLOY_IMAGE_DIGESTS_B64", "")
service_pattern = re.compile(r"^[a-z0-9][a-z0-9-]*$")
prefix_pattern = re.compile(r"^ghcr\.io/[a-z0-9._-]+/[a-z0-9._/-]+$")
digest_pattern = re.compile(r"^sha256:[0-9a-f]{64}$")

if not encoded or len(encoded) > 131072:
    raise SystemExit("deploy image digest manifest encoding is missing or unbounded")
try:
    payload = base64.b64decode(encoded, validate=True)
except (binascii.Error, ValueError) as error:
    raise SystemExit("deploy image digest manifest is not canonical base64") from error
if base64.b64encode(payload).decode("ascii") != encoded:
    raise SystemExit("deploy image digest manifest base64 representation is not canonical")
if not payload or len(payload) > 65536 or not payload.endswith(b"\n"):
    raise SystemExit("deploy image digest manifest payload is empty, unbounded, or unterminated")
try:
    text = payload.decode("utf-8")
except UnicodeDecodeError as error:
    raise SystemExit("deploy image digest manifest is not UTF-8") from error
if "\r" in text or "\x00" in text:
    raise SystemExit("deploy image digest manifest contains forbidden bytes")
if (
    not catalog_services
    or len(catalog_services) != len(set(catalog_services))
    or any(service_pattern.fullmatch(service) is None for service in catalog_services)
):
    raise SystemExit("application image catalog is invalid")
if (
    not deploy_services
    or len(deploy_services) != len(set(deploy_services))
    or any(service not in catalog_services for service in deploy_services)
    or "db-migrate" not in deploy_services
):
    raise SystemExit("deploy service selection is invalid")
if prefix_pattern.fullmatch(image_prefix) is None:
    raise SystemExit("deploy image repository prefix is invalid")

compose_image_bindings: list[tuple[str, str]] = []
seen_compose_services: set[str] = set()
for token in compose_image_tokens:
    fields = token.split(":")
    if len(fields) != 2:
        raise SystemExit("application compose-image binding schema is invalid")
    compose_service, image_service = fields
    if (
        service_pattern.fullmatch(compose_service) is None
        or service_pattern.fullmatch(image_service) is None
        or image_service not in catalog_services
        or compose_service in seen_compose_services
    ):
        raise SystemExit("application compose-image binding identity is invalid")
    seen_compose_services.add(compose_service)
    compose_image_bindings.append((compose_service, image_service))
if not compose_image_bindings or {image for _compose, image in compose_image_bindings} != set(catalog_services):
    raise SystemExit("application compose-image binding coverage is invalid")

rows: list[tuple[str, str, str]] = []
for line in text.splitlines():
    fields = line.split("\t")
    if len(fields) != 3:
        raise SystemExit("deploy image digest manifest row schema is invalid")
    service, repository, digest = fields
    if (
        service_pattern.fullmatch(service) is None
        or repository != f"{image_prefix}/{service}"
        or digest_pattern.fullmatch(digest) is None
    ):
        raise SystemExit(f"deploy image digest manifest row identity is invalid: {service}")
    rows.append((service, repository, digest))
if [row[0] for row in rows] != deploy_services:
    raise SystemExit("deploy image digest manifest service set/order is not exact")

rows_by_image = {service: (repository, digest) for service, repository, digest in rows}
override_payload = (
    "services:\n"
    + "".join(
        f"  {compose_service}:\n    image: {rows_by_image[image_service][0]}@{rows_by_image[image_service][1]}\n"
        for compose_service, image_service in compose_image_bindings
        if image_service in rows_by_image
    )
).encode("ascii")

parent = destination.parent
if override_destination.parent != parent or override_destination == destination:
    raise SystemExit("deploy compose override path is not canonical")
parent_info = os.lstat(parent)
if (
    stat.S_ISLNK(parent_info.st_mode)
    or not stat.S_ISDIR(parent_info.st_mode)
    or parent_info.st_uid != os.geteuid()
    or parent_info.st_mode & 0o022
):
    raise SystemExit("deploy image digest manifest parent directory is unsafe")
def validate_existing(path: pathlib.Path, label: str) -> None:
    if not path.exists() and not path.is_symlink():
        return
    destination_info = os.lstat(path)
    if (
        stat.S_ISLNK(destination_info.st_mode)
        or not stat.S_ISREG(destination_info.st_mode)
        or destination_info.st_uid != os.geteuid()
        or destination_info.st_nlink != 1
        or stat.S_IMODE(destination_info.st_mode) != 0o600
    ):
        raise SystemExit(f"existing {label} is unsafe")

validate_existing(destination, "deploy image digest manifest")
validate_existing(override_destination, "deploy compose override")


def publish(path: pathlib.Path, contents: bytes, prefix: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(dir=parent, prefix=prefix, suffix=".tmp")
    temporary_path = pathlib.Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary_path, path)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass
        raise


publish(destination, payload, ".image-digests.")
publish(override_destination, override_payload, ".immutable-images.")
directory_descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(directory_descriptor)
finally:
    os.close(directory_descriptor)
DEPLOY_IMAGE_MANIFEST_PY
}

if [ "${AQUA_DEPLOY_RECOVERY_ONLY}" != true ]; then
  materialize_deploy_image_digest_manifest
fi
unset DEPLOY_IMAGE_DIGESTS_B64

assert_deploy_compose_override() {
  /usr/bin/python3 - \
    "${DEPLOY_IMAGE_DIGESTS_FILE}" "${DEPLOY_COMPOSE_OVERRIDE_FILE}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${APPLICATION_IMAGE_SERVICES}" \
    "${APPLICATION_COMPOSE_IMAGE_MAP}" <<'DEPLOY_COMPOSE_OVERRIDE_VERIFY_PY'
import os
import pathlib
import re
import stat
import sys

manifest = pathlib.Path(sys.argv[1])
override = pathlib.Path(sys.argv[2])
expected_uid = int(sys.argv[3])
catalog_services = sys.argv[4].split()
compose_image_tokens = sys.argv[5].split()
service_pattern = re.compile(r"^[a-z0-9][a-z0-9-]*$")
row_pattern = re.compile(
    r"^([a-z0-9][a-z0-9-]*)\t([a-z0-9][a-z0-9._/-]*)\t(sha256:[0-9a-f]{64})$"
)


def read_safe(path: pathlib.Path, maximum: int) -> bytes:
    info = os.lstat(path)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > maximum
    ):
        raise SystemExit(f"immutable deploy artifact is unsafe: {path}")
    return path.read_bytes()


manifest_bytes = read_safe(manifest, 65536)
if not manifest_bytes.endswith(b"\n"):
    raise SystemExit("immutable deploy manifest is unterminated")
rows: list[tuple[str, str, str]] = []
for line in manifest_bytes.decode("ascii").splitlines():
    match = row_pattern.fullmatch(line)
    if match is None:
        raise SystemExit("immutable deploy manifest row is invalid")
    rows.append((match.group(1), match.group(2), match.group(3)))
if not rows or len({row[0] for row in rows}) != len(rows) or "db-migrate" not in {row[0] for row in rows}:
    raise SystemExit("immutable deploy manifest service set is invalid")
if (
    not catalog_services
    or len(catalog_services) != len(set(catalog_services))
    or any(service_pattern.fullmatch(service) is None for service in catalog_services)
):
    raise SystemExit("immutable deploy image catalog is invalid")
bindings: list[tuple[str, str]] = []
seen_compose_services: set[str] = set()
for token in compose_image_tokens:
    fields = token.split(":")
    if len(fields) != 2:
        raise SystemExit("immutable deploy compose-image binding schema is invalid")
    compose_service, image_service = fields
    if (
        service_pattern.fullmatch(compose_service) is None
        or service_pattern.fullmatch(image_service) is None
        or image_service not in catalog_services
        or compose_service in seen_compose_services
    ):
        raise SystemExit("immutable deploy compose-image binding identity is invalid")
    seen_compose_services.add(compose_service)
    bindings.append((compose_service, image_service))
if not bindings or {image for _compose, image in bindings} != set(catalog_services):
    raise SystemExit("immutable deploy compose-image binding coverage is invalid")
rows_by_image = {service: (repository, digest) for service, repository, digest in rows}
expected = (
    "services:\n"
    + "".join(
        f"  {compose_service}:\n    image: {rows_by_image[image_service][0]}@{rows_by_image[image_service][1]}\n"
        for compose_service, image_service in bindings
        if image_service in rows_by_image
    )
).encode("ascii")
if read_safe(override, 65536) != expected:
    raise SystemExit("immutable deploy compose override does not match the digest manifest")
DEPLOY_COMPOSE_OVERRIDE_VERIFY_PY
}

deploy_compose() {
  assert_deploy_compose_override || return
  docker compose -f docker-compose.droplet.yml -f "${DEPLOY_COMPOSE_OVERRIDE_FILE}" "$@"
}

rollback_compose() {
  docker compose -f docker-compose.droplet.yml "$@"
}

if [ "${AQUA_DEPLOY_RECOVERY_ONLY}" = true ]; then
  assert_deploy_compose_override
  [ "$(sha256sum --binary "${DEPLOY_IMAGE_DIGESTS_FILE}" | awk '{print $1}')" = \
    "${AQUA_RECOVERY_MANIFEST_HASH}" ] || {
    echo "::error::Recovery image manifest no longer matches the transaction journal." >&2
    exit 2
  }
fi

remove_canonical_project_containers_after_down() {
  local max_containers=128
  local inventory
  local services_inventory
  local container_id
  local details
  local inspected_id
  local project
  local service
  local extra
  local -a container_ids=()
  local -A allowed_services=()
  local -A seen_containers=()

  aqua_control_plane_lock_assert || return
  services_inventory=$(mktemp) || return
  inventory=$(mktemp) || {
    rm -f -- "${services_inventory}"
    return 1
  }
  if ! deploy_compose config --services > "${services_inventory}"; then
    rm -f -- "${services_inventory}" "${inventory}"
    return 1
  fi
  while IFS= read -r service; do
    if [[ ! "${service}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
      [[ -n "${allowed_services[${service}]+present}" ]]; then
      rm -f -- "${services_inventory}" "${inventory}"
      echo "::error::Canonical Compose service inventory is invalid." >&2
      return 1
    fi
    allowed_services["${service}"]=1
    if [ "${#allowed_services[@]}" -gt "${max_containers}" ]; then
      rm -f -- "${services_inventory}" "${inventory}"
      echo "::error::Canonical Compose service inventory exceeds its bound." >&2
      return 1
    fi
  done < "${services_inventory}"
  rm -f -- "${services_inventory}"
  [ "${#allowed_services[@]}" -gt 0 ] || {
    rm -f -- "${inventory}"
    echo "::error::Canonical Compose service inventory is empty." >&2
    return 1
  }

  if ! aqua_control_plane_capture_docker_output \
    "${inventory}" "$(((max_containers + 1) * 65))" \
    'project container cleanup inventory' \
    "${AQUA_PRODUCTION_DOCKER_CAPTURE_TIMEOUT_SECONDS}" \
    docker ps --all --quiet --no-trunc \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}"; then
    rm -f -- "${inventory}"
    return 1
  fi
  if [ -s "${inventory}" ] && \
    [ "$(tail -c 1 -- "${inventory}" | od -An -tx1 | tr -d '[:space:]')" != 0a ]; then
    rm -f -- "${inventory}"
    echo "::error::Project container cleanup inventory is unterminated." >&2
    return 1
  fi
  while IFS= read -r container_id; do
    if [[ ! "${container_id}" =~ ^[0-9a-f]{64}$ ]] || \
      [[ -n "${seen_containers[${container_id}]+present}" ]]; then
      rm -f -- "${inventory}"
      echo "::error::Project container cleanup inventory contains an invalid identity." >&2
      return 1
    fi
    seen_containers["${container_id}"]=1
    container_ids+=("${container_id}")
    if [ "${#container_ids[@]}" -gt "${max_containers}" ]; then
      rm -f -- "${inventory}"
      echo "::error::Project container cleanup inventory exceeds its bound." >&2
      return 1
    fi
  done < "${inventory}"
  rm -f -- "${inventory}"

  for container_id in "${container_ids[@]}"; do
    if ! details=$(docker inspect --type container --format \
      '{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "${container_id}"); then
      echo "::error::Cannot inspect exact project container ${container_id}." >&2
      return 1
    fi
    IFS='|' read -r inspected_id project service extra <<< "${details}"
    if [ -n "${extra}" ] || [ "${inspected_id}" != "${container_id}" ] || \
      [ "${project}" != "${COMPOSE_PROJECT_NAME}" ] || \
      [[ ! "${service:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
      [[ -z "${allowed_services[${service:-}]+present}" ]]; then
      echo "::error::Container cleanup authority rejected ${container_id}." >&2
      return 1
    fi
  done

  for container_id in "${container_ids[@]}"; do
    echo "  Removing canonical ${COMPOSE_PROJECT_NAME} container ${container_id}..."
    docker rm -f "${container_id}"
  done
}

OWN_DOCKER_CONFIG=false
if [ -z "${DOCKER_CONFIG:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d /tmp/aqua-docker-config.XXXXXX)"
  export DOCKER_CONFIG
  OWN_DOCKER_CONFIG=true
fi

cleanup_docker_auth() {
  if [ "${OWN_DOCKER_CONFIG}" = "true" ] && [ -n "${DOCKER_CONFIG:-}" ]; then
    case "${DOCKER_CONFIG}" in
      /tmp/aqua-docker-config.*) ;;
      *)
        echo "::error::Refusing to clean a non-canonical deploy Docker config path."
        return 1
        ;;
    esac
    [ -d "${DOCKER_CONFIG}" ] && [ ! -L "${DOCKER_CONFIG}" ] || {
      echo "::error::Deploy Docker config is not a real directory."
      return 1
    }
    docker logout ghcr.io >/dev/null 2>&1 || true
    rm -rf --one-file-system -- "${DOCKER_CONFIG}" || return
    [ ! -e "${DOCKER_CONFIG}" ] && [ ! -L "${DOCKER_CONFIG}" ] || return 1
    OWN_DOCKER_CONFIG=false
  fi
}
trap cleanup_docker_auth EXIT

ACTIVE_COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"
if [ -z "${ACTIVE_COMPOSE_PROFILES}" ] && [ -f "${DEPLOY_ENV_FILE}" ]; then
  ACTIVE_COMPOSE_PROFILES="$(grep -E '^COMPOSE_PROFILES=' "${DEPLOY_ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
fi
case ",${ACTIVE_COMPOSE_PROFILES// /,}," in
  *",rust-sidecar,"*)
    echo "::error::COMPOSE_PROFILES includes rust-sidecar, but sensor-ingestion is not in the production immutable image matrix."
    echo "  Refusing production deploy. Add sensor-ingestion to APPLICATION_IMAGE_SERVICES and the deploy image matrix before enabling this profile."
    exit 1
    ;;
esac

# ──────────────────────────────────────────────────────────────────────────
# ADR-031 — Service DB-role password SSoT
#
# The platform-bootstrap atom
# (apps/db-migrate/src/platform-bootstrap.service.ts) fails loud at Phase 0
# if any *_SERVICE_DB_PASS env var is missing or empty. THIS script's
# generate_credential loop provisions those passwords from the generated
# platform service catalog deploy artifact.
#
# Adding a new service-role requires a catalog runtime dbRole; this script
# must not carry a hand-written duplicate list.
#
# 2026-05-19: AI, OBSERVABILITY, EVENT_STORE, CONFIG appended after the
# 2026-05-18 cutover deploy 26082203809 aborted at:
#   [platform-bootstrap] Phase 0 abort: 4/15 service-role password env
#   vars are missing or empty: AI_SERVICE_DB_PASS, OBSERVABILITY_SERVICE_DB_PASS,
#   EVENT_STORE_SERVICE_DB_PASS, CONFIG_SERVICE_DB_PASS.
#
# The full-deploy and selective-deploy paths both consume SERVICE_DB_ROLES,
# which is derived from CATALOG_SERVICE_DB_ROLE_PREFIXES above.
# ──────────────────────────────────────────────────────────────────────────
read_env_file_value() {
  local name="$1"
  local file="${2:-${DEPLOY_ENV_FILE}}"

  if [ ! -r "$file" ]; then
    return 0
  fi

  grep -E "^${name}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

generate_credential() {
  local VAR_NAME="$1"
  local ENV_FILE="${2:-${DEPLOY_ENV_FILE}}"
  touch "${ENV_FILE}"
  if grep -q "^${VAR_NAME}=" "${ENV_FILE}" 2>/dev/null; then
    echo "  ${VAR_NAME}: already set"
  else
    local VALUE
    VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
    echo "${VAR_NAME}=${VALUE}" >> "${ENV_FILE}"
    echo "  ${VAR_NAME}: generated"
  fi
}

redact_sensitive() {
  sed -E \
    -e 's/([A-Za-z0-9_]*(PASSWORD|TOKEN|SECRET|PRIVATE_KEY|API_KEY|ACCESS_KEY|PEPPER)[A-Za-z0-9_]*=)[^[:space:]]+/\1[REDACTED]/gI' \
    -e 's#(postgres(ql)?|redis|rediss|mongodb|mysql)://[^[:space:]]+#\1://[REDACTED]#gI' \
    -e 's/(Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/gI' \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[JWT_REDACTED]/g' \
    -e 's/-----BEGIN [^-]+ PRIVATE KEY-----[^[:space:]]*/-----BEGIN PRIVATE KEY-----[REDACTED]/g'
}

run_redacted() {
  "$@" 2>&1 | redact_sensitive
}

dump_nonhealthy_container_logs() {
  local label="${1:-snapshot}"
  echo "=== Logs from non-healthy/restarting containers (${label}) ==="
  for c in $(docker ps -a --format '{{.Names}}' --filter "label=com.docker.compose.project=aqua-saas"); do
    HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$c" 2>/dev/null || echo "none")
    RESTARTS=$(docker inspect --format='{{.RestartCount}}' "$c" 2>/dev/null || echo "0")
    if [ "$HEALTH" != "healthy" ] || [ "$RESTARTS" -gt 0 ] 2>/dev/null; then
      echo "--- $c (health=$HEALTH, restarts=$RESTARTS) last 200 lines ---"
      docker logs --tail 200 "$c" 2>&1 | redact_sensitive || true
    fi
  done
}

run_db_migrate_or_exit() {
  local deploy_mode="${1:-deploy}"

  echo "=== Running aqua-db-migrate (one-shot schema runner) ==="
  # db-migrate is the only schema writer. Every selected image, including
  # db-migrate, was pulled and identity-checked before the first live mutation;
  # the exact Compose invocation creates this one-shot container from the
  # verified digest override. GNU timeout must receive an executable rather
  # than the deploy_compose shell function.

  DB_MIGRATE_TIMEOUT_SECONDS="${DB_MIGRATE_TIMEOUT_SECONDS:-1200}"
  assert_deploy_compose_override || return
  set +e
  timeout --kill-after=30s "${DB_MIGRATE_TIMEOUT_SECONDS}s" \
    docker compose -f docker-compose.droplet.yml \
      -f "${DEPLOY_COMPOSE_OVERRIDE_FILE}" \
      up --no-build --abort-on-container-exit \
      --exit-code-from db-migrate db-migrate
  DB_MIGRATE_STATUS=$?
  set -e

  if [ "${DB_MIGRATE_STATUS}" -eq 124 ] || [ "${DB_MIGRATE_STATUS}" -eq 137 ]; then
    echo "::error::aqua-db-migrate exceeded ${DB_MIGRATE_TIMEOUT_SECONDS}s during ${deploy_mode} — aborting before service restart."
    echo "--- aqua-db-migrate logs (last 500 lines) ---"
    docker logs aqua-db-migrate --tail=500 2>&1 | redact_sensitive || true
    echo "--- db-migrate/postgres status ---"
    docker compose -f docker-compose.droplet.yml ps db-migrate postgres 2>&1 || true
    docker compose -f docker-compose.droplet.yml stop db-migrate 2>&1 || true
    record_release_ledger "failed" "db_migrate_timeout"
    exit 1
  elif [ "${DB_MIGRATE_STATUS}" -ne 0 ]; then
    echo "::error::aqua-db-migrate failed during ${deploy_mode} — aborting BEFORE service containers start."
    echo "--- aqua-db-migrate logs (last 500 lines) ---"
    docker logs aqua-db-migrate --tail=500 2>&1 | redact_sensitive || true
    record_release_ledger "failed" "db_migrate"
    exit 1
  fi

  echo "  aqua-db-migrate completed successfully"

  # ORPHAN-HIGH-381: record how many migrations this release actually applied.
  # rollback_deployed_services uses this to refuse image rollback across a
  # forward-migrated schema (old image + new schema = SchemaDriftValidator
  # fatal crash-loop; the exact 2026-07-12 farm outage). Parse the runner's
  # structured completion line; anything unparseable stays "unknown" and the
  # rollback guard fails closed.
  MIGRATIONS_APPLIED_THIS_RELEASE=$(docker logs aqua-db-migrate --tail 200 2>/dev/null \
    | grep -o '"totalAppliedMigrations":[0-9]*' | tail -1 | cut -d: -f2 || true)
  MIGRATIONS_APPLIED_THIS_RELEASE="${MIGRATIONS_APPLIED_THIS_RELEASE:-unknown}"
  export MIGRATIONS_APPLIED_THIS_RELEASE
  echo "  Migrations applied this release: ${MIGRATIONS_APPLIED_THIS_RELEASE}"
  if [[ ! "${MIGRATIONS_APPLIED_THIS_RELEASE}" =~ ^[0-9]+$ ]]; then
    echo "::error::aqua-db-migrate did not emit a canonical applied-migration count; release recovery cannot choose rollback safely." >&2
    return 1
  fi
}

compose_image_target_for_service() {
  [ "$#" -eq 1 ] || return 64
  local requested_service="$1"
  local binding
  local compose_service
  local image_service
  for binding in ${APPLICATION_COMPOSE_IMAGE_MAP}; do
    compose_service=${binding%%:*}
    image_service=${binding#*:}
    if [ "${compose_service}" = "${requested_service}" ]; then
      printf '%s\n' "${image_service}"
      return 0
    fi
  done
  return 1
}

application_compose_services() {
  [ "$#" -eq 0 ] || return 64
  local binding
  for binding in ${APPLICATION_COMPOSE_IMAGE_MAP}; do
    printf '%s\n' "${binding%%:*}"
  done
}

is_application_image_service() {
  [ "$#" -eq 1 ] || return 64
  compose_image_target_for_service "$1" >/dev/null
}

image_ref_for_service() {
  local svc="$1"
  local image_service
  image_service=$(compose_image_target_for_service "${svc}") || return
  echo "${IMAGE_PREFIX}/${image_service}:latest"
}

deploy_tag_ref_for_service() {
  local svc="$1"
  local image_service
  image_service=$(compose_image_target_for_service "${svc}") || return
  echo "${IMAGE_PREFIX}/${image_service}:${DEPLOY_SHA}"
}

digest_ref_for_service() {
  local svc="$1"
  local image_service
  image_service=$(compose_image_target_for_service "${svc}") || return
  if [ -s "${DEPLOY_IMAGE_DIGESTS_FILE}" ]; then
    awk -F '\t' -v svc="${image_service}" '$1 == svc {print $2 "@" $3; exit}' "${DEPLOY_IMAGE_DIGESTS_FILE}" 2>/dev/null || true
  fi
}

deploy_includes_service() {
  local svc="$1"

  case " ${DEPLOY_SERVICES:-} " in
    *" ${svc} "*) return 0 ;;
    *) return 1 ;;
  esac
}

classify_pull_failure() {
  local log_file="$1"
  if grep -qi 'no space left on device' "${log_file}" 2>/dev/null; then
    echo "image_pull_no_space"
  elif grep -Eqi 'manifest unknown|not found|name unknown|unknown tag' "${log_file}" 2>/dev/null; then
    echo "image_pull_manifest_missing"
  elif grep -Eqi 'unauthorized|denied|forbidden|authentication required' "${log_file}" 2>/dev/null; then
    echo "image_pull_unauthorized"
  else
    echo "image_pull_network_timeout"
  fi
}

record_no_state_changed_failure() {
  local phase="$1"
  export ROLLBACK_SKIPPED_REASON="no_state_changed"
  export SCHEMA_MAY_BE_FORWARD="false"
  record_release_ledger "failed" "${phase}" || true
}

pull_deploy_image_required() {
  local svc="$1"
  local attempts="${DEPLOY_PULL_ATTEMPTS:-4}"
  local delay="${DEPLOY_PULL_RETRY_SECONDS:-15}"
  local image="${IMAGE_PREFIX}/${svc}"
  local immutable_ref
  local compose_ref="${image}:latest"
  local deploy_tag_ref="${image}:${DEPLOY_SHA}"
  local attempt
  local pull_log
  local phase="image_pull_network_timeout"
  local immutable_image_id
  local deploy_tag_image_id
  local compose_ref_image_id

  if [ -z "${DEPLOY_SHA:-}" ]; then
    echo "::error::DEPLOY_SHA is required for immutable deploy image pulls."
    return 1
  fi

  immutable_ref="$(digest_ref_for_service "${svc}")"
  if [ -z "${immutable_ref}" ]; then
    echo "::error::Validated digest manifest has no immutable image for ${svc}."
    record_no_state_changed_failure "image_digest_manifest_missing"
    return 1
  fi
  pull_log="$(mktemp)"

  for attempt in $(seq 1 "${attempts}"); do
    echo "  Pulling ${svc} (${immutable_ref}) [attempt ${attempt}/${attempts}]..."
    if docker pull "${immutable_ref}" >"${pull_log}" 2>&1; then
      redact_sensitive < "${pull_log}"
      if ! docker tag "${immutable_ref}" "${deploy_tag_ref}"; then
        echo "::error::Failed to pin compose deploy tag ${deploy_tag_ref} to ${immutable_ref}."
        record_no_state_changed_failure "image_deploy_tag_pin"
        rm -f "${pull_log}"
        return 1
      fi
      if ! docker tag "${immutable_ref}" "${compose_ref}"; then
        echo "::error::Failed to pin compatibility tag ${compose_ref} to ${immutable_ref}."
        record_no_state_changed_failure "image_compatibility_tag_pin"
        rm -f "${pull_log}"
        return 1
      fi
      if ! immutable_image_id=$(docker image inspect --format='{{.Id}}' "${immutable_ref}") || \
         ! deploy_tag_image_id=$(docker image inspect --format='{{.Id}}' "${deploy_tag_ref}") || \
         ! compose_ref_image_id=$(docker image inspect --format='{{.Id}}' "${compose_ref}"); then
        echo "::error::Cannot re-resolve local image identities after pinning ${svc}."
        record_no_state_changed_failure "image_tag_identity"
        rm -f "${pull_log}"
        return 1
      fi
      if [[ ! "${immutable_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
         [ "${deploy_tag_image_id}" != "${immutable_image_id}" ] || \
         [ "${compose_ref_image_id}" != "${immutable_image_id}" ]; then
        echo "::error::Local deploy tags do not resolve to the pulled immutable image for ${svc}."
        record_no_state_changed_failure "image_tag_identity"
        rm -f "${pull_log}"
        return 1
      fi
      echo "  ${svc}: pinned ${deploy_tag_ref} and ${compose_ref} to ${immutable_ref}"
      rm -f "${pull_log}"
      return 0
    fi
    redact_sensitive < "${pull_log}"
    phase="$(classify_pull_failure "${pull_log}")"

    if [ "${attempt}" -lt "${attempts}" ]; then
      echo "  WARN: ${svc} pull failed; retrying in ${delay}s..."
      sleep "${delay}"
    fi
  done

  echo "::error::Required image pull failed for ${svc} (${immutable_ref}) after ${attempts} attempt(s)."
  echo "  Aborting BEFORE service restart so the deploy cannot keep running stale images."
  record_no_state_changed_failure "${phase}"
  rm -f "${pull_log}"
  return 1
}

capture_rollback_manifest() (
  set -euo pipefail
  echo "=== Capturing current application image digests for rollback ==="

  if [ -e "${ROLLBACK_STATE_DIR}" ] || [ -L "${ROLLBACK_STATE_DIR}" ]; then
    echo "::error::Rollback state unit already exists: ${ROLLBACK_STATE_DIR}"
    return 1
  fi

  local rollback_stage_dir
  local rollback_stage_manifest
  local rollback_stage_checksum
  rollback_stage_dir=$(mktemp -d "${DEPLOY_STATE_DIR}/.rollback-state.XXXXXX")
  rollback_stage_manifest="${rollback_stage_dir}/rollback-images.tsv"
  rollback_stage_checksum="${rollback_stage_dir}/rollback-images.sha256"
  chmod 0700 "${rollback_stage_dir}"
  : > "${rollback_stage_manifest}"
  chmod 0600 "${rollback_stage_manifest}"

  cleanup_rollback_stage() {
    if [ -n "${rollback_stage_dir:-}" ]; then
      rm -rf -- "${rollback_stage_dir}"
    fi
  }
  trap cleanup_rollback_stage EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local svc
  local container_id
  local image_id
  local health
  local running
  local restarts
  local container_output
  local details
  local project
  local service_label
  local extra
  local -a container_ids=()
  while IFS= read -r svc; do
    [ "$svc" = "db-migrate" ] && continue
    if ! container_output=$(rollback_compose ps --all --quiet "$svc" 2>/dev/null); then
      echo "::error::Cannot resolve rollback container inventory for ${svc}." >&2
      return 1
    fi
    container_ids=()
    if [ -n "${container_output}" ]; then
      while IFS= read -r container_id; do
        [ -n "${container_id}" ] || continue
        container_ids+=("${container_id}")
      done <<< "${container_output}"
    fi
    if [ "${#container_ids[@]}" -eq 0 ]; then
      printf '%s\tABSENT\n' "$svc" >> "${rollback_stage_manifest}"
      continue
    fi
    if [ "${#container_ids[@]}" -ne 1 ]; then
      echo "::error::${svc} has a non-canonical rollback container set." >&2
      return 1
    fi
    container_id=${container_ids[0]}
    [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] || {
      echo "::error::${svc} rollback container identity is not canonical." >&2
      return 1
    }
    # ORPHAN-HIGH-381: a rollback point must be a PROVEN-GOOD image. Capturing a
    # crash-looping container (2026-07-12: farm-service fatal at bootstrap) poisons
    # the manifest, and every later rollback restores the broken image under the
    # new release tag — a self-sustaining outage. A present but unhealthy
    # service is not equivalent to ABSENT, so fail before the journal or any live
    # mutation instead of manufacturing an incomplete rollback point.
    if ! details=$(docker inspect --type container --format \
      '{{.Image}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "${container_id}"); then
      echo "::error::Cannot inspect rollback container for ${svc}." >&2
      return 1
    fi
    IFS='|' read -r image_id running health restarts project service_label extra <<< "${details}"
    if [ -n "${extra}" ] || [ "${project}" != "${COMPOSE_PROJECT_NAME}" ] || \
      [ "${service_label}" != "${svc}" ]; then
      echo "::error::${svc} rollback container authority is invalid." >&2
      return 1
    fi
    if [ "${running}" != "true" ] || { [ "${health}" != "healthy" ] && [ "${health}" != "none" ]; }; then
      echo "::error::${svc} is not a valid rollback point (running=${running} health=${health} restarts=${restarts})." >&2
      return 1
    fi
    [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
      echo "::error::${svc} rollback image identity is not canonical." >&2
      return 1
    }
    printf '%s\t%s\n' "$svc" "$image_id" >> "${rollback_stage_manifest}"
  done < <(application_compose_services)

  local captured
  captured=$(wc -l < "${rollback_stage_manifest}")
  sha256sum "${rollback_stage_manifest}" | awk '{print $1}' > "${rollback_stage_checksum}"
  chmod 0600 "${rollback_stage_checksum}"

  # The manifest and its checksum are one authoritative unit. Durably stage
  # both files and atomically publish their containing directory so a crash can
  # expose either the complete pair or no rollback state, never a half-pair.
  /usr/bin/python3 - "${rollback_stage_manifest}" "${rollback_stage_checksum}" "${rollback_stage_dir}" <<'ROLLBACK_STATE_FSYNC_PY'
import os
import sys

for path in sys.argv[1:3]:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

descriptor = os.open(sys.argv[3], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
ROLLBACK_STATE_FSYNC_PY
  mv -T -- "${rollback_stage_dir}" "${ROLLBACK_STATE_DIR}"
  rollback_stage_dir=""
  /usr/bin/python3 - "${DEPLOY_STATE_DIR}" <<'ROLLBACK_STATE_PARENT_FSYNC_PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
ROLLBACK_STATE_PARENT_FSYNC_PY

  echo "  Captured ${captured} service image(s) in ${ROLLBACK_MANIFEST}"
  echo "  Rollback manifest sha256: $(cat "${ROLLBACK_CHECKSUM}")"

)

assert_rollback_state() {
  [ "$#" -eq 0 ] || return 64
  /usr/bin/python3 - \
    "${ROLLBACK_STATE_DIR}" "${ROLLBACK_MANIFEST}" "${ROLLBACK_CHECKSUM}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${APPLICATION_COMPOSE_IMAGE_MAP}" <<'ROLLBACK_STATE_VERIFY_PY'
import hashlib
import os
import pathlib
import re
import stat
import sys

state = pathlib.Path(sys.argv[1])
manifest = pathlib.Path(sys.argv[2])
checksum = pathlib.Path(sys.argv[3])
expected_uid = int(sys.argv[4])
binding_tokens = sys.argv[5].split()
service_pattern = re.compile(r"^[a-z0-9][a-z0-9-]*$")
image_pattern = re.compile(r"^sha256:[0-9a-f]{64}$")
hash_pattern = re.compile(r"^[0-9a-f]{64}\n$")


def require(path: pathlib.Path, directory: bool, mode: int, maximum: int = 0) -> os.stat_result:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or directory != stat.S_ISDIR(info.st_mode):
        raise SystemExit(f"rollback state type is unsafe: {path}")
    if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise SystemExit(f"rollback state file identity is unsafe: {path}")
    if info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != mode:
        raise SystemExit(f"rollback state ownership/mode is unsafe: {path}")
    if maximum and info.st_size > maximum:
        raise SystemExit(f"rollback state file is unbounded: {path}")
    return info


require(state, True, 0o700)
require(manifest, False, 0o600, 65536)
require(checksum, False, 0o600, 65)
manifest_bytes = manifest.read_bytes()
checksum_text = checksum.read_text(encoding="ascii")
if hash_pattern.fullmatch(checksum_text) is None:
    raise SystemExit("rollback checksum representation is invalid")
if hashlib.sha256(manifest_bytes).hexdigest() != checksum_text.rstrip("\n"):
    raise SystemExit("rollback manifest checksum mismatch")
try:
    text = manifest_bytes.decode("ascii")
except UnicodeDecodeError as error:
    raise SystemExit("rollback manifest is not ASCII") from error
if text and not text.endswith("\n"):
    raise SystemExit("rollback manifest is unterminated")
rows: list[tuple[str, str]] = []
for line in text.splitlines():
    fields = line.split("\t")
    if len(fields) != 2:
        raise SystemExit("rollback manifest row schema is invalid")
    service, image = fields
    if service_pattern.fullmatch(service) is None or (image != "ABSENT" and image_pattern.fullmatch(image) is None):
        raise SystemExit("rollback manifest row identity is invalid")
    rows.append((service, image))
catalog: list[str] = []
seen_catalog: set[str] = set()
for token in binding_tokens:
    fields = token.split(":")
    if len(fields) != 2:
        raise SystemExit("rollback compose-image binding schema is invalid")
    compose_service, image_service = fields
    if (
        service_pattern.fullmatch(compose_service) is None
        or service_pattern.fullmatch(image_service) is None
        or compose_service in seen_catalog
    ):
        raise SystemExit("rollback compose-image binding identity is invalid")
    seen_catalog.add(compose_service)
    if compose_service != "db-migrate":
        catalog.append(compose_service)
if not catalog:
    raise SystemExit("rollback service catalog is invalid")
if [service for service, _image in rows] != catalog:
    raise SystemExit("rollback manifest does not exactly cover the application catalog")
ROLLBACK_STATE_VERIFY_PY
}

rollback_deployed_services() {
  local reason="${1:-deploy failure}"

  echo "=== Rolling back application images (${reason}) ==="

  # ORPHAN-HIGH-381: image rollback is only safe when the database did NOT move
  # forward in this release. Migrations are forward-only (blue-green discipline);
  # restoring a pre-release image against a schema that just dropped or reshaped
  # its tables boots straight into a SchemaDriftValidator fatal and the service
  # crash-loops until a human intervenes (2026-07-12 farm_documents outage).
  # Fail closed on "unknown": every rollback caller runs after db-migrate, so an
  # unparseable count means the boundary cannot be proven uncrossed.
  if [ "${MIGRATIONS_APPLIED_THIS_RELEASE:-unknown}" = "unknown" ]; then
    echo "::error::Rollback refused: applied-migration count for this release is unknown, so image rollback cannot be proven safe. Fix forward (repair the failing gate and redeploy)."
    export ROLLBACK_SKIPPED_REASON="migration_boundary_unknown"
    return 1
  fi
  if [ "${MIGRATIONS_APPLIED_THIS_RELEASE}" -gt 0 ] 2>/dev/null; then
    echo "::error::Rollback refused: this release applied ${MIGRATIONS_APPLIED_THIS_RELEASE} database migration(s). Restoring pre-release images against a forward-migrated schema is the crash-loop class that took farm-service down on 2026-07-12 (ORPHAN-HIGH-381). Fix forward (repair the failing gate and redeploy this or a newer release)."
    export ROLLBACK_SKIPPED_REASON="migration_boundary_crossed"
    return 1
  fi

  assert_rollback_state || return

  local scope_services=()
  local svc
  while IFS= read -r svc; do
    [ -n "$svc" ] || continue
    scope_services+=("$svc")
  done < <(rollback_scope_services)

  if [ "${#scope_services[@]}" -eq 0 ]; then
    echo "  No long-running service images were changed; rollback has no restart scope."
    return 0
  fi

  local image_id
  local resolved_image_id
  local container_output
  local container_id
  local details
  local inspected_id
  local project
  local service_label
  local extra
  local restored=0
  local removed=0
  local -a restore_services=()
  local -a absent_services=()
  local -a infrastructure_services=()
  for svc in "${scope_services[@]}"; do
    image_id="$(awk -F "$(printf '\t')" -v svc="${svc}" '$1 == svc {print $2; exit}' "${ROLLBACK_MANIFEST}")"
    if [ -z "${image_id}" ]; then
      echo "::error::Rollback manifest has no prior image for required service ${svc}."
      return 1
    fi
    if [ "${image_id}" = ABSENT ]; then
      absent_services+=("${svc}")
      continue
    fi
    resolved_image_id=$(docker image inspect --format='{{.Id}}' "${image_id}") || return
    [ "${resolved_image_id}" = "${image_id}" ] || {
      echo "::error::Rollback image identity changed for ${svc}." >&2
      return 1
    }
    echo "  ${svc}: restoring $(image_ref_for_service "$svc") -> ${image_id}"
    docker tag "${image_id}" "$(image_ref_for_service "$svc")"
    docker tag "${image_id}" "$(deploy_tag_ref_for_service "$svc")"
    restore_services+=("${svc}")
    restored=$((restored + 1))
  done

  if [ "${FULL_DEPLOY:-false}" = true ]; then
    while IFS= read -r svc; do
      [ -n "${svc}" ] || continue
      is_application_image_service "${svc}" && continue
      infrastructure_services+=("${svc}")
    done < <(rollback_compose config --services)
    [ "${#infrastructure_services[@]}" -gt 0 ] || {
      echo "::error::Full rollback has no canonical infrastructure service inventory." >&2
      return 1
    }
    rollback_compose up -d --no-deps --no-build "${infrastructure_services[@]}" || return
  fi
  if [ "${#restore_services[@]}" -gt 0 ]; then
    rollback_compose up -d --no-deps --no-build --force-recreate "${restore_services[@]}"
  fi

  for svc in "${absent_services[@]}"; do
    if ! container_output=$(rollback_compose ps --all --quiet "${svc}"); then
      echo "::error::Cannot resolve candidate container for previously absent service ${svc}." >&2
      return 1
    fi
    if [ -z "${container_output}" ]; then
      continue
    fi
    if [ "$(printf '%s\n' "${container_output}" | sed '/^$/d' | wc -l)" -ne 1 ]; then
      echo "::error::Previously absent service ${svc} has a non-canonical container set." >&2
      return 1
    fi
    container_id=$(printf '%s\n' "${container_output}" | sed '/^$/d')
    [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] || {
      echo "::error::Previously absent service ${svc} has an invalid container identity." >&2
      return 1
    }
    details=$(docker inspect --type container --format \
      '{{.Id}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "${container_id}") || return
    IFS='|' read -r inspected_id project service_label extra <<< "${details}"
    if [ -n "${extra}" ] || [ "${inspected_id}" != "${container_id}" ] || \
      [ "${project}" != "${COMPOSE_PROJECT_NAME}" ] || [ "${service_label}" != "${svc}" ]; then
      echo "::error::Previously absent service ${svc} container authority is invalid." >&2
      return 1
    fi
    docker rm -f "${container_id}" || return
    removed=$((removed + 1))
  done
  echo "  Rollback restored ${restored} image(s) and removed ${removed} previously absent service container(s)."
}

restartable_deploy_services() {
  local compose_service
  local image_service
  while IFS= read -r compose_service; do
    [ "${compose_service}" = "db-migrate" ] && continue
    image_service=$(compose_image_target_for_service "${compose_service}") || return
    if deploy_includes_service "${image_service}"; then
      echo "${compose_service}"
    fi
  done < <(application_compose_services)
}

rollback_scope_services() {
  if [ "${FULL_DEPLOY:-false}" = true ]; then
    application_compose_services | sed '/^db-migrate$/d'
  else
    restartable_deploy_services
  fi
}

migration_manifest_hash() {
  python3 - "${DEPLOY_BUNDLE_MANIFEST}" <<'PY'
import json
import pathlib
import re
import sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
value = manifest.get("migration_manifest_hash")
if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
    raise SystemExit("bundle manifest has no canonical migration_manifest_hash")
print(value)
PY
}

# BEGIN release-container-attestation
capture_release_container_attestation() {
  local json="{"
  local sep=""
  local svc
  local container_output
  local container_id
  local details
  local image_id
  local running
  local state
  local exit_code
  local compose_project
  local compose_service
  local extra
  local db_migrate_image=''
  local saw_db_migrate=0
  local manifest_service
  local manifest_repository
  local manifest_digest
  local expected_image_id
  local image_service
  local expected_rows=0
  local -a container_ids=()
  local -A seen_services=()
  local -A expected_deploy_image_ids=()
  local -A matched_expected_image_targets=()

  aqua_control_plane_lock_assert || return
  assert_deploy_compose_override || return
  while IFS=$'\t' read -r manifest_service manifest_repository manifest_digest extra || \
    [ -n "${manifest_service:-}${manifest_repository:-}${manifest_digest:-}${extra:-}" ]; do
    if [ -n "${extra:-}" ] || \
      [[ ! "${manifest_service:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
      [[ ! "${manifest_repository:-}" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || \
      [[ ! "${manifest_digest:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
      [ "${manifest_repository}" != "${IMAGE_PREFIX}/${manifest_service}" ] || \
      [[ -n "${expected_deploy_image_ids[${manifest_service:-}]+present}" ]]; then
      echo "::error::Deploy digest manifest is invalid during release attestation." >&2
      return 1
    fi
    if ! expected_image_id=$(docker image inspect --format='{{.Id}}' \
      "${manifest_repository}@${manifest_digest}") || \
      [[ ! "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "::error::Cannot resolve immutable image identity for ${manifest_service}." >&2
      return 1
    fi
    expected_deploy_image_ids["${manifest_service}"]=${expected_image_id}
    expected_rows=$((expected_rows + 1))
  done < "${DEPLOY_IMAGE_DIGESTS_FILE}"
  [ "${expected_rows}" -gt 0 ] && \
    [[ -n "${expected_deploy_image_ids[db-migrate]+present}" ]] || {
    echo "::error::Release attestation requires a nonempty digest manifest including db-migrate." >&2
    return 1
  }

  while IFS= read -r svc; do
    [[ "${svc}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || {
      echo "::error::Release catalog contains an invalid compose service: ${svc}" >&2
      return 1
    }
    [ -z "${seen_services[${svc}]:-}" ] || {
      echo "::error::Release catalog contains duplicate compose service: ${svc}" >&2
      return 1
    }
    seen_services[${svc}]=1

    if ! container_output=$(docker compose -f docker-compose.droplet.yml \
      ps --all --quiet "${svc}"); then
      echo "::error::Cannot resolve the canonical compose container for ${svc}." >&2
      return 1
    fi
    container_ids=()
    if [ -n "${container_output}" ]; then
      while IFS= read -r container_id; do
        [ -n "${container_id}" ] || {
          echo "::error::Compose returned an empty container identity for ${svc}." >&2
          return 1
        }
        container_ids+=("${container_id}")
      done <<< "${container_output}"
    fi
    [ "${#container_ids[@]}" -eq 1 ] || {
      echo "::error::Expected exactly one compose container for ${svc}; found ${#container_ids[@]}." >&2
      return 1
    }
    container_id=${container_ids[0]}
    [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] || {
      echo "::error::Compose container ID for ${svc} is not exact 64-hex." >&2
      return 1
    }
    if ! details=$(docker inspect --format \
      '{{.Image}}|{{.State.Running}}|{{.State.Status}}|{{.State.ExitCode}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "${container_id}"); then
      echo "::error::Cannot inspect the exact compose container for ${svc}." >&2
      return 1
    fi
    IFS='|' read -r image_id running state exit_code compose_project compose_service extra \
      <<< "${details}"
    [ -z "${extra}" ] && \
      [ "${compose_project}" = "${COMPOSE_PROJECT_NAME:-aqua-saas}" ] && \
      [ "${compose_service}" = "${svc}" ] || {
      echo "::error::Container identity labels do not match canonical compose service ${svc}." >&2
      return 1
    }
    [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
      echo "::error::Container image identity for ${svc} is not canonical." >&2
      return 1
    }
    image_service=$(compose_image_target_for_service "${svc}") || {
      echo "::error::Release catalog has no image target for compose service ${svc}." >&2
      return 1
    }
    if [[ -n "${expected_deploy_image_ids[${image_service}]+present}" ]]; then
      [ "${image_id}" = "${expected_deploy_image_ids[${image_service}]}" ] || {
        echo "::error::Live container image does not match the immutable manifest for ${svc}." >&2
        return 1
      }
      matched_expected_image_targets["${image_service}"]=1
    fi

    if [ "${svc}" = db-migrate ]; then
      [ "${running}" = false ] && [ "${state}" = exited ] && [ "${exit_code}" = 0 ] || {
        echo "::error::db-migrate must have exactly one completed exit-0 compose container." >&2
        return 1
      }
      db_migrate_image=${image_id}
      saw_db_migrate=$((saw_db_migrate + 1))
    else
      [ "${running}" = true ] && [ "${state}" = running ] || {
        echo "::error::Release service ${svc} is not running in its canonical compose container." >&2
        return 1
      }
      json="${json}${sep}\"${svc}\":\"${image_id}\""
      sep=","
    fi
  done < <(application_compose_services)

  [ "${saw_db_migrate}" -eq 1 ] && [ -n "${db_migrate_image}" ] || {
    echo "::error::Release catalog must contain exactly one terminal db-migrate service." >&2
    return 1
  }
  for manifest_service in "${!expected_deploy_image_ids[@]}"; do
    [[ -n "${matched_expected_image_targets[${manifest_service}]+present}" ]] || {
      echo "::error::Release attestation did not match immutable image target ${manifest_service}." >&2
      return 1
    }
  done
  json="${json}}"
  RELEASE_CONTAINER_IMAGE_DIGESTS=${json}
  RELEASE_DB_MIGRATE_IMAGE=${db_migrate_image}
}
# END release-container-attestation

deploy_metadata_json() {
  local capacity="{}"
  local image_manifest_hash=""

  if [ -s "${DEPLOY_STATE_DIR}/capacity-snapshot.json" ]; then
    capacity="$(cat "${DEPLOY_STATE_DIR}/capacity-snapshot.json")"
  fi
  if [ -s "${DEPLOY_IMAGE_DIGESTS_FILE}" ]; then
    image_manifest_hash="$(sha256sum "${DEPLOY_IMAGE_DIGESTS_FILE}" | awk '{print $1}')"
  fi

  printf '{"capacity":%s,"imageDigestManifestSha256":"%s","deployMode":"%s","fullDeploy":%s}' \
    "${capacity}" \
    "${image_manifest_hash}" \
    "${DEPLOY_MODE:-unknown}" \
    "$([ "${FULL_DEPLOY:-false}" = "true" ] && echo true || echo false)"
}

rollback_manifest_sha256() {
  if [ -f "${ROLLBACK_MANIFEST}" ] && [ ! -L "${ROLLBACK_MANIFEST}" ]; then
    sha256sum "${ROLLBACK_MANIFEST}" | awk '{print $1}'
  else
    echo ""
  fi
}

schema_may_be_forward_for() {
  local status="$1"
  local phase="$2"
  if [ "${SCHEMA_MAY_BE_FORWARD:-false}" = "true" ]; then
    echo "true"
    return 0
  fi
  case "${phase}" in
    critical_health|required_health|readiness|boot_signal|release_sql)
      echo "true"
      ;;
    *)
      case "${status}" in
        rollback_attempted|rollback_verified|rollback_failed|rolled_back)
          echo "true"
          ;;
        *)
          echo "false"
          ;;
      esac
      ;;
  esac
}

record_release_ledger() {
  local status="$1"
  local failure_phase="${2:-}"
  local ledger_write_required="${3:-false}"
  local db_name="${POSTGRES_DB:-aquaculture}"
  local operator="${GHCR_ACTOR:-${GITHUB_ACTOR:-unknown}}"
  local image_digests
  local db_migrate_image
  local manifest_hash
  local deploy_metadata
  local rollback_hash
  local schema_may_be_forward
  local rollback_skipped_reason="${ROLLBACK_SKIPPED_REASON:-}"

  if ! docker ps --format '{{.Names}}' | grep -qx 'aqua-postgres'; then
    echo "::warning::Cannot record release ledger status=${status}: aqua-postgres is not running."
    if [ "${ledger_write_required}" = "true" ]; then
      echo "::error::This release-ledger transition is mandatory; aborting."
      return 1
    fi
    case "${status}" in
      db_complete|apps_restarting|promoted|rollback_attempted|rollback_verified|rollback_failed|rolled_back)
        return 1
        ;;
      *)
        return 0
        ;;
    esac
  fi

  image_digests='{}'
  db_migrate_image=''
  if [ "${status}" = promoted ]; then
    capture_release_container_attestation || return
    image_digests=${RELEASE_CONTAINER_IMAGE_DIGESTS}
    db_migrate_image=${RELEASE_DB_MIGRATE_IMAGE}
  fi
  manifest_hash="$(migration_manifest_hash || true)"
  deploy_metadata="$(deploy_metadata_json || echo '{}')"
  rollback_hash="$(rollback_manifest_sha256 || true)"
  schema_may_be_forward="$(schema_may_be_forward_for "${status}" "${failure_phase}")"

  set +e
  docker exec -i aqua-postgres psql \
    -U "${POSTGRES_USER:-aquaculture}" \
    -d "${db_name}" \
    -v ON_ERROR_STOP=1 \
    -v release_id="${DEPLOY_RELEASE_ID:-${DEPLOY_SHA:-unknown}}" \
    -v git_sha="${DEPLOY_SHA:-unknown}" \
    -v db_migrate_image="${db_migrate_image}" \
    -v migration_manifest_hash="${manifest_hash}" \
    -v image_digests="${image_digests}" \
    -v deploy_metadata="${deploy_metadata}" \
    -v rollback_manifest_sha256="${rollback_hash}" \
    -v schema_may_be_forward="${schema_may_be_forward}" \
    -v rollback_skipped_reason="${rollback_skipped_reason}" \
    -v status="${status}" \
    -v failure_phase="${failure_phase}" \
    -v operator="${operator}" <<'SQL'
INSERT INTO platform.release_ledger (
  release_id,
  git_sha,
  db_migrate_image,
  migration_manifest_hash,
  expected_heads,
  applied_heads,
  tenant_schema_set,
  tenant_fanout,
  image_digests,
  deploy_metadata,
  rollback_manifest_sha256,
  schema_may_be_forward,
  rollback_skipped_reason,
  status,
  failure_phase,
  rollback_attempted,
  rollback_verified,
  rollback_failed,
  operator,
  completed_at
) VALUES (
  :'release_id',
  :'git_sha',
  NULLIF(:'db_migrate_image', ''),
  NULLIF(:'migration_manifest_hash', ''),
  '{}'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb,
  COALESCE(NULLIF(:'image_digests', '')::jsonb, '{}'::jsonb),
  COALESCE(NULLIF(:'deploy_metadata', '')::jsonb, '{}'::jsonb),
  NULLIF(:'rollback_manifest_sha256', ''),
  :'schema_may_be_forward'::boolean,
  NULLIF(:'rollback_skipped_reason', ''),
  :'status',
  NULLIF(:'failure_phase', ''),
  :'status' IN ('rollback_attempted', 'rollback_verified', 'rollback_failed', 'rolled_back'),
  :'status' IN ('rollback_verified', 'rolled_back'),
  :'status' = 'rollback_failed',
  NULLIF(:'operator', ''),
  CASE WHEN :'status' IN ('promoted', 'failed', 'rollback_verified', 'rollback_failed', 'rolled_back') THEN NOW() ELSE NULL END
)
ON CONFLICT (release_id) DO UPDATE SET
  git_sha = EXCLUDED.git_sha,
  db_migrate_image = COALESCE(EXCLUDED.db_migrate_image, platform.release_ledger.db_migrate_image),
  migration_manifest_hash = COALESCE(EXCLUDED.migration_manifest_hash, platform.release_ledger.migration_manifest_hash),
  expected_heads = CASE
    WHEN EXCLUDED.expected_heads = '{}'::jsonb THEN platform.release_ledger.expected_heads
    ELSE EXCLUDED.expected_heads
  END,
  applied_heads = CASE
    WHEN EXCLUDED.applied_heads = '{}'::jsonb THEN platform.release_ledger.applied_heads
    ELSE EXCLUDED.applied_heads
  END,
  tenant_schema_set = CASE
    WHEN EXCLUDED.tenant_schema_set = '[]'::jsonb THEN platform.release_ledger.tenant_schema_set
    ELSE EXCLUDED.tenant_schema_set
  END,
  tenant_fanout = CASE
    WHEN EXCLUDED.tenant_fanout = '{}'::jsonb THEN platform.release_ledger.tenant_fanout
    ELSE EXCLUDED.tenant_fanout
  END,
  image_digests = CASE
    WHEN EXCLUDED.image_digests = '{}'::jsonb THEN platform.release_ledger.image_digests
    ELSE EXCLUDED.image_digests
  END,
  deploy_metadata = EXCLUDED.deploy_metadata,
  rollback_manifest_sha256 = COALESCE(EXCLUDED.rollback_manifest_sha256, platform.release_ledger.rollback_manifest_sha256),
  schema_may_be_forward = platform.release_ledger.schema_may_be_forward OR EXCLUDED.schema_may_be_forward,
  rollback_skipped_reason = COALESCE(EXCLUDED.rollback_skipped_reason, platform.release_ledger.rollback_skipped_reason),
  status = EXCLUDED.status,
  failure_phase = EXCLUDED.failure_phase,
  rollback_attempted = platform.release_ledger.rollback_attempted OR EXCLUDED.rollback_attempted,
  rollback_verified = platform.release_ledger.rollback_verified OR EXCLUDED.rollback_verified,
  rollback_failed = platform.release_ledger.rollback_failed OR EXCLUDED.rollback_failed,
  operator = EXCLUDED.operator,
  completed_at = EXCLUDED.completed_at,
  updated_at = NOW();
SQL
  local rc=$?
  set -e

  if [ "${rc}" -ne 0 ]; then
    echo "::warning::Failed to record platform.release_ledger status=${status}."
    if [ "${ledger_write_required}" = "true" ]; then
      echo "::error::This release-ledger transition is mandatory; aborting."
      return 1
    fi
    case "${status}" in
      db_complete|apps_restarting|promoted|rollback_attempted|rollback_verified|rollback_failed|rolled_back)
        echo "::error::Release ledger write is mandatory after platform bootstrap; aborting."
        return 1
        ;;
      *)
        echo "::warning::Continuing because this is a pre-bootstrap/failure audit write."
        return 0
        ;;
    esac
  else
    echo "  Release ledger recorded: ${DEPLOY_RELEASE_ID:-${DEPLOY_SHA:-unknown}} status=${status}${failure_phase:+ phase=${failure_phase}}"
  fi
}

verify_rollback_images() {
  assert_rollback_state || return

  local svc
  local expected_image
  local container_output
  local container_id
  local actual_image
  local mismatches=0

  while IFS="$(printf '\t')" read -r svc expected_image; do
    [ -n "${svc}" ] || continue
    container_output=$(rollback_compose ps --all --quiet "$svc" 2>/dev/null || true)
    if [ "${expected_image}" = ABSENT ]; then
      if [ -n "${container_output}" ]; then
        echo "::error::Rollback verification: ${svc} was previously absent but still has a container."
        mismatches=$((mismatches + 1))
      fi
      continue
    fi
    if [ "$(printf '%s\n' "${container_output}" | sed '/^$/d' | wc -l)" -ne 1 ]; then
      echo "::error::Rollback verification: ${svc} does not have exactly one canonical container."
      mismatches=$((mismatches + 1))
      continue
    fi
    container_id=$(printf '%s\n' "${container_output}" | sed '/^$/d')
    if [ -z "${container_id}" ]; then
      echo "::error::Rollback verification: ${svc} container not found."
      mismatches=$((mismatches + 1))
      continue
    fi
    actual_image=$(docker inspect --format='{{.Image}}' "${container_id}" 2>/dev/null || true)
    if [ "${actual_image}" != "${expected_image}" ]; then
      echo "::error::Rollback verification: ${svc} image mismatch expected=${expected_image} actual=${actual_image}"
      mismatches=$((mismatches + 1))
    fi
  done < "${ROLLBACK_MANIFEST}"

  [ "${mismatches}" -eq 0 ]
}

rollback_and_record() {
  local reason="$1"
  local rollback_phase="${DEPLOY_TRANSACTION_PHASE:-}"

  mark_forward_required() {
    local refusal_reason=$1
    [ "${DEPLOY_TRANSACTION_ACTIVE:-false}" = true ] || return 0
    case "${DEPLOY_TRANSACTION_PHASE:-}" in
      FORWARD_REQUIRED) return 0 ;;
      MUTATION_STARTED|DB_COMPLETE|LIVE_CANDIDATE|LIVE_VERIFIED|FINALIZING|LEDGER_PROMOTED)
        release_transaction_transition \
          "${DEPLOY_TRANSACTION_PHASE}" FORWARD_REQUIRED preserve "${refusal_reason}"
        ;;
      *) return 0 ;;
    esac
  }

  if [ "${AQUA_DEPLOY_ROLLBACK_POLICY:-ALLOW_ZERO_MIGRATION}" = FORWARD_ONLY ]; then
    export ROLLBACK_SKIPPED_REASON="forward_only_supersession"
    echo "::error::Journaled rollback refused: this successor is structurally forward-only." >&2
    mark_forward_required "forward_only_supersession" || return
    return 1
  fi

  # Do not consume the commit-forward recovery path by entering
  # ROLLBACK_STARTED when the schema boundary is unknown or crossed.
  if [ "${MIGRATIONS_APPLIED_THIS_RELEASE:-unknown}" = unknown ]; then
    export ROLLBACK_SKIPPED_REASON="migration_boundary_unknown"
    echo "::error::Journaled rollback refused before phase transition: migration count is unknown." >&2
    mark_forward_required "migration_boundary_unknown" || return
    return 1
  fi
  if [ "${MIGRATIONS_APPLIED_THIS_RELEASE}" -gt 0 ] 2>/dev/null; then
    export ROLLBACK_SKIPPED_REASON="migration_boundary_crossed"
    echo "::error::Journaled rollback refused before phase transition: ${MIGRATIONS_APPLIED_THIS_RELEASE} migration(s) crossed the boundary." >&2
    mark_forward_required "migration_boundary_crossed" || return
    return 1
  fi

  if [ "${DEPLOY_TRANSACTION_ACTIVE:-false}" = true ] && \
    [ "${rollback_phase}" != ROLLBACK_STARTED ]; then
    case "${rollback_phase}" in
      MUTATION_STARTED|DB_COMPLETE|LIVE_CANDIDATE|LIVE_VERIFIED|FINALIZING|LEDGER_PROMOTED) ;;
      *)
        echo "::error::Release transaction cannot enter rollback from phase ${rollback_phase:-missing}." >&2
        return 1
        ;;
    esac
    release_transaction_transition "${rollback_phase}" ROLLBACK_STARTED preserve "${reason}" || return
  fi

  # A failed attempt audit must not prevent restoring service availability, but
  # the terminal rolled_back audit below is mandatory before the journal may
  # become ROLLED_BACK.
  record_release_ledger "rollback_attempted" "${reason}" || \
    echo "::warning::Rollback attempt audit failed; continuing physical recovery." >&2
  if ! rollback_deployed_services "${reason}"; then
    record_release_ledger "rollback_failed" "${reason}" || \
      echo "::warning::Rollback failure audit could not be persisted." >&2
    return 1
  fi

  sleep "${ROLLBACK_HEALTH_SETTLE_SECONDS:-30}"
  if verify_rollback_images && \
     COMPOSE_FILE=docker-compose.droplet.yml \
     MANIFEST=infrastructure/deploy/service-criticality.yaml \
     POLL_INTERVAL=10 \
     "${AQUA_PRODUCTION_NODE_BIN:?production host Node authority missing}" \
       "${DEPLOY_SOURCE_DIR}/runtime/check-service-health.mjs" && \
     deploy_transaction_marker_matches_prior; then
    record_release_ledger "rolled_back" "${reason}" "true" || return
    if [ "${DEPLOY_TRANSACTION_ACTIVE:-false}" = true ]; then
      release_transaction_transition ROLLBACK_STARTED ROLLED_BACK preserve "${reason}" || return
      DEPLOY_TRANSACTION_MUTATED=false
    fi
    return 0
  fi

  record_release_ledger "rollback_failed" "${reason}" || \
    echo "::warning::Rollback verification failure audit could not be persisted." >&2
  return 1
}

check_ready_endpoint() {
  local svc="$1"
  local port="$2"
  local container_id

  container_id=$(docker compose -f docker-compose.droplet.yml ps -q "$svc" 2>/dev/null || true)
  if [ -z "${container_id}" ]; then
    echo "::error::Readiness sweep: ${svc} container not found."
    return 1
  fi

  docker exec "${container_id}" curl -sf "http://localhost:${port}/health/ready" >/dev/null
}

run_readiness_sweep() {
  echo "=== /health/ready sweep for critical services ==="
  local failures=0

  for spec in \
    "gateway-api:3000" \
    "auth-service:3000" \
    "farm-service:3000" \
    "sensor-service:3000" \
    "messaging-service:3000"; do
    local svc="${spec%%:*}"
    local port="${spec##*:}"
    if check_ready_endpoint "${svc}" "${port}"; then
      echo "  ${svc}: ready"
    else
      echo "::error::${svc}: /health/ready failed"
      failures=$((failures + 1))
    fi
  done

  [ "${failures}" -eq 0 ]
}

verify_release_ledger_sql() {
  local db_name="${POSTGRES_DB:-aquaculture}"
  local release_id="${DEPLOY_RELEASE_ID:-${DEPLOY_SHA:-unknown}}"

  echo "=== SQL release verification ==="
  docker exec -i aqua-postgres psql \
    -U "${POSTGRES_USER:-aquaculture}" \
    -d "${db_name}" \
    -v ON_ERROR_STOP=1 \
    -v release_id="${release_id}" \
    -v git_sha="${DEPLOY_SHA:-unknown}" <<'SQL'
SELECT set_config('aqua.deploy_release_id', :'release_id', false);
SELECT set_config('aqua.deploy_git_sha', :'git_sha', false);

DO $$
DECLARE
  rel platform.release_ledger%ROWTYPE;
  expected_release_id text := current_setting('aqua.deploy_release_id');
  expected_git_sha text := current_setting('aqua.deploy_git_sha');
BEGIN
  SELECT *
    INTO rel
    FROM platform.release_ledger
   WHERE release_id = expected_release_id
     AND git_sha = expected_git_sha
   ORDER BY updated_at DESC
   LIMIT 1;

  IF rel.release_id IS NULL THEN
    RAISE EXCEPTION 'release ledger row missing for release_id=%', expected_release_id;
  END IF;

  IF rel.expected_heads = '{}'::jsonb
     OR rel.applied_heads = '{}'::jsonb
     OR rel.expected_heads <> rel.applied_heads THEN
    RAISE EXCEPTION 'release ledger expected/applied heads missing or mismatched for release_id=%', expected_release_id;
  END IF;

  IF rel.status NOT IN ('db_complete', 'apps_restarting', 'promoted') THEN
    RAISE EXCEPTION 'release ledger status is not deploy-progress/promotable for release_id=% status=%',
      expected_release_id,
      rel.status;
  END IF;
END
$$;
SELECT 'ok' AS release_verification;
SQL
}

# BEGIN production-release-transaction
DEPLOY_TRANSACTION_PATH="${AQUA_CONTROL_PLANE_ROOT}/active-release-transaction.json"
DEPLOY_TRANSACTION_ACTIVE=false
DEPLOY_TRANSACTION_TERMINAL=false
DEPLOY_TRANSACTION_MUTATED=false
DEPLOY_TRANSACTION_RECOVERING=false
DEPLOY_TRANSACTION_PRIOR_JSON=${AQUA_RECOVERY_PRIOR_JSON:-null}

release_transaction_write() {
  [ "$#" -eq 4 ] || return 64
  local expected_phase=$1
  local next_phase=$2
  local migrations_applied=$3
  local failure_phase=$4
  local manifest_hash
  local rollback_hash
  local rollback_policy=${AQUA_DEPLOY_ROLLBACK_POLICY:-ALLOW_ZERO_MIGRATION}
  local supersedes_release_id=${AQUA_DEPLOY_SUPERSEDES_RELEASE_ID:-}
  local supersedes_candidate_sha=${AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA:-}
  local supersession_proof=${AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256:-}

  aqua_control_plane_lock_assert || return
  assert_deploy_compose_override || return
  assert_rollback_state || return
  manifest_hash=$(sha256sum --binary "${DEPLOY_IMAGE_DIGESTS_FILE}" | awk '{print $1}') || return
  rollback_hash=$(cat "${ROLLBACK_CHECKSUM}") || return
  /usr/bin/python3 - \
    "${DEPLOY_TRANSACTION_PATH}" "${AQUA_CONTROL_PLANE_ROOT}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${expected_phase}" "${next_phase}" \
    "${DEPLOY_RELEASE_ID}" "${DEPLOY_SHA}" "${manifest_hash}" "${rollback_hash}" \
    "${FULL_DEPLOY}" "${DEPLOY_SERVICES}" "${migrations_applied}" \
    "${failure_phase}" "${DEPLOY_TRANSACTION_PRIOR_JSON}" \
    "${rollback_policy}" "${supersedes_release_id}" \
    "${supersedes_candidate_sha}" "${supersession_proof}" <<'RELEASE_TRANSACTION_PY'
import datetime
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

(
    path_raw,
    root_raw,
    expected_uid_raw,
    expected_phase,
    next_phase,
    release_id,
    candidate_sha,
    manifest_hash,
    rollback_hash,
    full_deploy_raw,
    services_raw,
    migrations_raw,
    failure_phase,
    prior_raw,
    rollback_policy,
    supersedes_release_id_raw,
    supersedes_candidate_sha_raw,
    supersession_proof_raw,
) = sys.argv[1:]
path = pathlib.Path(path_raw)
root = pathlib.Path(root_raw)
expected_uid = int(expected_uid_raw)
if path != root / "active-release-transaction.json":
    raise SystemExit("release transaction journal path is not canonical")
sha_pattern = re.compile(r"^[0-9a-f]{40}$")
hash_pattern = re.compile(r"^[0-9a-f]{64}$")
release_pattern = re.compile(r"^([0-9a-f]{40})-[0-9]{8}T[0-9]{6}Z$")
service_pattern = re.compile(r"^[a-z0-9][a-z0-9-]*$")
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
allowed = {
    "PREPARED": {"MUTATION_STARTED", "ROLLED_BACK", "FORWARD_REQUIRED"},
    "MUTATION_STARTED": {"DB_COMPLETE", "ROLLBACK_STARTED", "FORWARD_REQUIRED"},
    "DB_COMPLETE": {"LIVE_CANDIDATE", "ROLLBACK_STARTED", "FORWARD_REQUIRED"},
    "LIVE_CANDIDATE": {"LIVE_VERIFIED", "ROLLBACK_STARTED", "FORWARD_REQUIRED"},
    "LIVE_VERIFIED": {"FINALIZING", "ROLLBACK_STARTED", "FORWARD_REQUIRED"},
    "FINALIZING": {"LEDGER_PROMOTED", "ROLLBACK_STARTED", "FORWARD_REQUIRED"},
    "LEDGER_PROMOTED": {"COMMITTED", "ROLLBACK_STARTED", "FORWARD_REQUIRED"},
    "FORWARD_REQUIRED": {"LIVE_VERIFIED"},
    "ROLLBACK_STARTED": {"ROLLED_BACK"},
}
if next_phase not in phases:
    raise SystemExit("release transaction next phase is invalid")
root_info = os.lstat(root)
if (
    stat.S_ISLNK(root_info.st_mode)
    or not stat.S_ISDIR(root_info.st_mode)
    or root_info.st_uid != expected_uid
    or stat.S_IMODE(root_info.st_mode) != 0o700
):
    raise SystemExit("release transaction root is unsafe")
release_match = release_pattern.fullmatch(release_id)
if release_match is None or release_match.group(1) != candidate_sha:
    raise SystemExit("release transaction identity is invalid")
if sha_pattern.fullmatch(candidate_sha) is None or hash_pattern.fullmatch(manifest_hash) is None or hash_pattern.fullmatch(rollback_hash) is None:
    raise SystemExit("release transaction hash identity is invalid")
if rollback_policy not in {"ALLOW_ZERO_MIGRATION", "FORWARD_ONLY"}:
    raise SystemExit("release transaction rollback policy is invalid")
supersedes_release_id = supersedes_release_id_raw or None
supersedes_candidate_sha = supersedes_candidate_sha_raw or None
supersession_proof = supersession_proof_raw or None
if rollback_policy == "ALLOW_ZERO_MIGRATION":
    if any(value is not None for value in (supersedes_release_id, supersedes_candidate_sha, supersession_proof)):
        raise SystemExit("zero-migration rollback policy cannot carry supersession metadata")
else:
    superseded_match = release_pattern.fullmatch(str(supersedes_release_id))
    if (
        superseded_match is None
        or superseded_match.group(1) != supersedes_candidate_sha
        or sha_pattern.fullmatch(str(supersedes_candidate_sha)) is None
        or supersedes_candidate_sha == candidate_sha
        or hash_pattern.fullmatch(str(supersession_proof)) is None
    ):
        raise SystemExit("forward-only supersession metadata is invalid")
services = services_raw.split()
if not services or "db-migrate" not in services or len(services) > 64 or len(services) != len(set(services)) or any(service_pattern.fullmatch(service) is None for service in services):
    raise SystemExit("release transaction service scope is invalid")
if full_deploy_raw not in {"true", "false"}:
    raise SystemExit("release transaction deploy mode is invalid")
try:
    prior = json.loads(prior_raw)
except json.JSONDecodeError as error:
    raise SystemExit("release transaction prior marker is invalid") from error
if prior is not None:
    marker_keys = {
        "image_digest_manifest_sha256",
        "main_sha",
        "promoted_at",
        "release_id",
        "schema_version",
    }
    if not isinstance(prior, dict) or set(prior) != marker_keys or prior.get("schema_version") != 1:
        raise SystemExit("release transaction prior marker is invalid")
    prior_sha = prior.get("main_sha")
    prior_id = prior.get("release_id")
    prior_match = release_pattern.fullmatch(str(prior_id))
    if (
        not isinstance(prior_sha, str)
        or sha_pattern.fullmatch(prior_sha) is None
        or prior_match is None
        or prior_match.group(1) != prior_sha
        or hash_pattern.fullmatch(str(prior.get("image_digest_manifest_sha256"))) is None
        or not isinstance(prior.get("promoted_at"), str)
    ):
        raise SystemExit("release transaction prior marker identity is invalid")
if failure_phase and (
    len(failure_phase) > 128
    or re.fullmatch(r"[a-z0-9_-]+", failure_phase) is None
):
    raise SystemExit("release transaction failure phase is invalid")
if migrations_raw == "preserve":
    migrations = None
elif re.fullmatch(r"[0-9]+", migrations_raw) is not None:
    migrations = int(migrations_raw)
else:
    raise SystemExit("release transaction migration count is invalid")


def read_journal(candidate: pathlib.Path, label: str) -> dict[str, object] | None:
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
        or info.st_size > 16384
    ):
        raise SystemExit(f"release transaction {label} is unsafe")
    try:
        document = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"release transaction {label} is corrupt") from error
    expected_keys = {
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
    legacy_keys = expected_keys - {
        "rollback_policy",
        "supersedes_candidate_sha",
        "supersedes_release_id",
        "supersession_proof_sha256",
    }
    version = document.get("schema_version") if isinstance(document, dict) else None
    accepted_keys = legacy_keys if version == 1 else expected_keys
    if (
        not isinstance(document, dict)
        or set(document) != accepted_keys
        or version not in {1, 2}
        or document.get("phase") not in phases
        or (version == 1 and document.get("phase") not in {"COMMITTED", "ROLLED_BACK"})
    ):
        raise SystemExit(f"release transaction {label} schema is invalid")
    return document


def read_current() -> dict[str, object] | None:
    return read_journal(path, "journal")


def require_release_directory(target_release_id: str) -> pathlib.Path:
    releases_root = root / "releases"
    release_root_info = os.lstat(releases_root)
    if (
        stat.S_ISLNK(release_root_info.st_mode)
        or not stat.S_ISDIR(release_root_info.st_mode)
        or release_root_info.st_uid != expected_uid
        or stat.S_IMODE(release_root_info.st_mode) != 0o700
    ):
        raise SystemExit("release transaction evidence root is unsafe")
    target = releases_root / target_release_id
    target_info = os.lstat(target)
    target_match = release_pattern.fullmatch(target_release_id)
    if (
        target_match is None
        or stat.S_ISLNK(target_info.st_mode)
        or not stat.S_ISDIR(target_info.st_mode)
        or target_info.st_uid != expected_uid
        or stat.S_IMODE(target_info.st_mode) != 0o700
    ):
        raise SystemExit("release transaction evidence directory is unsafe")
    return target


def fsync_directory(directory: pathlib.Path) -> None:
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def read_safe_evidence(candidate: pathlib.Path) -> bytes | None:
    try:
        candidate_info = os.lstat(candidate)
    except FileNotFoundError:
        return None
    if (
        stat.S_ISLNK(candidate_info.st_mode)
        or not stat.S_ISREG(candidate_info.st_mode)
        or candidate_info.st_uid != expected_uid
        or candidate_info.st_nlink != 1
        or stat.S_IMODE(candidate_info.st_mode) != 0o400
        or not 0 < candidate_info.st_size <= 32768
    ):
        raise SystemExit(f"release transaction evidence file is unsafe: {candidate.name}")
    return candidate.read_bytes()


def parse_supersession_evidence(payload: bytes) -> dict[str, object]:
    if not payload.endswith(b"\n"):
        raise SystemExit("release transaction supersession evidence is noncanonical")
    try:
        evidence = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit("release transaction supersession evidence is corrupt") from error
    expected = {
        "schema_version",
        "successor_candidate_sha",
        "successor_release_id",
        "superseded_transaction",
        "superseded_transaction_sha256",
        "supersession_proof_sha256",
    }
    if not isinstance(evidence, dict) or set(evidence) != expected or evidence.get("schema_version") != 1:
        raise SystemExit("release transaction supersession evidence schema is invalid")
    if canonical_json_bytes(evidence) != payload:
        raise SystemExit("release transaction supersession evidence is noncanonical")
    predecessor = evidence.get("superseded_transaction")
    if not isinstance(predecessor, dict):
        raise SystemExit("release transaction supersession predecessor is invalid")
    successor_id = evidence.get("successor_release_id")
    successor_sha = evidence.get("successor_candidate_sha")
    successor_match = release_pattern.fullmatch(str(successor_id))
    if (
        successor_match is None
        or successor_match.group(1) != successor_sha
        or sha_pattern.fullmatch(str(successor_sha)) is None
        or hash_pattern.fullmatch(str(evidence.get("supersession_proof_sha256"))) is None
        or hashlib.sha256(canonical_json_bytes(predecessor)).hexdigest()
        != evidence.get("superseded_transaction_sha256")
    ):
        raise SystemExit("release transaction supersession evidence identity/hash is invalid")
    return evidence


def validate_supersession_predecessor(
    evidence: dict[str, object], predecessor: dict[str, object]
) -> None:
    if evidence.get("superseded_transaction") != predecessor:
        raise SystemExit("release transaction supersession predecessor replay mismatch")
    if predecessor.get("phase") != "FORWARD_REQUIRED":
        raise SystemExit("release transaction supersession predecessor is not forward-required")


def validate_supersession_successor(
    evidence: dict[str, object], successor: dict[str, object]
) -> None:
    predecessor = evidence.get("superseded_transaction")
    if not isinstance(predecessor, dict):
        raise SystemExit("release transaction supersession predecessor is invalid")
    if (
        evidence.get("successor_release_id") != successor.get("release_id")
        or evidence.get("successor_candidate_sha") != successor.get("candidate_sha")
        or evidence.get("supersession_proof_sha256")
        != successor.get("supersession_proof_sha256")
        or predecessor.get("release_id") != successor.get("supersedes_release_id")
        or predecessor.get("candidate_sha") != successor.get("supersedes_candidate_sha")
        or predecessor.get("phase") != "FORWARD_REQUIRED"
    ):
        raise SystemExit("release transaction supersession evidence is unrelated to active successor")


def write_immutable_stage(stage_path: pathlib.Path, payload: bytes) -> None:
    if not 0 < len(payload) <= 32768:
        raise SystemExit("release transaction evidence payload is unbounded")
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
    fsync_directory(stage_path.parent)


def publish_evidence(path: pathlib.Path, payload: bytes) -> None:
    if not 0 < len(payload) <= 32768:
        raise SystemExit("release transaction evidence payload is unbounded")
    existing = read_safe_evidence(path)
    if existing is not None:
        if existing != payload:
            raise SystemExit(f"release transaction evidence replay mismatch: {path.name}")
        return
    stage_path = path.with_name(f".{path.name}.staging")
    staged = read_safe_evidence(stage_path)
    if staged is not None:
        if staged != payload:
            raise SystemExit(f"release transaction evidence staging replay mismatch: {path.name}")
        os.replace(stage_path, path)
    else:
        write_immutable_stage(stage_path, payload)
        os.replace(stage_path, path)
    fsync_directory(path.parent)


def stage_supersession_evidence(
    path: pathlib.Path, payload: bytes, predecessor: dict[str, object]
) -> None:
    if read_safe_evidence(path) is not None:
        raise SystemExit("release transaction supersession evidence precedes active journal authority")
    stage_path = path.with_name(f".{path.name}.staging")
    staged = read_safe_evidence(stage_path)
    if staged is not None:
        staged_evidence = parse_supersession_evidence(staged)
        validate_supersession_predecessor(staged_evidence, predecessor)
        if staged == payload:
            return
        # A fully validated pre-CAS attempt is not authority.  Discarding it
        # lets a different valid descendant compete without being pinned by a
        # power cut, while malformed or unrelated residue remains fail-closed.
        stage_path.unlink()
        fsync_directory(path.parent)
    write_immutable_stage(stage_path, payload)


def finalize_supersession_evidence(
    path: pathlib.Path, payload: bytes, successor: dict[str, object]
) -> None:
    authoritative = read_current()
    if authoritative != successor:
        raise SystemExit("release transaction supersession finalization lost active journal authority")
    evidence = parse_supersession_evidence(payload)
    validate_supersession_successor(evidence, successor)
    stage_path = path.with_name(f".{path.name}.staging")
    existing = read_safe_evidence(path)
    staged = read_safe_evidence(stage_path)
    if existing is not None:
        if staged is not None or existing != payload:
            raise SystemExit("release transaction supersession final evidence replay mismatch")
        return
    if staged != payload:
        raise SystemExit("release transaction supersession staging is missing or tampered")
    os.replace(stage_path, path)
    fsync_directory(path.parent)


current = read_current()
current_before_cas = current
forward_start = False
forward_recovery = False
supersession_path: pathlib.Path | None = None
supersession_payload: bytes | None = None
if expected_phase == "START":
    if next_phase != "PREPARED":
        raise SystemExit("release transaction START must prepare the candidate")
    if rollback_policy == "FORWARD_ONLY":
        if current is not None and current.get("phase") == "PREPARED":
            expected_successor = {
                "candidate_sha": candidate_sha,
                "deploy_services": services,
                "failure_phase": None,
                "full_deploy": full_deploy_raw == "true",
                "image_digest_manifest_sha256": manifest_hash,
                "migrations_applied": None,
                "phase": "PREPARED",
                "prior_release": prior,
                "release_id": release_id,
                "rollback_manifest_sha256": rollback_hash,
                "rollback_policy": "FORWARD_ONLY",
                "schema_version": 2,
                "supersedes_candidate_sha": supersedes_candidate_sha,
                "supersedes_release_id": supersedes_release_id,
                "supersession_proof_sha256": supersession_proof,
            }
            for key, value in expected_successor.items():
                if current.get(key) != value:
                    raise SystemExit("forward-only recovery does not match the active successor")
            try:
                datetime.datetime.strptime(str(current.get("occurred_at")), "%Y-%m-%dT%H:%M:%SZ")
            except ValueError as error:
                raise SystemExit("forward-only recovery timestamp is invalid") from error
            forward_recovery = True
        elif (
            current is None
            or current.get("phase") != "FORWARD_REQUIRED"
            or current.get("release_id") != supersedes_release_id
            or current.get("candidate_sha") != supersedes_candidate_sha
        ):
            raise SystemExit("forward-only successor does not match the unresolved predecessor")
        else:
            superseded_bytes = canonical_json_bytes(current)
            superseded_evidence = {
                "schema_version": 1,
                "successor_candidate_sha": candidate_sha,
                "successor_release_id": release_id,
                "superseded_transaction": current,
                "superseded_transaction_sha256": hashlib.sha256(superseded_bytes).hexdigest(),
                "supersession_proof_sha256": supersession_proof,
            }
            supersession_payload = canonical_json_bytes(superseded_evidence)
            superseded_directory = require_release_directory(str(supersedes_release_id))
            supersession_path = superseded_directory / "superseded-transaction.json"
            stage_supersession_evidence(supersession_path, supersession_payload, current)
            forward_start = True
    elif current is not None and current.get("phase") not in {"COMMITTED", "ROLLED_BACK"}:
        raise SystemExit("an unresolved release transaction already owns the host")
    current_migrations = None
else:
    if current is None or current.get("phase") != expected_phase:
        raise SystemExit("release transaction phase compare-and-swap failed")
    immutable = {
        "candidate_sha": candidate_sha,
        "deploy_services": services,
        "full_deploy": full_deploy_raw == "true",
        "image_digest_manifest_sha256": manifest_hash,
        "prior_release": prior,
        "release_id": release_id,
        "rollback_manifest_sha256": rollback_hash,
        "rollback_policy": rollback_policy,
        "schema_version": 2,
        "supersedes_candidate_sha": supersedes_candidate_sha,
        "supersedes_release_id": supersedes_release_id,
        "supersession_proof_sha256": supersession_proof,
    }
    for key, value in immutable.items():
        if current.get(key) != value:
            raise SystemExit(f"release transaction immutable field changed: {key}")
    if next_phase not in allowed.get(expected_phase, set()):
        raise SystemExit("release transaction phase transition is illegal")
    current_migrations = current.get("migrations_applied")
    if current_migrations is not None and (not isinstance(current_migrations, int) or current_migrations < 0):
        raise SystemExit("release transaction stored migration count is invalid")

document = {
    "candidate_sha": candidate_sha,
    "deploy_services": services,
    "failure_phase": failure_phase or None,
    "full_deploy": full_deploy_raw == "true",
    "image_digest_manifest_sha256": manifest_hash,
    "migrations_applied": current_migrations if migrations is None else migrations,
    "occurred_at": (
        current["occurred_at"]
        if (next_phase in {"COMMITTED", "ROLLED_BACK"} or forward_recovery)
        and current is not None
        else datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ),
    "phase": next_phase,
    "prior_release": prior,
    "release_id": release_id,
    "rollback_manifest_sha256": rollback_hash,
    "rollback_policy": rollback_policy,
    "schema_version": 2,
    "supersedes_candidate_sha": supersedes_candidate_sha,
    "supersedes_release_id": supersedes_release_id,
    "supersession_proof_sha256": supersession_proof,
}
if forward_recovery:
    if document != current:
        raise SystemExit("forward-only recovery changed the active successor")
    superseded_directory = require_release_directory(str(supersedes_release_id))
    supersession_path = superseded_directory / "superseded-transaction.json"
    final_payload = read_safe_evidence(supersession_path)
    staged_payload = read_safe_evidence(
        supersession_path.with_name(f".{supersession_path.name}.staging")
    )
    if (final_payload is None) == (staged_payload is None):
        raise SystemExit("forward-only recovery evidence state is ambiguous or missing")
    supersession_payload = final_payload if final_payload is not None else staged_payload
    if supersession_payload is None:
        raise SystemExit("forward-only recovery evidence is missing")
    finalize_supersession_evidence(supersession_path, supersession_payload, document)
    raise SystemExit(0)
if next_phase in {"COMMITTED", "ROLLED_BACK"}:
    transaction_bytes = (
        json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    terminal_evidence = {
        "schema_version": 1,
        "terminal_transaction": document,
        "terminal_transaction_sha256": hashlib.sha256(transaction_bytes).hexdigest(),
    }
    terminal_payload = (
        json.dumps(terminal_evidence, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    terminal_directory = require_release_directory(release_id)
    terminal_path = terminal_directory / "release-transaction-terminal.json"
    publish_evidence(terminal_path, terminal_payload)
stage_path = root / ".active-release-transaction.staging"
try:
    stage_info = os.lstat(stage_path)
except FileNotFoundError:
    stage_info = None
if stage_info is not None:
    if (
        stat.S_ISLNK(stage_info.st_mode)
        or not stat.S_ISREG(stage_info.st_mode)
        or stage_info.st_uid != expected_uid
        or stage_info.st_nlink != 1
        or stat.S_IMODE(stage_info.st_mode) != 0o400
        or stage_info.st_size > 16384
    ):
        raise SystemExit("release transaction staging residue is unsafe")
    staged_journal = read_journal(stage_path, "staging residue")
    if forward_start and current_before_cas is not None:
        if (
            staged_journal is None
            or staged_journal.get("phase") != "PREPARED"
            or staged_journal.get("rollback_policy") != "FORWARD_ONLY"
            or staged_journal.get("supersedes_release_id")
            != current_before_cas.get("release_id")
            or staged_journal.get("supersedes_candidate_sha")
            != current_before_cas.get("candidate_sha")
        ):
            raise SystemExit("release transaction staging residue is unrelated")
    stage_path.unlink()
    fsync_directory(root)
descriptor = os.open(
    stage_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o400,
)
try:
    payload = canonical_json_bytes(document)
    if len(payload) > 16384:
        raise SystemExit("release transaction journal payload is unbounded")
    with os.fdopen(descriptor, "wb", closefd=False) as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    os.close(descriptor)
    descriptor = -1
    if read_current() != current_before_cas:
        raise SystemExit("release transaction journal authority changed before compare-and-swap")
    os.replace(stage_path, path)
    fsync_directory(root)
    if forward_start:
        if supersession_path is None or supersession_payload is None:
            raise SystemExit("release transaction supersession finalization state is missing")
        finalize_supersession_evidence(supersession_path, supersession_payload, document)
except BaseException:
    if descriptor >= 0:
        os.close(descriptor)
    try:
        stage_path.unlink()
    except FileNotFoundError:
        pass
    raise
RELEASE_TRANSACTION_PY
}

release_transaction_begin() {
  local marker_path="${AQUA_CONTROL_PLANE_ROOT}/current-release.json"
  local published_supersession_proof

  if [ "${AQUA_DEPLOY_ROLLBACK_POLICY:-ALLOW_ZERO_MIGRATION}" = FORWARD_ONLY ]; then
    : "${AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA:?superseded candidate SHA is required}"
    : "${AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256:?supersession proof is required}"
    published_supersession_proof=$(
      aqua_control_plane_descendant_source_proof \
        "${AQUA_DEPLOY_SUPERSEDES_CANDIDATE_SHA}"
    ) || return
    if [ "${published_supersession_proof}" != \
      "${AQUA_DEPLOY_SUPERSESSION_PROOF_SHA256}" ]; then
      echo "::error::Forward-only successor proof does not match the published source ancestry." >&2
      return 1
    fi
  fi
  if [ -e "${marker_path}" ] || [ -L "${marker_path}" ]; then
    DEPLOY_TRANSACTION_PRIOR_JSON=$(read_deploy_current_release) || return
  else
    DEPLOY_TRANSACTION_PRIOR_JSON='null'
  fi
  release_transaction_write START PREPARED preserve '' || return
  DEPLOY_TRANSACTION_ACTIVE=true
  DEPLOY_TRANSACTION_PHASE=PREPARED
  export AQUA_DEPLOY_TRANSACTION_OWNER_RELEASE_ID="${DEPLOY_RELEASE_ID}"
}

release_transaction_transition() {
  [ "$#" -ge 2 ] && [ "$#" -le 4 ] || return 64
  local expected_phase=$1
  local next_phase=$2
  local migrations=${3:-preserve}
  local failure=${4:-}
  release_transaction_write "${expected_phase}" "${next_phase}" "${migrations}" "${failure}" || return
  DEPLOY_TRANSACTION_PHASE=${next_phase}
  case "${next_phase}" in
    COMMITTED|ROLLED_BACK) DEPLOY_TRANSACTION_TERMINAL=true ;;
  esac
}

deploy_transaction_marker_matches_prior() {
  local marker_path="${AQUA_CONTROL_PLANE_ROOT}/current-release.json"
  local current='null'
  if [ -e "${marker_path}" ] || [ -L "${marker_path}" ]; then
    current=$(read_deploy_current_release) || return
  fi
  /usr/bin/python3 - "${DEPLOY_TRANSACTION_PRIOR_JSON}" "${current}" <<'PRIOR_MARKER_MATCH_PY'
import json
import sys

try:
    expected = json.loads(sys.argv[1])
    actual = json.loads(sys.argv[2])
except json.JSONDecodeError as error:
    raise SystemExit("release transaction prior-marker comparison is invalid") from error
if actual != expected:
    raise SystemExit("current-release marker no longer matches the transaction prior release")
PRIOR_MARKER_MATCH_PY
}

deploy_transaction_exit_handler() {
  local status=$?
  local cleanup_status=0
  trap - EXIT INT TERM HUP
  set +e
  cleanup_docker_auth || cleanup_status=$?
  if [ "${status}" -eq 0 ] && [ "${cleanup_status}" -ne 0 ]; then
    status=${cleanup_status}
  fi
  if [ "${DEPLOY_TRANSACTION_ACTIVE}" = true ] && \
    [ "${DEPLOY_TRANSACTION_TERMINAL}" != true ] && \
    [ "${DEPLOY_TRANSACTION_RECOVERING}" != true ]; then
    [ "${status}" -ne 0 ] || status=1
    DEPLOY_TRANSACTION_RECOVERING=true
    if [ "${DEPLOY_TRANSACTION_PHASE:-}" = LEDGER_PROMOTED ]; then
      local manifest_hash
      manifest_hash=$(sha256sum --binary "${DEPLOY_IMAGE_DIGESTS_FILE}" | awk '{print $1}')
      if assert_deploy_current_release \
        "${DEPLOY_SHA}" "${DEPLOY_RELEASE_ID}" "${manifest_hash}" && \
        capture_release_container_attestation && \
        record_release_ledger "promoted" "" "true" && \
        verify_release_ledger_sql && \
        release_transaction_transition LEDGER_PROMOTED COMMITTED preserve ''; then
        status=0
      elif deploy_transaction_marker_matches_prior; then
        if [[ "${MIGRATIONS_APPLIED_THIS_RELEASE:-unknown}" =~ ^[0-9]+$ ]] && \
          [ "${MIGRATIONS_APPLIED_THIS_RELEASE}" -gt 0 ]; then
          if capture_release_container_attestation && \
            record_release_ledger "promoted" "" "true" && \
            publish_deploy_current_release \
              "${DEPLOY_SHA}" "${DEPLOY_RELEASE_ID}" "${manifest_hash}" && \
            assert_deploy_current_release \
              "${DEPLOY_SHA}" "${DEPLOY_RELEASE_ID}" "${manifest_hash}" && \
            release_transaction_transition LEDGER_PROMOTED COMMITTED preserve ''; then
            status=0
          fi
        else
          rollback_and_record "terminal_finalization_failure" || true
        fi
      fi
    elif [ "${DEPLOY_TRANSACTION_MUTATED}" = true ]; then
      rollback_and_record "terminal_finalization_failure" || true
    elif [ "${DEPLOY_TRANSACTION_PHASE:-}" = PREPARED ]; then
      if [ "${AQUA_DEPLOY_ROLLBACK_POLICY:-ALLOW_ZERO_MIGRATION}" = FORWARD_ONLY ]; then
        # The predecessor already crossed an irreversible boundary. Even when
        # this successor fails before its own first mutation, terminalizing it
        # as ROLLED_BACK would erase the commit-forward obligation. Preserve a
        # supersedable forward-required journal for the same or a newer exact
        # protected-main descendant.
        release_transaction_transition PREPARED FORWARD_REQUIRED preserve \
          "forward_only_pre_mutation_failure" || true
      else
        release_transaction_transition PREPARED ROLLED_BACK preserve \
          "pre_mutation_failure" || true
      fi
    fi
  fi
  exit "${status}"
}

release_capacity_gc() {
  echo "=== Cleanup old images ==="
  bash scripts/deploy/droplet-capacity.sh gc
}

release_capacity_report() {
  bash scripts/deploy/droplet-capacity.sh report
}

release_container_status() {
  echo "=== Container status ==="
  docker compose -f docker-compose.droplet.yml ps
}

prepare_deploy_mutation() {
  [ "${DEPLOY_TRANSACTION_PHASE:-}" = PREPARED ] || {
    echo "::error::Deploy mutation preparation requires a PREPARED release transaction." >&2
    return 1
  }
  release_capacity_gc || return
  release_capacity_report || return
  release_container_status || return
  cleanup_docker_auth || return
  release_transaction_transition PREPARED MUTATION_STARTED preserve '' || return
  DEPLOY_TRANSACTION_MUTATED=true
}

resume_candidate_applications() {
  [ "${DEPLOY_TRANSACTION_PHASE:-}" = DB_COMPLETE ] || return 64
  local restart_services
  record_release_ledger "apps_restarting" "" || return
  if [ "${FULL_DEPLOY}" = true ]; then
    deploy_compose up -d --no-build || return
  else
    restart_services=$(restartable_deploy_services | xargs)
    if [ -n "${restart_services}" ]; then
      deploy_compose up -d --no-deps --no-build --force-recreate \
        ${restart_services} || return
    fi
  fi
  release_transaction_transition DB_COMPLETE LIVE_CANDIDATE preserve '' || return
  sleep "${RECOVERY_BOOT_SETTLE_SECONDS:-30}"
  docker exec aqua-nginx nginx -s reload || return
  if [ "${FULL_DEPLOY}" = true ] || \
    printf '%s\n' "${DEPLOY_SERVICES}" | grep -qE \
      'gateway-api|auth-service|farm-service|sensor-service|alert-engine|billing-service|hr-service|hydroponics-service|notification-service|config-service|messaging-service'; then
    docker compose -f docker-compose.droplet.yml restart gateway-api || return
  fi
}

recover_release_transaction_entry() {
  [ "${AQUA_DEPLOY_RECOVERY_ONLY}" = true ] || return 64
  aqua_control_plane_lock_assert || return
  aqua_control_plane_guard_dr_state || return
  assert_deploy_compose_override || return
  assert_rollback_state || return
  [ "$(cat "${ROLLBACK_CHECKSUM}")" = "${AQUA_RECOVERY_ROLLBACK_HASH}" ] || {
    echo "::error::Recovery rollback state no longer matches the transaction journal." >&2
    return 1
  }

  DEPLOY_TRANSACTION_ACTIVE=true
  DEPLOY_TRANSACTION_TERMINAL=false
  DEPLOY_TRANSACTION_RECOVERING=false
  DEPLOY_TRANSACTION_PHASE=${AQUA_RECOVERY_PHASE}
  case "${DEPLOY_TRANSACTION_PHASE}" in
    PREPARED) DEPLOY_TRANSACTION_MUTATED=false ;;
    *) DEPLOY_TRANSACTION_MUTATED=true ;;
  esac
  MIGRATIONS_APPLIED_THIS_RELEASE=${AQUA_RECOVERY_MIGRATIONS}
  export MIGRATIONS_APPLIED_THIS_RELEASE
  trap deploy_transaction_exit_handler EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  echo "=== Recovering release ${DEPLOY_RELEASE_ID} from ${DEPLOY_TRANSACTION_PHASE} ==="
  case "${DEPLOY_TRANSACTION_PHASE}" in
    PREPARED)
      release_transaction_transition PREPARED ROLLED_BACK preserve \
        power_cut_before_mutation || return
      AQUA_DEPLOY_RECOVERY_TERMINAL=true
      ;;
    ROLLBACK_STARTED)
      rollback_and_record power_cut_rollback_resume || return
      AQUA_DEPLOY_RECOVERY_TERMINAL=true
      ;;
    LEDGER_PROMOTED)
      # The EXIT recovery handler observes the atomic marker: exact target
      # commits forward, exact prior rolls back only across a zero-migration
      # boundary, and every other state remains nonterminal/fail-closed.
      return 1
      ;;
    MUTATION_STARTED)
      deploy_compose up -d --no-build postgres redis nats minio || return
      run_db_migrate_or_exit "release recovery" || return
      # A power cut can occur after the original runner committed migrations
      # but before it journaled the count. A successful idempotent rerun that
      # reports zero therefore remains conservatively non-rollbackable.
      if [ "${MIGRATIONS_APPLIED_THIS_RELEASE}" -eq 0 ]; then
        MIGRATIONS_APPLIED_THIS_RELEASE=1
        export MIGRATIONS_APPLIED_THIS_RELEASE
      fi
      release_transaction_transition MUTATION_STARTED DB_COMPLETE \
        "${MIGRATIONS_APPLIED_THIS_RELEASE}" power_cut_resume || return
      record_release_ledger "db_complete" "" || return
      resume_candidate_applications || return
      ;;
    DB_COMPLETE)
      [[ "${MIGRATIONS_APPLIED_THIS_RELEASE}" =~ ^[0-9]+$ ]] || return 1
      resume_candidate_applications || return
      ;;
    LIVE_CANDIDATE|LIVE_VERIFIED|FINALIZING|FORWARD_REQUIRED)
      [[ "${MIGRATIONS_APPLIED_THIS_RELEASE}" =~ ^[0-9]+$ ]] || return 1
      # A transient gate failure records `failed` before the EXIT handler
      # decides that a crossed migration boundary requires commit-forward.
      # Journal phase, not that retryable audit status, is the recovery SSoT;
      # restore the promotable lifecycle state before rerunning SQL/live gates.
      record_release_ledger "apps_restarting" "" || return
      ;;
    *)
      echo "::error::Release transaction phase is not recoverable: ${DEPLOY_TRANSACTION_PHASE}" >&2
      return 1
      ;;
  esac
}
# END production-release-transaction

if [ "${AQUA_DEPLOY_RECOVERY_ONLY}" = true ]; then
  recover_release_transaction_entry
  if [ "${AQUA_DEPLOY_RECOVERY_TERMINAL:-false}" = true ]; then
    exit 0
  fi
else
# Reverify the immutable source marker while the host-global lock is held. The
# target has no Git remote, config, refs or object database in this authority
# path; every relative input below comes from the runner-attested bundle.
echo "=== Verifying exact-SHA deploy source bundle ==="
assert_deploy_source_bundle "${DEPLOY_SHA}"
aqua_control_plane_lock_assert
aqua_control_plane_guard_dr_state
cd "${DEPLOY_CHECKOUT_DIR}"

echo "Deploy release id: ${DEPLOY_RELEASE_ID}"
echo "Deploy state dir: ${DEPLOY_STATE_DIR}"

echo "=== Capacity preflight (before certs, secrets, pulls, migrations, restarts) ==="
if ! CAPACITY_GC_MODE="${CAPACITY_GC_MODE:-auto}" bash scripts/deploy/droplet-capacity.sh gate; then
  echo "::error::Capacity preflight failed before production state changed."
  record_no_state_changed_failure "disk_preflight_low_bytes"
  exit 1
fi

# IP-1: Auto-generate/renew TLS certificates for NATS/Redis/PostgreSQL.
#
# ARCHITECTURAL CHANGE 2026-04-14: ALWAYS run generate-internal-certs.sh.
#
# Previous gate "if redis cert valid > 30 days, skip generation" caused
# an outage: new per-service NATS client certs (commit 11c21fda added
# auth_service / farm_service / .../ messaging_service / hydroponics_service
# certs to the script's `for svc in ...` loop) were NEVER generated on
# droplets where redis cert was still valid — the gate skipped the
# whole script. Result: clients/<svc>-cert.pem files missing → mTLS
# handshake fails → 'Authorization Violation' across every backend.
#
# Tier-1 Make-Impossible fix: ALWAYS invoke the script. Its per-file
# skip-if-exists logic (line 45-46 of generate-internal-certs.sh)
# makes the no-op case ~100ms total. New per-service certs added in
# lockstep with services.yaml will land on next deploy automatically,
# without operator intervention. Existing production identities are never
# force-rotated inside a deploy: exact-file bind mounts pin source inodes, so a
# safe rotation needs a separately staged cert/key/CA set plus an explicit
# recreate ceremony for every consumer.
echo "=== TLS certificate generation (always-run; idempotent) ==="
# Read and write TLS material only in the persistent certs dir. The immutable
# exact-SHA source contains no mutable cert symlink; the generator consumes
# DEPLOY_CERTS_DIR and Compose uses the same absolute bind source.
CERT_RENEW=false
if [ -f "${DEPLOY_CERTS_DIR}/redis/redis-cert.pem" ]; then
  EXPIRY=$(openssl x509 -enddate -noout -in "${DEPLOY_CERTS_DIR}/redis/redis-cert.pem" 2>/dev/null | cut -d= -f2)
  if [ -n "$EXPIRY" ]; then
    EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    echo "  Server certificate expires in ${DAYS_LEFT} days"
    if [ "$DAYS_LEFT" -lt 30 ]; then
      echo "::error::TLS certificate rotation is required; use the staged rotation and consumer-recreate ceremony."
      CERT_RENEW=true
    fi
  fi
fi
if [ "$CERT_RENEW" = true ]; then
  record_no_state_changed_failure "tls_rotation_required"
  exit 1
fi
# No --force: generate ONLY missing certs; existing valid cert/key/CA inodes
# stay untouched. This catches a newly added service identity without creating
# an in-place production rotation split-brain.
bash infrastructure/docker/scripts/generate-internal-certs.sh

# ──────────────────────────────────────────────────────────────
# ADR-016 Phase A — Pre-flight validation
# ──────────────────────────────────────────────────────────────
#
# All checks below MUST pass before we touch live production
# state. A bad commit caught here means zero-impact rollback
# (we never destroyed the running containers). A bad commit
# NOT caught here costs 5 minutes of timeout + log dive +
# health-check rollback.
#
# Tier-1 Make-Impossible: the compose interpolation, NATS
# SSoT drift, and required-secret presence are all detectable
# in <1s without touching containers. Failing fast here is
# always cheaper than failing during boot.
#
# Phase A2 — docker-compose interpolation valid
echo "=== Pre-flight: generated service DB credentials ==="
ENV_FILE="${DEPLOY_ENV_FILE}"
for SVC in ${SERVICE_DB_ROLES}; do
  generate_credential "${SVC}_SERVICE_DB_PASS" "${ENV_FILE}"
done

# Phase A2a — ensure required secrets exist in .env BEFORE interpolation.
# ORDERING IS LOAD-BEARING (INFRA-HIGH-007, 2026-06-11): this bootstrap
# used to run as Phase A4, AFTER the compose interpolation check — so a
# missing :?-required secret aborted the deploy before its generator
# ever ran, and #388's SERVICE_IDENTITY_KEYRING generator was dead code
# on the deploy path. Worse, compose's env-map iteration reports an
# ARBITRARY first-missing variable per run (Go map ordering), so serial
# deploys surfaced a different name each time and masked the full
# missing set. Generate-if-absent MUST precede the check that consumes
# the values.
#
# The REQUIRED set lives in scripts/deploy/lib/required-env-secrets.sh
# and is shared with droplet-bootstrap-env.sh so the preflight list and
# the bootstrap generator cannot drift (Tier-1 SSoT architectural fix).
# Bootstrap is strictly idempotent: generates only absent secrets,
# never rotates (rotation stays an incident-response ceremony — see
# docs/runbooks/secret-rotation.md).
echo "=== Pre-flight: required secrets presence ==="
# Bootstrap writes to the PERSISTENT secrets file (DEPLOY_ENV_FILE), never the
# ephemeral checkout. The bootstrap + lib scripts themselves come from the
# SHA-pinned checkout (relative paths; we cd'd there) so they match the
# deployed source exactly.
ENV_FILE="${DEPLOY_ENV_FILE}" bash scripts/deploy/droplet-bootstrap-env.sh
# shellcheck disable=SC1091
source scripts/deploy/lib/required-env-secrets.sh
MISSING=()
while IFS= read -r SECRET; do
  if ! grep -q "^${SECRET}=" "${DEPLOY_ENV_FILE}" 2>/dev/null; then
    MISSING+=("$SECRET")
  fi
done < <(required_env_secret_names)
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "::error::Still missing after bootstrap: ${MISSING[*]}"
  echo "  Bootstrap reported success but preflight re-check failed — investigate"
  echo "  ${DEPLOY_ENV_FILE} permissions and scripts/deploy/droplet-bootstrap-env.sh output."
  exit 1
fi
echo "  OK: ${#REQUIRED_ENV_SECRETS[@]} required secrets present"

echo "=== Pre-flight: compose interpolation ==="
if ! deploy_compose config --quiet; then
  echo "::error::docker-compose.droplet.yml interpolation failed."
  echo "  Likely cause: missing :? required env var in ${DEPLOY_ENV_FILE}"
  echo "  Aborting BEFORE any container actions — no production state changed."
  exit 1
fi
echo "  OK: compose interpolates cleanly"

# Phase A3 — NATS SSoT not drifted from generated nats.conf
echo "=== Pre-flight: NATS SSoT drift check ==="
if [ -f scripts/nats/generate-nats-conf.py ]; then
  if ! python3 scripts/nats/generate-nats-conf.py --check; then
    echo "::error::nats.conf drifted from infrastructure/nats/services.yaml"
    echo "  Run 'python3 scripts/nats/generate-nats-conf.py' locally and commit the diff."
    exit 1
  fi
  echo "  OK: nats.conf matches services.yaml"
else
  echo "  SKIP: generator script not present (commit predates ADR-015)"
fi

# Phase A4 — (moved to Phase A2a above: generate-if-absent must precede
# the interpolation check that consumes the values — INFRA-HIGH-007.)

# End of pre-flight ──────────────────────────────────────────

# BEGIN ghcr-credential-login
# SEC-CI-001: the protected production Environment supplies a dedicated
# package-read-only GHCR principal. The payload has no GITHUB_TOKEN fallback.
# The unexported credential is exposed to Docker only through stdin and is
# erased from the shell immediately after a successful login.
echo "=== Logging into GHCR ==="
GHCR_LOGIN_ATTEMPTS="${GHCR_LOGIN_ATTEMPTS:-3}"
for attempt in $(seq 1 "${GHCR_LOGIN_ATTEMPTS}"); do
  echo "  GHCR login attempt ${attempt}/${GHCR_LOGIN_ATTEMPTS}"
  if builtin printf '%s\n' "${ghcr_read_token_material}" | \
    docker login ghcr.io -u "${GHCR_ACTOR}" --password-stdin; then
    unset ghcr_read_token_material
    echo "  GHCR login succeeded"
    break
  fi
  if [ "${attempt}" -eq "${GHCR_LOGIN_ATTEMPTS}" ]; then
    echo "::error::GHCR login failed after ${GHCR_LOGIN_ATTEMPTS} attempt(s)."
    exit 1
  fi
  sleep $((attempt * 5))
done
# END ghcr-credential-login

# ARCH-CI-007: Capture current image digests for rollback before pulling new images.
# This is stack-wide, not gateway-only: a failed auth/farm/sensor rollout must
# restore the exact service image that changed.
capture_rollback_manifest
assert_rollback_state
release_transaction_begin
trap deploy_transaction_exit_handler EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Scope boot-signal assertions to this deploy attempt. The asserter falls
# back to per-container StartedAt if this is absent, but an explicit since
# marker makes full and selective deploy log windows obvious in output.
export BOOT_SIGNAL_SINCE
BOOT_SIGNAL_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Boot signal log window starts at: ${BOOT_SIGNAL_SINCE}"

if [ "$FULL_DEPLOY" = "true" ]; then
  # ── Full deploy mode (workflow_dispatch "all" or first deploy) ──
  echo "=== FULL DEPLOY: Pulling infrastructure images sequentially ==="
  for svc in $(deploy_compose config --services); do
    if is_application_image_service "$svc"; then
      continue
    fi
    echo "  Pulling $svc..."
    docker compose -f docker-compose.droplet.yml pull "$svc" 2>&1 || echo "  WARN: infrastructure image pull for $svc failed, continuing with local image if present..."
  done

  echo "=== FULL DEPLOY: Pulling application images by immutable deploy SHA ==="
  for svc in ${APPLICATION_IMAGE_SERVICES}; do
    pull_deploy_image_required "$svc"
  done

  # ARCH-031: Pre-deploy NATS JetStream storage maintenance.
  # If JetStream data exceeds server limit (nats.conf max_file_store: 2GB),
  # purge the data directory to allow clean startup. NATS will recreate
  # streams via nats-event-bus.ts setupStream() on first service connection.
  # This prevents "insufficient storage resources available" (error 10047).
  echo "=== NATS JetStream storage maintenance ==="
  NATS_DATA_DIR="/var/lib/docker/volumes/aqua-saas_nats_data/_data/jetstream"
  if [ -d "$NATS_DATA_DIR" ]; then
    JS_SIZE=$(du -sm "$NATS_DATA_DIR" 2>/dev/null | awk '{print $1}')
    echo "JetStream storage usage: ${JS_SIZE:-0}MB / 2048MB limit"
    if [ "${JS_SIZE:-0}" -gt 1800 ]; then
      echo "::error::JetStream storage near limit (${JS_SIZE}MB > 1800MB)."
      echo "  Refusing deploy-time data purge. Export/backup and run the JetStream recovery runbook during a maintenance window."
      exit 1
    fi
  else
    echo "No existing JetStream data directory found (first deploy or volume not mounted)"
  fi

  # ================================================================
  # Per-service credential provisioning (CRITICAL-002 / CRITICAL-001)
  #
  # Each service needs its own NATS user/password and DB role password.
  # These are generated ONCE and persisted in .env. Subsequent deploys
  # detect existing values and skip generation (idempotent).
  # ================================================================
  echo "=== Ensuring per-service credentials exist ==="
  ENV_FILE="${DEPLOY_ENV_FILE}"

  generate_credential() {
    local VAR_NAME="$1"
    if grep -q "^${VAR_NAME}=" "$ENV_FILE" 2>/dev/null; then
      echo "  ${VAR_NAME}: already set"
    else
      local VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
      echo "${VAR_NAME}=${VALUE}" >> "$ENV_FILE"
      echo "  ${VAR_NAME}: generated"
    fi
  }

  # ADR-015 (cert-is-identity): NATS per-service identity is the
  # mTLS cert CN via `verify_and_map: true`. The previous
  # set_canonical NATS_*_USER / generate_credential NATS_*_PASS
  # provisioning block was removed — those env vars are no longer
  # consumed by nats.conf (literal user names from services.yaml)
  # or by the client factory (mtls-cert mode omits user/pass from
  # CONNECT frame). Keeping them provisioned would resurrect the
  # 3-way drift surface (.env ↔ nats.conf ↔ cert CN) that caused
  # the 2026-04-14 Authorization Violation outage.
  #
  # Canonical service name list now lives exclusively at
  # infrastructure/nats/services.yaml and is consumed by:
  #   - scripts/nats/generate-nats-conf.py (generates nats.conf)
  #   - infrastructure/docker/scripts/generate-internal-certs.sh
  #     (cert CN list — hand-written in lockstep, CI-validated)
  #   - e2e/tests/integration/nats-invariants.spec.ts (drift
  #     detection)
  #
  # If the SSoT gets out of sync with generated artifacts, the
  # nats-invariants CI test fails the build — no need for deploy
  # workflow to enforce it.
  #
  # NATS_*_SVC_USER / NATS_*_SVC_PASS are historical (internal
  # deploy bookkeeping, not client auth). Preserved to avoid
  # churning deploy-state conventions in the same PR as the
  # architectural refactor. Tracked as BACKLOG-NATS-003 to audit
  # whether they're still read by any pipeline step and remove
  # them if not.

  # NATS per-service internal bookkeeping credentials (unrelated
  # to client auth; legacy — see comment above)
  for SVC in AUTH FARM SENSOR GATEWAY NOTIFICATION BILLING ALERT HR MESSAGING HYDROPONICS; do
    generate_credential "NATS_${SVC}_SVC_USER"
    generate_credential "NATS_${SVC}_SVC_PASS"
  done

  # PostgreSQL per-service role passwords
  # SSoT: SERVICE_DB_ROLES is generated from the platform service catalog.
  for SVC in ${SERVICE_DB_ROLES}; do
    generate_credential "${SVC}_SERVICE_DB_PASS"
  done

  # Application secrets
  generate_credential "WEBHOOK_ENCRYPTION_KEY"

  echo "=== Per-service credentials provisioned ==="

  # RSA key pair for JWT RS256 signing (auth-service signs, all verify).
  # Persisted in the stable certs dir and mounted through DEPLOY_CERTS_DIR —
  # never regenerated merely because the immutable source changes.
  echo "=== Ensuring JWT RSA key pair exists ==="
  JWT_KEY_DIR="${DEPLOY_CERTS_DIR}/jwt"
  if [ ! -f "$JWT_KEY_DIR/private.pem" ]; then
    echo "  Generating RSA-2048 key pair for JWT..."
    mkdir -p "$JWT_KEY_DIR"
    openssl genrsa -out "$JWT_KEY_DIR/private.pem" 2048
    openssl rsa -in "$JWT_KEY_DIR/private.pem" -pubout -out "$JWT_KEY_DIR/public.pem"
    chmod 600 "$JWT_KEY_DIR/private.pem"
    chmod 644 "$JWT_KEY_DIR/public.pem"
    # Write PEM paths to .env
    grep -q "^JWT_PRIVATE_KEY_PATH=" "$ENV_FILE" || echo "JWT_PRIVATE_KEY_PATH=/etc/ssl/jwt/private.pem" >> "$ENV_FILE"
    grep -q "^JWT_PUBLIC_KEY_PATH=" "$ENV_FILE" || echo "JWT_PUBLIC_KEY_PATH=/etc/ssl/jwt/public.pem" >> "$ENV_FILE"
    echo "  JWT RSA key pair generated"
  else
    echo "  JWT RSA key pair already exists"
    # Ensure .env has the path vars even if keys were generated in a prior deploy
    grep -q "^JWT_PRIVATE_KEY_PATH=" "$ENV_FILE" || echo "JWT_PRIVATE_KEY_PATH=/etc/ssl/jwt/private.pem" >> "$ENV_FILE"
    grep -q "^JWT_PUBLIC_KEY_PATH=" "$ENV_FILE" || echo "JWT_PUBLIC_KEY_PATH=/etc/ssl/jwt/public.pem" >> "$ENV_FILE"
  fi

  echo "=== Ensuring infrastructure databases exist ==="
  prepare_deploy_mutation
  echo "=== Stopping all services ==="
  rollback_compose down --remove-orphans --timeout 30 2>&1 || true
  # Compose owns only exact container IDs labelled with its canonical project
  # and service identities. Name prefixes are not lifecycle authority: backup,
  # PITR and agent workloads intentionally share this host.
  echo "Removing any canonical project containers left after Compose down..."
  remove_canonical_project_containers_after_down

  # Start only postgres first to create additional databases
  deploy_compose up -d --no-build postgres 2>&1
  sleep 10

  # DB-PWD-SYNC: Verify POSTGRES_PASSWORD matches what's in the data volume.
  # Deploy must not mutate database roles. A mismatch means bootstrap state
  # and secret state diverged and must be corrected through the db-migrate /
  # infrastructure bootstrap authority, not by this runtime deploy script.
  echo "=== Verifying PostgreSQL superuser password ==="
  POSTGRES_EFFECTIVE_USER="${POSTGRES_USER:-$(read_env_file_value POSTGRES_USER "$ENV_FILE")}"
  POSTGRES_EFFECTIVE_USER="${POSTGRES_EFFECTIVE_USER:-aquaculture}"
  POSTGRES_EFFECTIVE_PASSWORD="${POSTGRES_PASSWORD:-$(read_env_file_value POSTGRES_PASSWORD "$ENV_FILE")}"
  if [ -z "$POSTGRES_EFFECTIVE_PASSWORD" ]; then
    echo "::error::POSTGRES_PASSWORD is missing from shell env and ${ENV_FILE}; aborting before migrations."
    exit 1
  fi

  if docker exec aqua-postgres psql -U "${POSTGRES_EFFECTIVE_USER}" -c "SELECT 1" >/dev/null 2>&1; then
    if docker exec -e PGPASSWORD="${POSTGRES_EFFECTIVE_PASSWORD}" aqua-postgres \
      psql -h 127.0.0.1 -U "${POSTGRES_EFFECTIVE_USER}" -c "SELECT 1" >/dev/null 2>&1; then
      echo "  PostgreSQL superuser password matches .env"
    else
      echo "::error::PostgreSQL superuser password mismatch — refusing deploy-time role mutation."
      echo "  Rotate or repair the credential through the platform bootstrap authority, then rerun deploy."
      exit 1
    fi
  else
    echo "::error::Cannot connect to PostgreSQL via local auth — aborting before migrations."
    exit 1
  fi

  # ─────────────────────────────────────────────────────────────
  # ADR-033 — one-shot authoritative schema migration container.
  #
  # Run aqua-db-migrate BEFORE service containers so schema state
  # is at the known-good version when gateway-api / auth-service
  # / every other backend boots.
  #
  # --exit-code-from aqua-db-migrate: compose blocks until the
  # container exits and surfaces its exit code to the script.
  # Exit 0 → proceed. Non-zero → abort deploy BEFORE service
  # containers ever start (services' depends_on
  # service_completed_successfully would enforce this at
  # compose level too, but the explicit early exit here gives
  # the operator a clear failure signal without compose's
  # more verbose error output).
  #
  # If the migration container fails (exit code != 0), the deploy aborts.
  # Production services use schema-version gates; they do not act as a
  # fallback schema writer.
  # ─────────────────────────────────────────────────────────────
  run_db_migrate_or_exit "full deploy"
  release_transaction_transition MUTATION_STARTED DB_COMPLETE \
    "${MIGRATIONS_APPLIED_THIS_RELEASE}" ''
  record_release_ledger "db_complete" ""

  echo "=== Starting all services ==="
  record_release_ledger "apps_restarting" ""
  deploy_compose up -d --no-build 2>&1
  release_transaction_transition DB_COMPLETE LIVE_CANDIDATE preserve ''

  echo "=== Waiting 90s for services to bootstrap ==="
  sleep 90

  # ARCH-NM-DNS: Graceful nginx reload after full deploy to ensure
  # all upstream hostnames are resolved to current container IPs.
  echo "=== Reloading nginx to pick up new container IPs ==="
  docker exec aqua-nginx nginx -s reload 2>&1
  sleep 2

  # ARCH-GW-006: Force Apollo Gateway to recompose supergraph schema.
  # After backend services restart with new GraphQL types/fields, the
  # gateway may hold a stale supergraph from the previous composition.
  # The pollIntervalInMs (300s) would eventually refresh it, but during
  # that window frontend queries for new fields return 400.
  # Restarting the gateway forces immediate schema introspection.
  echo "=== Restarting gateway for schema recomposition ==="
  docker compose -f docker-compose.droplet.yml restart gateway-api 2>&1
  sleep 15

else
  # ── Selective deploy mode (only affected services) ──
  echo "=== SELECTIVE DEPLOY: ${DEPLOY_SERVICES} ==="

  # ARCH-031: Pre-deploy NATS JetStream storage maintenance (selective path).
  echo "=== NATS JetStream storage maintenance ==="
  NATS_DATA_DIR="/var/lib/docker/volumes/aqua-saas_nats_data/_data/jetstream"
  if [ -d "$NATS_DATA_DIR" ]; then
    JS_SIZE=$(du -sm "$NATS_DATA_DIR" 2>/dev/null | awk '{print $1}')
    echo "JetStream storage usage: ${JS_SIZE:-0}MB / 2048MB limit"
    if [ "${JS_SIZE:-0}" -gt 1800 ]; then
      echo "::error::JetStream storage near limit (${JS_SIZE}MB > 1800MB)."
      echo "  Refusing deploy-time data purge. Export/backup and run the JetStream recovery runbook during a maintenance window."
      exit 1
    fi
  else
    echo "No existing JetStream data directory found"
  fi

  # Per-service credential provisioning (same as full deploy path).
  # ADR-015: no NATS client-auth credential provisioning here —
  # mTLS cert CN IS identity. Only legacy internal bookkeeping
  # credentials + DB role passwords get generated.
  echo "=== Ensuring per-service credentials exist ==="
  ENV_FILE="${DEPLOY_ENV_FILE}"
  generate_credential() {
    local VAR_NAME="$1"
    if grep -q "^${VAR_NAME}=" "$ENV_FILE" 2>/dev/null; then
      echo "  ${VAR_NAME}: already set"
    else
      local VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
      echo "${VAR_NAME}=${VALUE}" >> "$ENV_FILE"
      echo "  ${VAR_NAME}: generated"
    fi
  }
  # NATS per-service internal bookkeeping (legacy; see full-deploy
  # block above for BACKLOG-NATS-003 to audit whether any pipeline
  # step still consumes these).
  for SVC in AUTH FARM SENSOR GATEWAY NOTIFICATION BILLING ALERT HR MESSAGING HYDROPONICS; do
    generate_credential "NATS_${SVC}_SVC_USER"
    generate_credential "NATS_${SVC}_SVC_PASS"
  done
  # SSoT: SERVICE_DB_ROLES is generated from the platform service catalog.
  for SVC in ${SERVICE_DB_ROLES}; do
    generate_credential "${SVC}_SERVICE_DB_PASS"
  done

  # Application secrets
  generate_credential "WEBHOOK_ENCRYPTION_KEY"

  echo "=== Pulling affected images sequentially: ${DEPLOY_SERVICES} ==="
  for svc in ${DEPLOY_SERVICES}; do
    pull_deploy_image_required "$svc"
  done

  # Ensure infrastructure services required for migrations are running only
  # after every selected image and the rollback journal are durable.
  prepare_deploy_mutation
  echo "=== Ensuring migration infrastructure is running ==="
  deploy_compose up -d --no-build postgres redis nats minio 2>&1
  sleep 5

  # ─────────────────────────────────────────────────────────────
  # ADR-033 — one-shot authoritative schema migration container.
  #
  # Selective deploys must prove every requested image is pullable BEFORE
  # db-migrate advances schema. Otherwise a later image-pull failure leaves
  # production running old app code against new DB state.
  # ─────────────────────────────────────────────────────────────
  run_db_migrate_or_exit "selective deploy"
  release_transaction_transition MUTATION_STARTED DB_COMPLETE \
    "${MIGRATIONS_APPLIED_THIS_RELEASE}" ''
  record_release_ledger "db_complete" ""

  RESTART_SERVICES=$(restartable_deploy_services | xargs)
  if [ -n "${RESTART_SERVICES}" ]; then
    echo "=== Restarting affected services (no-deps): ${RESTART_SERVICES} ==="
    record_release_ledger "apps_restarting" ""
    deploy_compose up -d --no-deps --no-build --force-recreate ${RESTART_SERVICES} 2>&1
  else
    echo "=== No long-running services requested; db-migrate-only deploy complete ==="
  fi
  release_transaction_transition DB_COMPLETE LIVE_CANDIDATE preserve ''

  echo "=== Waiting 30s for services to bootstrap ==="
  sleep 30

  # ARCH-NM-DNS: Graceful nginx reload after container recreation.
  # Belt-and-suspenders: the nginx config uses resolver + variable proxy_pass
  # for dynamic DNS, but a reload ensures immediate resolution of new IPs
  # without waiting for the resolver TTL to expire.
  echo "=== Reloading nginx to pick up new container IPs ==="
  docker exec aqua-nginx nginx -s reload 2>&1 || docker compose -f docker-compose.droplet.yml restart nginx 2>&1
  sleep 2

  # ARCH-GW-006: Force gateway schema recomposition when backend services change.
  # Only restart gateway when a backend subgraph service was deployed, since
  # frontend-only deploys don't affect the supergraph schema.
  BACKEND_PATTERN="gateway-api|auth-service|farm-service|sensor-service|alert-engine|billing-service|hr-service|hydroponics-service|notification-service|config-service|messaging-service"
  if echo "${DEPLOY_SERVICES}" | grep -qE "${BACKEND_PATTERN}"; then
    echo "=== Backend subgraph changed — restarting gateway for schema recomposition ==="
    docker compose -f docker-compose.droplet.yml restart gateway-api 2>&1
    sleep 15
  fi
fi

fi # normal deploy versus exact-candidate transaction recovery

echo "=== Container health status ==="
docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true

dump_nonhealthy_container_logs "pre-health-gate"

# ADR-016 Phase C / WS6 — criticality-aware multi-service health
# gate. Replaces the old "poll only gateway-api /health/live" block
# that silently passed when other backends crash-looped (2026-04-14
# cascade failure mode). The script reads
# `infrastructure/deploy/service-criticality.yaml`. Critical failures
# rollback; required failures fail the deploy without rollback so an
# operator can inspect the rollout surface in place.
# Warning-level failures surface as warnings.
# The exact-SHA bundle contains standalone JavaScript, so no target-host
# node_modules tree is required. The preflighted host Node 22 authority is
# resolved before any release mutation and reused for every runtime gate.
echo "=== Waiting for critical/required services ==="
set +e
COMPOSE_FILE=docker-compose.droplet.yml \
  MANIFEST=infrastructure/deploy/service-criticality.yaml \
  POLL_INTERVAL=10 \
  "${AQUA_PRODUCTION_NODE_BIN:?production host Node authority missing}" \
    "${DEPLOY_SOURCE_DIR}/runtime/check-service-health.mjs"
HEALTH_STATUS=$?
set -e
if [ "${HEALTH_STATUS}" -eq 1 ]; then
  docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  dump_nonhealthy_container_logs "post-health-gate-failure"
  echo "::error::Critical service health check failed. Initiating rollback."
  record_release_ledger "failed" "critical_health"
  rollback_and_record "critical_health" || true
  echo "Rollback attempted. If db-migrate already applied DDL, follow the database recovery runbook before retrying."
  exit 1
elif [ "${HEALTH_STATUS}" -eq 3 ]; then
  docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  dump_nonhealthy_container_logs "post-required-health-failure"
  echo "::error::Required service health check failed. Initiating journaled rollback."
  record_release_ledger "failed" "required_health"
  rollback_and_record "required_health" || true
  exit 1
elif [ "${HEALTH_STATUS}" -ne 0 ]; then
  docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  dump_nonhealthy_container_logs "post-health-invocation-failure"
  echo "::error::Service health check could not run (exit ${HEALTH_STATUS}). Initiating journaled rollback."
  record_release_ledger "failed" "health_gate_invocation"
  rollback_and_record "health_gate_invocation" || true
  exit 1
fi

# ADR-016 Phase F / WS7 — boot-signal assertion. "Healthy"
# is necessary but not sufficient for deploy success — a
# service can be healthy while silently skipping NATS mTLS,
# schema-drift scan, or migration runner. This step greps
# `docker compose logs` for canonical signal strings
# declared in required-signals.yaml. Missing signal =
# failed deploy = rollback.
echo "=== Asserting boot signals ==="
if ! COMPOSE_FILE=docker-compose.droplet.yml \
     MANIFEST=infrastructure/deploy/required-signals.yaml \
     POLL_INTERVAL=10 \
     "${AQUA_PRODUCTION_NODE_BIN:?production host Node authority missing}" \
       "${DEPLOY_SOURCE_DIR}/runtime/assert-service-signals.mjs"; then
  echo "::error::Boot signal assertion failed. Initiating rollback."
  record_release_ledger "failed" "boot_signal"
  rollback_and_record "boot_signal" || true
  echo "Rollback attempted. If db-migrate already applied DDL, follow the database recovery runbook before retrying."
  exit 1
fi

if ! run_readiness_sweep; then
  echo "::error::Readiness sweep failed. Initiating rollback."
  record_release_ledger "failed" "readiness"
  rollback_and_record "readiness" || true
  exit 1
fi

if ! verify_release_ledger_sql; then
  echo "::error::Release SQL verification failed. Initiating rollback."
  record_release_ledger "failed" "release_sql"
  rollback_and_record "release_sql" || true
  exit 1
fi

# Pre-promotion public-path smoke THROUGH nginx — the gate the app.suderra.com outage
# slipped past. Every container can be "healthy" (and boot-signals/readiness can pass)
# while nginx→gateway still returns 502: a subgraph being down means the supergraph never
# composes and the gateway never serves /graphql. Assert the REAL public path returns
# valid GraphQL JSON before promoting; a 502/HTML body rolls the deploy back.
echo "=== Public /graphql smoke through nginx ==="
SMOKE_HOST="${PUBLIC_SMOKE_HOST:-app.suderra.com}"
# Exercise the REAL https public path. Was http://localhost, which nginx
# 301-redirects http→https, so the smoke saw a 301 (not GraphQL JSON) and
# false-failed every deploy. Default to https on the public host, pinned to the
# local nginx via --resolve so it tests the exact public TLS path (valid cert,
# SNI, Host) without depending on external DNS. -L/--post301/--post302 also
# re-POST through a redirect if PUBLIC_SMOKE_ORIGIN is overridden back to http.
SMOKE_ORIGIN="${PUBLIC_SMOKE_ORIGIN:-https://${SMOKE_HOST}}"
SMOKE_RESOLVE="${PUBLIC_SMOKE_RESOLVE:-${SMOKE_HOST}:443:127.0.0.1}"
smoke_out="$(curl -sS -m 15 -L --post301 --post302 --resolve "${SMOKE_RESOLVE}" -w $'\n%{http_code}' \
  -H "Host: ${SMOKE_HOST}" -H 'Content-Type: application/json' \
  -X POST --data '{"query":"{ __typename }"}' "${SMOKE_ORIGIN}/graphql" || true)"
smoke_code="$(printf '%s' "${smoke_out}" | tail -n1)"
smoke_body="$(printf '%s' "${smoke_out}" | sed '$d')"
if [ "${smoke_code}" != "200" ] || \
   ! printf '%s' "${smoke_body}" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("data",{}).get("__typename") else 1)' 2>/dev/null; then
  echo "::error::Public POST /graphql smoke failed through nginx (HTTP ${smoke_code}; body is not GraphQL JSON). The gateway is not serving public traffic — a subgraph is likely down. Initiating rollback."
  record_release_ledger "failed" "public_graphql_smoke"
  rollback_and_record "public_graphql_smoke" || true
  exit 1
fi
echo "  Public /graphql smoke passed (HTTP 200, valid GraphQL JSON)."
capture_release_container_attestation
case "${DEPLOY_TRANSACTION_PHASE:-}" in
    LIVE_CANDIDATE)
      release_transaction_transition LIVE_CANDIDATE LIVE_VERIFIED preserve ''
      ;;
    FORWARD_REQUIRED)
      release_transaction_transition FORWARD_REQUIRED LIVE_VERIFIED preserve ''
      ;;
  LIVE_VERIFIED|FINALIZING)
    # Exact-candidate recovery reruns all live gates before resuming the
    # already-durable finalization phase.
    ;;
  *)
    echo "::error::Release reached promotion gates from an invalid transaction phase." >&2
    exit 1
    ;;
esac

# BEGIN production-release-finalization
finalize_production_release() {
  local current_release_manifest_hash

  if [ ! -s "${DEPLOY_IMAGE_DIGESTS_FILE}" ]; then
    echo "::error::Cannot publish current-release proof without the deploy image digest manifest."
    return 1
  fi
  current_release_manifest_hash=$(sha256sum --binary \
    "${DEPLOY_IMAGE_DIGESTS_FILE}" | awk '{print $1}') || return
  if [[ ! "${current_release_manifest_hash}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "::error::Deploy image digest manifest hash is not canonical."
    return 1
  fi

  case "${DEPLOY_TRANSACTION_PHASE:-}" in
    LIVE_VERIFIED)
      release_transaction_transition LIVE_VERIFIED FINALIZING preserve '' || return
      ;;
    FINALIZING) ;;
    *)
      echo "::error::Release finalization entered from an invalid transaction phase." >&2
      return 1
      ;;
  esac
  record_release_ledger "promoted" "" "true" || return
  release_transaction_transition FINALIZING LEDGER_PROMOTED preserve '' || return
  publish_deploy_current_release \
    "${DEPLOY_SHA}" "${DEPLOY_RELEASE_ID}" "${current_release_manifest_hash}" || return
  assert_deploy_current_release \
    "${DEPLOY_SHA}" "${DEPLOY_RELEASE_ID}" "${current_release_manifest_hash}" || return
  capture_release_container_attestation || return
  verify_release_ledger_sql || return
  release_transaction_transition LEDGER_PROMOTED COMMITTED preserve ''
}
# END production-release-finalization

finalize_production_release
