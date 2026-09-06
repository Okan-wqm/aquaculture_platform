#!/usr/bin/env bash
# Shared broker rollout contract; the deploy holds its exclusive host lock.
# Compare actual container mounts and authenticate against the loaded identity,
# rather than assuming a fresh config generation changed a running consumer.

nats_runtime_mount_source() {
  [ "$#" -eq 2 ] || return 64
  docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$2"'"}}{{.Source}}{{end}}{{end}}' "$1"
}

nats_runtime_assert_same_ca() {
  local mounted_ca
  mounted_ca=$(nats_runtime_mount_source "$1" /etc/nats/certs/ca-cert.pem) || return
  [ -f "${mounted_ca}" ] && [ -r "${mounted_ca}" ] || return 1
  cmp -s -- "${mounted_ca}" "${DEPLOY_CERTS_DIR}/nats/ca-cert.pem" || {
    printf '::error::NATS trust-root change requires a coordinated CA rotation.\n' >&2
    return 2
  }
}

nats_runtime_tls_matches() {
  local container_id=$1 source desired destination
  nats_runtime_assert_same_ca "${container_id}" || return
  for destination in /etc/nats/certs/nats-cert.pem /etc/nats/certs/nats-key.pem /etc/nats/certs/ca-cert.pem /etc/nats/nats-tls.conf; do
    source=$(nats_runtime_mount_source "${container_id}" "${destination}") || return
    case "${destination}" in
      /etc/nats/nats-tls.conf) desired="${PWD}/infrastructure/docker/nats/nats-tls-enabled.conf" ;;
      *) desired="${DEPLOY_CERTS_DIR}/nats/${destination##*/}" ;;
    esac
    [ -f "${source}" ] && [ -r "${source}" ] || return 1
    cmp -s -- "${source}" "${desired}" || return 1
  done
  # The live mounted leaf can expire independently of a fresh generation's
  # Redis certificate. Its lifetime is part of the skip predicate.
  source=$(nats_runtime_mount_source "${container_id}" /etc/nats/certs/nats-cert.pem) || return
  openssl x509 -in "${source}" -checkend 2592000 -noout >/dev/null
}

nats_runtime_probe() {
  local addresses address
  addresses=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1") || return
  read -r -a address <<< "${addresses}"
  [ "${#address[@]}" -eq 1 ] || return 1
  /usr/bin/python3 "$(dirname "${BASH_SOURCE[0]}")/probe-nats-mtls.py" \
    "${address[0]}" "${DEPLOY_CERTS_DIR}"
}

ensure_nats_acl_loaded() {
  acquire_deploy_control_lock || return
  local desired_path="${PWD}/infrastructure/docker/nats/nats.conf"
  local desired_hash container_id mounted_source loaded_hash state health
  local started_at started_epoch source_mtime
  local attempt

  if [ ! -r "${desired_path}" ]; then
    echo "::error::NATS ACL is unreadable: ${desired_path}"
    return 1
  fi
  desired_hash=$(sha256sum "${desired_path}" | awk '{print $1}')
  container_id=$(docker compose -f docker-compose.droplet.yml ps -q nats 2>/dev/null || true)

  if [ -n "${container_id}" ]; then
    mounted_source=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/nats/nats.conf"}}{{.Source}}{{end}}{{end}}' "${container_id}" 2>/dev/null || true)
    if [ -n "${mounted_source}" ] && [ -r "${mounted_source}" ]; then
      loaded_hash=$(sha256sum "${mounted_source}" | awk '{print $1}')
      state=$(docker inspect --format '{{.State.Status}}' "${container_id}" 2>/dev/null || true)
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}" 2>/dev/null || true)
      started_at=$(docker inspect --format '{{.State.StartedAt}}' "${container_id}" 2>/dev/null || true)
      started_epoch=$(date -d "${started_at}" +%s 2>/dev/null || true)
      source_mtime=$(stat -c '%Y' "${mounted_source}" 2>/dev/null || true)
      # Hash equality alone is insufficient for a bind mount: the host file can
      # change in place while the running broker keeps its previously parsed
      # authorization. Only skip when the source strictly predates this
      # container start; equal whole-second timestamps are ambiguous because
      # Docker reports StartedAt with finer precision than stat's epoch value.
      if [ "${state}" = "running" ] && [ "${health}" = "healthy" ] &&
         [ "${loaded_hash}" = "${desired_hash}" ] &&
         [ -n "${started_epoch}" ] && [ -n "${source_mtime}" ] &&
         [ "${source_mtime}" -lt "${started_epoch}" ]; then
        local tls_status=0
        nats_runtime_tls_matches "${container_id}" || tls_status=$?
        [ "${tls_status}" -ne 2 ] || return 1
        if [ "${tls_status}" -eq 0 ] && nats_runtime_probe "${container_id}"; then
          echo "  NATS runs the desired ACL and verified TLS identity (${desired_hash})."
          return 0
        fi
      fi
    fi
  fi

  # A leaf rollout is permitted only under the same CA as the observed
  # broker. Rotating a trust root requires a separate coordinated operation.
  if [ -n "${container_id}" ]; then
    nats_runtime_assert_same_ca "${container_id}" || return
  fi
  openssl x509 -in "${DEPLOY_CERTS_DIR}/nats/nats-cert.pem" -checkend 2592000 -noout >/dev/null || return
  echo "=== Reloading NATS certificate identities and ACL before client restart ==="
  if ! docker compose -f docker-compose.droplet.yml run --rm --no-deps -T nats \
       -t -c /etc/nats/nats.conf 2>&1 | redact_sensitive; then
    echo "::error::Desired NATS configuration failed broker-native validation; live broker was not replaced."
    return 1
  fi
  docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build --force-recreate nats 2>&1 | redact_sensitive

  for attempt in $(seq 1 30); do
    container_id=$(docker compose -f docker-compose.droplet.yml ps -q nats 2>/dev/null || true)
    if [ -n "${container_id}" ]; then
      state=$(docker inspect --format '{{.State.Status}}' "${container_id}" 2>/dev/null || true)
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}" 2>/dev/null || true)
      if [ "${state}" = "running" ] && [ "${health}" = "healthy" ]; then
        break
      fi
      case "${state}" in
        exited|dead)
          echo "::error::NATS exited while loading the new ACL."
          docker logs --tail 200 "${container_id}" 2>&1 | redact_sensitive || true
          return 1
          ;;
      esac
    fi
    sleep 2
  done

  if [ "${state:-}" != "running" ] || [ "${health:-}" != "healthy" ]; then
    echo "::error::NATS did not become healthy after ACL reload."
    [ -n "${container_id:-}" ] && docker logs --tail 200 "${container_id}" 2>&1 | redact_sensitive || true
    return 1
  fi

  mounted_source=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/nats/nats.conf"}}{{.Source}}{{end}}{{end}}' "${container_id}" 2>/dev/null || true)
  if [ -z "${mounted_source}" ] || [ ! -r "${mounted_source}" ]; then
    echo "::error::Healthy NATS container does not expose the expected /etc/nats/nats.conf bind mount."
    return 1
  fi
  loaded_hash=$(sha256sum "${mounted_source}" | awk '{print $1}')
  if [ "${loaded_hash}" != "${desired_hash}" ]; then
    echo "::error::NATS bind-mounted ACL hash differs after reload."
    return 1
  fi

  nats_runtime_tls_matches "${container_id}" || return
  nats_runtime_probe "${container_id}" || return
  NATS_ACL_RELOADED=true
  echo "  NATS loaded the desired ACL (${desired_hash})."
}
