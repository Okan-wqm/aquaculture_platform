#!/usr/bin/env bash
# Canonical droplet capacity preflight + image-only garbage collection.
#
# This script is intentionally conservative. It never removes volumes,
# containers, networks, or build cache. Deploy-time cleanup is limited to
# dangling images and, under IMAGE_PREFIX only, app tags outside the closed
# keep-allowlist (latest/staging/buildcache-*/current DEPLOY_SHA) whose image
# IDs no container, rollback manifest, or deploy target references — old SHA
# tags, superseded rollback retags, and unclassified ad-hoc tags alike
# (default-deny: an unlisted tag class cannot become immortal).

set -euo pipefail

IMAGE_PREFIX="${IMAGE_PREFIX:-ghcr.io/okan-wqm/aquaculture_platform}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
FULL_DEPLOY="${FULL_DEPLOY:-false}"
DEPLOY_SERVICES="${DEPLOY_SERVICES:-}"
ROLLBACK_MANIFEST="${ROLLBACK_MANIFEST:-}"
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-}"
CAPACITY_GC_MODE="${CAPACITY_GC_MODE:-auto}" # auto | off
CAPACITY_DISK_USAGE_MODE="${CAPACITY_DISK_USAGE_MODE:-summary}" # summary | deep | off
# One wall-clock budget owns each diagnostic snapshot. Disjoint frontier
# workers share that deadline, rather than multiplying a per-scope timeout
# across overlapping /, /var, /var/lib, ... scans.
CAPACITY_DU_TIMEOUT_SECONDS="${CAPACITY_DU_TIMEOUT_SECONDS:-120}"
CAPACITY_DU_TIMEOUT_MAX_SECONDS=120
# timeout(1) first sends TERM, then has this fixed grace to reap a stuck du.
# The invariant guarantees the following non-du headroom inside the OUTER SSH
# command timeout for setup, checkout, Docker inventory/GC, threshold
# evaluation, formatting, and teardown. It is a budget relationship, not a
# second timer implemented by this script.
CAPACITY_DU_KILL_GRACE_SECONDS=5
CAPACITY_NON_DU_HEADROOM_SECONDS=300
# Disjoint scopes run concurrently, but all workers share one wall-clock
# deadline. These are constants rather than operator overrides so a dispatch
# cannot turn diagnostics into an unbounded I/O fan-out.
CAPACITY_DU_PARALLELISM=4
CAPACITY_DU_MAX_SCOPES=512
# No single tranche may monopolize the global deadline. A timed-out summary
# still attributes the suspect path while freeing a slot for later families.
CAPACITY_DU_SCOPE_TIMEOUT_SECONDS=15
# Filesystem discovery is part of the same global deadline and all directory
# enumerations share this smaller discovery phase. Each enumeration returns at
# most N+1 records (the extra record proves truncation without unbounded output).
CAPACITY_DU_DISCOVERY_TIMEOUT_SECONDS=20
CAPACITY_DU_MAX_DISCOVERY_CALLS=64
CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY=128
CAPACITY_DU_MAX_UNAVAILABLE_RECORDS=64
# `du -s --null` should emit one PATH_MAX-sized record. Cap the capture anyway
# so a broken binary or hostile wrapper cannot fill the already-tight disk.
CAPACITY_DU_MAX_RESULT_BYTES=8192

GIB=$((1024 * 1024 * 1024))
FULL_HARD_FREE_GIB="${FULL_HARD_FREE_GIB:-35}"
# 45 GiB warn (was 50): the healthy droplet baseline sits at ~49.8 GiB free, so a
# 50 GiB warn fired on EVERY deploy (alert fatigue). 45 stays well above the 35 GiB
# hard floor while still warning before the box is genuinely tight. Non-blocking (returns 1).
FULL_WARN_FREE_GIB="${FULL_WARN_FREE_GIB:-45}"
FULL_HARD_FREE_PERCENT="${FULL_HARD_FREE_PERCENT:-20}"
SELECTIVE_HARD_FREE_GIB="${SELECTIVE_HARD_FREE_GIB:-15}"
SELECTIVE_WARN_FREE_GIB="${SELECTIVE_WARN_FREE_GIB:-25}"
SELECTIVE_HARD_FREE_PERCENT="${SELECTIVE_HARD_FREE_PERCENT:-10}"
HARD_INODE_FREE_PERCENT="${HARD_INODE_FREE_PERCENT:-5}"
WARN_INODE_FREE_PERCENT="${WARN_INODE_FREE_PERCENT:-10}"
FULL_PULL_ESTIMATE_GIB="${FULL_PULL_ESTIMATE_GIB:-20}"
SERVICE_PULL_ESTIMATE_GIB="${SERVICE_PULL_ESTIMATE_GIB:-2}"
FULL_PROJECTED_RESERVE_GIB="${FULL_PROJECTED_RESERVE_GIB:-20}"
SELECTIVE_PROJECTED_RESERVE_GIB="${SELECTIVE_PROJECTED_RESERVE_GIB:-10}"

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy/droplet-capacity.sh report
  scripts/deploy/droplet-capacity.sh gate
  scripts/deploy/droplet-capacity.sh gc

Environment:
  FULL_DEPLOY=true|false
  DEPLOY_SERVICES="svc-a svc-b"
  DEPLOY_SHA=<40-char sha>
  IMAGE_PREFIX=ghcr.io/owner/repo
  CAPACITY_GC_MODE=auto|off
  CAPACITY_DISK_USAGE_MODE=summary|deep|off
  CAPACITY_DU_TIMEOUT_SECONDS=1..120
  GC_DRY_RUN=true|false   (gc only: enumerate removals without deleting)
EOF
}

command="${1:-}"
if [ -z "${command}" ]; then
  usage
  exit 2
fi

detect_docker_root() {
  local root
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null | awk 'NF {print; exit}')" || true
  if [ -z "${root}" ]; then
    root="/var/lib/docker"
  fi
  printf '%s\n' "${root}"
}

DOCKER_ROOT_DIR="${DOCKER_ROOT_DIR:-$(detect_docker_root)}"

unique_paths() {
  local seen=" "
  local p
  for p in "$@"; do
    [ -n "${p}" ] || continue
    [ -e "${p}" ] || continue
    case "${seen}" in
      *" ${p} "*) ;;
      *)
        printf '%s\n' "${p}"
        seen="${seen}${p} "
        ;;
    esac
  done
}

docker_root() {
  echo "${DOCKER_ROOT_DIR}"
}

runtime_paths() {
  local droot
  droot="$(docker_root)"
  unique_paths "/" "${droot}" "/var/lib/containerd"
}

df_bytes_row() {
  local path="$1"
  df -PB1 "${path}" 2>/dev/null | awk 'NR==2 {print $1 "\t" $2 "\t" $4 "\t" $6}'
}

df_inode_row() {
  local path="$1"
  df -Pi "${path}" 2>/dev/null | awk 'NR==2 {print $2 "\t" $4}'
}

capacity_record_unavailable_encoded() {
  local error_file="$1"
  local reason="$2"
  local detail="$3"
  local path_base64="$4"
  local operation_timeout_seconds="${5:-0}"

  if [ "${CAPACITY_UNAVAILABLE_RECORDS:-0}" -ge \
    "${CAPACITY_DU_MAX_UNAVAILABLE_RECORDS}" ]; then
    CAPACITY_UNAVAILABLE_TRUNCATED=true
    CAPACITY_FRONTIER_TRUNCATED=true
    return 0
  fi
  printf '%s\t%s\t%s\t%s\n' \
    "${reason}" "${detail}" "${operation_timeout_seconds}" "${path_base64}" >> "${error_file}"
  CAPACITY_UNAVAILABLE_RECORDS=$((CAPACITY_UNAVAILABLE_RECORDS + 1))
}

# A scope worth measuring is one that can actually consume disk. `df` reports
# zero total bytes for pseudo-filesystems (procfs, sysfs); every real mount —
# ext4, overlay, even tmpfs — reports its size. An unreadable `df` is treated
# as NOT disk-backed on purpose: the alternative is walking a filesystem we
# could not identify, which is how this lane started failing in the first
# place, and a skipped scope is recorded out loud rather than dropped.
capacity_scope_is_disk_backed() {
  local scope_path="$1"
  local total_bytes
  total_bytes="$(df -PB1 -- "${scope_path}" 2>/dev/null | awk 'NR==2 {print $2}')"
  case "${total_bytes}" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "${total_bytes}" -gt 0 ]
}

capacity_record_unavailable() {
  local error_file="$1"
  local reason="$2"
  local detail="$3"
  local scope_path="$4"
  local operation_timeout_seconds="${5:-0}"
  local path_base64
  path_base64="$(printf '%s' "${scope_path}" | base64 -w0)"
  capacity_record_unavailable_encoded \
    "${error_file}" "${reason}" "${detail}" "${path_base64}" \
    "${operation_timeout_seconds}"
}

capacity_is_hotspot() {
  [ "${CAPACITY_DISK_USAGE_MODE}" = "deep" ] || return 1
  case "$1" in
    /tmp | /var/aqua-saas | /var/suderra-os) return 0 ;;
    *) return 1 ;;
  esac
}

capacity_target_below() {
  local candidate_path="$1"
  local target_path="$2"
  [ "${candidate_path}" != "${target_path}" ] &&
    [[ "${target_path}" == "${candidate_path}/"* ]]
}

capacity_add_frontier_scope() {
  local frontier_file="$1"
  local error_file="$2"
  local scope_path="$3"
  local scope_key

  [ -e "${scope_path}" ] || [ -L "${scope_path}" ] || return 0
  # Bash associative keys preserve every legal pathname byte (NUL is not a
  # legal pathname byte), avoiding a subprocess for each discovered scope.
  scope_key="${scope_path}"
  if [[ -n "${CAPACITY_FRONTIER_SEEN[${scope_key}]+present}" ]]; then
    return 0
  fi

  if [ "${CAPACITY_FRONTIER_COUNT}" -ge "${CAPACITY_DU_MAX_SCOPES}" ]; then
    CAPACITY_FRONTIER_TRUNCATED=true
    if [ "${CAPACITY_FRONTIER_LIMIT_RECORDED}" = false ]; then
      capacity_record_unavailable \
        "${error_file}" scope_limit "${CAPACITY_DU_MAX_SCOPES}" "${scope_path}"
      CAPACITY_FRONTIER_LIMIT_RECORDED=true
    fi
    return 0
  fi

  CAPACITY_FRONTIER_SEEN["${scope_key}"]=1
  printf '%s\0' "${scope_path}" >> "${frontier_file}"
  CAPACITY_FRONTIER_COUNT=$((CAPACITY_FRONTIER_COUNT + 1))
}

capacity_discover_children() {
  local parent_path="$1"
  local output_file="$2"
  local error_file="$3"
  local work_dir="$4"
  local deadline="$5"
  local remaining=$((deadline - SECONDS))
  local discovery_budget
  local raw_file
  local find_status
  local head_status
  local entry_index
  local -a pipeline_status=()
  local -a discovered_entries=()

  : > "${output_file}"
  if [ "${CAPACITY_DISCOVERY_SEQUENCE}" -ge "${CAPACITY_DU_MAX_DISCOVERY_CALLS}" ]; then
    CAPACITY_FRONTIER_TRUNCATED=true
    capacity_record_unavailable \
      "${error_file}" discovery_call_limit \
      "${CAPACITY_DU_MAX_DISCOVERY_CALLS}" "${parent_path}"
    return 0
  fi
  if [ "${remaining}" -le 0 ]; then
    CAPACITY_FRONTIER_TRUNCATED=true
    capacity_record_unavailable "${error_file}" discovery_deadline 0 "${parent_path}"
    return 0
  fi

  discovery_budget="${CAPACITY_DU_DISCOVERY_TIMEOUT_SECONDS}"
  if [ "${remaining}" -lt "${discovery_budget}" ]; then
    discovery_budget="${remaining}"
  fi

  CAPACITY_DISCOVERY_SEQUENCE=$((CAPACITY_DISCOVERY_SEQUENCE + 1))
  raw_file="${work_dir}/discovery.${CAPACITY_DISCOVERY_SEQUENCE}.raw"
  set +e
  timeout --signal=TERM \
    --kill-after="${CAPACITY_DU_KILL_GRACE_SECONDS}s" \
    "${discovery_budget}s" \
    find "${parent_path}" -xdev -mindepth 1 -maxdepth 1 -print0 2>/dev/null |
    head -z -n "$((CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY + 1))" > "${raw_file}"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  find_status="${pipeline_status[0]:-1}"
  head_status="${pipeline_status[1]:-1}"

  mapfile -d '' -t discovered_entries < "${raw_file}"
  rm -f -- "${raw_file}"

  for ((entry_index = 0;
    entry_index < ${#discovered_entries[@]} &&
      entry_index < CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY;
    entry_index++)); do
    # `find -xdev` refuses to DESCEND past a mount point but still LISTS the
    # mount point itself, so /proc and /sys arrive here as capacity scopes.
    # `du` then walks procfs and exits non-zero the moment a process it is
    # reading exits — measured 2026-08-19 on this host: `du -sx /proc` -> 1,
    # "cannot access '/proc/<pid>'", while the same command over /run, /dev
    # and /dev/shm returns 0. The lane was therefore structurally flaky, and
    # what it was trying to measure is meaningless: a pseudo-filesystem
    # occupies no disk.
    #
    # The discriminator is a property, not a name list. A filesystem that
    # reports ZERO total bytes cannot hold anything that fills a disk, and
    # that is exactly what procfs and sysfs report (measured: /proc 0,
    # /sys 0, /dev 4143394816, / 165295407104). Naming the filesystems
    # instead would go stale the first time the host mounts one nobody
    # listed.
    if ! capacity_scope_is_disk_backed "${discovered_entries[entry_index]}"; then
      capacity_record_unavailable \
        "${error_file}" scope_not_disk_backed 0 \
        "${discovered_entries[entry_index]}"
      continue
    fi
    printf '%s\0' "${discovered_entries[entry_index]}" >> "${output_file}"
  done

  if [ "${#discovered_entries[@]}" -gt "${CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY}" ]; then
    CAPACITY_FRONTIER_TRUNCATED=true
    capacity_record_unavailable \
      "${error_file}" discovery_scope_limit \
      "${CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY}" "${parent_path}"
  fi

  case "${find_status}" in
    0) ;;
    124 | 137)
      CAPACITY_FRONTIER_TRUNCATED=true
      capacity_record_unavailable \
        "${error_file}" discovery_timeout "${find_status}" "${parent_path}" \
        "${discovery_budget}"
      ;;
    141)
      # `head` intentionally closes the pipe after N+1 records. A SIGPIPE is
      # expected only when that bounded record proves truncation.
      if [ "${#discovered_entries[@]}" -le "${CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY}" ]; then
        CAPACITY_FRONTIER_TRUNCATED=true
        capacity_record_unavailable \
          "${error_file}" discovery_failed "${find_status}" "${parent_path}" \
          "${discovery_budget}"
      fi
      ;;
    *)
      CAPACITY_FRONTIER_TRUNCATED=true
      capacity_record_unavailable \
        "${error_file}" discovery_failed "${find_status}" "${parent_path}" \
        "${discovery_budget}"
      ;;
  esac
  if [ "${head_status}" -ne 0 ]; then
    CAPACITY_FRONTIER_TRUNCATED=true
    capacity_record_unavailable \
      "${error_file}" discovery_capture_failed "${head_status}" "${parent_path}" \
      "${discovery_budget}"
  fi
}

emit_exclusion_safe_frontier() {
  local candidate_path="$1"
  local docker_path="$2"
  local frontier_file="$3"
  local error_file="$4"
  local work_dir="$5"
  local deadline="$6"
  local containerd_path=/var/lib/containerd
  local child_file
  local child_path
  local split_candidate=false
  local hotspot_path

  [ -e "${candidate_path}" ] || [ -L "${candidate_path}" ] || return 0
  if [ "${candidate_path}" = "${docker_path}" ] ||
    [[ "${candidate_path}" == "${docker_path}/"* ]] ||
    [ "${candidate_path}" = "${containerd_path}" ] ||
    [[ "${candidate_path}" == "${containerd_path}/"* ]] ||
    capacity_is_hotspot "${candidate_path}"; then
    return 0
  fi

  if capacity_target_below "${candidate_path}" "${docker_path}" ||
    capacity_target_below "${candidate_path}" "${containerd_path}"; then
    split_candidate=true
  fi
  if [ "${CAPACITY_DISK_USAGE_MODE}" = "deep" ]; then
    for hotspot_path in /tmp /var/aqua-saas /var/suderra-os; do
      if [ -e "${hotspot_path}" ] &&
        capacity_target_below "${candidate_path}" "${hotspot_path}"; then
        split_candidate=true
      fi
    done
  fi

  if [ "${split_candidate}" = false ]; then
    capacity_add_frontier_scope "${frontier_file}" "${error_file}" "${candidate_path}"
    return 0
  fi

  CAPACITY_CHILD_SEQUENCE=$((CAPACITY_CHILD_SEQUENCE + 1))
  child_file="${work_dir}/children.${CAPACITY_CHILD_SEQUENCE}"
  capacity_discover_children \
    "${candidate_path}" "${child_file}" "${error_file}" "${work_dir}" "${deadline}"
  while IFS= read -r -d '' child_path; do
    emit_exclusion_safe_frontier \
      "${child_path}" "${docker_path}" "${frontier_file}" \
      "${error_file}" "${work_dir}" "${deadline}"
  done < "${child_file}"
  rm -f -- "${child_file}"
}

capacity_hotspot_frontier() {
  local hotspot_path="$1"
  local docker_path="$2"
  local frontier_file="$3"
  local error_file="$4"
  local work_dir="$5"
  local deadline="$6"
  local child_file
  local child_path

  [ -e "${hotspot_path}" ] || return 0
  if [ "${hotspot_path}" = "${docker_path}" ] ||
    [[ "${hotspot_path}" == "${docker_path}/"* ]] ||
    [ "${hotspot_path}" = /var/lib/containerd ] ||
    [[ "${hotspot_path}" == /var/lib/containerd/* ]]; then
    return 0
  fi

  CAPACITY_CHILD_SEQUENCE=$((CAPACITY_CHILD_SEQUENCE + 1))
  child_file="${work_dir}/children.${CAPACITY_CHILD_SEQUENCE}"
  capacity_discover_children \
    "${hotspot_path}" "${child_file}" "${error_file}" "${work_dir}" "${deadline}"
  while IFS= read -r -d '' child_path; do
    emit_exclusion_safe_frontier \
      "${child_path}" "${docker_path}" "${frontier_file}" \
      "${error_file}" "${work_dir}" "${deadline}"
  done < "${child_file}"
  rm -f -- "${child_file}"
}

capacity_build_frontier() {
  local frontier_file="$1"
  local error_file="$2"
  local work_dir="$3"
  local deadline="$4"
  local docker_path
  local priority_path
  local hotspot_path
  local root_children_file
  local root_path

  docker_path="$(docker_root)"
  CAPACITY_FRONTIER_COUNT=0
  CAPACITY_FRONTIER_TRUNCATED=false
  CAPACITY_FRONTIER_LIMIT_RECORDED=false
  CAPACITY_UNAVAILABLE_RECORDS=0
  CAPACITY_UNAVAILABLE_TRUNCATED=false
  CAPACITY_DISCOVERY_SEQUENCE=0
  CAPACITY_CHILD_SEQUENCE=0
  declare -gA CAPACITY_FRONTIER_SEEN=()
  : > "${frontier_file}"

  case "${CAPACITY_DISK_USAGE_MODE}" in
    deep)
      # Known large paths go first so they retain a worker even if a hostile
      # directory later hits the discovery or global scope cap.
      for priority_path in \
        /var/aqua-saas/target /var/aqua-saas/node_modules \
        /var/suderra-os/target /var/suderra-os/node_modules; do
        emit_exclusion_safe_frontier \
          "${priority_path}" "${docker_path}" "${frontier_file}" \
          "${error_file}" "${work_dir}" "${deadline}"
      done
      for hotspot_path in /tmp /var/aqua-saas /var/suderra-os; do
        capacity_hotspot_frontier \
          "${hotspot_path}" "${docker_path}" "${frontier_file}" \
          "${error_file}" "${work_dir}" "${deadline}"
      done
      ;;
    summary) ;;
    *)
      echo "::warning::unknown_capacity_disk_usage_mode mode=${CAPACITY_DISK_USAGE_MODE}; using summary" >&2
      ;;
  esac

  # Preserve likely high-value evidence before the generic root enumeration.
  for priority_path in /var/lib/postgresql /var/log /opt /home /root; do
    emit_exclusion_safe_frontier \
      "${priority_path}" "${docker_path}" "${frontier_file}" \
      "${error_file}" "${work_dir}" "${deadline}"
  done

  CAPACITY_CHILD_SEQUENCE=$((CAPACITY_CHILD_SEQUENCE + 1))
  root_children_file="${work_dir}/children.${CAPACITY_CHILD_SEQUENCE}"
  capacity_discover_children / "${root_children_file}" \
    "${error_file}" "${work_dir}" "${deadline}"
  while IFS= read -r -d '' root_path; do
    emit_exclusion_safe_frontier \
      "${root_path}" "${docker_path}" "${frontier_file}" \
      "${error_file}" "${work_dir}" "${deadline}"
  done < "${root_children_file}"
  rm -f -- "${root_children_file}"
}

du_frontier_snapshot() {
  local snapshot_file="$1"
  local error_file="$2"
  local work_dir="$3"
  local deadline=$((SECONDS + CAPACITY_DU_TIMEOUT_SECONDS))
  local discovery_deadline=$((SECONDS + CAPACITY_DU_DISCOVERY_TIMEOUT_SECONDS))
  local frontier_file="${work_dir}/frontier.paths"
  local active=0
  local discovered=0
  local started=0
  local scope_path
  local path_base64
  local remaining
  local scope_timeout
  local result_path
  local result_index
  local result_kind
  local result_value
  local result_detail
  local result_timeout
  local deadline_recorded=false

  if [ "${discovery_deadline}" -gt "${deadline}" ]; then
    discovery_deadline="${deadline}"
  fi
  capacity_build_frontier \
    "${frontier_file}" "${error_file}" "${work_dir}" "${discovery_deadline}"

  while IFS= read -r -d '' scope_path; do
    discovered=$((discovered + 1))
    while [ "${active}" -ge "${CAPACITY_DU_PARALLELISM}" ]; do
      wait -n
      active=$((active - 1))
    done

    remaining=$((deadline - SECONDS))
    if [ "${remaining}" -le 0 ]; then
      CAPACITY_FRONTIER_TRUNCATED=true
      if [ "${deadline_recorded}" = false ]; then
        capacity_record_unavailable \
          "${error_file}" global_deadline 0 "${scope_path}"
        deadline_recorded=true
      fi
      break
    fi
    scope_timeout="${remaining}"
    if [ "${scope_timeout}" -gt "${CAPACITY_DU_SCOPE_TIMEOUT_SECONDS}" ]; then
      scope_timeout="${CAPACITY_DU_SCOPE_TIMEOUT_SECONDS}"
    fi

    started=$((started + 1))
    result_path="${work_dir}/result.${started}"
    path_base64="$(printf '%s' "${scope_path}" | base64 -w0)"
    (
      set +e
      raw_output_path="${result_path}.raw"
      timeout --signal=TERM \
        --kill-after="${CAPACITY_DU_KILL_GRACE_SECONDS}s" \
        "${scope_timeout}s" du -sx -B1 --null -- "${scope_path}" 2>/dev/null |
        head -c "${CAPACITY_DU_MAX_RESULT_BYTES}" > "${raw_output_path}"
      local_pipeline_status=("${PIPESTATUS[@]}")
      local_status="${local_pipeline_status[0]:-1}"
      local_head_status="${local_pipeline_status[1]:-1}"
      local_output_bytes="$(wc -c < "${raw_output_path}")"
      local_record=''
      local_record_status=1
      if [ "${local_output_bytes}" -lt "${CAPACITY_DU_MAX_RESULT_BYTES}" ]; then
        IFS= read -r -d '' local_record < "${raw_output_path}"
        local_record_status=$?
      fi
      if [ "${local_record_status}" -eq 0 ]; then
        local_bytes=${local_record%%$'\t'*}
        local_path=${local_record#*$'\t'}
        if [[ "${local_bytes}" =~ ^[0-9]+$ ]] && [ "${local_path}" != "${local_record}" ]; then
          local_path_base64="$(printf '%s' "${local_path}" | base64 -w0)"
          printf 'ok\t%s\t0\t0\t%s\n' "${local_bytes}" "${local_path_base64}"
        else
          printf 'error\tmalformed_output\t0\t%s\t%s\n' \
            "${scope_timeout}" "${path_base64}"
        fi
      elif [ "${local_output_bytes}" -ge "${CAPACITY_DU_MAX_RESULT_BYTES}" ]; then
        printf 'error\tdu_output_limit\t%s\t%s\t%s\n' \
          "${CAPACITY_DU_MAX_RESULT_BYTES}" "${scope_timeout}" "${path_base64}"
      elif [ "${local_status}" -eq 0 ]; then
        printf 'error\tmalformed_output\t0\t%s\t%s\n' \
          "${scope_timeout}" "${path_base64}"
      fi
      if [ "${local_head_status}" -ne 0 ]; then
        printf 'error\tdu_capture_failed\t%s\t%s\t%s\n' \
          "${local_head_status}" "${scope_timeout}" "${path_base64}"
      elif [ "${local_output_bytes}" -lt "${CAPACITY_DU_MAX_RESULT_BYTES}" ] &&
        [ "${local_status}" -ne 0 ]; then
        case "${local_status}" in
          124 | 137) local_reason=du_timeout ;;
          *) local_reason=du_failed ;;
        esac
        printf 'error\t%s\t%s\t%s\t%s\n' \
          "${local_reason}" "${local_status}" "${scope_timeout}" "${path_base64}"
      fi
      rm -f -- "${raw_output_path}"
      exit 0
    ) > "${result_path}" &
    active=$((active + 1))
  done < "${frontier_file}"

  while [ "${active}" -gt 0 ]; do
    wait -n
    active=$((active - 1))
  done

  for ((result_index = 1; result_index <= started; result_index++)); do
    result_path="${work_dir}/result.${result_index}"
    if [ ! -f "${result_path}" ]; then
      capacity_record_unavailable \
        "${error_file}" worker_result_missing 0 "${result_path}"
      continue
    fi
    if [ ! -s "${result_path}" ]; then
      capacity_record_unavailable \
        "${error_file}" worker_result_empty 0 "${result_path}"
      continue
    fi
    while IFS=$'\t' read -r \
      result_kind result_value result_detail result_timeout path_base64; do
      case "${result_kind}" in
        ok) printf '%s\t%s\n' "${result_value}" "${path_base64}" >> "${snapshot_file}" ;;
        error)
          capacity_record_unavailable_encoded \
            "${error_file}" "${result_value}" "${result_detail}" "${path_base64}" \
            "${result_timeout}"
          ;;
        *)
          capacity_record_unavailable \
            "${error_file}" malformed_worker_result 0 "${result_path}"
          ;;
      esac
    done < "${result_path}"
  done

  printf '  frontier_scopes_discovered=%s started=%s records=%s unavailable_scopes=%s truncated=%s unavailable_truncated=%s parallelism=%s scope_timeout_max_seconds=%s\n' \
    "${discovered}" \
    "${started}" \
    "$(awk 'END {print NR + 0}' "${snapshot_file}")" \
    "$(awk 'END {print NR + 0}' "${error_file}")" \
    "${CAPACITY_FRONTIER_TRUNCATED}" \
    "${CAPACITY_UNAVAILABLE_TRUNCATED}" \
    "${CAPACITY_DU_PARALLELISM}" \
    "${CAPACITY_DU_SCOPE_TIMEOUT_SECONDS}"
}

disk_usage_snapshot() {
  echo ""
  echo "Top-level disk usage (same filesystem only):"
  echo "  disk_usage_mode=${CAPACITY_DISK_USAGE_MODE}"
  if [ "${CAPACITY_DISK_USAGE_MODE}" = "off" ]; then
    echo "  disk_usage_unavailable reason=disabled"
    return 0
  fi

  local capacity_command
  for capacity_command in timeout base64 find head wc; do
    if ! command -v "${capacity_command}" >/dev/null 2>&1; then
      echo "  disk_usage_unavailable reason=required_command_missing command=${capacity_command}"
      return 0
    fi
  done

  case "${CAPACITY_DU_TIMEOUT_SECONDS}" in
    ''|*[!0-9]*|0|0*)
      echo "  disk_usage_unavailable reason=invalid_timeout_seconds value=${CAPACITY_DU_TIMEOUT_SECONDS} allowed_range=1-${CAPACITY_DU_TIMEOUT_MAX_SECONDS}"
      return 0
      ;;
  esac
  if [ "${#CAPACITY_DU_TIMEOUT_SECONDS}" -gt "${#CAPACITY_DU_TIMEOUT_MAX_SECONDS}" ] ||
    { [ "${#CAPACITY_DU_TIMEOUT_SECONDS}" -eq "${#CAPACITY_DU_TIMEOUT_MAX_SECONDS}" ] &&
      [[ "${CAPACITY_DU_TIMEOUT_SECONDS}" > "${CAPACITY_DU_TIMEOUT_MAX_SECONDS}" ]]; }; then
    echo "  disk_usage_unavailable reason=invalid_timeout_seconds value=${CAPACITY_DU_TIMEOUT_SECONDS} allowed_range=1-${CAPACITY_DU_TIMEOUT_MAX_SECONDS}"
    return 0
  fi

  local work_dir
  if ! work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aqua-capacity-du.XXXXXX")"; then
    echo "  disk_usage_unavailable reason=mktemp_failed"
    return 0
  fi
  local snapshot_file="${work_dir}/completed.tsv"
  local error_file="${work_dir}/unavailable.tsv"
  local top_file="${work_dir}/top.tsv"
  local bytes
  local path_base64
  local decoded_path
  local unavailable_reason
  local unavailable_detail
  local unavailable_timeout
  local timeout_label
  local -a format_status=()
  : > "${snapshot_file}"
  : > "${error_file}"

  echo "  scope=disjoint_frontier excludes=$(docker_root),/var/lib/containerd"
  echo "  global_timeout_seconds=${CAPACITY_DU_TIMEOUT_SECONDS} scope_timeout_max_seconds=${CAPACITY_DU_SCOPE_TIMEOUT_SECONDS} discovery_timeout_max_seconds=${CAPACITY_DU_DISCOVERY_TIMEOUT_SECONDS} kill_grace_seconds=${CAPACITY_DU_KILL_GRACE_SECONDS} required_non_du_headroom_seconds=${CAPACITY_NON_DU_HEADROOM_SECONDS}"
  du_frontier_snapshot "${snapshot_file}" "${error_file}" "${work_dir}"

  if [ -s "${snapshot_file}" ]; then
    set +e
    sort -nr -k1,1 "${snapshot_file}" | awk 'NR <= 40' > "${top_file}"
    format_status=("${PIPESTATUS[@]}")
    set -e
    if [ "${format_status[0]:-1}" -ne 0 ] || [ "${format_status[1]:-1}" -ne 0 ]; then
      echo "    disk_usage_unavailable reason=sort_or_format_failed"
    else
      while IFS=$'\t' read -r bytes path_base64; do
        if ! decoded_path="$(printf '%s' "${path_base64}" | base64 --decode 2>/dev/null)"; then
          echo "    disk_usage_unavailable reason=path_decode_failed"
          continue
        fi
        printf '    bytes=%s path=%q\n' "${bytes}" "${decoded_path}"
      done < "${top_file}"
    fi
  else
    echo "    disk_usage_unavailable reason=no_frontier_scope_completed"
  fi

  if [ -s "${error_file}" ]; then
    while IFS=$'\t' read -r \
      unavailable_reason unavailable_detail unavailable_timeout path_base64; do
      if ! decoded_path="$(printf '%s' "${path_base64}" | base64 --decode 2>/dev/null)"; then
        echo "    disk_usage_unavailable reason=unavailable_path_decode_failed"
        continue
      fi
      case "${unavailable_reason}" in
        du_* | malformed_output) timeout_label=scope_timeout_seconds ;;
        discovery_*) timeout_label=discovery_timeout_seconds ;;
        *) timeout_label=operation_timeout_seconds ;;
      esac
      printf '    disk_usage_unavailable path=%q reason=%s detail=%s global_timeout_seconds=%s %s=%s\n' \
        "${decoded_path}" "${unavailable_reason}" "${unavailable_detail}" \
        "${CAPACITY_DU_TIMEOUT_SECONDS}" "${timeout_label}" "${unavailable_timeout}"
    done < "${error_file}"
  fi

  rm -rf -- "${work_dir}"
  # Diagnostics are evidence only. In particular, timeout(1)'s 124/137 must
  # never replace the canonical capacity verdict captured by run_gate.
  return 0
}

docker_image_inventory() {
  echo ""
  echo "Docker image inventory:"
  docker image ls --format '  repository={{.Repository}} tag={{.Tag}} id={{.ID}} size={{.Size}}' 2>/dev/null || true
}

service_count() {
  if [ "${FULL_DEPLOY}" = "true" ]; then
    echo 0
    return 0
  fi
  if [ -z "${DEPLOY_SERVICES}" ]; then
    echo 0
    return 0
  fi
  # shellcheck disable=SC2086
  set -- ${DEPLOY_SERVICES}
  echo "$#"
}

projected_pull_bytes() {
  if [ -n "${DEPLOY_PROJECTED_PULL_BYTES:-}" ]; then
    echo "${DEPLOY_PROJECTED_PULL_BYTES}"
    return 0
  fi

  if [ "${FULL_DEPLOY}" = "true" ]; then
    echo $((FULL_PULL_ESTIMATE_GIB * GIB))
  else
    local count
    count="$(service_count)"
    if [ "${count}" -eq 0 ]; then
      echo 0
    else
      echo $((count * SERVICE_PULL_ESTIMATE_GIB * GIB))
    fi
  fi
}

thresholds() {
  if [ "${FULL_DEPLOY}" = "true" ]; then
    echo "$((FULL_HARD_FREE_GIB * GIB)) $((FULL_WARN_FREE_GIB * GIB)) ${FULL_HARD_FREE_PERCENT} $((FULL_PROJECTED_RESERVE_GIB * GIB))"
  else
    echo "$((SELECTIVE_HARD_FREE_GIB * GIB)) $((SELECTIVE_WARN_FREE_GIB * GIB)) ${SELECTIVE_HARD_FREE_PERCENT} $((SELECTIVE_PROJECTED_RESERVE_GIB * GIB))"
  fi
}

capacity_core_snapshot() {
  local pull_estimate
  pull_estimate="$(projected_pull_bytes)"

  echo "=== Droplet capacity snapshot ==="
  echo "mode=$([ "${FULL_DEPLOY}" = "true" ] && echo full || echo selective)"
  echo "deploy_services=${DEPLOY_SERVICES:-none}"
  echo "image_prefix=${IMAGE_PREFIX}"
  echo "deploy_sha=${DEPLOY_SHA:-unknown}"
  echo "docker_root=$(docker_root)"
  echo "projected_pull_bytes=${pull_estimate}"
  echo ""
  echo "Filesystem bytes:"
  local path fs size avail mount used_pct free_pct
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    IFS="$(printf '\t')" read -r fs size avail mount < <(df_bytes_row "${path}")
    if [ -z "${size:-}" ] || [ "${size}" -eq 0 ]; then
      continue
    fi
    used_pct=$((100 - (avail * 100 / size)))
    free_pct=$((avail * 100 / size))
    printf '  path=%s mount=%s fs=%s size_bytes=%s free_bytes=%s used_pct=%s free_pct=%s\n' \
      "${path}" "${mount}" "${fs}" "${size}" "${avail}" "${used_pct}" "${free_pct}"
  done < <(runtime_paths)

  echo ""
  echo "Filesystem inodes:"
  local inodes_free inodes_total inode_free_pct
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    IFS="$(printf '\t')" read -r inodes_total inodes_free < <(df_inode_row "${path}")
    if [ -z "${inodes_total:-}" ] || [ "${inodes_total}" -eq 0 ]; then
      continue
    fi
    inode_free_pct=$((inodes_free * 100 / inodes_total))
    printf '  path=%s inodes_total=%s inodes_free=%s inode_free_pct=%s\n' \
      "${path}" "${inodes_total}" "${inodes_free}" "${inode_free_pct}"
  done < <(runtime_paths)

}

capacity_diagnostic_snapshot() {
  disk_usage_snapshot || echo "  disk_usage_unavailable reason=unexpected_diagnostic_failure"
  echo ""
  echo "Docker storage usage:"
  docker system df 2>/dev/null || true
  docker_image_inventory || echo "  docker_image_inventory_unavailable reason=unexpected_diagnostic_failure"
  return 0
}

capacity_snapshot() {
  capacity_core_snapshot
  capacity_diagnostic_snapshot
}

write_capacity_json() {
  [ -n "${DEPLOY_STATE_DIR}" ] || return 0
  mkdir -p "${DEPLOY_STATE_DIR}"
  local out="${DEPLOY_STATE_DIR}/capacity-snapshot.json"
  local pull_estimate
  pull_estimate="$(projected_pull_bytes)"
  local docker_root_dir
  docker_root_dir="$(docker_root)"
  local min_free=""
  local min_inode=""
  local path size avail inodes_total inodes_free pct inode_pct

  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    IFS="$(printf '\t')" read -r _ size avail _ < <(df_bytes_row "${path}")
    if [ -n "${avail:-}" ]; then
      if [ -z "${min_free}" ] || [ "${avail}" -lt "${min_free}" ]; then
        min_free="${avail}"
      fi
    fi
    IFS="$(printf '\t')" read -r inodes_total inodes_free < <(df_inode_row "${path}")
    if [ -n "${inodes_total:-}" ] && [ "${inodes_total}" -gt 0 ]; then
      inode_pct=$((inodes_free * 100 / inodes_total))
      if [ -z "${min_inode}" ] || [ "${inode_pct}" -lt "${min_inode}" ]; then
        min_inode="${inode_pct}"
      fi
    fi
  done < <(runtime_paths)

  cat > "${out}" <<EOF
{"dockerRoot":"${docker_root_dir}","fullDeploy":$([ "${FULL_DEPLOY}" = "true" ] && echo true || echo false),"deployServices":"${DEPLOY_SERVICES:-}","projectedPullBytes":${pull_estimate},"minRuntimeFreeBytes":${min_free:-0},"minRuntimeInodeFreePercent":${min_inode:-0}}
EOF
}

capacity_failures() {
  local hard_free warn_free hard_free_pct projected_reserve
  read -r hard_free warn_free hard_free_pct projected_reserve < <(thresholds)
  local pull_estimate
  pull_estimate="$(projected_pull_bytes)"
  local failures=0
  local warnings=0
  local path fs size avail mount free_pct projected_free
  local inodes_total inodes_free inode_free_pct

  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    IFS="$(printf '\t')" read -r fs size avail mount < <(df_bytes_row "${path}")
    if [ -z "${size:-}" ] || [ "${size}" -eq 0 ]; then
      continue
    fi
    free_pct=$((avail * 100 / size))
    projected_free=$((avail - pull_estimate))

    if [ "${avail}" -lt "${hard_free}" ]; then
      echo "::error::disk_preflight_low_bytes path=${path} free_bytes=${avail} hard_free_bytes=${hard_free}"
      failures=$((failures + 1))
    elif [ "${avail}" -lt "${warn_free}" ]; then
      echo "::warning::disk_preflight_warn_bytes path=${path} free_bytes=${avail} warn_free_bytes=${warn_free}"
      warnings=$((warnings + 1))
    fi

    if [ "${free_pct}" -lt "${hard_free_pct}" ]; then
      echo "::error::disk_preflight_low_percent path=${path} free_pct=${free_pct} hard_free_pct=${hard_free_pct}"
      failures=$((failures + 1))
    fi

    if [ "${projected_free}" -lt "${projected_reserve}" ]; then
      echo "::error::disk_preflight_projected_low path=${path} projected_free_bytes=${projected_free} reserve_bytes=${projected_reserve}"
      failures=$((failures + 1))
    fi

    IFS="$(printf '\t')" read -r inodes_total inodes_free < <(df_inode_row "${path}")
    if [ -n "${inodes_total:-}" ] && [ "${inodes_total}" -gt 0 ]; then
      inode_free_pct=$((inodes_free * 100 / inodes_total))
      if [ "${inode_free_pct}" -lt "${HARD_INODE_FREE_PERCENT}" ]; then
        echo "::error::disk_preflight_low_inodes path=${path} inode_free_pct=${inode_free_pct} hard_inode_free_pct=${HARD_INODE_FREE_PERCENT}"
        failures=$((failures + 1))
      elif [ "${inode_free_pct}" -lt "${WARN_INODE_FREE_PERCENT}" ]; then
        echo "::warning::disk_preflight_warn_inodes path=${path} inode_free_pct=${inode_free_pct} warn_inode_free_pct=${WARN_INODE_FREE_PERCENT}"
        warnings=$((warnings + 1))
      fi
    fi
  done < <(runtime_paths)

  if [ "${failures}" -gt 0 ]; then
    return 2
  fi
  if [ "${warnings}" -gt 0 ]; then
    return 1
  fi
  return 0
}

protected_image_ids_file() {
  local file="$1"
  local image_inventory_file="$2"
  : > "${file}"

  local -a container_ids=()
  mapfile -t container_ids < <(docker ps -aq 2>/dev/null || true)
  if [ "${#container_ids[@]}" -gt 0 ]; then
    docker inspect --format='{{.Image}}' "${container_ids[@]}" 2>/dev/null >> "${file}" || true
  fi

  if [ -n "${ROLLBACK_MANIFEST}" ] && [ -s "${ROLLBACK_MANIFEST}" ]; then
    awk -F '\t' 'NF >= 2 {print $2}' "${ROLLBACK_MANIFEST}" >> "${file}" || true
  fi

  if [ -n "${DEPLOY_SHA}" ]; then
    awk -v sha="${DEPLOY_SHA}" '$2 == sha {print $3}' \
      "${image_inventory_file}" >> "${file}" || true
  fi

  sort -u "${file}" -o "${file}"
}

is_protected_id() {
  local id="$1"
  local file="$2"
  local needle="${id#sha256:}"
  awk -v needle="${needle}" '
    {
      candidate = $0
      sub(/^sha256:/, "", candidate)
      if (candidate == needle || index(candidate, needle) == 1 || index(needle, candidate) == 1) {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  ' "${file}" 2>/dev/null
}

capacity_gc_target_met() {
  [ -n "${GC_CAPACITY_TARGET_RC:-}" ] || return 1
  [ "${GC_DRY_RUN:-false}" != "true" ] || return 1

  local current_rc
  if capacity_failures >/dev/null 2>&1; then
    current_rc=0
  else
    current_rc=$?
  fi
  [ "${current_rc}" -le "${GC_CAPACITY_TARGET_RC}" ] || return 1

  CAPACITY_GC_TARGET_MET=true
  if [ "${GC_CAPACITY_TARGET_RC}" -eq 0 ]; then
    echo "Capacity GC target met: warnings cleared; stopping safe image GC."
  else
    echo "Capacity GC target met: hard failures cleared; stopping safe image GC."
  fi
  return 0
}

gc_remove_ref() {
  # GC_DRY_RUN=true lists what WOULD be removed without touching the
  # daemon — operator-auditable enumeration before any destructive run.
  local ref="$1"
  if [ "${GC_DRY_RUN:-false}" = "true" ]; then
    echo "  [dry-run] would remove ${ref}"
    return 0
  fi
  docker rmi "${ref}" 2>&1 || true
}

safe_image_gc() {
  echo "=== Safe image-only GC ==="
  echo "Policy: dangling images + unused old app SHA tags + superseded rollback retags + unclassified app tags (default-deny); volumes/containers/networks/build-cache untouched."
  local docker_root_path before_fs before_size before_free before_mount
  local after_fs after_size after_free after_mount reclaimed_bytes
  docker_root_path="$(docker_root)"
  IFS="$(printf '\t')" read -r before_fs before_size before_free before_mount \
    < <(df_bytes_row "${docker_root_path}") || true
  CAPACITY_GC_TARGET_MET=false

  if [ "${GC_DRY_RUN:-false}" != "true" ]; then
    docker image prune -f --filter "dangling=true" 2>&1 || true
    capacity_gc_target_met || true
  fi

  local protected
  local image_inventory
  protected="$(mktemp)"
  image_inventory="$(mktemp)"
  if [ "${CAPACITY_GC_TARGET_MET}" != "true" ]; then
    docker image ls --format '{{.Repository}} {{.Tag}} {{.ID}}' \
      > "${image_inventory}" 2>/dev/null || true
    protected_image_ids_file "${protected}" "${image_inventory}"
  fi

  # Rollback-retag retention (INFRA-HIGH-013). Every deploy retags the
  # previously-running generation as rollback-<sha>-<ts> — a full image
  # set (~20GB) per deploy — and the SHA-only filter in the pass below
  # never matches those tags, so generations accumulated until the
  # capacity gate blocked the train (3x on 2026-06-11 alone). Retention
  # policy: a rollback retag survives ONLY while the current rollback
  # manifest (or a running container) references its image ID — i.e.
  # exactly the newest generation. Older generations are LOCAL retags of
  # images this droplet only ever PULLED from GHCR (pull-only runtime,
  # ADR-033), so deletion loses nothing that is not re-pullable.
  local repo tag id ref removed_rollback=0 skipped=0
  if [ "${CAPACITY_GC_TARGET_MET}" != "true" ]; then
    while read -r repo tag id; do
      [ -n "${repo:-}" ] || continue
      case "${repo}" in
        "${IMAGE_PREFIX}"/*) ;;
        *) continue ;;
      esac
      case "${tag}" in
        rollback-*) ;;
        *) continue ;;
      esac
      if is_protected_id "${id}" "${protected}"; then
        echo "  keep protected rollback retag ${repo}:${tag} ${id}"
        skipped=$((skipped + 1))
        continue
      fi
      echo "  remove superseded rollback retag ${repo}:${tag} ${id}"
      gc_remove_ref "${repo}:${tag}"
      removed_rollback=$((removed_rollback + 1))
      if capacity_gc_target_met; then
        break
      fi
    done < "${image_inventory}"
  fi

  local removed=0 removed_untagged=0 removed_unclassified=0
  if [ "${CAPACITY_GC_TARGET_MET}" != "true" ]; then
    while read -r repo tag id; do
      [ -n "${repo:-}" ] || continue
      case "${repo}" in
        "${IMAGE_PREFIX}"/*) ;;
        *) continue ;;
      esac

      if [ "${tag}" = "<none>" ]; then
        if is_protected_id "${id}" "${protected}"; then
          echo "  keep protected untagged app image ${repo}@${id}"
          skipped=$((skipped + 1))
          continue
        fi

        echo "  remove unused untagged app image ${repo}@${id}"
        gc_remove_ref "${id}"
        removed_untagged=$((removed_untagged + 1))
        if capacity_gc_target_met; then
          break
        fi
        continue
      fi

      case "${tag}" in
        latest|staging|buildcache-*) continue ;;
        rollback-*) continue ;; # retention pass above owns rollback retags
      esac
      if [ -n "${DEPLOY_SHA}" ] && [ "${tag}" = "${DEPLOY_SHA}" ]; then
        continue
      fi
      if is_protected_id "${id}" "${protected}"; then
        echo "  keep protected ${repo}:${tag} ${id}"
        skipped=$((skipped + 1))
        continue
      fi

      ref="${repo}:${tag}"
      if printf '%s' "${tag}" | grep -Eq '^[0-9a-f]{40}$'; then
        echo "  remove unused old app tag ${ref} ${id}"
        gc_remove_ref "${ref}"
        removed=$((removed + 1))
      else
        # Default-deny: an app tag outside the closed keep-allowlist (e.g. an
        # ad-hoc incident-clean-* retag) previously matched NO branch and
        # became immortal — unclassified is a reason to reclaim, not to keep.
        echo "  remove unclassified app tag ${ref} ${id}"
        gc_remove_ref "${ref}"
        removed_unclassified=$((removed_unclassified + 1))
      fi
      if capacity_gc_target_met; then
        break
      fi
    done < "${image_inventory}"
  fi

  rm -f "${protected}" "${image_inventory}"

  # Untagging alone reclaims nothing while sibling tags or freshly
  # orphaned layers remain — the historical before=after symptom. A final
  # dangling-only prune converts the untag passes into actual bytes.
  if [ "${GC_DRY_RUN:-false}" != "true" ] && \
    [ "${CAPACITY_GC_TARGET_MET}" != "true" ]; then
    docker image prune -f --filter "dangling=true" 2>&1 || true
    capacity_gc_target_met || true
  fi

  IFS="$(printf '\t')" read -r after_fs after_size after_free after_mount \
    < <(df_bytes_row "${docker_root_path}") || true
  reclaimed_bytes="unknown"
  if [[ "${before_free:-}" =~ ^[0-9]+$ ]] && [[ "${after_free:-}" =~ ^[0-9]+$ ]]; then
    reclaimed_bytes=$((after_free - before_free))
  fi
  echo "Safe GC complete; removed_tags=${removed:-0} removed_untagged=${removed_untagged:-0} removed_rollback_retags=${removed_rollback:-0} removed_unclassified=${removed_unclassified:-0} skipped_protected=${skipped:-0} dry_run=${GC_DRY_RUN:-false} before_free_bytes=${before_free:-unknown} after_free_bytes=${after_free:-unknown} reclaimed_bytes=${reclaimed_bytes} capacity_target_met=${CAPACITY_GC_TARGET_MET}"
}

# =============================================================================
# safe_tmp_gc — reclaim REGENERABLE build caches from the temp filesystem.
# =============================================================================
# WHY THIS EXISTS. On 2026-08-09 the capacity gate blocked with 1.24 GB free
# against a 37.5 GB floor while `safe_image_gc` had nothing left to take: all
# 37 images backed running containers. The space was in /tmp, and one pattern
# owned half the disk:
#
#     nx-native-file-cache-*   1,421 directories, 29.3 GB
#
# Nx's native module resolves its cache through `std::env::temp_dir()` — i.e.
# TMPDIR — and creates a fresh directory per workspace-process. Nothing ever
# removes them, so every CI invocation leaks one. The age histogram showed
# 100-400 new directories a day since 2026-08-04. A one-off manual sweep
# reclaimed 12.9 GB on 2026-08-08 and the disk was full again within a day,
# which is what makes this a gate concern rather than an operator chore.
#
# WHY A SEPARATE FUNCTION. safe_image_gc states its own contract in its banner:
# "volumes/containers/networks/build-cache untouched". Widening it to sweep a
# filesystem would make that sentence false. This is the same conservatism
# applied to a different resource, kept separate so each policy can be read
# on its own.
#
# THE POLICY IS DEFAULT-DENY, and every clause below is load-bearing:
#   * an explicit allowlist of patterns that are REGENERABLE BY CONSTRUCTION —
#     a build cache, not a work product. Anything unlisted is never touched,
#     which is what keeps another session's checkout safe.
#   * an age floor, so an in-flight build's cache is never pulled out from
#     under it.
#   * an open-handle check per candidate; a directory any process still holds
#     is skipped even if it is old.
#   * `-maxdepth 1` and an absolute root, so a pattern can never match deeper
#     than the temp directory itself.
#
# It does NOT touch: repository checkouts, git worktrees, ARIA state, session
# scratchpads, or anything outside TMPDIR.
TMP_GC_PATTERNS="nx-native-file-cache-* v8-compile-cache-* node-compile-cache jest_* pytest-of-*"
TMP_GC_MIN_AGE_MINUTES="${TMP_GC_MIN_AGE_MINUTES:-720}"

safe_tmp_gc() {
  local root="${TMPDIR:-/tmp}"
  echo "=== Safe temp GC (regenerable build caches only) ==="
  echo "Policy: default-deny allowlist [${TMP_GC_PATTERNS}]; age > ${TMP_GC_MIN_AGE_MINUTES}m; open handles skipped; nothing outside ${root} is considered."
  if [ ! -d "${root}" ]; then
    echo "Safe temp GC: ${root} is not a directory; nothing to do."
    return 0
  fi

  local before after removed skipped_open candidate
  before=$(df -k --output=avail "${root}" 2>/dev/null | tail -1 | tr -d ' ')
  removed=0
  skipped_open=0

  local pattern
  for pattern in ${TMP_GC_PATTERNS}; do
    while IFS= read -r candidate; do
      [ -n "${candidate}" ] || continue
      # A cache someone is still writing is not garbage, whatever its age.
      if command -v fuser > /dev/null 2>&1 && fuser -s "${candidate}" 2>/dev/null; then
        skipped_open=$((skipped_open + 1))
        continue
      fi
      if [ "${GC_DRY_RUN:-false}" = "true" ]; then
        echo "  would remove ${candidate}"
      else
        rm -rf -- "${candidate}" 2>/dev/null || true
      fi
      removed=$((removed + 1))
    done < <(/usr/bin/find "${root}" -maxdepth 1 -name "${pattern}" -type d -mmin "+${TMP_GC_MIN_AGE_MINUTES}" 2>/dev/null)
  done

  after=$(df -k --output=avail "${root}" 2>/dev/null | tail -1 | tr -d ' ')
  local reclaimed_mb=0
  if [ -n "${before}" ] && [ -n "${after}" ]; then
    reclaimed_mb=$(( (after - before) / 1024 ))
  fi
  echo "Safe temp GC complete; removed=${removed} skipped_open=${skipped_open} dry_run=${GC_DRY_RUN:-false} reclaimed_mb=${reclaimed_mb}"
}

run_gate() {
  capacity_core_snapshot
  write_capacity_json

  set +e
  capacity_failures
  local rc=$?
  set -e

  if [ "${rc}" -ne 0 ] && [ "${CAPACITY_GC_MODE}" = "auto" ]; then
    echo "Capacity preflight: warning/failure before GC; running one safe image-only GC pass."
    GC_CAPACITY_TARGET_RC=$((rc - 1))
    safe_image_gc
    unset GC_CAPACITY_TARGET_RC
    # Images are not always where the space is. On 2026-08-09 every image
    # backed a running container and the shortfall was entirely regenerable
    # build caches in TMPDIR, so an image-only response reported "nothing to
    # reclaim" beside a disk that was 98% full.
    if [ "${CAPACITY_GC_TARGET_MET}" != "true" ]; then
      safe_tmp_gc
    fi
    capacity_core_snapshot
    write_capacity_json
    set +e
    capacity_failures
    rc=$?
    set -e
  fi

  # Exactly one bounded diagnostic snapshot follows the final threshold verdict.
  # It is deliberately outside the verdict-producing section so a timeout
  # emits unavailable evidence without changing rc.
  capacity_diagnostic_snapshot

  if [ "${rc}" -eq 0 ]; then
    echo "Capacity preflight: PASS"
    return 0
  fi

  if [ "${rc}" -eq 1 ]; then
    echo "Capacity preflight: PASS with warnings"
    return 0
  fi

  echo "::error::Capacity preflight failed. No production containers, data volumes, migrations, or image pulls should be touched after this failure."
  return 1
}

case "${command}" in
  report)
    capacity_snapshot
    write_capacity_json
    ;;
  gate)
    run_gate
    ;;
  gc)
    safe_image_gc
    ;;
  *)
    usage
    exit 2
    ;;
esac
