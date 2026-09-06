#!/bin/bash -p
# Provider-console executor for the signed PostgreSQL DR bootstrap candidate.
# It has one mutation authority: recreate the existing `postgres` Compose
# service from one verified OCI digest. It neither authenticates to GitHub nor
# invokes the repository's application deployment path.

set -euo pipefail
IFS=$'\n\t'
umask 077

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

[ "$#" -eq 0 ] || die 'The provider-console bootstrap does not accept arguments.'

# Re-exec once with only the operator coordinates needed by this executor. This
# prevents inherited Compose interpolation, Docker context, Bash startup, and
# credential variables from crossing the privileged mutation boundary.
if [ "${DR_BOOTSTRAP_CLEAN_ENVIRONMENT:-}" != aqua/postgres-dr-bootstrap/v1 ]; then
  EXECUTOR_PATH=$(/usr/bin/readlink -f -- "${BASH_SOURCE[0]}") || \
    die 'The provider-console executor path cannot be resolved.'
  exec /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LC_ALL=C \
    HOME=/root \
    DR_BOOTSTRAP_CLEAN_ENVIRONMENT=aqua/postgres-dr-bootstrap/v1 \
    RELEASE_ROOT="${RELEASE_ROOT-}" \
    EXPECTED_MAIN_SHA="${EXPECTED_MAIN_SHA-}" \
    EXPECTED_IMAGE_DIGEST="${EXPECTED_IMAGE_DIGEST-}" \
    EXPECTED_RUN_ID="${EXPECTED_RUN_ID-}" \
    EXPECTED_RUN_ATTEMPT="${EXPECTED_RUN_ATTEMPT-}" \
    DR_BOOTSTRAP_MODE="${DR_BOOTSTRAP_MODE:-healthy_upgrade}" \
    /bin/bash -p "${EXECUTOR_PATH}"
fi

while IFS='=' read -r environment_name _; do
  case "${environment_name}" in
    PATH | LC_ALL | HOME | DR_BOOTSTRAP_CLEAN_ENVIRONMENT | \
      RELEASE_ROOT | EXPECTED_MAIN_SHA | EXPECTED_IMAGE_DIGEST | \
      EXPECTED_RUN_ID | EXPECTED_RUN_ATTEMPT | DR_BOOTSTRAP_MODE | PWD | SHLVL | _) ;;
    *) die "Unexpected inherited environment variable: ${environment_name}" ;;
  esac
done < <(/usr/bin/env)
unset DR_BOOTSTRAP_CLEAN_ENVIRONMENT
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
export HOME=/root
unset BASH_ENV ENV CDPATH GLOBIGNORE SSH_AUTH_SOCK
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY
unset DOCKER_API_VERSION DOCKER_CONTENT_TRUST COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES
unset COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES COMPOSE_MENU COMPOSE_PARALLEL_LIMIT
unset COMPOSE_ANSI COMPOSE_PROGRESS COMPOSE_STATUS_STDOUT COMPOSE_IGNORE_ORPHANS
export DOCKER_HOST=unix:///var/run/docker.sock

require_canonical_absolute_path() {
  local path_value=$1
  case "${path_value}" in
    / | */ | *//* | *$'\n'* | *$'\r'*)
      die 'A required path is not canonical.'
      ;;
    /*) ;;
    *) die 'A required path is not absolute.' ;;
  esac
  case "/${path_value#/}/" in
    */./* | */../*) die 'A required path contains a dot component.' ;;
  esac
}

require_compose_safe_absolute_path() {
  local path_value=$1
  require_canonical_absolute_path "${path_value}"
  [[ "${path_value}" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
    die 'A Compose-authoritative path contains a forbidden metacharacter.'
}

require_root_owned_nonwritable_file() {
  local file_path=$1
  local mode
  [ -f "${file_path}" ] || die "Required release file is missing: ${file_path}"
  [ ! -L "${file_path}" ] || die "Release file must not be a symlink: ${file_path}"
  [ "$(stat -c '%u' "${file_path}")" -eq 0 ] || \
    die "Release file must be owned by root: ${file_path}"
  mode=$(stat -c '%a' "${file_path}")
  (( (8#${mode} & 8#022) == 0 )) || \
    die "Release file must not be group/world writable: ${file_path}"
}

require_root_owned_nonwritable_directory() {
  local directory_path=$1
  local mode
  [ -d "${directory_path}" ] || die "Required directory is missing: ${directory_path}"
  [ ! -L "${directory_path}" ] || die "Directory must not be a symlink: ${directory_path}"
  [ "$(stat -c '%u' "${directory_path}")" -eq 0 ] || \
    die "Directory must be owned by root: ${directory_path}"
  mode=$(stat -c '%a' "${directory_path}")
  (( (8#${mode} & 8#022) == 0 )) || \
    die "Directory must not be group/world writable: ${directory_path}"
}

resolve_root_owned_nonwritable_directory_chain() {
  local requested_path=$1
  local resolved_path
  local current_path=''
  local component
  local -a components
  resolved_path=$(readlink -e -- "${requested_path}") || \
    die "Directory chain cannot be resolved: ${requested_path}"
  require_canonical_absolute_path "${resolved_path}"
  require_root_owned_nonwritable_directory /
  IFS='/' read -r -a components <<< "${resolved_path#/}"
  for component in "${components[@]}"; do
    [ -n "${component}" ] || die 'Resolved directory chain contains an empty component.'
    current_path="${current_path}/${component}"
    require_root_owned_nonwritable_directory "${current_path}"
  done
  printf '%s' "${resolved_path}"
}

require_unchanged_directory_identity() {
  local directory_path=$1
  local expected_identity=$2
  local boundary_name=$3
  local resolved_path
  resolved_path=$(resolve_root_owned_nonwritable_directory_chain "${directory_path}")
  [ "${resolved_path}" = "${directory_path}" ] || \
    die "${boundary_name} directory no longer resolves to the authorized path."
  [ "$(stat -c '%d:%i' "${directory_path}")" = "${expected_identity}" ] || \
    die "${boundary_name} directory identity changed before mutation."
}

require_unchanged_symlink_target() {
  local symlink_path=$1
  local expected_target=$2
  local boundary_name=$3
  local resolved_target
  [ -L "${symlink_path}" ] || die "${boundary_name} is no longer a symlink."
  [ "$(stat -c '%u' -- "${symlink_path}")" -eq 0 ] || \
    die "${boundary_name} symlink is no longer owned by root."
  resolved_target=$(readlink -e -- "${symlink_path}") || \
    die "${boundary_name} symlink target cannot be resolved."
  [ "${resolved_target}" = "${expected_target}" ] || \
    die "${boundary_name} symlink target changed before mutation."
}

wait_for_postgres_health() {
  local container_id=$1
  local deadline=$((SECONDS + 180))
  local state
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    state=$(docker inspect --format \
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "${container_id}" 2>/dev/null || true)
    case "${state}" in
      healthy) return 0 ;;
      unhealthy | exited | dead) return 1 ;;
    esac
    sleep 5
  done
  return 1
}

for required_command in \
  awk base64 chmod chown cmp cosign cp date diff docker find flock id install jq mkdir mktemp mv tar \
  readlink rm sha256sum sleep stat sync timeout du df tail tr xargs sort; do
  command -v "${required_command}" >/dev/null 2>&1 || \
    die "Required command is unavailable: ${required_command}"
done

[ "$(id -u)" -eq 0 ] || die 'The provider-console bootstrap must run as root.'

COSIGN_PATH=$(command -v cosign)
[ "${COSIGN_PATH}" = /usr/local/bin/cosign ] || \
  die 'The provider-console bootstrap requires cosign at /usr/local/bin/cosign.'
require_root_owned_nonwritable_file "${COSIGN_PATH}"
COSIGN_PARENT=${COSIGN_PATH%/*}
[ "$(resolve_root_owned_nonwritable_directory_chain "${COSIGN_PARENT}")" = \
  "${COSIGN_PARENT}" ] || die 'The cosign binary parent path is not canonical.'
[ "$(cosign version 2>/dev/null | awk '$1 == "GitVersion:" {print $2}')" = v3.0.6 ] || \
  die 'The provider-console bootstrap requires cosign v3.0.6.'
[ "$(sha256sum --binary "${COSIGN_PATH}" | awk '{print $1}')" = \
  c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74 ] || \
  die 'The provider-console cosign binary does not match the v3.0.6 linux-amd64 release.'

RELEASE_ROOT=${RELEASE_ROOT:?RELEASE_ROOT is required}
EXPECTED_MAIN_SHA=${EXPECTED_MAIN_SHA:?EXPECTED_MAIN_SHA is required}
EXPECTED_IMAGE_DIGEST=${EXPECTED_IMAGE_DIGEST:?EXPECTED_IMAGE_DIGEST is required}
EXPECTED_RUN_ID=${EXPECTED_RUN_ID:?EXPECTED_RUN_ID is required}
EXPECTED_RUN_ATTEMPT=${EXPECTED_RUN_ATTEMPT:?EXPECTED_RUN_ATTEMPT is required}
DEPLOY_ROOT="${RELEASE_ROOT}/repository"
DR_BOOTSTRAP_MODE=${DR_BOOTSTRAP_MODE:-healthy_upgrade}
case "${DR_BOOTSTRAP_MODE}" in healthy_upgrade|degraded_legacy_recovery) ;; *) die "Invalid recovery mode." ;; esac
DEPLOY_ENV_FILE=/var/aqua-saas/.env
CERTS_SEED_ROOT=/var/aqua-saas/certs
if [ -f /var/lib/aqua/deploy/config-generations/current ]; then
  [ ! -L /var/lib/aqua/deploy/config-generations/current ] || die 'Config generation pointer must not be a symlink.'
  [ "$(stat -c '%u:%a:%h' /var/lib/aqua/deploy/config-generations/current)" = '0:400:1' ] || die 'Config generation pointer is unsafe.'
  PRIOR_CONFIG_GENERATION=$(cat /var/lib/aqua/deploy/config-generations/current)
  [[ "${PRIOR_CONFIG_GENERATION}" =~ ^[0-9a-f]{40}/[1-9][0-9]*-[1-9][0-9]*$ ]] || die 'Config generation key is invalid.'
  DEPLOY_ENV_FILE="/var/lib/aqua/deploy/config-generations/${PRIOR_CONFIG_GENERATION}/.env"
  CERTS_SEED_ROOT="/var/lib/aqua/deploy/config-generations/${PRIOR_CONFIG_GENERATION}/certs"
fi
STATE_ROOT=/var/lib/aqua/deploy/dr-bootstrap
CONTROL_PLANE_LOCK_PATH=/var/lib/aqua/deploy/control-plane.lock
PUBLIC_DOCKER_CONFIG_ROOT=/etc/aqua/dr-bootstrap-public-registry
PUBLIC_DOCKER_CONFIG_PATH="${PUBLIC_DOCKER_CONFIG_ROOT}/config.json"

require_compose_safe_absolute_path "${RELEASE_ROOT}"
require_canonical_absolute_path "${DEPLOY_ROOT}"
require_canonical_absolute_path "${DEPLOY_ENV_FILE}"
require_canonical_absolute_path "${STATE_ROOT}"
require_canonical_absolute_path "${CONTROL_PLANE_LOCK_PATH}"
[[ "${EXPECTED_MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]] || \
  die 'EXPECTED_MAIN_SHA must be a lowercase 40-character SHA.'
[[ "${EXPECTED_IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
  die 'EXPECTED_IMAGE_DIGEST must be a canonical sha256 digest.'
[[ "${EXPECTED_RUN_ID}" =~ ^[1-9][0-9]*$ ]] || \
  die 'EXPECTED_RUN_ID must be a positive integer.'
[[ "${EXPECTED_RUN_ATTEMPT}" =~ ^[1-9][0-9]*$ ]] || \
  die 'EXPECTED_RUN_ATTEMPT must be a positive integer.'
# TAG exists only to satisfy interpolation in the signed production Compose
# file. The run-scoped digest override remains the sole image authority.
export TAG="${EXPECTED_MAIN_SHA}"
[ -d "${RELEASE_ROOT}" ] || die 'RELEASE_ROOT does not exist.'
[ ! -L "${RELEASE_ROOT}" ] || die 'RELEASE_ROOT must not be a symlink.'
REQUESTED_RELEASE_ROOT=${RELEASE_ROOT}
RELEASE_ROOT=$(resolve_root_owned_nonwritable_directory_chain "${REQUESTED_RELEASE_ROOT}")
[ "${RELEASE_ROOT}" = "${REQUESTED_RELEASE_ROOT}" ] || \
  die 'RELEASE_ROOT must not traverse a symlink.'
RELEASE_ROOT_ID=$(stat -c '%d:%i' "${RELEASE_ROOT}")
[ -d "${DEPLOY_ROOT}" ] || die 'The production deploy root does not exist.'
[ ! -L "${DEPLOY_ROOT}" ] || die 'The production deploy root must not be a symlink.'
REQUESTED_DEPLOY_ROOT=${DEPLOY_ROOT}
DEPLOY_ROOT=$(resolve_root_owned_nonwritable_directory_chain "${REQUESTED_DEPLOY_ROOT}")
[ "${DEPLOY_ROOT}" = "${REQUESTED_DEPLOY_ROOT}" ] || \
  die 'The production deploy root must not traverse a symlink.'
DEPLOY_ROOT_ID=$(stat -c '%d:%i' "${DEPLOY_ROOT}")
[ -f "${DEPLOY_ENV_FILE}" ] || die 'The production environment file does not exist.'
[ ! -L "${DEPLOY_ENV_FILE}" ] || die 'The production environment file must not be a symlink.'
REQUESTED_DEPLOY_ENV_FILE=${DEPLOY_ENV_FILE}
DEPLOY_ENV_FILE=$(readlink -e -- "${DEPLOY_ENV_FILE}") || \
  die 'The production environment file cannot be resolved.'
[ "${DEPLOY_ENV_FILE}" = "${REQUESTED_DEPLOY_ENV_FILE}" ] || \
  die 'The production environment file must not traverse an ancestor symlink.'
DEPLOY_ENV_PARENT=${DEPLOY_ENV_FILE%/*}
[ "$(resolve_root_owned_nonwritable_directory_chain "${DEPLOY_ENV_PARENT}")" = \
  "${DEPLOY_ENV_PARENT}" ] || die 'The production environment parent path is not canonical.'
require_root_owned_nonwritable_file "${DEPLOY_ENV_FILE}"
DEPLOY_ENV_FILE_ID=$(stat -c '%d:%i' "${DEPLOY_ENV_FILE}")
CERTS_LINK_PATH=${CERTS_SEED_ROOT}
CERTS_REAL_ROOT=$(resolve_root_owned_nonwritable_directory_chain "${CERTS_LINK_PATH}")
CERTS_REAL_ROOT_ID=$(stat -c '%d:%i' "${CERTS_REAL_ROOT}")
WALG_SECRET_DIR=$(resolve_root_owned_nonwritable_directory_chain \
  "${CERTS_LINK_PATH}/wal-g/postgres")
WALG_SECRET_DIR_ID=$(stat -c '%d:%i' "${WALG_SECRET_DIR}")
STATE_ROOT_PARENT=${STATE_ROOT%/*}
STATE_ROOT_NAME=${STATE_ROOT##*/}
[ -n "${STATE_ROOT_NAME}" ] || die 'STATE_ROOT must have a directory name.'
REQUESTED_STATE_ROOT_PARENT=${STATE_ROOT_PARENT}
STATE_ROOT_PARENT=$(resolve_root_owned_nonwritable_directory_chain \
  "${REQUESTED_STATE_ROOT_PARENT}")
[ "${STATE_ROOT_PARENT}" = "${REQUESTED_STATE_ROOT_PARENT}" ] || \
  die 'STATE_ROOT parent must not traverse a symlink.'
STATE_ROOT_PARENT_ID=$(stat -c '%d:%i' "${STATE_ROOT_PARENT}")
STATE_ROOT="${STATE_ROOT_PARENT}/${STATE_ROOT_NAME}"
[ ! -L "${STATE_ROOT}" ] || die 'STATE_ROOT must not be a symlink.'
[ "${CONTROL_PLANE_LOCK_PATH}" = "${STATE_ROOT_PARENT}/control-plane.lock" ] || \
  die 'The shared control-plane lock is not under the pinned deploy state parent.'
REQUESTED_PUBLIC_DOCKER_CONFIG_ROOT=${PUBLIC_DOCKER_CONFIG_ROOT}
PUBLIC_DOCKER_CONFIG_ROOT=$(resolve_root_owned_nonwritable_directory_chain \
  "${REQUESTED_PUBLIC_DOCKER_CONFIG_ROOT}")
[ "${PUBLIC_DOCKER_CONFIG_ROOT}" = "${REQUESTED_PUBLIC_DOCKER_CONFIG_ROOT}" ] || \
  die 'The public-registry Docker config path must not traverse a symlink.'
PUBLIC_DOCKER_CONFIG_PATH="${PUBLIC_DOCKER_CONFIG_ROOT}/config.json"
require_root_owned_nonwritable_file "${PUBLIC_DOCKER_CONFIG_PATH}"
jq --exit-status \
  'type == "object" and keys == ["auths"] and .auths == {}' \
  "${PUBLIC_DOCKER_CONFIG_PATH}" >/dev/null || \
  die 'The DR bootstrap Docker config must contain no registry credentials.'
PUBLIC_DOCKER_CONFIG_ROOT_ID=$(stat -c '%d:%i' "${PUBLIC_DOCKER_CONFIG_ROOT}")
export DOCKER_CONFIG="${PUBLIC_DOCKER_CONFIG_ROOT}"

CANDIDATE_PATH="${RELEASE_ROOT}/candidate.json"
CANDIDATE_BUNDLE_PATH="${RELEASE_ROOT}/candidate.json.sigstore.json"
AUTHORITY_PATH="${RELEASE_ROOT}/release-authority.json"
AUTHORITY_BUNDLE_PATH="${RELEASE_ROOT}/release-authority.json.sigstore.json"
POLICY_RELATIVE_PATH=.github/manifests/postgres-dr-bootstrap-policy.json
POLICY_PATH="${RELEASE_ROOT}/repository/${POLICY_RELATIVE_PATH}"
REQUIRED_CHECKS_RELATIVE_PATH=.github/manifests/main-required-status-checks.json
REQUIRED_CHECKS_PATH="${RELEASE_ROOT}/repository/${REQUIRED_CHECKS_RELATIVE_PATH}"
REQUIRED_CHECK_SELECTOR_RELATIVE_PATH=.github/scripts/select-effective-required-check.jq
REQUIRED_CHECK_SELECTOR_PATH="${RELEASE_ROOT}/repository/${REQUIRED_CHECK_SELECTOR_RELATIVE_PATH}"
SIGNED_COMPOSE_PATH="${RELEASE_ROOT}/repository/docker-compose.droplet.yml"
SIGNED_ROLLBACK_COMPOSE_PATH="${RELEASE_ROOT}/repository/infrastructure/deploy/postgres-dr-bootstrap-rollback.override.yml"
SIGNED_EXECUTOR_PATH="${RELEASE_ROOT}/repository/infrastructure/scripts/provider-console-bootstrap-postgres-walg.sh"
SIGNED_STATE_HELPER_PATH="${RELEASE_ROOT}/repository/infrastructure/scripts/postgres-dr-bootstrap-state.sh"
SIGNED_RECOVERY_HELPER_PATH="${RELEASE_ROOT}/repository/infrastructure/scripts/postgres-dr-recovery.sh"
SIGNED_INIT_DIRECTORY="${RELEASE_ROOT}/repository/infrastructure/docker/init-scripts"
SIGNED_INIT_DATABASES_PATH="${SIGNED_INIT_DIRECTORY}/01-init-databases.sql"
DR_CONTRACT_PATH="${RELEASE_ROOT}/repository/.github/manifests/postgres-dr-contract.sha256"
WORKFLOW_PATH=.github/workflows/postgres-dr-bootstrap-candidate.yml
IDENTITY="https://github.com/Okan-wqm/aquaculture_platform/${WORKFLOW_PATH}@refs/heads/main"
IMAGE_REPOSITORY=ghcr.io/okan-wqm/aquaculture_platform/postgres
IMAGE_REF="${IMAGE_REPOSITORY}@${EXPECTED_IMAGE_DIGEST}"

for release_file in \
  "${CANDIDATE_PATH}" \
  "${CANDIDATE_BUNDLE_PATH}" \
  "${AUTHORITY_PATH}" \
  "${AUTHORITY_BUNDLE_PATH}" \
  "${POLICY_PATH}" \
  "${REQUIRED_CHECKS_PATH}" \
  "${REQUIRED_CHECK_SELECTOR_PATH}" \
  "${SIGNED_COMPOSE_PATH}" \
  "${SIGNED_ROLLBACK_COMPOSE_PATH}" \
  "${SIGNED_EXECUTOR_PATH}" \
  "${SIGNED_STATE_HELPER_PATH}" \
  "${SIGNED_RECOVERY_HELPER_PATH}" \
  "${SIGNED_INIT_DATABASES_PATH}" \
  "${DR_CONTRACT_PATH}"; do
  require_root_owned_nonwritable_file "${release_file}"
done
[ -z "$(find "${RELEASE_ROOT}" -type l -print -quit)" ] || \
  die 'The signed release must not contain symlinks.'
while IFS= read -r -d '' release_directory; do
  require_root_owned_nonwritable_directory "${release_directory}"
done < <(find "${RELEASE_ROOT}" -type d -print0)

# The operator verifies candidate.json and this script before privileged
# execution. The executor repeats both Sigstore checks so later file
# replacement cannot cross the mutation boundary.
for subject in candidate.json release-authority.json; do
  cosign verify-blob \
    --bundle "${RELEASE_ROOT}/${subject}.sigstore.json" \
    --certificate-identity "${IDENTITY}" \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --certificate-github-workflow-repository 'Okan-wqm/aquaculture_platform' \
    --certificate-github-workflow-ref 'refs/heads/main' \
    --certificate-github-workflow-sha "${EXPECTED_MAIN_SHA}" \
    --certificate-github-workflow-trigger 'workflow_dispatch' \
    --certificate-github-workflow-name 'PostgreSQL DR Bootstrap Candidate' \
    "${RELEASE_ROOT}/${subject}" >/dev/null
done

jq --exit-status \
  --arg main_sha "${EXPECTED_MAIN_SHA}" \
  --arg run_id "${EXPECTED_RUN_ID}" \
  --arg run_attempt "${EXPECTED_RUN_ATTEMPT}" \
  --arg image_digest "${EXPECTED_IMAGE_DIGEST}" \
  --arg image_ref "${IMAGE_REF}" \
  '
    .schema_version == 1 and
    .predicate_type == "https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-candidate/v1" and
    .source == {
      repository: "Okan-wqm/aquaculture_platform",
      ref: "refs/heads/main",
      main_sha: $main_sha
    } and
    .build.workflow == ".github/workflows/postgres-dr-bootstrap-candidate.yml" and
    .build.workflow_ref ==
      ("Okan-wqm/aquaculture_platform/" + .build.workflow + "@refs/heads/main") and
    .build.workflow_sha == $main_sha and
    .build.run_id == $run_id and
    .build.run_attempt == $run_attempt and
    .image.repository == "ghcr.io/okan-wqm/aquaculture_platform/postgres" and
    .image.digest == $image_digest and
    .image.reference == $image_ref and
    .image.immutable_tag == ($main_sha + "-" + $run_id + "-" + $run_attempt) and
    .bootstrap == {
      channel: "provider-console",
      compose_project: "aqua-saas",
      allowed_compose_services: ["postgres"]
    }
  ' "${CANDIDATE_PATH}" >/dev/null || die 'Candidate coordinates do not match operator authorization.'

jq --exit-status \
  --arg policy_path "${POLICY_RELATIVE_PATH}" \
  --arg required_checks_path "${REQUIRED_CHECKS_RELATIVE_PATH}" \
  --arg required_check_selector_path "${REQUIRED_CHECK_SELECTOR_RELATIVE_PATH}" \
  --arg workflow_path "${WORKFLOW_PATH}" \
  --arg executor_path 'infrastructure/scripts/provider-console-bootstrap-postgres-walg.sh' \
  --arg state_helper_path 'infrastructure/scripts/postgres-dr-bootstrap-state.sh' \
  --arg compose_path 'docker-compose.droplet.yml' \
  --arg rollback_path 'infrastructure/deploy/postgres-dr-bootstrap-rollback.override.yml' \
  --arg init_databases_path 'infrastructure/docker/init-scripts/01-init-databases.sql' \
  '
    (.materials | length) == (.materials | map(.path) | unique | length) and
    (.materials | length) == (.materials | map(.role) | unique | length) and
    any(.materials[]; .role == "policy" and .path == $policy_path) and
    any(.materials[]; .role == "required-checks" and .path == $required_checks_path) and
    any(.materials[];
      .role == "required-check-selector" and .path == $required_check_selector_path) and
    any(.materials[]; .role == "release-workflow" and .path == $workflow_path) and
    any(.materials[]; .role == "provider-console-bootstrap" and .path == $executor_path) and
    any(.materials[]; .role == "provider-state-machine" and .path == $state_helper_path) and
    any(.materials[]; .role == "provider-recovery-point" and .path == "infrastructure/scripts/postgres-dr-recovery.sh") and
    any(.materials[]; .role == "production-compose" and .path == $compose_path) and
    any(.materials[]; .role == "postgres-rollback-compose" and .path == $rollback_path) and
    any(.materials[];
      .role == "postgres-init-databases" and .path == $init_databases_path)
  ' "${CANDIDATE_PATH}" >/dev/null || \
  die 'Candidate does not bind every privileged provider-console material.'

jq --exit-status \
  --arg main_sha "${EXPECTED_MAIN_SHA}" \
  --arg run_id "${EXPECTED_RUN_ID}" \
  --arg run_attempt "${EXPECTED_RUN_ATTEMPT}" \
  --arg image_digest "${EXPECTED_IMAGE_DIGEST}" \
  --arg workflow_path "${WORKFLOW_PATH}" \
  --arg workflow_ref "Okan-wqm/aquaculture_platform/${WORKFLOW_PATH}@refs/heads/main" \
  --arg required_checks_path "${REQUIRED_CHECKS_RELATIVE_PATH}" \
  --arg required_checks_sha256 "$(sha256sum --binary "${REQUIRED_CHECKS_PATH}" | awk '{print $1}')" \
  --slurpfile required_manifest "${REQUIRED_CHECKS_PATH}" \
  '
    .schema_version == 1 and
    .predicate_type == "https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-release-authority/v1" and
    .repository == "Okan-wqm/aquaculture_platform" and
    .ref == "refs/heads/main" and
    .ref_protected == true and
    .branch_protection == {
      enforce_admins: $required_manifest[0].branch_protection.enforce_admins,
      strict: $required_manifest[0].required_status_checks.strict,
      contexts: ($required_manifest[0].required_status_checks.contexts | sort),
      checks: ($required_manifest[0].required_status_checks.checks |
        sort_by(.context, .app_id))
    } and
    .main_sha == $main_sha and
    .run_id == $run_id and
    .run_attempt == $run_attempt and
    .image_digest == $image_digest and
    .dispatch_workflow == {
      path: $workflow_path,
      ref: $workflow_ref,
      sha: $main_sha
    } and
    .signing_environment == "production-backup-release" and
    .signing_environment_protection.name == "production-backup-release" and
    .signing_environment_protection.can_admins_bypass == false and
    .signing_environment_protection.prevent_self_review == true and
    (.signing_environment_protection.reviewers | length) >= 2 and
    ([.signing_environment_protection.reviewers[] | (.type + ":" + (.id | tostring))] |
      unique | length) == (.signing_environment_protection.reviewers | length) and
    all(.signing_environment_protection.reviewers[];
      (.type == "User" or .type == "Team") and
      (.id | type) == "number" and .id > 0 and
      (.name | type) == "string" and (.name | length) > 0) and
    .signing_environment_protection.deployment_branch_policies == [
      {name: "main", type: "branch"}
    ] and
    .required_checks_manifest == {
      path: $required_checks_path,
      sha256: $required_checks_sha256
    } and
    ($required_manifest[0].schema_version == 1) and
    ($required_manifest[0].repository == "Okan-wqm/aquaculture_platform") and
    ($required_manifest[0].branch == "main") and
    ($required_manifest[0].branch_protection.enforce_admins == true) and
    ($required_manifest[0].required_status_checks.strict == true) and
    ($required_manifest[0].required_status_checks.contexts | length) > 0 and
    ($required_manifest[0].required_status_checks.contexts | length) ==
      ($required_manifest[0].required_status_checks.contexts | unique | length) and
    ($required_manifest[0].required_status_checks.checks |
      sort_by(.context, .app_id) |
      map(.context)) ==
      ($required_manifest[0].required_status_checks.contexts | sort) and
    all($required_manifest[0].required_status_checks.checks[];
      (.app_id | type) == "number" and .app_id > 0) and
    .pull_request.head_sha != .pull_request.merge_commit_sha and
    .pull_request.merge_commit_sha == $main_sha and
    (.pull_request.merged_at | fromdateiso8601 | type) == "number" and
    (.required_checks | length) ==
      ($required_manifest[0].required_status_checks.contexts | length) and
    ([.required_checks[].name] | sort) ==
      ($required_manifest[0].required_status_checks.contexts | sort) and
    (. as $authority |
    all($authority.required_checks[];
      . as $check |
      ($check.details_url | capture(
        "^https://github.com/Okan-wqm/aquaculture_platform/actions/runs/(?<run>[1-9][0-9]*)/job/(?<job>[1-9][0-9]*)$"
      )) as $details |
      $check.status == "completed" and $check.conclusion == "success" and
      $check.head_sha == $authority.pull_request.head_sha and
      ($check.app_id | type) == "number" and
      ([$required_manifest[0].required_status_checks.checks[] |
        select(.context == $check.name) | .app_id]) == [$check.app_id] and
      ($check.created_at | fromdateiso8601) <=
        ($authority.pull_request.merged_at | fromdateiso8601) and
      ($check.started_at | fromdateiso8601) <=
        ($authority.pull_request.merged_at | fromdateiso8601) and
      ($check.completed_at | fromdateiso8601) <=
        ($authority.pull_request.merged_at | fromdateiso8601) and
      ($check.workflow_job_id | type) == "number" and
      $check.workflow_job_id == $check.id and
      ($details.job | tonumber) == $check.workflow_job_id and
      ($check.workflow_run_id | type) == "number" and $check.workflow_run_id > 0 and
      ($details.run | tonumber) == $check.workflow_run_id and
      ($check.workflow_run_attempt | type) == "number" and
        $check.workflow_run_attempt > 0 and
      (
        $check.name as $check_name |
        $check.workflow_path as $check_workflow_path |
        any($required_manifest[0].workflow_contracts[];
          .workflow == $check_workflow_path and
          any(.contexts[]; .context == $check_name))
      )))
  ' "${AUTHORITY_PATH}" >/dev/null || die 'Release authority does not match the candidate.'

jq --exit-status \
  '
    .schema_version == 2 and
    .finding_ids == ["INFRA-HIGH-073"] and
    .does_not_close_findings == ["INFRA-HIGH-033"] and
    .release.workflow == ".github/workflows/postgres-dr-bootstrap-candidate.yml" and
    .release.event == "workflow_dispatch" and
    .release.ref == "refs/heads/main" and
    .release.signing_environment == "production-backup-release" and
    .release.live_environment_authority_snapshot_required == true and
    .release.live_branch_protection_snapshot_required == true and
    .release.required_check_selector ==
      ".github/scripts/select-effective-required-check.jq" and
    .release.required_check_effective_order ==
      "created_at_then_id_as_of_merge" and
    .release.required_check_creation_authority == "actions_job.created_at" and
    .release.required_check_workflow_path_binding == true and
    .release.required_check_job_attempt_binding == true and
    .release.cosign_version == "v3.0.6" and
    .release.cosign_linux_amd64_sha256 ==
      "c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74" and
    .release.candidate_predicate_type ==
      "https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-candidate/v1" and
    .release.authority_predicate_type ==
      "https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-release-authority/v1" and
    .release.signing_environment_protection == {
      can_admins_bypass: false,
      prevent_self_review: true,
      minimum_reviewers: 2,
      deployment_branch: "main"
    } and
    .release.mutable_tags == [] and
    .build_boundary.production_secrets == [] and
    .build_boundary.ssh_enabled == false and
    .build_boundary.deployment_enabled == false and
    .bootstrap.channel == "provider-console" and
    .bootstrap.allowed_compose_services == ["postgres"] and
    .bootstrap.compose_interpolation_tag_source == "expected_main_sha" and
    .bootstrap.legacy_github_ssh_enabled == false and
    .bootstrap.requires_production_deploy_unlock == false and
    .bootstrap.repository_variable_mutation_enabled == false and
    .bootstrap.tag_mutation_enabled == false and
    .bootstrap.pre_execution_signature_verification_required == true and
    .bootstrap.global_nonblocking_lock_required == true and
    .bootstrap.pinned_host_paths == {
      deploy_root: "<release_root>/repository",
      config_generations_root: "/var/lib/aqua/deploy/config-generations",
      deploy_env_file: "/var/aqua-saas/.env",
      state_root: "/var/lib/aqua/deploy/dr-bootstrap",
      control_plane_lock: "/var/lib/aqua/deploy/control-plane.lock"
    } and
    .bootstrap.shared_control_plane_lock == {
      mode: "exclusive-nonblocking",
      held_from_before_supply_chain_pull_through_terminal_state: true
    } and
    .bootstrap.state_machine == {
      helper: "infrastructure/scripts/postgres-dr-bootstrap-state.sh",
      schema_version: 2,
      modes: ["healthy_upgrade", "degraded_legacy_recovery"],
      recovery_helper: "infrastructure/scripts/postgres-dr-recovery.sh",
      verified_cold_copy_required: true,
      baseline: "signed_candidate_walg_disabled_on_isolated_copy",
      writer_quiescence: "record_and_stop_existing_compose_containers",
      durable_phases: [
        "VERIFYING",
        "PREPARED",
        "FORWARD_STARTED",
        "ROLLBACK_STARTED",
        "ROLLED_BACK",
        "COMMITTED",
        "RECOVERY_REQUIRED",
        "FINALIZING",
        "ROLLBACK_FINALIZING"
      ],
      exact_prior_recovery_required: true,
      power_loss_reentry_required: true,
      reentry_after_rollback: "require_new_signed_run_attempt"
    } and
    .bootstrap.signed_init_directory == "infrastructure/docker/init-scripts" and
    .bootstrap.release_root_safe_path_pattern == "^/[A-Za-z0-9._/-]+$" and
    .bootstrap.rendered_init_mount_assertion_required == true and
    .bootstrap.registry_pull == {
      mode: "anonymous-public-only",
      docker_config_path: "/etc/aqua/dr-bootstrap-public-registry/config.json",
      credential_entries_allowed: false
    } and
    .bootstrap.provider_cosign == {
      path: "/usr/local/bin/cosign",
      version: "v3.0.6",
      sha256: "c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74",
      root_owned_nonwritable: true
    }
  ' "${POLICY_PATH}" >/dev/null || die 'The signed bootstrap policy is not fail-closed.'

while IFS=$'\t' read -r material_path expected_sha256; do
  case "${material_path}" in
    /* | *..*) die 'Candidate material path escapes the signed repository root.' ;;
  esac
  material="${RELEASE_ROOT}/repository/${material_path}"
  require_root_owned_nonwritable_file "${material}"
  [ "$(sha256sum --binary "${material}" | awk '{print $1}')" = "${expected_sha256}" ] || \
    die "Candidate material digest mismatch: ${material_path}"
done < <(jq --raw-output '.materials[] | [.path, .sha256] | @tsv' "${CANDIDATE_PATH}")

mapfile -d '' SIGNED_INIT_FILES < <(
  find "${SIGNED_INIT_DIRECTORY}" -mindepth 1 -maxdepth 1 -type f -print0
)
[ "${#SIGNED_INIT_FILES[@]}" -eq 1 ] || \
  die 'The signed PostgreSQL init directory must contain exactly one file.'
[ "${SIGNED_INIT_FILES[0]}" = "${SIGNED_INIT_DATABASES_PATH}" ] || \
  die 'The signed PostgreSQL init directory contains an unauthorized file.'
[ -z "$(find "${SIGNED_INIT_DIRECTORY}" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ] || \
  die 'The signed PostgreSQL init directory contains a non-file entry.'

EXECUTING_SCRIPT=$(readlink -f -- "${BASH_SOURCE[0]}")
require_root_owned_nonwritable_file "${EXECUTING_SCRIPT}"
cmp --silent "${EXECUTING_SCRIPT}" "${SIGNED_EXECUTOR_PATH}" || \
  die 'Executing provider-console script differs from the signed candidate material.'
# shellcheck source=/dev/null
source "${SIGNED_STATE_HELPER_PATH}"
source "${SIGNED_RECOVERY_HELPER_PATH}"
for required_state_function in \
  dr_state_initialize dr_state_transition dr_state_validate dr_state_validate_any \
  dr_state_phase dr_state_prior_image_id dr_state_candidate_image_id \
  dr_state_reentry_action dr_state_bind_recovery dr_state_reconcile_staging dr_copy_cluster \
  prepare_postgres_recovery_point verify_postgres_recovery_point \
  restore_postgres_recovery_point resume_postgres_recovery_writers; do
  declare -F "${required_state_function}" >/dev/null || \
    die "Signed state helper is missing ${required_state_function}."
done

EXPECTED_CONTRACT_SHA256=$(jq --raw-output '.postgres_dr_contract_sha256' "${CANDIDATE_PATH}")
[[ "${EXPECTED_CONTRACT_SHA256}" =~ ^[0-9a-f]{64}$ ]] || \
  die 'Candidate DR contract digest is invalid.'
[ "$(sha256sum --binary "${DR_CONTRACT_PATH}" | awk '{print $1}')" = \
  "${EXPECTED_CONTRACT_SHA256}" ] || die 'Candidate DR contract manifest digest mismatch.'
(
  cd "${RELEASE_ROOT}/repository"
  sha256sum --strict --check .github/manifests/postgres-dr-contract.sha256
) >/dev/null

if [ ! -e "${CONTROL_PLANE_LOCK_PATH}" ]; then
  require_unchanged_directory_identity \
    "${STATE_ROOT_PARENT}" "${STATE_ROOT_PARENT_ID}" STATE_ROOT_PARENT
  (set -o noclobber; umask 077; : > "${CONTROL_PLANE_LOCK_PATH}") 2>/dev/null || true
  sync -f "${STATE_ROOT_PARENT}"
fi
require_root_owned_nonwritable_file "${CONTROL_PLANE_LOCK_PATH}"
chmod 0600 "${CONTROL_PLANE_LOCK_PATH}"
exec {CONTROL_PLANE_LOCK_FD}<>"${CONTROL_PLANE_LOCK_PATH}"
flock --exclusive --nonblock "${CONTROL_PLANE_LOCK_FD}" || \
  die 'Another production control-plane mutation holds the shared host lock.'
require_root_owned_nonwritable_file "${CONTROL_PLANE_LOCK_PATH}"

if [ ! -e "${STATE_ROOT}" ]; then
  require_unchanged_directory_identity \
    "${STATE_ROOT_PARENT}" "${STATE_ROOT_PARENT_ID}" STATE_ROOT_PARENT
  mkdir --mode=0700 -- "${STATE_ROOT}"
  sync -f "${STATE_ROOT_PARENT}"
fi
STATE_ROOT=$(resolve_root_owned_nonwritable_directory_chain "${STATE_ROOT}")
chmod 0700 "${STATE_ROOT}"
STATE_ROOT_ID=$(stat -c '%d:%i' "${STATE_ROOT}")
GLOBAL_LOCK_PATH="${STATE_ROOT}/postgres-dr-bootstrap.lock"
if [ ! -e "${GLOBAL_LOCK_PATH}" ]; then
  (set -o noclobber; umask 077; : > "${GLOBAL_LOCK_PATH}") 2>/dev/null || true
  sync -f "${STATE_ROOT}"
fi
require_root_owned_nonwritable_file "${GLOBAL_LOCK_PATH}"
chmod 0600 "${GLOBAL_LOCK_PATH}"
exec {GLOBAL_LOCK_FD}<>"${GLOBAL_LOCK_PATH}"
flock --exclusive --nonblock "${GLOBAL_LOCK_FD}" || \
  die 'Another PostgreSQL DR bootstrap candidate holds the global lock.'
require_root_owned_nonwritable_file "${GLOBAL_LOCK_PATH}"

RUN_KEY="${EXPECTED_MAIN_SHA}-${EXPECTED_RUN_ID}-${EXPECTED_RUN_ATTEMPT}"
STATE_DIR="${STATE_ROOT}/${RUN_KEY}"
STATE_PATH="${STATE_DIR}/phase.json"
CURRENT_STATE_NEEDS_INITIALIZATION=false
[ -z "$(find "${STATE_ROOT}" -mindepth 1 -maxdepth 1 \
  ! -name postgres-dr-bootstrap.lock ! -type d -print -quit)" ] || \
  die 'The PostgreSQL DR bootstrap state root contains an unexpected entry.'
while IFS= read -r -d '' recorded_state_dir; do
  require_root_owned_nonwritable_directory "${recorded_state_dir}"
  recorded_state_path="${recorded_state_dir}/phase.json"
  if [ "${recorded_state_dir}" = "${STATE_DIR}" ]; then
    dr_state_reconcile_staging "${recorded_state_path}" Okan-wqm/aquaculture_platform \
      "${EXPECTED_MAIN_SHA}" "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" "${EXPECTED_IMAGE_DIGEST}" || \
      die 'Same-attempt state staging could not be safely reconciled.'
  fi
  if [ ! -e "${recorded_state_path}" ] && [ ! -L "${recorded_state_path}" ]; then
    [ "${recorded_state_dir}" = "${STATE_DIR}" ] || die 'A different candidate has an incomplete journal.'
    [ -z "$(find "${recorded_state_dir}" -mindepth 1 -maxdepth 1 -print -quit)" ] || die 'Initial journal directory is not empty after staging reconciliation.'
    CURRENT_STATE_NEEDS_INITIALIZATION=true
    continue
  fi
  require_root_owned_nonwritable_file "${recorded_state_path}"
  dr_state_validate_any "${recorded_state_path}" || \
    die "A PostgreSQL DR bootstrap execution record is corrupt: ${recorded_state_path}"
  recorded_key=$(jq --raw-output \
    '.candidate.main_sha + "-" + .candidate.run_id + "-" + .candidate.run_attempt' \
    "${recorded_state_path}")
  [ "${recorded_state_dir##*/}" = "${recorded_key}" ] || \
    die 'A PostgreSQL DR bootstrap execution record is stored under the wrong key.'
  recorded_phase=$(dr_state_phase "${recorded_state_path}")
  if [ "${recorded_state_dir}" != "${STATE_DIR}" ]; then
    case "${recorded_phase}" in
      COMMITTED | ROLLED_BACK) ;;
      *) die 'A different PostgreSQL DR bootstrap candidate has unresolved state.' ;;
    esac
  fi
done < <(find "${STATE_ROOT}" -mindepth 1 -maxdepth 1 -type d -print0)

if [ ! -e "${STATE_DIR}" ]; then
  mkdir --mode=0700 -- "${STATE_DIR}"
  sync -f "${STATE_ROOT}"
  CURRENT_STATE_NEEDS_INITIALIZATION=true
fi
if [ "${CURRENT_STATE_NEEDS_INITIALIZATION}" = true ]; then
  dr_state_initialize \
    "${STATE_PATH}" Okan-wqm/aquaculture_platform "${EXPECTED_MAIN_SHA}" \
    "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" "${EXPECTED_IMAGE_DIGEST}" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || \
    die 'The initial VERIFYING phase could not be made durable.'
else
  require_root_owned_nonwritable_directory "${STATE_DIR}"
fi
require_root_owned_nonwritable_file "${STATE_PATH}"
dr_state_validate \
  "${STATE_PATH}" Okan-wqm/aquaculture_platform "${EXPECTED_MAIN_SHA}" \
  "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" "${EXPECTED_IMAGE_DIGEST}" || \
  die 'The signed candidate does not match its durable execution record.'
STATE_DIR_ID=$(stat -c '%d:%i' "${STATE_DIR}")
FORWARD_OVERRIDE="${STATE_DIR}/postgres-forward.override.yml"
ROLLBACK_OVERRIDE="${STATE_DIR}/postgres-rollback.override.yml"
export DR_BOOTSTRAP_RELEASE_ROOT="${RELEASE_ROOT}"

publish_state_file() {
  local temporary_path=$1
  local destination_path=$2
  chmod 0400 "${temporary_path}"
  sync -f "${temporary_path}"
  mv -f -- "${temporary_path}" "${destination_path}"
  sync -f "${STATE_DIR}"
}

render_image_override() {
  local destination_path=$1
  local image_value=$2
  local baseline_environment=${3:-}
  local temporary_path
  temporary_path=$(mktemp --tmpdir="${STATE_DIR}" .override.XXXXXXXX)
  printf \
    'services:\n  postgres:\n    image: %s\n    volumes:\n      - type: bind\n        source: %s\n        target: /docker-entrypoint-initdb.d\n        read_only: true\n' \
    "${image_value}" "${SIGNED_INIT_DIRECTORY}" > "${temporary_path}"
  if [ -n "${baseline_environment}" ]; then
    printf '    environment: %s\n' "$(jq -Rn '[inputs | capture("^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$") | {key:.key,value:.value}] | from_entries' "${baseline_environment}" | jq -c .)" >> "${temporary_path}"
  fi
  publish_state_file "${temporary_path}" "${destination_path}"
}

require_execution_boundaries() {
  local material
  local material_path
  local expected_sha256
  require_unchanged_directory_identity "${DEPLOY_ROOT}" "${DEPLOY_ROOT_ID}" DEPLOY_ROOT
  require_unchanged_directory_identity "${RELEASE_ROOT}" "${RELEASE_ROOT_ID}" RELEASE_ROOT
  require_unchanged_directory_identity "${CERTS_REAL_ROOT}" "${CERTS_REAL_ROOT_ID}" CERTS_ROOT
  require_unchanged_directory_identity "${WALG_SECRET_DIR}" "${WALG_SECRET_DIR_ID}" WAL_G_BUNDLE
  require_unchanged_directory_identity "${STATE_ROOT}" "${STATE_ROOT_ID}" STATE_ROOT
  require_unchanged_directory_identity "${STATE_DIR}" "${STATE_DIR_ID}" STATE_DIR
  require_root_owned_nonwritable_file "${STATE_PATH}"
  dr_state_validate \
    "${STATE_PATH}" Okan-wqm/aquaculture_platform "${EXPECTED_MAIN_SHA}" \
    "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" "${EXPECTED_IMAGE_DIGEST}" || \
    die 'The durable execution record changed before mutation.'
  require_unchanged_directory_identity \
    "${PUBLIC_DOCKER_CONFIG_ROOT}" "${PUBLIC_DOCKER_CONFIG_ROOT_ID}" PUBLIC_DOCKER_CONFIG
  require_root_owned_nonwritable_file "${DEPLOY_ENV_FILE}"
  [ "$(stat -c '%d:%i' "${DEPLOY_ENV_FILE}")" = "${DEPLOY_ENV_FILE_ID}" ] || \
    die 'The production environment file identity changed before mutation.'
  cmp --silent "${EXECUTING_SCRIPT}" "${SIGNED_EXECUTOR_PATH}" || \
    die 'Executing provider-console script changed before mutation.'
  while IFS=$'\t' read -r material_path expected_sha256; do
    material="${RELEASE_ROOT}/repository/${material_path}"
    require_root_owned_nonwritable_file "${material}"
    [ "$(sha256sum --binary "${material}" | awk '{print $1}')" = "${expected_sha256}" ] || \
      die "Candidate material changed before mutation: ${material_path}"
  done < <(jq --raw-output '.materials[] | [.path, .sha256] | @tsv' "${CANDIDATE_PATH}")
}

verify_walg_secret_bundle() {
  local secret_entry
  local secret_path
  for secret_entry in \
    .lock aws_access_key_id aws_secret_access_key libsodium.key \
    walg_backup_epoch walg_s3_prefix manifest.sha256; do
    secret_path="${WALG_SECRET_DIR}/${secret_entry}"
    require_root_owned_nonwritable_file "${secret_path}"
  done
}

active_postgres_container() {
  local container_id
  container_id=$(docker ps --all --no-trunc \
    --filter 'name=^/aqua-postgres$' --format '{{.ID}}') || return
  [[ "${container_id}" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "${container_id}"
}

verify_active_exact_image() {
  local expected_image_id=$1
  local require_walg_health=$2
  local container_id
  local stable_container_id
  local active_image_id
  container_id=$(active_postgres_container) || return
  wait_for_postgres_health "${container_id}" || return
  stable_container_id=$(active_postgres_container) || return
  [ "${stable_container_id}" = "${container_id}" ] || return 1
  active_image_id=$(docker inspect --format '{{.Image}}' "${container_id}") || return
  [ "${active_image_id}" = "${expected_image_id}" ] || return 1
  if [ "${require_walg_health}" = true ]; then
    docker exec "${container_id}" \
      /usr/local/bin/postgres-walg-healthcheck.sh >/dev/null || return
  fi
  printf '%s' "${container_id}"
}

assert_rendered_signed_init_mount() {
  local rendered_config_path=$1
  jq --exit-status \
    --arg signed_init_directory "${SIGNED_INIT_DIRECTORY}" \
    --arg init_target /docker-entrypoint-initdb.d \
    '
      [.services.postgres.volumes[]? |
        select(
          .target == $init_target or
          ((.target | type) == "string" and
            (.target | startswith($init_target + "/")))
        )] as $init_mounts |
      ($init_mounts | length) == 1 and
      $init_mounts[0].type == "bind" and
      $init_mounts[0].source == $signed_init_directory and
      $init_mounts[0].target == $init_target and
      $init_mounts[0].read_only == true
    ' "${rendered_config_path}" >/dev/null
}

configure_forward_compose() {
  local rendered_config_path
  rendered_config_path=$(mktemp /tmp/aqua-postgres-forward-compose.XXXXXXXX)
  if ! docker compose \
    --project-name aqua-saas \
    --project-directory "${DEPLOY_ROOT}" \
    --env-file "${DEPLOY_ENV_FILE}" \
    -f "${SIGNED_COMPOSE_PATH}" \
    -f "${FORWARD_OVERRIDE}" \
    config --format json > "${rendered_config_path}"; then
    rm -f -- "${rendered_config_path}"
    die 'The forward PostgreSQL Compose model is invalid.'
  fi
  if ! assert_rendered_signed_init_mount "${rendered_config_path}"; then
    rm -f -- "${rendered_config_path}"
    die 'The forward PostgreSQL Compose model does not bind the exact signed init directory.'
  fi
  rm -f -- "${rendered_config_path}"
}

configure_rollback_compose() {
  local rendered_config_path
  rendered_config_path=$(mktemp /tmp/aqua-postgres-rollback-compose.XXXXXXXX)
  if ! docker compose \
    --project-name aqua-saas \
    --project-directory "${DEPLOY_ROOT}" \
    --env-file "${DEPLOY_ENV_FILE}" \
    -f "${SIGNED_COMPOSE_PATH}" \
    -f "${SIGNED_ROLLBACK_COMPOSE_PATH}" \
    -f "${ROLLBACK_OVERRIDE}" \
    config --format json > "${rendered_config_path}"; then
    rm -f -- "${rendered_config_path}"
    die 'The rollback PostgreSQL Compose model is invalid.'
  fi
  if ! assert_rendered_signed_init_mount "${rendered_config_path}"; then
    rm -f -- "${rendered_config_path}"
    die 'The rollback PostgreSQL Compose model does not bind the exact signed init directory.'
  fi
  rm -f -- "${rendered_config_path}"
}

write_rollback_result() {
  local prior_image_id=$1
  local candidate_image_id=$2
  local active_container_id=$3
  local temporary_path
  temporary_path=$(mktemp --tmpdir="${STATE_DIR}" .rollback.XXXXXXXX)
  jq --sort-keys --null-input \
    --arg prior_image_id "${prior_image_id}" \
    --arg candidate_image_id "${candidate_image_id}" \
    --arg active_container_id "${active_container_id}" \
    --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      result: "rollback",
      prior_image_id: $prior_image_id,
      candidate_image_id: $candidate_image_id,
      active_container_id: $active_container_id,
      active_image_id: $prior_image_id,
      completed_at: $completed_at
    }' > "${temporary_path}"
  publish_state_file "${temporary_path}" "${STATE_DIR}/rollback.json"
}

write_forward_result() {
  local prior_image_id=$1
  local candidate_image_id=$2
  local active_container_id=$3
  local temporary_path
  temporary_path=$(mktemp --tmpdir="${STATE_DIR}" .result.XXXXXXXX)
  jq --sort-keys --null-input \
    --arg main_sha "${EXPECTED_MAIN_SHA}" \
    --arg run_id "${EXPECTED_RUN_ID}" \
    --arg run_attempt "${EXPECTED_RUN_ATTEMPT}" \
    --arg image_digest "${EXPECTED_IMAGE_DIGEST}" \
    --arg image_id "${candidate_image_id}" \
    --arg prior_image_id "${prior_image_id}" \
    --arg active_container_id "${active_container_id}" \
    --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      result: "success",
      main_sha: $main_sha,
      run_id: $run_id,
      run_attempt: $run_attempt,
      image_digest: $image_digest,
      image_id: $image_id,
      prior_image_id: $prior_image_id,
      active_container_id: $active_container_id,
      completed_at: $completed_at
    }' > "${temporary_path}"
  publish_state_file "${temporary_path}" "${STATE_DIR}/result.json"
}

recover_exact_prior() {
  local phase
  local prior_image_id
  local candidate_image_id
  local rollback_container_id
  phase=$(dr_state_phase "${STATE_PATH}") || return
  case "${phase}" in
    FORWARD_STARTED | ROLLBACK_STARTED | RECOVERY_REQUIRED) ;;
    *) return 65 ;;
  esac
  prior_image_id=$(dr_state_prior_image_id "${STATE_PATH}") || return
  candidate_image_id=$(dr_state_candidate_image_id "${STATE_PATH}") || return
  CANDIDATE_IMAGE_ID=${candidate_image_id}
  [[ "${prior_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 65
  [[ "${candidate_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 65
  docker image inspect "${prior_image_id}" >/dev/null 2>&1 || return
  require_execution_boundaries
  render_image_override "${ROLLBACK_OVERRIDE}" "${prior_image_id}" \
    "/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}/baseline.env"
  configure_rollback_compose
  if [ "${phase}" = FORWARD_STARTED ] || [ "${phase}" = RECOVERY_REQUIRED ]; then
    dr_state_transition \
      "${STATE_PATH}" "${phase}" ROLLBACK_STARTED \
      "${prior_image_id}" "${candidate_image_id}" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return
  fi
  restore_postgres_recovery_point || return
  DEPLOY_CERTS_DIR="/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}/certs" docker compose \
    --project-name aqua-saas \
    --project-directory "${DEPLOY_ROOT}" \
    --env-file "${DEPLOY_ENV_FILE}" \
    -f "${SIGNED_COMPOSE_PATH}" \
    -f "${SIGNED_ROLLBACK_COMPOSE_PATH}" \
    -f "${ROLLBACK_OVERRIDE}" \
    up -d --no-deps --no-build --force-recreate --pull never postgres || return
  rollback_container_id=$(verify_active_exact_image "${prior_image_id}" false) || return
  write_rollback_result \
    "${prior_image_id}" "${candidate_image_id}" "${rollback_container_id}" || return
  rm -f -- "${STATE_DIR}/result.json"
  sync -f "${STATE_DIR}"
  dr_state_transition "${STATE_PATH}" ROLLBACK_STARTED ROLLBACK_FINALIZING \
    "${prior_image_id}" "${candidate_image_id}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return
  resume_postgres_recovery_writers || return
  dr_state_transition \
    "${STATE_PATH}" ROLLBACK_FINALIZING ROLLED_BACK \
    "${prior_image_id}" "${candidate_image_id}" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

verify_candidate_supply_chain() {
  local attestations_path
  local candidate_path
  local matching_attestations=0
  local payload
  local predicate_path
  local signature_path
  local statement_path
  signature_path=$(mktemp --tmpdir="${STATE_DIR}" .signature.XXXXXXXX)
  attestations_path=$(mktemp --tmpdir="${STATE_DIR}" .attestations.XXXXXXXX)
  candidate_path=$(mktemp --tmpdir="${STATE_DIR}" .candidate.XXXXXXXX)
  cosign verify \
    --certificate-identity "${IDENTITY}" \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --certificate-github-workflow-sha "${EXPECTED_MAIN_SHA}" \
    "${IMAGE_REF}" > "${signature_path}"
  cosign verify-attestation \
    --type 'https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-candidate/v1' \
    --certificate-identity "${IDENTITY}" \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --certificate-github-workflow-sha "${EXPECTED_MAIN_SHA}" \
    "${IMAGE_REF}" > "${attestations_path}"
  jq --sort-keys '.' "${CANDIDATE_PATH}" > "${candidate_path}"
  while IFS= read -r payload; do
    statement_path=$(mktemp --tmpdir="${STATE_DIR}" .statement.XXXXXXXX)
    predicate_path=$(mktemp --tmpdir="${STATE_DIR}" .predicate.XXXXXXXX)
    printf '%s' "${payload}" | base64 --decode > "${statement_path}" || \
      die 'Verified OCI attestation contains an invalid payload.'
    jq --sort-keys '.predicate' "${statement_path}" > "${predicate_path}"
    if cmp --silent "${predicate_path}" "${candidate_path}"; then
      matching_attestations=$((matching_attestations + 1))
    fi
    rm -f -- "${statement_path}" "${predicate_path}"
  done < <(
    jq --raw-output \
      'if type == "array" then .[] else . end | select(.payload | type == "string") | .payload' \
      "${attestations_path}"
  )
  [ "${matching_attestations}" -eq 1 ] || \
    die 'The image digest must have exactly one attestation matching this candidate and run.'
  publish_state_file "${signature_path}" "${STATE_DIR}/image-signature.json"
  publish_state_file "${attestations_path}" "${STATE_DIR}/image-attestations.jsonl"
  publish_state_file "${candidate_path}" "${STATE_DIR}/local-candidate.json"

  docker pull "${IMAGE_REF}" >/dev/null
  CANDIDATE_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "${IMAGE_REF}")
  [[ "${CANDIDATE_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
    die 'Pulled candidate image ID is invalid.'
  [ "$(docker image inspect --format \
    '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${IMAGE_REF}")" = \
    "${EXPECTED_MAIN_SHA}" ] || die 'Candidate image revision label does not match main SHA.'
  [ "$(docker image inspect --format \
    '{{ index .Config.Labels "io.aquaculture.postgres.dr-contract-sha256" }}' "${IMAGE_REF}")" = \
    "${EXPECTED_CONTRACT_SHA256}" ] || die 'Candidate image DR contract label does not match.'
}

finalize_postgres_recovery() {
# Publish the recovered private configuration as the seed for later releases.
CONFIG_POINTER=$(mktemp /var/lib/aqua/deploy/config-generations/.current.XXXXXXXX)
printf '%s/%s-%s\n' "${EXPECTED_MAIN_SHA}" "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" > "${CONFIG_POINTER}"
chmod 0400 "${CONFIG_POINTER}"
sync -f "${CONFIG_POINTER}"
mv "${CONFIG_POINTER}" /var/lib/aqua/deploy/config-generations/current
sync -f /var/lib/aqua/deploy/config-generations
resume_postgres_recovery_writers || die 'PostgreSQL recovered but recorded writers could not restart.'
}

CONFIG_GENERATION="/var/lib/aqua/deploy/config-generations/${EXPECTED_MAIN_SHA}/${EXPECTED_RUN_ID}-${EXPECTED_RUN_ATTEMPT}"
if [ ! -e "${CONFIG_GENERATION}" ]; then
  install -d -m 0700 "/var/lib/aqua/deploy/config-generations/${EXPECTED_MAIN_SHA}"
  CONFIG_STAGE=$(mktemp -d "/var/lib/aqua/deploy/config-generations/${EXPECTED_MAIN_SHA}/.preparing-${EXPECTED_RUN_ID}-${EXPECTED_RUN_ATTEMPT}.XXXXXXXX")
  cp --preserve=mode,ownership -- "${DEPLOY_ENV_FILE}" "${CONFIG_STAGE}/.env"
  cp -aL -- "${CERTS_REAL_ROOT}" "${CONFIG_STAGE}/certs"
  printf '{"schema_version":2,"main_sha":"%s","attempt":"%s-%s"}\n' \
    "${EXPECTED_MAIN_SHA}" "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" > "${CONFIG_STAGE}/.generation-identity.json"
  chmod 0400 "${CONFIG_STAGE}/.generation-identity.json"
  sync -f "${CONFIG_STAGE}"
  mv -T -- "${CONFIG_STAGE}" "${CONFIG_GENERATION}"
  sync -f "/var/lib/aqua/deploy/config-generations/${EXPECTED_MAIN_SHA}"
fi
require_root_owned_nonwritable_directory "${CONFIG_GENERATION}"
require_root_owned_nonwritable_file "${CONFIG_GENERATION}/.generation-identity.json"
jq -e --arg sha "${EXPECTED_MAIN_SHA}" --arg attempt "${EXPECTED_RUN_ID}-${EXPECTED_RUN_ATTEMPT}" \
  '.schema_version == 2 and .main_sha == $sha and .attempt == $attempt' \
  "${CONFIG_GENERATION}/.generation-identity.json" >/dev/null || die 'Configuration generation identity changed.'
DEPLOY_ENV_FILE="${CONFIG_GENERATION}/.env"
DEPLOY_ENV_FILE_ID=$(stat -c '%d:%i' "${DEPLOY_ENV_FILE}")
CERTS_REAL_ROOT="${CONFIG_GENERATION}/certs"
CERTS_REAL_ROOT_ID=$(stat -c '%d:%i' "${CERTS_REAL_ROOT}")
WALG_SECRET_DIR="${CERTS_REAL_ROOT}/wal-g/postgres"
WALG_SECRET_DIR_ID=$(stat -c '%d:%i' "${WALG_SECRET_DIR}")
export DEPLOY_CERTS_DIR="${CERTS_REAL_ROOT}"
PHASE=$(dr_state_phase "${STATE_PATH}")
[ "$(jq -r '.mode' "${STATE_PATH}")" = "${DR_BOOTSTRAP_MODE}" ] || die 'Recovery mode changed during re-entry.'
REENTRY_ACTION=$(dr_state_reentry_action "${PHASE}")
case "${REENTRY_ACTION}" in
  finish-forward)
    PRIOR_IMAGE_ID=$(dr_state_prior_image_id "${STATE_PATH}")
    CANDIDATE_IMAGE_ID=$(dr_state_candidate_image_id "${STATE_PATH}")
    verify_active_exact_image "${CANDIDATE_IMAGE_ID}" true >/dev/null || die 'Forward finalization requires repair in place; writers may already have committed data.'
    finalize_postgres_recovery
    dr_state_transition "${STATE_PATH}" FINALIZING COMMITTED "${PRIOR_IMAGE_ID}" "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    exit 0
    ;;
  finish-rollback)
    PRIOR_IMAGE_ID=$(dr_state_prior_image_id "${STATE_PATH}")
    CANDIDATE_IMAGE_ID=$(dr_state_candidate_image_id "${STATE_PATH}")
    verify_active_exact_image "${PRIOR_IMAGE_ID}" false >/dev/null || die 'Rollback finalization requires repair in place; writers may already have committed data.'
    resume_postgres_recovery_writers
    dr_state_transition "${STATE_PATH}" ROLLBACK_FINALIZING ROLLED_BACK "${PRIOR_IMAGE_ID}" "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    exit 0
    ;;
  recover-exact-prior)
    recover_exact_prior || die 'Exact-prior recovery failed; bootstrap remains fail-closed.'
    die 'Exact-prior recovery completed; a new signed run attempt is required.'
    ;;
  require-new-signed-candidate)
    PRIOR_IMAGE_ID=$(dr_state_prior_image_id "${STATE_PATH}")
    verify_active_exact_image "${PRIOR_IMAGE_ID}" false >/dev/null || \
      die 'The rolled-back exact prior PostgreSQL image is no longer healthy.'
    die 'This candidate was rolled back; a new signed run attempt is required.'
    ;;
  verify-committed)
    CANDIDATE_IMAGE_ID=$(dr_state_candidate_image_id "${STATE_PATH}")
    verify_active_exact_image "${CANDIDATE_IMAGE_ID}" true >/dev/null || \
      die 'The committed PostgreSQL candidate no longer satisfies exact-image health.'
    printf 'PostgreSQL DR bootstrap candidate remains healthy at %s.\n' \
      "${EXPECTED_IMAGE_DIGEST}"
    exit 0
    ;;
  resume-forward)
    PRIOR_IMAGE_ID=$(dr_state_prior_image_id "${STATE_PATH}")
    CANDIDATE_IMAGE_ID=$(dr_state_candidate_image_id "${STATE_PATH}")
    verify_postgres_recovery_point || die 'PREPARED re-entry requires the verified cold recovery point.'
    ;;
  resume-verification) ;;
  *) die 'The durable PostgreSQL DR bootstrap phase has no safe re-entry action.' ;;
esac

require_execution_boundaries
verify_candidate_supply_chain
verify_walg_secret_bundle

if [ "${PHASE}" = VERIFYING ]; then
  PRIOR_CONTAINER_ID=$(active_postgres_container) || \
    die 'The production PostgreSQL container is not running under its exact name.'
  PRIOR_IMAGE_ID=$(docker inspect --format '{{.Image}}' "${PRIOR_CONTAINER_ID}")
  [[ "${PRIOR_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
    die 'Prior PostgreSQL image ID is invalid.'
  [ "$(active_postgres_container)" = "${PRIOR_CONTAINER_ID}" ] || \
    die 'The prior PostgreSQL name-to-ID mapping changed during observation.'
  prepare_postgres_recovery_point "${PRIOR_CONTAINER_ID}" || die 'The complete recovery point could not be verified; live database bytes were not replaced.'
  PRIOR_IMAGE_ID=${CANDIDATE_IMAGE_ID}
  render_image_override "${FORWARD_OVERRIDE}" "${IMAGE_REF}"
  render_image_override "${ROLLBACK_OVERRIDE}" "${PRIOR_IMAGE_ID}" \
    "/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}/baseline.env"
  configure_forward_compose
  configure_rollback_compose
  dr_state_transition \
    "${STATE_PATH}" VERIFYING PREPARED "${PRIOR_IMAGE_ID}" \
    "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || \
    die 'The PREPARED phase could not be made durable.'
else
  [ "${PHASE}" = PREPARED ] || die 'Unexpected pre-forward state.'
  [ "${CANDIDATE_IMAGE_ID}" = \
    "$(dr_state_candidate_image_id "${STATE_PATH}")" ] || \
    die 'Reverified candidate image ID differs from the PREPARED record.'
  render_image_override "${FORWARD_OVERRIDE}" "${IMAGE_REF}"
  render_image_override "${ROLLBACK_OVERRIDE}" "${PRIOR_IMAGE_ID}" \
    "/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}/baseline.env"
  configure_forward_compose
  configure_rollback_compose
fi

require_execution_boundaries
verify_postgres_recovery_point || die 'The recovery point changed before the forward mutation.'

RECOVERY_REQUIRED=true
on_exit() {
  local status=$?
  local exit_phase=''
  trap - EXIT HUP INT TERM
  if [ "${status}" -ne 0 ] && [ "${RECOVERY_REQUIRED}" = true ]; then
    exit_phase=$(dr_state_phase "${STATE_PATH}" 2>/dev/null || true)
    case "${exit_phase}" in
      FORWARD_STARTED | ROLLBACK_STARTED)
        set +e
        recover_exact_prior
        if [ "$?" -ne 0 ]; then
          status=3
          exit_phase=$(dr_state_phase "${STATE_PATH}")
          case "${exit_phase}" in
            FORWARD_STARTED|ROLLBACK_STARTED)
              dr_state_transition "${STATE_PATH}" "${exit_phase}" RECOVERY_REQUIRED \
                "${PRIOR_IMAGE_ID}" "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
          esac
        fi
        ;;
    esac
  fi
  exit "${status}"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

dr_state_transition \
  "${STATE_PATH}" PREPARED FORWARD_STARTED "${PRIOR_IMAGE_ID}" \
  "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || \
  die 'The FORWARD_STARTED phase could not be made durable before mutation.'
docker compose \
  --project-name aqua-saas \
  --project-directory "${DEPLOY_ROOT}" \
  --env-file "${DEPLOY_ENV_FILE}" \
  -f "${SIGNED_COMPOSE_PATH}" \
  -f "${FORWARD_OVERRIDE}" \
  up -d --no-deps --no-build --force-recreate --pull never postgres
CANDIDATE_CONTAINER_ID=$(verify_active_exact_image "${CANDIDATE_IMAGE_ID}" true) || \
  die 'Candidate PostgreSQL did not satisfy exact-image WAL-G health.'
write_forward_result \
  "${PRIOR_IMAGE_ID}" "${CANDIDATE_IMAGE_ID}" "${CANDIDATE_CONTAINER_ID}"
dr_state_transition \
  "${STATE_PATH}" FORWARD_STARTED FINALIZING "${PRIOR_IMAGE_ID}" \
  "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || \
  die 'The verified candidate could not reach the durable COMMITTED phase.'
finalize_postgres_recovery
dr_state_transition "${STATE_PATH}" FINALIZING COMMITTED "${PRIOR_IMAGE_ID}" \
  "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || die 'Finalization could not be committed.'
RECOVERY_REQUIRED=false
trap - EXIT HUP INT TERM
printf 'PostgreSQL DR bootstrap candidate is healthy at %s.\n' "${EXPECTED_IMAGE_DIGEST}"
