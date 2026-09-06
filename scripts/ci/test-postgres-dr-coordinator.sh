#!/usr/bin/env bash
# Hosted-only real database proof of the production recovery coordinator.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] && [ "$(id -u)" = 0 ] || exit 2
repository=${DR_FIXTURE_REPOSITORY:-${PWD}}
image=${POSTGRES_DR_TEST_IMAGE:?immutable test image required}
[[ "${image}" =~ ^sha256:[0-9a-f]{64}$ || "${image}" =~ @sha256:[0-9a-f]{64}$ ]] || exit 2
image_id=$(docker image inspect --format '{{.Id}}' "${image}")
[[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 2
[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image_id}")" = "${GITHUB_SHA:?}" ] || exit 2
[ "$(git -c safe.directory="${repository}" -C "${repository}" rev-parse HEAD)" = "${GITHUB_SHA}" ] || exit 2
contract_digest=$(sha256sum --binary "${repository}/.github/manifests/postgres-dr-contract.sha256" | awk '{print $1}')
[ "$(docker image inspect --format '{{index .Config.Labels "io.aquaculture.postgres.dr-contract-sha256"}}' "${image_id}")" = "${contract_digest}" ] || exit 2

if [ "${1:-}" = attempt ]; then
  source "${repository}/scripts/deploy/deploy-paths.sh"
  acquire_deploy_control_lock
  source "${repository}/infrastructure/scripts/postgres-dr-bootstrap-state.sh"
  source "${repository}/infrastructure/scripts/postgres-dr-recovery.sh"
  source "${repository}/infrastructure/scripts/postgres-dr-coordinator.sh"
  source "${DR_FIXTURE_CASE_ROOT:?}/coordinates.sh"
  export DEPLOY_CERTS_DIR="${CERTS_REAL_ROOT}" DR_BOOTSTRAP_RELEASE_ROOT="${repository%/repository}"
  # The fixture owns its source/image authority. Production uses the signed
  # provider's boundary callbacks; all state, recovery, Docker/SQL and archive
  # health operations below are the actual production implementations.
  die() { printf 'fixture coordinator: %s\n' "$*" >&2; exit 2; }
  require_execution_boundaries() {
    [ "$(git -c safe.directory="${repository}" -C "${repository}" rev-parse HEAD)" = "${EXPECTED_MAIN_SHA}" ] || return
    [ "$(docker image inspect --format '{{.Id}}' "${image_id}")" = "${image_id}" ] || return
    acquire_deploy_control_lock || return
    dr_state_validate "${STATE_PATH}" Okan-wqm/aquaculture_platform "${EXPECTED_MAIN_SHA}" "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" "${EXPECTED_IMAGE_DIGEST}"
  }
  verify_candidate_supply_chain() {
    [ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image_id}")" = "${EXPECTED_MAIN_SHA}" ] || return
    CANDIDATE_IMAGE_ID=${image_id}
    # Supply-chain artifacts are fixture-authorized here; the strict terminal
    # reader still consumes its exact production artifact schema and bindings.
    jq -n --arg sha "${EXPECTED_MAIN_SHA}" --arg run "${EXPECTED_RUN_ID}" --arg attempt "${EXPECTED_RUN_ATTEMPT}" --arg digest "${EXPECTED_IMAGE_DIGEST}" \
      '{schema_version:1,predicate_type:"https://github.com/Okan-wqm/aquaculture_platform/attestations/postgres-dr-bootstrap-candidate/v1",
        source:{repository:"Okan-wqm/aquaculture_platform",main_sha:$sha},build:{run_id:$run,run_attempt:$attempt},
        image:{repository:"ghcr.io/okan-wqm/aquaculture_platform/postgres",digest:$digest,reference:("ghcr.io/okan-wqm/aquaculture_platform/postgres@"+$digest)},
        bootstrap:{},materials:[],policy:{},postgres_dr_contract_sha256:"fixture-authority"}' > "${STATE_DIR}/local-candidate.json"
    printf '[{"fixture_authorized":true}]\n' > "${STATE_DIR}/image-signature.json"
    printf '{"fixture_authorized":true}\n' > "${STATE_DIR}/image-attestations.jsonl"
    chmod 0400 "${STATE_DIR}/local-candidate.json" "${STATE_DIR}/image-signature.json" "${STATE_DIR}/image-attestations.jsonl"
  }
  verify_walg_secret_bundle() {
    (cd "${CERTS_REAL_ROOT}/wal-g/postgres" && sha256sum --strict --check manifest.sha256 >/dev/null)
  }
  dr_state_reconcile_staging "${STATE_PATH}" Okan-wqm/aquaculture_platform "${EXPECTED_MAIN_SHA}" "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" "${EXPECTED_IMAGE_DIGEST}"
  if [ ! -e "${STATE_PATH}" ]; then
    dr_state_initialize "${STATE_PATH}" Okan-wqm/aquaculture_platform "${EXPECTED_MAIN_SHA}" "${EXPECTED_RUN_ID}" "${EXPECTED_RUN_ATTEMPT}" "${EXPECTED_IMAGE_DIGEST}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  # Faults live only in this hosted test process. No production bypass flag or
  # injected command exists in the signed coordinator.
  df() {
    if [ "${DR_FIXTURE_FAULT:-}" = capacity ] && [ "${1:-}" = --output=avail ]; then
      printf 'Avail\n%s\n' "${DR_FIXTURE_AVAILABLE_BYTES:?capacity boundary required}"
    else
      command df "$@"
    fi
  }
  eval "$(declare -f dr_state_transition | sed '1s/dr_state_transition/fixture_actual_transition/')"
  dr_state_transition() {
    fixture_actual_transition "$@" || return
    if [ "${DR_FIXTURE_FAULT:-}" = "before-$3" ]; then kill -KILL "${BASHPID}"; fi
  }
  eval "$(declare -f resume_postgres_recovery_writers | sed '1s/resume_postgres_recovery_writers/fixture_actual_resume/')"
  resume_postgres_recovery_writers() {
    fixture_actual_resume || return
    if [ ! -f "${DR_FIXTURE_CASE_ROOT}/writer-sentinel-inserted" ]; then
      docker exec aqua-dr-fixture-writer /bin/bash -c 'PGPASSWORD="$DR_FIXTURE_PASSWORD" psql -X -h aqua-postgres -U aquaculture -d aquaculture -v ON_ERROR_STOP=1 -c "INSERT INTO recovery_fixture.sentinel VALUES (84)"' >/dev/null || return
      : > "${DR_FIXTURE_CASE_ROOT}/writer-sentinel-inserted"
      sync -f "${DR_FIXTURE_CASE_ROOT}/writer-sentinel-inserted"
      sync -f "${DR_FIXTURE_CASE_ROOT}"
    fi
    if [ "${DR_FIXTURE_FAULT:-}" = "after-$(dr_state_phase "${STATE_PATH}")" ]; then kill -KILL "${BASHPID}"; fi
  }
  eval "$(declare -f render_image_override | sed '1s/render_image_override/fixture_actual_override/')"
  render_image_override() {
    fixture_actual_override "$@" || return
    case "${DR_FIXTURE_FAULT:-}:$1" in
      forward-failure:"${FORWARD_OVERRIDE}"|rollback-failure:"${FORWARD_OVERRIDE}"|rollback-failure:"${ROLLBACK_OVERRIDE}"|before-ROLLBACK_FINALIZING:"${FORWARD_OVERRIDE}"|after-ROLLBACK_FINALIZING:"${FORWARD_OVERRIDE}")
        chmod 0600 "$1"
        printf "    command: ['postgres', '-c', 'invalid_coordinator_fixture_setting=1']\n" >> "$1"
        chmod 0400 "$1"
        ;;
    esac
  }
  # Exercise the actual phase/result/override publisher crash windows too.
  eval "$(declare -f _dr_state_publish | sed '1s/_dr_state_publish/fixture_actual_phase_publish/')"
  _dr_state_publish() {
    if [ "${DR_FIXTURE_FAULT:-}" = phase-publish ] && [ -f "$2" ]; then
      chmod 0400 "$1"; sync -f "$1"; kill -KILL "${BASHPID}"
    fi
    fixture_actual_phase_publish "$@"
  }
  eval "$(declare -f publish_state_file | sed '1s/publish_state_file/fixture_actual_artifact_publish/')"
  publish_state_file() {
    if { [ "${DR_FIXTURE_FAULT:-}" = result-publish ] && [ "${2##*/}" = result.json ]; } ||
       { [ "${DR_FIXTURE_FAULT:-}" = override-publish ] && [ "${2##*/}" = postgres-forward.override.yml ]; }; then
      chmod 0400 "$1"; sync -f "$1"; kill -KILL "${BASHPID}"
    fi
    fixture_actual_artifact_publish "$@"
  }
  run_postgres_recovery_coordinator
  exit 0
fi

# The runner must start without the canonical live names. Ownership is acquired
# once here and cleanup only removes resources created by this fixture.
if docker inspect aqua-postgres >/dev/null 2>&1 || docker volume inspect aqua-saas_postgres_data >/dev/null 2>&1; then
  printf 'Canonical fixture names are already occupied.\n' >&2; exit 2
fi
DR_FIXTURE_PASSWORD=$(openssl rand -hex 32)
DR_FIXTURE_ACCESS="fixture-$(openssl rand -hex 8)"
DR_FIXTURE_S3_SECRET=$(openssl rand -hex 32)
export DR_FIXTURE_PASSWORD DR_FIXTURE_ACCESS DR_FIXTURE_S3_SECRET
fixture_root=$(mktemp -d /tmp/aqua-dr-coordinator.XXXXXXXX)
config_root=/var/lib/aqua/deploy/config-generations
[ ! -e "${config_root}/current" ] && [ ! -L "${config_root}/current" ] || exit 2
install -d -m 0700 "${config_root}"
fixture_key="aqua-dr-coordinator-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
fixture_network="${fixture_key}"
minio_container="${fixture_key}-minio"
created_keys=()
cleanup() {
  local fixture_status=$?
  if [ "${fixture_status}" -ne 0 ]; then
    # Failure is evidence too: preserve bounded, redacted fixture diagnostics
    # before destroying its private TLS/environment and Docker resources.
    if ! python3 - "${repository}" "${fixture_root}" "${fixture_status}" "${scenario:-setup}" "${image_id}" <<'PY'
import json
import os
from pathlib import Path
import sys

repository, fixture_root, status, scenario, image_id = sys.argv[1:]
output = Path(repository) / 'artifacts/postgres-recovery'
output.mkdir(parents=True, exist_ok=True)
record = {'github_sha': os.environ['GITHUB_SHA'], 'run_id': os.environ['GITHUB_RUN_ID'],
          'run_attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'candidate_image_id': image_id,
          'success': False, 'exit_status': int(status), 'scenario': scenario}
case = Path(fixture_root) / scenario
phases = list(case.glob('journal/*/phase.json'))
if len(phases) == 1:
    try:
        record['phase'] = json.loads(phases[0].read_text()).get('phase')
    except (OSError, json.JSONDecodeError):
        record['phase'] = 'unreadable'
for name in ('capacity-initial.log', 'attempt.log', 'capacity-retry.log', 'reentry.log'):
    source = case / name
    if not source.is_file():
        continue
    content = source.read_text(errors='replace')
    for variable in ('DR_FIXTURE_PASSWORD', 'DR_FIXTURE_ACCESS', 'DR_FIXTURE_S3_SECRET'):
        secret = os.environ.get(variable)
        if secret:
            content = content.replace(secret, '[redacted-fixture-credential]')
    target = output / f'{scenario}-{name}'
    target.write_text(content[-65536:])
    target.chmod(0o644)
summary = output / 'failure-summary.json'
summary.write_text(json.dumps(record, indent=2) + '\n')
summary.chmod(0o644)
PY
    then
      printf 'Could not preserve coordinator fixture failure diagnostics.\n' >&2
    fi
  fi
  docker rm --force aqua-postgres aqua-dr-fixture-writer "${minio_container}" >/dev/null 2>&1 || true
  docker volume rm aqua-saas_postgres_data >/dev/null 2>&1 || true
  for key in "${created_keys[@]}"; do
    docker rm --force "aqua-dr-probe-${key}" >/dev/null 2>&1 || true
    docker volume rm "aqua-dr-point-${key}" "aqua-dr-probe-${key}" >/dev/null 2>&1 || true
    rm -rf -- "/var/lib/aqua/deploy/dr-recovery/${key}"
    generation_attempt=${key#${GITHUB_SHA}-${GITHUB_RUN_ID}-}
    rm -rf -- "${config_root}/${GITHUB_SHA}/${GITHUB_RUN_ID}-${generation_attempt}"
  done
  if [ -f "${config_root}/current" ]; then
    current=$(cat "${config_root}/current")
    for key in "${created_keys[@]}"; do
      generation_attempt=${key#${GITHUB_SHA}-${GITHUB_RUN_ID}-}
      if [ "${current}" = "${GITHUB_SHA}/${GITHUB_RUN_ID}-${generation_attempt}" ]; then rm -f "${config_root}/current"; fi
    done
  fi
  docker network rm "${fixture_network}" >/dev/null 2>&1 || true
  rm -rf -- "${fixture_root}"
}
trap cleanup EXIT
docker network create "${fixture_network}" >/dev/null
docker run -d --name "${minio_container}" --network "${fixture_network}" --network-alias dr-minio \
  -e MINIO_ROOT_USER="${DR_FIXTURE_ACCESS}" -e MINIO_ROOT_PASSWORD="${DR_FIXTURE_S3_SECRET}" \
  quay.io/minio/minio:RELEASE.2025-04-03T14-56-28Z server /data >/dev/null
minio_address=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${minio_container}")
for attempt in $(seq 1 60); do
  if curl --silent --fail "http://${minio_address}:9000/minio/health/ready" >/dev/null; then break; fi
  sleep 1
done
curl --silent --show-error --fail --aws-sigv4 'aws:amz:us-east-1:s3' \
  --user "${DR_FIXTURE_ACCESS}:${DR_FIXTURE_S3_SECRET}" -X PUT "http://${minio_address}:9000/coordinator" >/dev/null
DEPLOY_CERTS_DIR="${fixture_root}/seed-certs" bash "${repository}/infrastructure/docker/scripts/generate-internal-certs.sh" >/dev/null
legacy_digest=timescale/timescaledb-ha@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7
docker pull "${legacy_digest}" >/dev/null
docker tag "${legacy_digest}" timescale/timescaledb-ha:pg16
source "${repository}/infrastructure/scripts/postgres-dr-recovery.sh"
scenario_index=0
scenarios=(healthy degraded forward-failure rollback-failure before-FINALIZING after-FINALIZING before-ROLLBACK_FINALIZING after-ROLLBACK_FINALIZING phase-publish result-publish override-publish)
scenario_results=()
capacity_results=()
for scenario in "${scenarios[@]}"; do
  scenario_index=$((scenario_index + 1))
  case_root="${fixture_root}/${scenario}"
  mkdir -m 0700 "${case_root}"
  export DR_FIXTURE_REPOSITORY="${repository}" DR_FIXTURE_CASE_ROOT="${case_root}"
  expected_attempt="${GITHUB_RUN_ATTEMPT}${scenario_index}"
  run_key="${GITHUB_SHA}-${GITHUB_RUN_ID}-${expected_attempt}"
  created_keys+=("${run_key}")
  cp -aL "${fixture_root}/seed-certs" "${case_root}/certs"
  install -d -m 0700 "${case_root}/journal" "${case_root}/journal/${run_key}"
  secret_root="${case_root}/certs/wal-g/postgres"
  mkdir -p -m 0700 "${secret_root}"
  printf '%s' "${DR_FIXTURE_ACCESS}" > "${secret_root}/aws_access_key_id"
  printf '%s' "${DR_FIXTURE_S3_SECRET}" > "${secret_root}/aws_secret_access_key"
  head -c 32 /dev/urandom > "${secret_root}/libsodium.key"
  printf 'coordinator-%s' "${scenario_index}" > "${secret_root}/walg_backup_epoch"
  printf 's3://coordinator/postgres/wal-g/coordinator-%s' "${scenario_index}" > "${secret_root}/walg_s3_prefix"
  : > "${secret_root}/.lock"
  (cd "${secret_root}" && sha256sum aws_access_key_id aws_secret_access_key libsodium.key walg_backup_epoch walg_s3_prefix > manifest.sha256)
  chmod 0400 "${secret_root}"/* "${secret_root}/.lock"
  printf 'POSTGRES_USER=aquaculture\nPOSTGRES_DB=aquaculture\nPOSTGRES_PASSWORD=%s\n' "${DR_FIXTURE_PASSWORD}" > "${case_root}/runtime.env"
  chmod 0400 "${case_root}/runtime.env"
  generation="${config_root}/${GITHUB_SHA}/${GITHUB_RUN_ID}-${expected_attempt}"
  [ ! -e "${generation}" ] || exit 2
  install -d -m 0700 "${generation}"
  cp -a "${case_root}/certs" "${generation}/certs"
  cp -a "${case_root}/runtime.env" "${generation}/.env"
  # The fixture Compose keeps exactly the production PGDATA, TLS tmpfs,
  # root entrypoint, WAL-G environment and named-volume contract.
  python3 - "${case_root}" "${fixture_network}" "${image_id}" "${scenario_index}" <<'PY'
import json
import os
from pathlib import Path
import sys
root, network, image, index = sys.argv[1:]
base = Path(root)
environment = {
  'POSTGRES_USER': 'aquaculture', 'POSTGRES_DB': 'aquaculture', 'POSTGRES_PASSWORD': os.environ['DR_FIXTURE_PASSWORD'],
  'PGDATA': '/var/lib/postgresql/data', 'POSTGRES_SSL': 'on', 'POSTGRES_SSL_RUNTIME_DIR': '/run/aqua-postgres-tls',
  'WALG_ENABLED': 'on', 'WALG_BACKUP_EPOCH': f'coordinator-{index}',
  'WALG_S3_PREFIX': f's3://coordinator/postgres/wal-g/coordinator-{index}', 'WALG_S3_ENDPOINT': 'http://dr-minio:9000',
  'WALG_S3_REGION': 'us-east-1', 'AWS_S3_FORCE_PATH_STYLE': 'true',
  'WALG_RPO_BUDGET_SECONDS': '300', 'WALG_ARCHIVE_SWITCH_BUDGET_SECONDS': '225',
  'WALG_WAL_PUSH_BUDGET_SECONDS': '45', 'WALG_HEALTH_DETECTION_BUDGET_SECONDS': '30',
  'WALG_SECRET_SOURCE_DIR': '/var/lib/postgresql/wal-g-secrets-source',
  'WALG_SECRET_RUNTIME_DIR': '/run/aqua-walg-secrets', 'WALG_SECRET_DIR': '/run/aqua-walg-secrets',
}
command = ['postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/run/aqua-postgres-tls/server.crt',
  '-c', 'ssl_key_file=/run/aqua-postgres-tls/server.key', '-c', 'ssl_ca_file=/run/aqua-postgres-tls/root.crt',
  '-c', 'archive_mode=on', '-c', 'archive_command=/usr/local/bin/walg-archive-command.sh %p %f', '-c', 'archive_timeout=225s']
mounts = [{'type': 'volume', 'source': 'postgres_data', 'target': '/var/lib/postgresql/data'}]
for source, target, readonly in [('postgres/postgres-cert.pem', 'ssl/server.crt', True), ('postgres/postgres-key.pem', 'ssl/server.key', False), ('postgres/ca-cert.pem', 'ssl/root.crt', True), ('wal-g/postgres', 'wal-g-secrets-source', True)]:
  mounts.append({'type': 'bind', 'source': '${DEPLOY_CERTS_DIR}/' + source, 'target': '/var/lib/postgresql/' + target, 'read_only': readonly})
model = {'services': {'postgres': {'image': image, 'container_name': 'aqua-postgres', 'user': 'root',
  'environment': environment, 'entrypoint': ['/usr/local/bin/postgres-ssl-entrypoint.sh'], 'command': command,
  'volumes': mounts, 'tmpfs': ['/run/aqua-postgres-tls:rw,noexec,nosuid,nodev,size=1m,mode=0700', '/run/aqua-walg-secrets:rw,noexec,nosuid,nodev,size=1m,mode=0700'],
  'healthcheck': {'test': ['CMD', '/usr/local/bin/postgres-walg-healthcheck.sh'], 'interval': '1s', 'timeout': '5s', 'retries': 5}}},
  'volumes': {'postgres_data': {'name': 'aqua-saas_postgres_data'}}, 'networks': {'default': {'external': True, 'name': network}}}
(base / 'compose.json').write_text(json.dumps(model))
# Same baseline override command/TLS contract as production, with fixture-owned
# signed init directory supplied by the coordinator's last override.
(base / 'rollback.yml').write_text('''services:
  postgres:
    environment:
      WALG_ENABLED: 'off'
    command: ['postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/run/aqua-postgres-tls/server.crt', '-c', 'ssl_key_file=/run/aqua-postgres-tls/server.key', '-c', 'ssl_ca_file=/run/aqua-postgres-tls/root.crt']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U aquaculture -d aquaculture']
      interval: 1s
      timeout: 5s
      retries: 5
''')
(base / 'legacy.yml').write_text('''services:
  postgres:
    image: timescale/timescaledb-ha:pg16
    entrypoint: ['/bin/sh']
    command: ['-c', 'exit 126']
''')
PY
  mode=healthy_upgrade
  [ "${scenario}" != degraded ] || mode=degraded_legacy_recovery
  {
    printf 'EXPECTED_MAIN_SHA=%q\nEXPECTED_RUN_ID=%q\nEXPECTED_RUN_ATTEMPT=%q\n' "${GITHUB_SHA}" "${GITHUB_RUN_ID}" "${expected_attempt}"
    printf 'EXPECTED_IMAGE_DIGEST=%q\nIMAGE_REF=%q\nRUN_KEY=%q\nDR_BOOTSTRAP_MODE=%q\n' "${image_id}" "${image_id}" "${run_key}" "${mode}"
    printf 'STATE_DIR=%q\nSTATE_PATH=%q\n' "${case_root}/journal/${run_key}" "${case_root}/journal/${run_key}/phase.json"
    printf 'DEPLOY_ROOT=%q\nDEPLOY_ENV_FILE=%q\nCERTS_REAL_ROOT=%q\n' "${case_root}" "${generation}/.env" "${generation}/certs"
    printf 'SIGNED_COMPOSE_PATH=%q\nSIGNED_ROLLBACK_COMPOSE_PATH=%q\nSIGNED_INIT_DIRECTORY=%q\n' "${case_root}/compose.json" "${case_root}/rollback.yml" "${repository}/infrastructure/docker/init-scripts"
    printf 'FORWARD_OVERRIDE=%q\nROLLBACK_OVERRIDE=%q\n' "${case_root}/journal/${run_key}/postgres-forward.override.yml" "${case_root}/journal/${run_key}/postgres-rollback.override.yml"
  } > "${case_root}/coordinates.sh"
  chmod 0400 "${case_root}/coordinates.sh"
  # The observed production service is Compose-owned. Seed through Compose so
  # its config-hash/oneoff/service labels and volume ownership are real; adding
  # only project/service labels to docker run leaves an unadoptable namesake.
  DEPLOY_CERTS_DIR="${generation}/certs" docker compose \
    --project-name aqua-saas --project-directory "${case_root}" \
    --env-file "${generation}/.env" -f "${case_root}/compose.json" -f "${case_root}/rollback.yml" \
    up -d --no-deps --no-build --pull never postgres >/dev/null
  for attempt in $(seq 1 60); do
    [ "$(docker inspect --format '{{.State.Health.Status}}' aqua-postgres)" != healthy ] || break
    sleep 1
  done
  [ "$(docker inspect --format '{{.State.Health.Status}}' aqua-postgres)" = healthy ]
  docker exec aqua-postgres psql -X -U aquaculture -d aquaculture -v ON_ERROR_STOP=1 \
    -c 'CREATE EXTENSION vector; CREATE SCHEMA recovery_fixture; CREATE TABLE recovery_fixture.sentinel(value integer); INSERT INTO recovery_fixture.sentinel VALUES (42); CREATE TABLE recovery_fixture.writer_ticks(at timestamptz DEFAULT clock_timestamp());' >/dev/null
  docker exec --user root aqua-postgres /bin/bash -c 'printf "legacy-hosted-fixture\n" > /var/lib/postgresql/data/server.key; chmod 0600 /var/lib/postgresql/data/server.key'
  if [ "${scenario}" = degraded ]; then
    docker stop --time 120 aqua-postgres >/dev/null
    DEPLOY_CERTS_DIR="${generation}/certs" docker compose \
      --project-name aqua-saas --project-directory "${case_root}" \
      --env-file "${generation}/.env" -f "${case_root}/compose.json" \
      -f "${case_root}/rollback.yml" -f "${case_root}/legacy.yml" \
      up -d --no-deps --no-build --force-recreate --pull never postgres >/dev/null
    [ "$(docker wait aqua-postgres)" = 126 ]
  fi
  [ -n "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' aqua-postgres)" ]
  docker run -d --name aqua-dr-fixture-writer --network "${fixture_network}" \
    --label com.docker.compose.project=aqua-saas --label com.docker.compose.service=fixture-writer \
    -e DR_FIXTURE_PASSWORD="${DR_FIXTURE_PASSWORD}" \
    --entrypoint /bin/bash "${image_id}" -c 'while true; do PGPASSWORD="$DR_FIXTURE_PASSWORD" psql -X -h aqua-postgres -U aquaculture -d aquaculture -c "INSERT INTO recovery_fixture.writer_ticks DEFAULT VALUES" >/dev/null 2>&1 || true; sleep 1; done' >/dev/null
  if [ "${scenario}" = healthy ]; then
    data_path=$(docker volume inspect --format '{{.Mountpoint}}' aqua-saas_postgres_data)
    copy_bytes=$(dr_cluster_copy_bytes "${data_path}")
    # This amount passed the old two-copy admission but cannot accommodate the
    # retained probe and failed-forward cluster during the first rollback.
    capacity_limit=$((copy_bytes * 2 + copy_bytes / 5 + 1073741824))
    before_container=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' aqua-postgres)
    before_writer=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' aqua-dr-fixture-writer)
    set +e
    DR_FIXTURE_FAULT=capacity DR_FIXTURE_AVAILABLE_BYTES="${capacity_limit}" bash "${BASH_SOURCE[0]}" attempt > "${case_root}/capacity-initial.log" 2>&1
    capacity_status=$?
    set -e
    [ "${capacity_status}" != 0 ]
    grep -Fq 'Recovery capacity refused:' "${case_root}/capacity-initial.log"
    [ "$(jq -r .phase "${case_root}/journal/${run_key}/phase.json")" = VERIFYING ]
    [ "$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' aqua-postgres)" = "${before_container}" ]
    [ "$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' aqua-dr-fixture-writer)" = "${before_writer}" ]
    [ "$(docker inspect --format '{{.State.Running}}' aqua-postgres)" = true ]
    [ "$(docker inspect --format '{{.State.Running}}' aqua-dr-fixture-writer)" = true ]
    [ ! -e "/var/lib/aqua/deploy/dr-recovery/${run_key}/writers" ]
    [ ! -e "${case_root}/journal/${run_key}/recovery-point.json" ]
    [ "$(docker exec aqua-postgres psql -X -U aquaculture -d aquaculture -Atc 'SELECT count(*) FROM recovery_fixture.sentinel WHERE value=42')" = 1 ]
    capacity_results+=(initial-admission-refused-before-writer-stop)
  fi
  fault=${scenario}
  case "${scenario}" in healthy|degraded) fault= ;; esac
  set +e
  DR_FIXTURE_FAULT="${fault}" bash "${BASH_SOURCE[0]}" attempt > "${case_root}/attempt.log" 2>&1
  first_status=$?
  set -e
  if [ -z "${fault}" ]; then
    [ "${first_status}" = 0 ] || { cat "${case_root}/attempt.log"; exit 1; }
  else
    [ "${first_status}" != 0 ] || exit 1
    phase=$(jq -r .phase "${case_root}/journal/${run_key}/phase.json")
    case "${scenario}" in
      forward-failure) [ "${phase}" = ROLLED_BACK ] ;;
      rollback-failure) [ "${phase}" = RECOVERY_REQUIRED ] ;;
      before-FINALIZING|after-FINALIZING) [ "${phase}" = FINALIZING ] ;;
      before-ROLLBACK_FINALIZING|after-ROLLBACK_FINALIZING) [ "${phase}" = ROLLBACK_FINALIZING ] ;;
    esac
    if [[ "${scenario}" = after-* ]]; then
      [ "$(docker exec aqua-postgres psql -X -U aquaculture -d aquaculture -Atc 'SELECT count(*) FROM recovery_fixture.sentinel WHERE value=84')" -ge 1 ]
    fi
    if [ "${scenario}" != forward-failure ]; then
      if [ "${scenario}" = rollback-failure ]; then
        snapshot_path=$(docker volume inspect --format '{{.Mountpoint}}' "aqua-dr-point-${run_key}")
        data_path=$(docker volume inspect --format '{{.Mountpoint}}' aqua-saas_postgres_data)
        copy_bytes=$(dr_cluster_copy_bytes "${snapshot_path}")
        capacity_limit=$((copy_bytes + copy_bytes / 5 + 1073741824 - 1))
        before_container=$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' aqua-postgres)
        before_data_digest=$(dr_cluster_digest "${data_path}")
        before_point_digest=$(dr_cluster_digest "${snapshot_path}")
        before_retained_count=$(find "/var/lib/aqua/deploy/dr-recovery/${run_key}" -mindepth 1 -maxdepth 1 -type d -name 'failed-forward.*' | wc -l)
        set +e
        DR_FIXTURE_FAULT=capacity DR_FIXTURE_AVAILABLE_BYTES="${capacity_limit}" bash "${BASH_SOURCE[0]}" attempt > "${case_root}/capacity-retry.log" 2>&1
        capacity_status=$?
        set -e
        [ "${capacity_status}" != 0 ]
        grep -Fq 'Recovery capacity refused:' "${case_root}/capacity-retry.log"
        [ "$(jq -r .phase "${case_root}/journal/${run_key}/phase.json")" = ROLLBACK_STARTED ]
        [ "$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' aqua-postgres)" = "${before_container}" ]
        [ "$(dr_cluster_digest "${data_path}")" = "${before_data_digest}" ]
        [ "$(dr_cluster_digest "${snapshot_path}")" = "${before_point_digest}" ]
        [ "$(find "/var/lib/aqua/deploy/dr-recovery/${run_key}" -mindepth 1 -maxdepth 1 -type d -name 'failed-forward.*' | wc -l)" = "${before_retained_count}" ]
        [ "$(docker inspect --format '{{.State.Running}}' aqua-dr-fixture-writer)" = false ]
        capacity_results+=(rollback-retry-refused-before-data-move)
      fi
      set +e
      DR_FIXTURE_FAULT='' bash "${BASH_SOURCE[0]}" attempt > "${case_root}/reentry.log" 2>&1
      second_status=$?
      set -e
      phase=$(jq -r .phase "${case_root}/journal/${run_key}/phase.json")
      # Successful rollback requires a new signed run; its exit stays nonzero.
      if [ "${phase}" != ROLLED_BACK ]; then
        [ "${second_status}" = 0 ] || { cat "${case_root}/reentry.log"; exit 1; }
      fi
    fi
  fi
  phase=$(jq -r .phase "${case_root}/journal/${run_key}/phase.json")
  case "${phase}" in COMMITTED|ROLLED_BACK) ;; *) cat "${case_root}/attempt.log"; exit 1 ;; esac
  [ "$(docker exec aqua-postgres psql -X -U aquaculture -d aquaculture -Atc 'SELECT count(*) FROM recovery_fixture.sentinel WHERE value=42')" = 1 ]
  [ "$(docker exec aqua-postgres psql -X -U aquaculture -d aquaculture -Atc 'SELECT count(*) FROM recovery_fixture.sentinel WHERE value=84')" -ge 1 ]
  [ "$(docker inspect --format '{{.State.Running}}' aqua-dr-fixture-writer)" = true ]
  # Quiescence was recorded by the real preparation path, and the pristine
  # recovery point still matches its journal binding after all failures.
  [ "$(wc -l < "/var/lib/aqua/deploy/dr-recovery/${run_key}/writers")" = 1 ]
  [ "$(sha256sum "${case_root}/journal/${run_key}/recovery-point.json" | awk '{print $1}')" = "$(jq -r .recovery_point_sha256 "${case_root}/journal/${run_key}/phase.json")" ]
  snapshot_path=$(docker volume inspect --format '{{.Mountpoint}}' "aqua-dr-point-${run_key}")
  [ "$(dr_cluster_digest "${snapshot_path}")" = "$(jq -r .snapshot_sha256 "${case_root}/journal/${run_key}/recovery-point.json")" ]
  [ "$(cat "${snapshot_path}/server.key")" = legacy-hosted-fixture ]
  [ "$(docker exec aqua-postgres psql -X -U aquaculture -d aquaculture -Atc "SELECT count(*) FROM pg_extension WHERE extname='vector'")" = 1 ]
  /usr/bin/python3 "${repository}/scripts/deploy/validate-postgres-dr-state.py" "${case_root}/journal" 0
  printf 'Coordinator scenario verified: %s (%s)\n' "${scenario}" "${phase}"
  docker rm --force aqua-postgres aqua-dr-fixture-writer >/dev/null
  docker volume rm aqua-saas_postgres_data >/dev/null
  docker rm --force "aqua-dr-probe-${run_key}" >/dev/null
  docker volume rm "aqua-dr-point-${run_key}" "aqua-dr-probe-${run_key}" >/dev/null
  rm -rf -- "/var/lib/aqua/deploy/dr-recovery/${run_key}"
  scenario_results+=("${scenario}:${phase}")
done
# Publish only after every actual coordinator scenario and its assertions ran.
# The required CI job validates these coordinates before issuing its receipt.
python3 - "${repository}" "${image}" "${image_id}" "${contract_digest}" "${#scenarios[@]}" "${capacity_results[*]}" "${scenario_results[@]}" <<'PY'
import json
import os
from pathlib import Path
import sys

repository, reference, image_id, contract_digest, expected_count, capacity_results, *results = sys.argv[1:]
scenarios = [dict(zip(('name', 'terminal_phase'), result.split(':', 1))) for result in results]
if len(scenarios) != int(expected_count) or not scenarios or len({item['name'] for item in scenarios}) != len(scenarios):
    raise SystemExit('Coordinator proof did not execute every required scenario')
if any(item['terminal_phase'] not in {'COMMITTED', 'ROLLED_BACK'} for item in scenarios):
    raise SystemExit('Coordinator proof contains an unresolved scenario')
capacity_results = capacity_results.split()
if set(capacity_results) != {'initial-admission-refused-before-writer-stop', 'rollback-retry-refused-before-data-move'} or len(capacity_results) != 2:
    raise SystemExit('Coordinator proof did not execute both capacity boundaries')
record = {
    'schema_version': 1, 'github_sha': os.environ['GITHUB_SHA'],
    'run_id': os.environ['GITHUB_RUN_ID'], 'run_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
    'candidate_reference': reference, 'candidate_image_id': image_id,
    'postgres_dr_contract_sha256': contract_digest,
    'expected_scenarios': int(expected_count), 'executed_scenarios': len(scenarios), 'skipped_scenarios': 0,
    'scenarios': [dict(item, passed=True) for item in scenarios],
    'capacity_boundaries': [dict(name=name, passed=True) for name in capacity_results],
}
output = Path(repository) / 'artifacts/postgres-recovery'
output.mkdir(parents=True, exist_ok=True)
temporary = output / '.coordinator-results.json'
temporary.write_text(json.dumps(record, indent=2) + '\n')
temporary.chmod(0o644)
temporary.replace(output / 'coordinator-results.json')
PY
