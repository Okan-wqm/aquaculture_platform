#!/usr/bin/env bash
# Hosted-only proof using the production NATS coordinator and real mTLS.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] && [ "$(id -u)" = 0 ] || exit 2
repository=${PWD}
fixture_root=$(mktemp -d /tmp/aqua-nats-leaf.XXXXXXXX)
fixture_project="aqua-nats-leaf-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
cleanup() {
  if [ -f "${fixture_root}/docker-compose.droplet.yml" ]; then
    (cd "${fixture_root}" && COMPOSE_PROJECT_NAME="${fixture_project}" DEPLOY_CERTS_DIR="${fixture_root}/candidate" \
      docker compose -f docker-compose.droplet.yml down --volumes --remove-orphans) >/dev/null 2>&1 || true
  fi
  rm -rf -- "${fixture_root}"
}
trap cleanup EXIT
DEPLOY_CERTS_DIR="${fixture_root}/candidate" bash infrastructure/docker/scripts/generate-internal-certs.sh >/dev/null
cp -aL -- "${fixture_root}/candidate" "${fixture_root}/old"
mkdir -p "${fixture_root}/issued" "${fixture_root}/infrastructure/docker/nats"
: > "${fixture_root}/index.txt"
printf '1000\n' > "${fixture_root}/serial"
cat > "${fixture_root}/ca.conf" <<EOF
[ca]
default_ca=issuer
[issuer]
database=${fixture_root}/index.txt
new_certs_dir=${fixture_root}/issued
serial=${fixture_root}/serial
certificate=${fixture_root}/old/ca/ca-cert.pem
private_key=${fixture_root}/old/ca/ca-key.pem
default_md=sha256
policy=subject_policy
[subject_policy]
commonName=supplied
organizationName=optional
[server]
subjectAltName=DNS:nats,DNS:aqua-nats,DNS:localhost
extendedKeyUsage=serverAuth
EOF
openssl req -new -key "${fixture_root}/old/nats/nats-key.pem" -subj '/CN=nats/O=Aquaculture Platform' \
  -out "${fixture_root}/old-nats.csr" >/dev/null 2>&1
openssl ca -batch -notext -config "${fixture_root}/ca.conf" -extensions server \
  -startdate 20200101000000Z -enddate 20200102000000Z -in "${fixture_root}/old-nats.csr" \
  -out "${fixture_root}/old/nats/nats-cert.pem" >/dev/null 2>&1
chmod 0644 "${fixture_root}/old/nats/nats-cert.pem"
cp infrastructure/docker/nats/nats.conf infrastructure/docker/nats/nats-tls-enabled.conf \
  "${fixture_root}/infrastructure/docker/nats/"
cat > "${fixture_root}/docker-compose.droplet.yml" <<'YAML'
services:
  nats:
    image: nats:2.10.24-alpine
    command: ['--config', '/etc/nats/nats.conf']
    volumes:
      - nats_data:/data
      - ./infrastructure/docker/nats/nats.conf:/etc/nats/nats.conf:ro
      - ./infrastructure/docker/nats/nats-tls-enabled.conf:/etc/nats/nats-tls.conf:ro
      - ${DEPLOY_CERTS_DIR}/nats/nats-cert.pem:/etc/nats/certs/nats-cert.pem:ro
      - ${DEPLOY_CERTS_DIR}/nats/nats-key.pem:/etc/nats/certs/nats-key.pem:ro
      - ${DEPLOY_CERTS_DIR}/nats/ca-cert.pem:/etc/nats/certs/ca-cert.pem:ro
    healthcheck:
      test: ['CMD', 'wget', '-q', '--spider', 'http://localhost:8222/healthz']
      interval: 1s
      timeout: 1s
      retries: 30
volumes:
  nats_data:
YAML
source "${repository}/scripts/deploy/deploy-paths.sh"
source "${repository}/scripts/deploy/nats-runtime.sh"
export COMPOSE_PROJECT_NAME="${fixture_project}"
export DEPLOY_CERTS_DIR="${fixture_root}/old"
cd "${fixture_root}"
docker compose -f docker-compose.droplet.yml up -d nats >/dev/null
old_id=$(docker compose -f docker-compose.droplet.yml ps -q nats)
for attempt in $(seq 1 30); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "${old_id}")" != healthy ] || break
  sleep 1
done
[ "$(docker inspect --format '{{.State.Health.Status}}' "${old_id}")" = healthy ]
export DEPLOY_CERTS_DIR="${fixture_root}/candidate"
# A fresh client certificate cannot authenticate to the expired old server.
if nats_runtime_probe "${old_id}" >/dev/null 2>&1; then exit 1; fi
old_leaf=$(sha256sum "${fixture_root}/old/nats/nats-cert.pem" | awk '{print $1}')
redact_sensitive() { cat; }
ensure_nats_acl_loaded
new_id=$(docker compose -f docker-compose.droplet.yml ps -q nats)
[ "${new_id}" != "${old_id}" ]
[ "${NATS_ACL_RELOADED}" = true ]
nats_runtime_probe "${new_id}"
[ "$(sha256sum "${fixture_root}/old/nats/nats-cert.pem" | awk '{print $1}')" = "${old_leaf}" ]
cmp "${fixture_root}/old/ca/ca-cert.pem" "${fixture_root}/candidate/ca/ca-cert.pem"
# A distinct root must fail before replacing the healthy broker.
cp -aL "${fixture_root}/candidate" "${fixture_root}/different-root"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Different Root' \
  -keyout "${fixture_root}/other-root.key" -out "${fixture_root}/different-root/nats/ca-cert.pem" >/dev/null 2>&1
export DEPLOY_CERTS_DIR="${fixture_root}/different-root"
if ensure_nats_acl_loaded >/dev/null 2>&1; then exit 1; fi
[ "$(docker compose -f docker-compose.droplet.yml ps -q nats)" = "${new_id}" ]
printf 'NATS same-ACL expired-leaf rollout and authenticated fresh-client connection verified.\n'
