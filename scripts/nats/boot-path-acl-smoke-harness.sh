#!/usr/bin/env bash
# boot-path-acl-smoke-harness.sh — boots a broker on the repo's generated
# nats.conf, mints one client certificate per service in services.yaml (CN =
# service name, the identity the ACL maps), and runs
# tools/scripts/nats-boot-path-acl-smoke.ts against it. See that file for WHY.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
CONTAINER="aqua-nats-boot-path-smoke-$RANDOM-$$"
PORT="$((22000 + RANDOM % 20000))"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_DIR/certs" "$TMP_DIR/clients"

openssl genrsa -out "$TMP_DIR/ca-key.pem" 2048 >/dev/null 2>&1
openssl req -new -x509 -days 7 -key "$TMP_DIR/ca-key.pem" \
  -out "$TMP_DIR/certs/ca-cert.pem" -subj "/CN=Aquaculture NATS Boot-Path Smoke CA" >/dev/null 2>&1

openssl genrsa -out "$TMP_DIR/certs/nats-key.pem" 2048 >/dev/null 2>&1
openssl req -new -key "$TMP_DIR/certs/nats-key.pem" -out "$TMP_DIR/nats.csr" \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
openssl x509 -req -days 7 -in "$TMP_DIR/nats.csr" \
  -CA "$TMP_DIR/certs/ca-cert.pem" -CAkey "$TMP_DIR/ca-key.pem" -CAcreateserial \
  -out "$TMP_DIR/certs/nats-cert.pem" -copy_extensions copyall >/dev/null 2>&1

# One certificate per identity the SSoT declares; the CN is the NATS user.
mapfile -t SERVICE_NAMES < <(
  node -e "
    const { parse } = require('yaml');
    const { readFileSync } = require('node:fs');
    const doc = parse(readFileSync('$ROOT/infrastructure/nats/services.yaml', 'utf8'));
    for (const s of doc.services) console.log(s.name);
  "
)
if [ "${#SERVICE_NAMES[@]}" -eq 0 ]; then
  echo "boot-path smoke: services.yaml yielded no services" >&2
  exit 1
fi
for name in "${SERVICE_NAMES[@]}"; do
  openssl genrsa -out "$TMP_DIR/clients/${name}-key.pem" 2048 >/dev/null 2>&1
  openssl req -new -key "$TMP_DIR/clients/${name}-key.pem" \
    -out "$TMP_DIR/clients/${name}.csr" -subj "/CN=${name}" >/dev/null 2>&1
  openssl x509 -req -days 7 -in "$TMP_DIR/clients/${name}.csr" \
    -CA "$TMP_DIR/certs/ca-cert.pem" -CAkey "$TMP_DIR/ca-key.pem" -CAcreateserial \
    -out "$TMP_DIR/clients/${name}-cert.pem" >/dev/null 2>&1
done

cp "$ROOT/infrastructure/docker/nats/nats.conf" "$TMP_DIR/nats.conf"
cp "$ROOT/infrastructure/docker/nats/nats-tls-enabled.conf" "$TMP_DIR/nats-tls.conf"

docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:4222" \
  -v "$TMP_DIR/nats.conf:/etc/nats/nats.conf:ro" \
  -v "$TMP_DIR/nats-tls.conf:/etc/nats/nats-tls.conf:ro" \
  -v "$TMP_DIR/certs:/etc/nats/certs:ro" \
  nats:2.10.24-alpine -c /etc/nats/nats.conf >/dev/null

# Wait for the broker (the first identity's connect is the readiness probe).
for _ in $(seq 1 30); do
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "boot-path smoke: broker exited before readiness" >&2
    docker logs "$CONTAINER" >&2 || true
    exit 1
  fi
  if docker logs "$CONTAINER" 2>&1 | grep -q "Server is ready"; then
    break
  fi
  sleep 1
done

cd "$ROOT"
if NATS_URL="tls://127.0.0.1:${PORT}" \
  NATS_TLS_CA="$TMP_DIR/certs/ca-cert.pem" \
  NATS_CLIENT_CERT_DIR="$TMP_DIR/clients" \
  npx ts-node --project tools/gates/tsconfig.json tools/scripts/nats-boot-path-acl-smoke.ts; then
  echo "OK: every NestJS identity ran the event-bus boot path inside the generated ACL"
  exit 0
fi

echo "boot-path smoke: findings above; broker log follows" >&2
docker logs "$CONTAINER" 2>&1 | grep -i "violation\|error" | tail -40 >&2 || true
exit 1
