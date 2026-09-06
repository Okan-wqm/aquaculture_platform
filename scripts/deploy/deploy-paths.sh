#!/usr/bin/env bash
# Release paths are write-once. Containers never bind the checkout that the
# next deployment updates. All callers retain the same host lock through exit.
export DEPLOY_SOURCE_REPO="${DEPLOY_SOURCE_REPO:-/var/aqua-saas}"
export DEPLOY_RELEASES_ROOT="${DEPLOY_RELEASES_ROOT:-/var/lib/aqua/deploy/releases}"
export DEPLOY_CONFIG_ROOT="${DEPLOY_CONFIG_ROOT:-/var/lib/aqua/deploy/config-generations}"
export DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-${DEPLOY_SOURCE_REPO}/.env}"
export DEPLOY_CERTS_DIR="${DEPLOY_CERTS_DIR:-${DEPLOY_SOURCE_REPO}/certs}"
export COMPOSE_PROJECT_NAME=aqua-saas

deploy_paths_error() {
  printf '::error::Deploy admission: %s\n' "$1" >&2
  return 1
}

acquire_deploy_control_lock() {
  local control_root=/var/lib/aqua/deploy
  local lock_path="${control_root}/control-plane.lock"
  [ ! -L "${control_root}" ] || return 1
  install -d -m 0700 "${control_root}"
  [ ! -L "${lock_path}" ] || return 1
  if [ ! -e "${lock_path}" ]; then
    (umask 077; set -o noclobber; : > "${lock_path}") 2>/dev/null || return 1
  fi
  [ "$(stat -c '%u:%a:%h' "${lock_path}")" = '0:600:1' ] || \
    deploy_paths_error unsafe-control-lock || return
  if [ -z "${DEPLOY_CONTROL_LOCK_FD:-}" ] && [ -n "${AQUA_CONTROL_PLANE_LOCK_FD:-}" ]; then
    DEPLOY_CONTROL_LOCK_FD=${AQUA_CONTROL_PLANE_LOCK_FD}
  fi
  if [ -z "${DEPLOY_CONTROL_LOCK_FD:-}" ]; then
    exec {DEPLOY_CONTROL_LOCK_FD}<>"${lock_path}"
  fi
  [[ "${DEPLOY_CONTROL_LOCK_FD}" =~ ^[0-9]+$ ]] || return 1
  [ "$(stat -Lc '%d:%i' "/proc/${BASHPID}/fd/${DEPLOY_CONTROL_LOCK_FD}")" = \
    "$(stat -c '%d:%i' "${lock_path}")" ] || return 1
  flock --exclusive --nonblock "${DEPLOY_CONTROL_LOCK_FD}" || \
    deploy_paths_error control-plane-busy || return
  export DEPLOY_CONTROL_LOCK_FD
}

# A preserved database is admitted only when it is healthy, runs the candidate
# image contract, and has a successful provider-console recovery receipt. This
# guard runs before worktree/config publication, capacity GC or app mutation.
assert_deploy_infrastructure() {
  local sha=${1:?candidate SHA required}
  local expected_contract observed image_id running health
  expected_contract=$(git -C "${DEPLOY_SOURCE_REPO}" show \
    "${sha}:.github/manifests/postgres-dr-contract.sha256" | sha256sum | awk '{print $1}') || return
  observed=$(timeout 30 docker inspect --format \
    '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.Image}}' \
    aqua-postgres) || deploy_paths_error postgres-inspection-failed || return
  read -r running health image_id <<< "${observed}"
  [ "${running}" = true ] && [ "${health}" = healthy ] || \
    deploy_paths_error postgres-not-healthy || return
  [ "$(timeout 30 docker image inspect --format \
    '{{index .Config.Labels "io.aquaculture.postgres.dr-contract-sha256"}}' "${image_id}")" = \
    "${expected_contract}" ] || deploy_paths_error image-contract-mismatch || return
  # Both entrypoints execute the same strict receipt reader: exact artifact
  # membership, candidate/result binding, ownership and modes are inseparable.
  # Read it from this exact commit before any candidate checkout is published.
  (
    set -o pipefail
    git -C "${DEPLOY_SOURCE_REPO}" show "${sha}:scripts/deploy/validate-postgres-dr-state.py" | \
      /usr/bin/python3 - /var/lib/aqua/deploy/dr-bootstrap 0 "${image_id}"
  ) || deploy_paths_error unresolved-recovery

}

materialize_deploy_checkout() {
  local sha=${1:?materialize_deploy_checkout requires a commit SHA}
  local attempt=${DEPLOY_ATTEMPT:?DEPLOY_ATTEMPT must identify workflow run and attempt}
  [[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "${attempt}" =~ ^[1-9][0-9]*-[1-9][0-9]*$ ]] || return 1
  acquire_deploy_control_lock || return
  assert_deploy_infrastructure "${sha}" || return
  local src=${DEPLOY_SOURCE_REPO}
  local dir="${DEPLOY_RELEASES_ROOT}/${sha}/${attempt}"
  local configuration="${DEPLOY_CONFIG_ROOT}/${sha}/${attempt}"
  local seed_env=${DEPLOY_ENV_FILE} seed_certs=${DEPLOY_CERTS_DIR}
  if [ -f "${DEPLOY_CONFIG_ROOT}/current" ]; then
    local previous
    previous=$(cat "${DEPLOY_CONFIG_ROOT}/current") || return
    [[ "${previous}" =~ ^[0-9a-f]{40}/[1-9][0-9]*-[1-9][0-9]*$ ]] || return 1
    seed_env="${DEPLOY_CONFIG_ROOT}/${previous}/.env"
    seed_certs="${DEPLOY_CONFIG_ROOT}/${previous}/certs"
  fi
  [ ! -L "${configuration}" ] && [ ! -L "${dir}" ] || return 1
  if [ ! -e "${configuration}" ]; then
    [ -f "${seed_env}" ] && [ -d "${seed_certs}" ] || return 1
    local configuration_stage
    install -d -m 0700 "${DEPLOY_CONFIG_ROOT}/${sha}"
    configuration_stage=$(mktemp -d "${DEPLOY_CONFIG_ROOT}/${sha}/.preparing-${attempt}.XXXXXXXX") || return
    install -d -m 0700 "${configuration_stage}/certs"
    cp --preserve=mode,ownership -- "${seed_env}" "${configuration_stage}/.env" || return
    cp -aL -- "${seed_certs}/." "${configuration_stage}/certs/" || return
    printf '{"schema_version":2,"main_sha":"%s","attempt":"%s"}\n' "${sha}" "${attempt}" > "${configuration_stage}/.generation-identity.json"
    chmod 0400 "${configuration_stage}/.generation-identity.json"
    sync -f "${configuration_stage}" || return
    mv -T -- "${configuration_stage}" "${configuration}" || return
    sync -f "${DEPLOY_CONFIG_ROOT}/${sha}" || return
  fi
  # An interrupted publication can reuse only the complete, same-attempt
  # generation. Incomplete staging directories remain private and unmounted.
  jq -e --arg sha "${sha}" --arg attempt "${attempt}" \
    '.schema_version == 2 and .main_sha == $sha and .attempt == $attempt' \
    "${configuration}/.generation-identity.json" >/dev/null || return
  if [ ! -e "${dir}" ]; then
    local source_stage staging_root="${DEPLOY_RELEASES_ROOT%/*}/publication-staging"
    install -d -m 0700 "${staging_root}" "${DEPLOY_RELEASES_ROOT}/${sha}"
    source_stage=$(mktemp -d "${staging_root}/${sha}-${attempt}.XXXXXXXX") || return
    git -C "${src}" worktree add --detach "${source_stage}" "${sha}" || return
    ln -s "${configuration}/.env" "${source_stage}/.env" || return
    ln -s "${configuration}/certs" "${source_stage}/certs" || return
    printf '{"schema_version":2,"main_sha":"%s","attempt":"%s"}\n' "${sha}" "${attempt}" > "${source_stage}/.release-identity.json"
    chmod 0400 "${source_stage}/.release-identity.json"
    if [ -d "${src}/node_modules" ]; then
      ln -s "${src}/node_modules" "${source_stage}/node_modules" || return
    fi
    chmod 0755 "${source_stage}" || return
    sync -f "${source_stage}" || return
    git -C "${src}" worktree move "${source_stage}" "${dir}" || return
    sync -f "${DEPLOY_RELEASES_ROOT}/${sha}" || return
  fi
  jq -e --arg sha "${sha}" --arg attempt "${attempt}" \
    '.schema_version == 2 and .main_sha == $sha and .attempt == $attempt' \
    "${dir}/.release-identity.json" >/dev/null || return
  # A crash after the atomic directory move may precede Git's backlink update.
  # Repair only the metadata of this already complete immutable worktree.
  git -C "${src}" worktree repair "${dir}" || return
  [ ! -L "${dir}" ] && [ ! -L "${configuration}" ] || return 1
  [ "$(git -C "${dir}" rev-parse HEAD)" = "${sha}" ] || return 1
  [ "$(readlink "${dir}/.env")" = "${configuration}/.env" ] || return 1
  [ "$(readlink "${dir}/certs")" = "${configuration}/certs" ] || return 1
  [ -z "$(git -C "${dir}" status --porcelain --untracked-files=no)" ] || \
    deploy_paths_error release-source-modified || return
  export DEPLOY_CHECKOUT_DIR=${dir}
  export DEPLOY_ENV_FILE="${configuration}/.env"
  export DEPLOY_CERTS_DIR="${configuration}/certs"
}

promote_deploy_configuration() {
  local key="${DEPLOY_SHA}/${DEPLOY_ATTEMPT}"
  local temporary
  temporary=$(mktemp "${DEPLOY_CONFIG_ROOT}/.current.XXXXXXXX") || return
  printf '%s\n' "${key}" > "${temporary}"
  chmod 0400 "${temporary}"
  sync -f "${temporary}"
  mv -- "${temporary}" "${DEPLOY_CONFIG_ROOT}/current"
  sync -f "${DEPLOY_CONFIG_ROOT}"
}

# The manifest binds bytes within one private generation. Runtime changes use a
# new generation; no deployment is allowed to edit an already published one.
deploy_configuration_is_sealed() {
  [ -f "${DEPLOY_ENV_FILE%/*}/sealed.sha256" ]
}

seal_deploy_configuration() {
  local generation=${DEPLOY_ENV_FILE%/*}
  [ ! -e "${generation}/sealed.sha256" ] || return 1
  (cd "${generation}" && find . -type f ! -name sealed.sha256 -print0 | sort -z | xargs -0 sha256sum) > "${generation}/sealed.sha256"
  chmod 0400 "${generation}/sealed.sha256" "${DEPLOY_ENV_FILE}"
  sync -f "${generation}"
  # Source files are never regenerated or reset once published.
  find "${DEPLOY_CHECKOUT_DIR}" -type f -exec chmod a-w -- {} +
  find "${DEPLOY_CHECKOUT_DIR}" -type d -exec chmod 0555 -- {} +
}

verify_deploy_configuration() {
  local generation=${DEPLOY_ENV_FILE%/*}
  (cd "${generation}" && sha256sum --status --check sealed.sha256)
}
