#!/usr/bin/env bash
# Production recovery coordinator. The provider verifies this exact material,
# fixes host boundaries and acquires the shared lock before invoking it.
# Hosted integration supplies isolated runtime/supply-chain boundaries while
# executing these same state transitions, Compose actions and recovery helpers.

wait_for_postgres_health() {
  local container_id=$1
  local deadline=$((SECONDS + 180))
  local state
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    state=$(docker inspect --format \
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "${container_id}" 2>/dev/null || true)
    case "${state}" in
      'running healthy') return 0 ;;
      *' unhealthy' | exited\ * | dead\ *) return 1 ;;
    esac
    sleep 5
  done
  return 1
}

publish_state_file() {
  local temporary_path=$1
  local destination_path=$2
  chmod 0400 "${temporary_path}" || return
  sync -f "${temporary_path}" || return
  mv -f -- "${temporary_path}" "${destination_path}" || return
  sync -f "${STATE_DIR}"
}

render_image_override() {
  local destination_path=$1
  local image_value=$2
  local baseline_environment=${3:-}
  local temporary_path baseline_json
  temporary_path=$(mktemp --tmpdir="${STATE_DIR}" .override.XXXXXXXX) || return
  printf \
    'services:\n  postgres:\n    image: %s\n    volumes:\n      - type: bind\n        source: %s\n        target: /docker-entrypoint-initdb.d\n        read_only: true\n' \
    "${image_value}" "${SIGNED_INIT_DIRECTORY}" > "${temporary_path}" || return
  if [ -n "${baseline_environment}" ]; then
    baseline_json=$(jq -Rnc '[inputs | capture("^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$") | {key:.key,value:.value}] | from_entries' "${baseline_environment}") || return
    printf '    environment: %s\n' "${baseline_json}" >> "${temporary_path}" || return
  fi
  publish_state_file "${temporary_path}" "${destination_path}"
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
  rendered_config_path=$(mktemp /tmp/aqua-postgres-forward-compose.XXXXXXXX) || return
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
  rendered_config_path=$(mktemp /tmp/aqua-postgres-rollback-compose.XXXXXXXX) || return
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
  temporary_path=$(mktemp --tmpdir="${STATE_DIR}" .rollback.XXXXXXXX) || return
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
    }' > "${temporary_path}" || return
  publish_state_file "${temporary_path}" "${STATE_DIR}/rollback.json"
}

write_forward_result() {
  local prior_image_id=$1
  local candidate_image_id=$2
  local active_container_id=$3
  local temporary_path
  temporary_path=$(mktemp --tmpdir="${STATE_DIR}" .result.XXXXXXXX) || return
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
    }' > "${temporary_path}" || return
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
  require_execution_boundaries || return
  render_image_override "${ROLLBACK_OVERRIDE}" "${prior_image_id}" \
    "/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}/baseline.env" || return
  configure_rollback_compose || return
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
  rm -f -- "${STATE_DIR}/result.json" || return
  sync -f "${STATE_DIR}" || return
  dr_state_transition "${STATE_PATH}" ROLLBACK_STARTED ROLLBACK_FINALIZING \
    "${prior_image_id}" "${candidate_image_id}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return
  resume_postgres_recovery_writers || return
  dr_state_transition \
    "${STATE_PATH}" ROLLBACK_FINALIZING ROLLED_BACK \
    "${prior_image_id}" "${candidate_image_id}" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

finalize_postgres_recovery() {
  # Publish the recovered private configuration as the seed for later releases.
  local config_pointer
  config_pointer=$(mktemp /var/lib/aqua/deploy/config-generations/.current.XXXXXXXX) || return
  printf '%s/%s-%s\n' "${EXPECTED_MAIN_SHA}" "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" > "${config_pointer}" || return
  chmod 0400 "${config_pointer}" || return
  sync -f "${config_pointer}" || return
  mv "${config_pointer}" /var/lib/aqua/deploy/config-generations/current || return
  sync -f /var/lib/aqua/deploy/config-generations || return
  resume_postgres_recovery_writers
}

run_postgres_recovery_coordinator() {
PHASE=$(dr_state_phase "${STATE_PATH}")
[ "$(jq -r '.mode' "${STATE_PATH}")" = "${DR_BOOTSTRAP_MODE}" ] || die 'Recovery mode changed during re-entry.'
REENTRY_ACTION=$(dr_state_reentry_action "${PHASE}")
case "${REENTRY_ACTION}" in
  finish-forward)
    PRIOR_IMAGE_ID=$(dr_state_prior_image_id "${STATE_PATH}")
    CANDIDATE_IMAGE_ID=$(dr_state_candidate_image_id "${STATE_PATH}")
    verify_active_exact_image "${CANDIDATE_IMAGE_ID}" true >/dev/null || die 'Forward finalization requires repair in place; writers may already have committed data.'
    finalize_postgres_recovery || die 'PostgreSQL recovered but private configuration or recorded writers could not finalize.'
    dr_state_transition "${STATE_PATH}" FINALIZING COMMITTED "${PRIOR_IMAGE_ID}" "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 0
    ;;
  finish-rollback)
    PRIOR_IMAGE_ID=$(dr_state_prior_image_id "${STATE_PATH}")
    CANDIDATE_IMAGE_ID=$(dr_state_candidate_image_id "${STATE_PATH}")
    verify_active_exact_image "${PRIOR_IMAGE_ID}" false >/dev/null || die 'Rollback finalization requires repair in place; writers may already have committed data.'
    resume_postgres_recovery_writers
    dr_state_transition "${STATE_PATH}" ROLLBACK_FINALIZING ROLLED_BACK "${PRIOR_IMAGE_ID}" "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 0
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
    return 0
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
finalize_postgres_recovery || die 'PostgreSQL recovered but private configuration or recorded writers could not finalize.'
dr_state_transition "${STATE_PATH}" FINALIZING COMMITTED "${PRIOR_IMAGE_ID}" \
  "${CANDIDATE_IMAGE_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || die 'Finalization could not be committed.'
RECOVERY_REQUIRED=false
trap - EXIT HUP INT TERM
printf 'PostgreSQL DR bootstrap candidate is healthy at %s.\n' "${EXPECTED_IMAGE_DIGEST}"
}
