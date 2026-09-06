#!/usr/bin/env bash
# Exact candidate broker ACL, exercised only on a fresh GitHub-hosted runner.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || exit 2
repository=${PWD}
fixture_root=$(mktemp -d /tmp/aqua-nats-production-acl.XXXXXXXX)
fixture_container="aqua-nats-production-acl-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
cleanup() {
  local status=$?
  if [ "${status}" -ne 0 ]; then
    docker logs --tail 100 "${fixture_container}" > artifacts/authentication-proof/nats-broker.log 2>&1 || true
    docker inspect --format '{{json .State}} user={{.Config.User}}' "${fixture_container}" \
      > artifacts/authentication-proof/nats-broker-state.txt 2>&1 || true
  fi
  docker rm -fv "${fixture_container}" >/dev/null 2>&1 || true
  rm -rf -- "${fixture_root}"
}
trap cleanup EXIT
mkdir -p "${fixture_root}/certs" "${fixture_root}/clients" artifacts/authentication-proof
# These are disposable fixture identities, never deployment credentials.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Hosted NATS Test CA' \
  -keyout "${fixture_root}/ca-key.pem" -out "${fixture_root}/certs/ca-cert.pem" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "${fixture_root}/certs/nats-key.pem" -out "${fixture_root}/server.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -in "${fixture_root}/server.csr" -copy_extensions copyall \
  -CA "${fixture_root}/certs/ca-cert.pem" -CAkey "${fixture_root}/ca-key.pem" -CAcreateserial \
  -out "${fixture_root}/certs/nats-cert.pem" >/dev/null 2>&1
python3 - <<'PYTHON' > "${fixture_root}/identities"
import yaml
from pathlib import Path
for service in yaml.safe_load(Path('infrastructure/nats/services.yaml').read_text())['services']:
    print(service['name'])
PYTHON
while IFS= read -r identity; do
  [[ "${identity}" =~ ^[a-z][a-z0-9_-]+$ ]] || exit 2
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=${identity}" \
    -keyout "${fixture_root}/clients/${identity}-key.pem" -out "${fixture_root}/client.csr" >/dev/null 2>&1
  openssl x509 -req -days 1 -in "${fixture_root}/client.csr" \
    -CA "${fixture_root}/certs/ca-cert.pem" -CAkey "${fixture_root}/ca-key.pem" -CAcreateserial \
    -out "${fixture_root}/clients/${identity}-cert.pem" >/dev/null 2>&1
done < "${fixture_root}/identities"
# The pinned image runs as root; prove that contract before mounting mode-0600
# ephemeral keys. A future image UID change must update fixture ownership.
docker pull --quiet nats:2.10.24-alpine >/dev/null
broker_user=$(docker image inspect --format '{{.Config.User}}' nats:2.10.24-alpine)
case "${broker_user}" in
  ''|0|root|0:0|root:root) ;;
  *) printf 'Pinned NATS image UID contract changed: %s\n' "${broker_user}" >&2; exit 2 ;;
esac
# No generation/repair here: mount the candidate's committed ACL and TLS contract.
docker run -d --name "${fixture_container}" \
  -p 127.0.0.1::4222 -p 127.0.0.1::8222 \
  -v "${repository}/infrastructure/docker/nats/nats.conf:/etc/nats/nats.conf:ro" \
  -v "${repository}/infrastructure/docker/nats/nats-tls-enabled.conf:/etc/nats/nats-tls.conf:ro" \
  -v "${fixture_root}/certs:/etc/nats/certs:ro" \
  nats:2.10.24-alpine -c /etc/nats/nats.conf >/dev/null
broker_address=$(docker port "${fixture_container}" 4222/tcp)
monitor_address=$(docker port "${fixture_container}" 8222/tcp)
[[ "${broker_address}" =~ ^127\.0\.0\.1:[0-9]+$ ]] || exit 2
[[ "${monitor_address}" =~ ^127\.0\.0\.1:[0-9]+$ ]] || exit 2
for attempt in $(seq 1 30); do
  if curl --silent --fail "http://${monitor_address}/healthz" >/dev/null; then break; fi
  [ "$(docker inspect --format '{{.State.Running}}' "${fixture_container}")" = true ] || exit 1
  sleep 1
done
curl --silent --fail "http://${monitor_address}/healthz" >/dev/null
export NATS_ACL_CERT_ROOT="${fixture_root}"
export NATS_ACL_TEST_CONTAINER="${fixture_container}"
export NATS_URL="tls://${broker_address}"
node tools/toolchain/run.mjs jest --config scripts/ci/jest.nats-acl.config.cjs --runInBand \
  --json --outputFile artifacts/authentication-proof/nats-acl.json
