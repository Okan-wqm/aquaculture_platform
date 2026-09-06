#!/bin/bash
# Signed recovery primitives. Source and backup are distinct cold clusters.
# The original named volume is retained; only a separately verified baseline
# may replace its bytes while every recorded writer remains stopped.

dr_cluster_copy_bytes() {
  [ "$#" -eq 1 ] || return 64
  local allocated apparent
  allocated=$(timeout 30 du -sx --block-size=1 "$1" | awk '{print $1}') || return
  apparent=$(timeout 30 du -sx --apparent-size --block-size=1 "$1" | awk '{print $1}') || return
  [[ "${allocated}" =~ ^[0-9]{1,16}$ ]] && [[ "${apparent}" =~ ^[0-9]{1,16}$ ]] || return 65
  # Capacity must remain sufficient on filesystems without reflinks and when
  # sparse source files become fully allocated by the copy operation.
  if [ "${allocated}" -ge "${apparent}" ]; then printf '%s' "${allocated}"; else printf '%s' "${apparent}"; fi
}

dr_require_copy_capacity() {
  [ "$#" -eq 3 ] || return 64
  local source=$1 copies=$2 destination=$3
  local source_bytes available_bytes required_bytes
  case "${copies}" in 1|3) ;; *) return 64 ;; esac
  source_bytes=$(dr_cluster_copy_bytes "${source}") || return
  available_bytes=$(df --output=avail -B1 "${destination}" | tail -1 | tr -d ' ') || return
  [[ "${available_bytes}" =~ ^[0-9]{1,16}$ ]] || return 65
  required_bytes=$((source_bytes * copies + source_bytes / 5 + 1073741824))
  if [ "${available_bytes}" -lt "${required_bytes}" ]; then
    printf 'Recovery capacity refused: need %s free bytes for %s copies; found %s.\n' "${required_bytes}" "${copies}" "${available_bytes}" >&2
    return 65
  fi
}

dr_copy_cluster() {
  [ "$#" -eq 2 ] || return 64
  local source=$1 destination=$2
  [ -d "${source}" ] && [ ! -L "${source}" ] || return 65
  [ -d "${destination}" ] && [ ! -L "${destination}" ] || return 65
  [ "$(readlink -f "${source}")" != "$(readlink -f "${destination}")" ] || return 65
  [ "$(cat "${source}/PG_VERSION")" = 16 ] || return 65
  # External tablespaces require a different complete-volume inventory; never
  # silently follow or omit them from a purported zero-loss recovery point.
  [ -z "$(find "${source}" -type l -print -quit)" ] || return 65
  [ -z "$(find "${destination}" -mindepth 1 -maxdepth 1 -print -quit)" ] || return 65
  cp -a --reflink=auto -- "${source}/." "${destination}/" || return
  chown --reference="${source}" "${destination}" || return
  chmod --reference="${source}" "${destination}" || return
  sync -f "${destination}" || return
  diff --brief --recursive --no-dereference -- "${source}" "${destination}" >/dev/null
}

verify_postgres_recovery_point() {
  local point="${STATE_DIR}/recovery-point.json"
  [ -f "${point}" ] && [ ! -L "${point}" ] || return 65
  [ "$(sha256sum --binary "${point}" | awk '{print $1}')" = \
    "$(jq -r '.recovery_point_sha256' "${STATE_PATH}")" ] || return 65
  jq -e --arg key "${RUN_KEY}" --arg baseline "${CANDIDATE_IMAGE_ID}" '
    .schema_version == 2 and .run_key == $key and
    .baseline_image_id == $baseline and .verified_boot == true and
    .data_volume == "aqua-saas_postgres_data" and
    .snapshot_volume == ("aqua-dr-point-" + $key) and
    .probe_volume == ("aqua-dr-probe-" + $key)
  ' "${point}" >/dev/null || return
  local private_root="/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}"
  [ "$(dr_baseline_config_digest "${private_root}")" = "$(jq -r '.baseline_config_sha256' "${point}")" ] || return 65
  local volume expected actual snapshot_path
  snapshot_path=$(docker volume inspect --format "{{.Mountpoint}}" "$(jq -r ".snapshot_volume" "${point}")") || return
  [ "$(dr_cluster_digest "${snapshot_path}")" = "$(jq -r ".snapshot_sha256" "${point}")" ] || return 65
  volume=$(jq -r '.snapshot_volume' "${point}") || return
  expected=$(jq -r '.snapshot_volume_created_at' "${point}") || return
  actual=$(docker volume inspect --format '{{.CreatedAt}}' "${volume}") || return
  [ "${expected}" = "${actual}" ] || return 65
  if [ "$(dr_state_phase "${STATE_PATH}")" = PREPARED ]; then
    [ "$(docker inspect --format '{{.State.Running}}' aqua-postgres)" = false ] || return 65
    [ "$(docker inspect --format '{{.Id}}' aqua-postgres)" = \
      "$(jq -r '.[0].Id' "${private_root}/observed-container.json")" ] || return 65
    [ "$(docker inspect --format '{{.Image}}' aqua-postgres)" = \
      "$(jq -r '.observed_image_id' "${point}")" ] || return 65
    local data_path writer
    data_path=$(docker volume inspect --format '{{.Mountpoint}}' aqua-saas_postgres_data) || return
    [ "$(dr_cluster_digest "${data_path}")" = "$(jq -r '.snapshot_sha256' "${point}")" ] || return 65
    while IFS= read -r writer; do
      [ "$(docker inspect --format '{{.State.Running}}' "${writer}")" = false ] || return 65
    done < "${private_root}/writers"
  fi
}

prepare_postgres_recovery_point() {
  local observed_container=$1
  local private_root="/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}"
  local data_volume=aqua-saas_postgres_data
  local snapshot_volume="aqua-dr-point-${RUN_KEY}"
  local probe_volume="aqua-dr-probe-${RUN_KEY}"
  local probe_container="aqua-dr-probe-${RUN_KEY}"
  local source_path snapshot_path probe_path writer
  local observed_image
  observed_image=$(docker inspect --format '{{.Image}}' "${observed_container}") || return
  case "${DR_BOOTSTRAP_MODE}" in
    healthy_upgrade)
      if [ ! -f "${private_root}/observed-container.json" ]; then
        wait_for_postgres_health "${observed_container}" || return
      fi ;;
    degraded_legacy_recovery)
      [ "$(docker inspect --format '{{.Config.Image}}' "${observed_container}")" = timescale/timescaledb-ha:pg16 ] || return 65
      docker image inspect --format '{{json .RepoDigests}}' "${observed_image}" | \
        jq -e 'index("timescale/timescaledb-ha@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7") != null' >/dev/null || return ;;
    *) return 65 ;;
  esac
  [ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}} {{.Name}}{{end}}{{end}}' "${observed_container}")" = \
    "volume ${data_volume}" ] || return 65
  # Peak allocation is live/failed-forward + cold point + retained probe +
  # restored PGDATA: three additional complete copies beyond the live cluster.
  # A failed capacity admission leaves the observed runtime untouched.
  source_path=$(docker volume inspect --format '{{.Mountpoint}}' "${data_volume}") || return
  [ ! -L "${private_root}" ] || return 65
  install -d -m 0700 "${private_root}" || return
  # Failed-forward retention uses rename, so all managed recovery allocations
  # must share one filesystem. Split-storage layouts need their own allocator.
  [ "$(stat -c '%d' "${source_path}")" = "$(stat -c '%d' "${private_root}")" ] || return 65
  dr_require_copy_capacity "${source_path}" 3 "${source_path}" || return
  if [ ! -f "${private_root}/observed-container.json" ]; then
    docker inspect "${observed_container}" > "${private_root}/.observed-container.json" || return
    chmod 0400 "${private_root}/.observed-container.json"
    mv "${private_root}/.observed-container.json" "${private_root}/observed-container.json"
  fi
  jq -e --arg id "${observed_container}" '.[0].Id == $id' "${private_root}/observed-container.json" >/dev/null || return
  if [ ! -f "${private_root}/writers" ]; then
    docker ps --no-trunc --filter label=com.docker.compose.project=aqua-saas \
      --format '{{.ID}} {{.Names}}' | awk '$2 != "aqua-postgres" {print $1}' > "${private_root}/.writers"
    chmod 0400 "${private_root}/.writers"
    mv "${private_root}/.writers" "${private_root}/writers"
  fi
  sync -f "${private_root}"
  while IFS= read -r writer; do
    [[ "${writer}" =~ ^[0-9a-f]{64}$ ]] || return 65
    docker stop --time 60 "${writer}" >/dev/null || return
  done < "${private_root}/writers"
  docker stop --time 120 "${observed_container}" >/dev/null || return
  [ "$(docker inspect --format '{{.State.Running}}' "${observed_container}")" = false ] || return 65
  docker volume create "${snapshot_volume}" >/dev/null || return
  docker volume create "${probe_volume}" >/dev/null || return
  source_path=$(docker volume inspect --format '{{.Mountpoint}}' "${data_volume}") || return
  snapshot_path=$(docker volume inspect --format '{{.Mountpoint}}' "${snapshot_volume}") || return
  probe_path=$(docker volume inspect --format '{{.Mountpoint}}' "${probe_volume}") || return
  [ "$(stat -c '%d' "${source_path}")" = "$(stat -c '%d' "${snapshot_path}")" ] || return 65
  [ "$(stat -c '%d' "${source_path}")" = "$(stat -c '%d' "${probe_path}")" ] || return 65
  # Only VERIFYING may rebuild incomplete copies; original PGDATA has not yet
  # entered a forward write phase. Names are bound to this signed run attempt.
  [ "$(dr_state_phase "${STATE_PATH}")" = VERIFYING ] || return 65
  if docker inspect "${probe_container}" >/dev/null 2>&1; then
    docker rm --force "${probe_container}" >/dev/null || return
  fi
  find "${snapshot_path}" "${probe_path}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || return
  dr_copy_cluster "${source_path}" "${snapshot_path}" || return
  dr_copy_cluster "${snapshot_path}" "${probe_path}" || return
  install -d -m 0700 "${private_root}/certs"
  cp -aL -- "${CERTS_REAL_ROOT}/." "${private_root}/certs/" || return
  jq -e 'all(.[0].Config.Env[]; test("^[A-Za-z_][A-Za-z0-9_]*=") and (contains("\n") | not))' \
    "${private_root}/observed-container.json" >/dev/null || return
  jq -r '.[0].Config.Env[] | select(startswith("WALG_") | not) | select(startswith("POSTGRES_SSL") | not)' \
    "${private_root}/observed-container.json" > "${private_root}/baseline.env" || return
  printf '%s\n' WALG_ENABLED=off POSTGRES_SSL=on POSTGRES_SSL_RUNTIME_DIR=/run/aqua-postgres-tls \
    >> "${private_root}/baseline.env"
  chmod 0400 "${private_root}/baseline.env"
  docker run -d --name "${probe_container}" --network none --user root \
    --env-file "${private_root}/baseline.env" \
    --mount "type=volume,source=${probe_volume},target=/var/lib/postgresql/data" \
    --mount "type=bind,source=${private_root}/certs/postgres/postgres-cert.pem,target=/var/lib/postgresql/ssl/server.crt,readonly" \
    --mount "type=bind,source=${private_root}/certs/postgres/postgres-key.pem,target=/var/lib/postgresql/ssl/server.key" \
    --mount "type=bind,source=${private_root}/certs/postgres/ca-cert.pem,target=/var/lib/postgresql/ssl/root.crt,readonly" \
    --tmpfs /run/aqua-postgres-tls:rw,noexec,nosuid,nodev,size=1m,mode=0700 \
    --entrypoint /usr/local/bin/postgres-ssl-entrypoint.sh "${CANDIDATE_IMAGE_ID}" \
    postgres -c ssl=on -c archive_mode=off \
    -c ssl_cert_file=/run/aqua-postgres-tls/server.crt \
    -c ssl_key_file=/run/aqua-postgres-tls/server.key \
    -c ssl_ca_file=/run/aqua-postgres-tls/root.crt >/dev/null || return
  local ready=false deadline=$((SECONDS + 180))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if docker exec "${probe_container}" pg_isready >/dev/null 2>&1; then ready=true; break; fi
    sleep 3
  done
  [ "${ready}" = true ] || return 65
  docker exec "${probe_container}" /bin/bash -c \
    'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT extname, extversion FROM pg_extension ORDER BY extname"' \
    > "${private_root}/extensions.txt" || return
  docker stop --time 120 "${probe_container}" >/dev/null || return
  # The probe mutates only a disposable copy. Retain the pristine cold point
  # and the tested baseline's private TLS and environment for rollback.
  local temporary_path
  temporary_path=$(mktemp --tmpdir="${STATE_DIR}" .recovery.XXXXXXXX) || return
  jq -n --arg key "${RUN_KEY}" --arg observed "${observed_image}" \
    --arg baseline "${CANDIDATE_IMAGE_ID}" --arg data "${data_volume}" \
    --arg snapshot "${snapshot_volume}" --arg probe "${probe_volume}" \
    --arg snapshot_sha256 "$(dr_cluster_digest "${snapshot_path}")" \
    --arg baseline_config_sha256 "$(dr_baseline_config_digest "${private_root}")" \
    --arg created "$(docker volume inspect --format '{{.CreatedAt}}' "${snapshot_volume}")" \
    '{schema_version:2,run_key:$key,observed_image_id:$observed,baseline_image_id:$baseline,
      data_volume:$data,snapshot_volume:$snapshot,probe_volume:$probe,
      snapshot_volume_created_at:$created,snapshot_sha256:$snapshot_sha256,baseline_config_sha256:$baseline_config_sha256,verified_boot:true}' > "${temporary_path}" || return
  publish_state_file "${temporary_path}" "${STATE_DIR}/recovery-point.json" || return
  dr_state_bind_recovery "${STATE_PATH}" "${STATE_DIR}/recovery-point.json"
}

# Content plus ownership, modes, names and link metadata are all bound. This
# stays private; only the digest appears in the non-secret execution journal.
dr_cluster_digest() {
  [ "$#" -eq 1 ] || return 64
  tar --sort=name --format=gnu --numeric-owner -C "$1" -cf - . | sha256sum | awk '{print $1}'
}

restore_postgres_recovery_point() {
  verify_postgres_recovery_point || return
  local point="${STATE_DIR}/recovery-point.json" snapshot_path data_path
  local private_root="/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}"
  snapshot_path=$(docker volume inspect --format '{{.Mountpoint}}' "$(jq -r '.snapshot_volume' "${point}")") || return
  [ "$(dr_cluster_digest "${snapshot_path}")" = "$(jq -r '.snapshot_sha256' "${point}")" ] || return 65
  data_path=$(docker volume inspect --format '{{.Mountpoint}}' aqua-saas_postgres_data) || return
  [ "$(stat -c '%d' "${data_path}")" = "$(stat -c '%d' "${private_root}")" ] || return 65
  [ "$(stat -c '%d' "${data_path}")" = "$(stat -c '%d' "${snapshot_path}")" ] || return 65
  # Each retry retains the last failed-forward cluster. Recheck the next full
  # copy before stopping/moving anything; prior admission cannot cover an
  # unbounded number of retained rollback attempts or unrelated disk growth.
  dr_require_copy_capacity "${snapshot_path}" 1 "${data_path}" || return
  docker stop --time 120 aqua-postgres >/dev/null || return
  [ "$(docker inspect --format '{{.State.Running}}' aqua-postgres)" = false ] || return 65
  local writer
  while IFS= read -r writer; do
    [ "$(docker inspect --format '{{.State.Running}}' "${writer}")" = false ] || return 65
  done < "${private_root}/writers"
  # Keep the failed-forward bytes as a separate recovery artifact, including
  # across a repeated rollback. Never delete the authoritative cold point.
  local failed_copy
  failed_copy=$(mktemp -d "${private_root}/failed-forward.XXXXXXXX") || return
  find "${data_path}" -mindepth 1 -maxdepth 1 -exec mv -t "${failed_copy}" -- {} + || return
  dr_copy_cluster "${snapshot_path}" "${data_path}" || return
  [ "$(dr_cluster_digest "${data_path}")" = "$(jq -r '.snapshot_sha256' "${point}")" ]
}

resume_postgres_recovery_writers() {
  local writer
  while IFS= read -r writer; do
    [[ "${writer}" =~ ^[0-9a-f]{64}$ ]] || return 65
    docker start "${writer}" >/dev/null || return
  done < "/var/lib/aqua/deploy/dr-recovery/${RUN_KEY}/writers"
}


dr_baseline_config_digest() {
  [ "$#" -eq 1 ] || return 64
  (cd "$1" && { sha256sum baseline.env observed-container.json; find certs -type f -print0 | sort -z | xargs -0 sha256sum; }) | sha256sum | awk '{print $1}'
}
