#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
CONTAINER="aqua-nats-acl-smoke-$RANDOM-$$"
PORT="$((22000 + RANDOM % 20000))"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_DIR/certs" "$TMP_DIR/client"

openssl genrsa -out "$TMP_DIR/ca-key.pem" 4096 >/dev/null 2>&1
openssl req -new -x509 -days 7 -key "$TMP_DIR/ca-key.pem" \
  -out "$TMP_DIR/certs/ca-cert.pem" -subj "/CN=Aquaculture NATS Smoke CA" >/dev/null 2>&1

openssl genrsa -out "$TMP_DIR/certs/nats-key.pem" 2048 >/dev/null 2>&1
openssl req -new -key "$TMP_DIR/certs/nats-key.pem" -out "$TMP_DIR/nats.csr" \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
openssl x509 -req -days 7 -in "$TMP_DIR/nats.csr" \
  -CA "$TMP_DIR/certs/ca-cert.pem" -CAkey "$TMP_DIR/ca-key.pem" -CAcreateserial \
  -out "$TMP_DIR/certs/nats-cert.pem" -copy_extensions copyall >/dev/null 2>&1

openssl genrsa -out "$TMP_DIR/client/messaging_service-key.pem" 2048 >/dev/null 2>&1
openssl req -new -key "$TMP_DIR/client/messaging_service-key.pem" \
  -out "$TMP_DIR/client/messaging_service.csr" -subj "/CN=messaging_service" >/dev/null 2>&1
openssl x509 -req -days 7 -in "$TMP_DIR/client/messaging_service.csr" \
  -CA "$TMP_DIR/certs/ca-cert.pem" -CAkey "$TMP_DIR/ca-key.pem" -CAcreateserial \
  -out "$TMP_DIR/client/messaging_service-cert.pem" >/dev/null 2>&1

cp "$ROOT/infrastructure/docker/nats/nats.conf" "$TMP_DIR/nats.conf"
cp "$ROOT/infrastructure/docker/nats/nats-tls-enabled.conf" "$TMP_DIR/nats-tls.conf"

docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:4222" \
  -v "$TMP_DIR/nats.conf:/etc/nats/nats.conf:ro" \
  -v "$TMP_DIR/nats-tls.conf:/etc/nats/nats-tls.conf:ro" \
  -v "$TMP_DIR/certs:/etc/nats/certs:ro" \
  nats:2.10.24-alpine -c /etc/nats/nats.conf >/dev/null

for _ in $(seq 1 30); do
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "messaging NATS ACL live harness broker exited before readiness" >&2
    docker logs "$CONTAINER" >&2 || true
    exit 1
  fi
  if NATS_URL="tls://127.0.0.1:${PORT}" \
    NATS_TLS_ENABLED=true \
    NATS_TLS_CA="$TMP_DIR/certs/ca-cert.pem" \
    NATS_TLS_CERT="$TMP_DIR/client/messaging_service-cert.pem" \
    NATS_TLS_KEY="$TMP_DIR/client/messaging_service-key.pem" \
    node "$ROOT/scripts/nats/messaging-acl-smoke.mjs" --mode live; then
    echo "OK: repo-managed messaging NATS ACL live harness completed"
    exit 0
  fi
  sleep 1
done

echo "messaging NATS ACL live harness failed after waiting for broker readiness" >&2
docker logs "$CONTAINER" >&2 || true
exit 1
