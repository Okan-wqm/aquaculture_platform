#!/usr/bin/env bash
# Real PostgreSQL recovery proof. This test owns an isolated hosted-runner stack.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] || { printf 'Hosted Actions runner required.\n' >&2; exit 2; }
[ "$(id -u)" = 0 ] || { printf 'Run under sudo on the hosted runner.\n' >&2; exit 2; }
image=${POSTGRES_DR_TEST_IMAGE:?immutable candidate image required}
if [[ "${image}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  [ "$(docker image inspect --format '{{.Id}}' "${image}")" = "${image}" ] || exit 2
elif [[ "${image}" =~ @sha256:[0-9a-f]{64}$ ]]; then
  docker pull "${image}" >/dev/null
else
  exit 2
fi
[[ "${GITHUB_SHA:?checkout SHA required}" =~ ^[0-9a-f]{40}$ ]] || exit 2
[ "$(git -c safe.directory="${PWD}" rev-parse HEAD)" = "${GITHUB_SHA}" ] || exit 2
[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${image}")" = "${GITHUB_SHA}" ] || exit 2
contract_digest=$(sha256sum --binary .github/manifests/postgres-dr-contract.sha256 | awk '{print $1}')
[ "$(docker image inspect --format '{{index .Config.Labels "io.aquaculture.postgres.dr-contract-sha256"}}' "${image}")" = "${contract_digest}" ] || exit 2
source infrastructure/scripts/postgres-dr-recovery.sh
fixture_root=$(mktemp -d /tmp/aqua-dr-contract.XXXXXXXX)
fixture_key="aqua-dr-contract-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
fixture_password=$(openssl rand -hex 24)
source_volume="${fixture_key}-source"
point_volume="${fixture_key}-point"
probe_volume="${fixture_key}-probe"
source_container="${fixture_key}-source"
probe_container="${fixture_key}-probe"
cleanup() {
  docker rm --force "${source_container}" "${probe_container}" >/dev/null 2>&1 || true
  docker volume rm "${source_volume}" "${point_volume}" "${probe_volume}" >/dev/null 2>&1 || true
  rm -rf -- "${fixture_root}"
}
trap cleanup EXIT
for volume in "${source_volume}" "${point_volume}" "${probe_volume}"; do docker volume create "${volume}" >/dev/null; done
source_path=$(docker volume inspect --format '{{.Mountpoint}}' "${source_volume}")
point_path=$(docker volume inspect --format '{{.Mountpoint}}' "${point_volume}")
probe_path=$(docker volume inspect --format '{{.Mountpoint}}' "${probe_volume}")
openssl req -x509 -newkey rsa:2048 -nodes -keyout "${fixture_root}/key.pem" -out "${fixture_root}/cert.pem" \
  -days 1 -subj /CN=localhost >/dev/null 2>&1
chmod 0600 "${fixture_root}/key.pem"
docker run -d --name "${source_container}" --network none --user root \
  -e POSTGRES_PASSWORD="${fixture_password}" -e POSTGRES_USER=aquaculture -e POSTGRES_DB=aquaculture \
  -e PGDATA=/var/lib/postgresql/data -e POSTGRES_SSL=off -e WALG_ENABLED=off \
  --mount "type=volume,source=${source_volume},target=/var/lib/postgresql/data" \
  --entrypoint /usr/local/bin/postgres-ssl-entrypoint.sh "${image}" postgres >/dev/null
wait_ready() {
  local container=$1 deadline=$((SECONDS + 120))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if docker exec "${container}" pg_isready -U aquaculture >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
wait_ready "${source_container}"
docker exec "${source_container}" psql -X -U aquaculture -d aquaculture -v ON_ERROR_STOP=1 \
  -c 'CREATE SCHEMA recovery_fixture; CREATE TABLE recovery_fixture.sentinel (value integer); INSERT INTO recovery_fixture.sentinel VALUES (42);' >/dev/null
docker stop --time 120 "${source_container}" >/dev/null
printf 'legacy-private-fixture\n' > "${source_path}/server.key"
chmod 0600 "${source_path}/server.key"
dr_copy_cluster "${source_path}" "${point_path}"
expected_point=$(dr_cluster_digest "${point_path}")
dr_copy_cluster "${point_path}" "${probe_path}"
start_probe() {
  docker run -d --name "${probe_container}" --network none --user root \
    -e POSTGRES_PASSWORD="${fixture_password}" -e POSTGRES_USER=aquaculture -e POSTGRES_DB=aquaculture \
    -e PGDATA=/var/lib/postgresql/data -e POSTGRES_SSL=on -e WALG_ENABLED=off \
    --mount "type=volume,source=${probe_volume},target=/var/lib/postgresql/data" \
    --mount "type=bind,source=${fixture_root}/cert.pem,target=/var/lib/postgresql/ssl/server.crt,readonly" \
    --mount "type=bind,source=${fixture_root}/key.pem,target=/var/lib/postgresql/ssl/server.key" \
    --mount "type=bind,source=${fixture_root}/cert.pem,target=/var/lib/postgresql/ssl/root.crt,readonly" \
    --tmpfs /run/aqua-postgres-tls:rw,noexec,nosuid,nodev,size=1m,mode=0700 \
    --entrypoint /usr/local/bin/postgres-ssl-entrypoint.sh "${image}" postgres \
    -c ssl=on -c ssl_cert_file=/run/aqua-postgres-tls/server.crt \
    -c ssl_key_file=/run/aqua-postgres-tls/server.key -c ssl_ca_file=/run/aqua-postgres-tls/root.crt "$@" >/dev/null
}
# Fail after the entrypoint has changed TLS ownership and removed legacy keys,
# but before PostgreSQL can report healthy. The retained point must not change.
start_probe -c definitely_invalid_recovery_fixture_setting=1
exit_code=$(docker wait "${probe_container}")
[ "${exit_code}" != 0 ]
[ ! -e "${probe_path}/server.key" ]
[ "$(stat -c '%u:%a' "${fixture_root}/key.pem")" = 0:600 ]
[ "$(dr_cluster_digest "${point_path}")" = "${expected_point}" ]
docker rm "${probe_container}" >/dev/null
find "${probe_path}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
dr_copy_cluster "${point_path}" "${probe_path}"
[ "$(dr_cluster_digest "${probe_path}")" = "${expected_point}" ]
start_probe
wait_ready "${probe_container}"
[ "$(docker exec "${probe_container}" psql -X -U aquaculture -d aquaculture -Atc 'SELECT value FROM recovery_fixture.sentinel')" = 42 ]
[ "$(dr_cluster_digest "${point_path}")" = "${expected_point}" ]
printf 'PostgreSQL cold-copy, TLS-mutation failure and restored-baseline boot verified.\n'
