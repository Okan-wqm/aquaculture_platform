#!/usr/bin/env bash
# Canonical droplet capacity preflight + closed-policy garbage collection.
#
# This script never removes volumes, containers, networks, databases, WAL, or
# build cache. Image cleanup considers only explicit application references and
# image IDs selected from one lock-consistent inventory. Host cleanup is a
# separate exact-path policy whose predicates all fail closed.

set -euo pipefail

CAPACITY_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/deploy/production-host-control-plane.sh
source "${CAPACITY_SCRIPT_DIR}/production-host-control-plane.sh"
# shellcheck source=scripts/deploy/deploy-paths.sh
source "${CAPACITY_SCRIPT_DIR}/deploy-paths.sh"

readonly CAPACITY_CANONICAL_IMAGE_PREFIX=ghcr.io/okan-wqm/aquaculture_platform
if [ -n "${IMAGE_PREFIX:-}" ] && [ "${IMAGE_PREFIX}" != "${CAPACITY_CANONICAL_IMAGE_PREFIX}" ]; then
  echo "::error::capacity_image_prefix_override_rejected"
  exit 2
fi
readonly IMAGE_PREFIX="${CAPACITY_CANONICAL_IMAGE_PREFIX}"
DEPLOY_SHA="${DEPLOY_SHA:-}"
FULL_DEPLOY="${FULL_DEPLOY:-false}"
DEPLOY_SERVICES="${DEPLOY_SERVICES:-}"
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-}"
CAPACITY_GC_BOOTSTRAP_AUTHORITY=false
CAPACITY_GC_BOOTSTRAP_REPLAY=false
CAPACITY_GC_BOOTSTRAP_ROLLOVER=false
CAPACITY_GC_PROTECT_ALL_ROLLBACK_RELEASES=false
readonly DEPLOY_STATE_ROOT_DEFAULT=/var/lib/aqua/deploy/releases
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
readonly -a CAPACITY_HOTSPOTS=(
  /root
  /tmp
  /var/aqua-saas
  /var/suderra-os
)
readonly -a CAPACITY_HOST_ARTIFACT_ALLOWLIST=(
  /swapfile-cleanup-20260610
)
readonly CAPACITY_HOST_ARTIFACT_MIN_BYTES=$((5 * GIB))
readonly CAPACITY_HOST_ARTIFACT_MAX_BYTES=$((7 * GIB))
readonly CAPACITY_HOST_ARTIFACT_MIN_AGE_SECONDS=$((30 * 24 * 60 * 60))
readonly CAPACITY_MAX_RELEASE_STATE_DIRECTORIES=512
readonly CAPACITY_MAX_RELEASE_STATE_ENTRIES=12
readonly CAPACITY_MAX_RELEASE_STATE_FILE_BYTES=$((1024 * 1024))
readonly CAPACITY_MAX_ROLLBACK_MANIFEST_ROWS=512
readonly CAPACITY_MAX_ROLLBACK_STAGE_RESIDUES=8
readonly CAPACITY_MAX_IMMUTABLE_STAGE_RESIDUES=4
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
  scripts/deploy/droplet-capacity.sh safe-image-gc
  scripts/deploy/droplet-capacity.sh host-artifact-gc-dry-run
  scripts/deploy/droplet-capacity.sh host-artifact-gc

Environment:
  FULL_DEPLOY=true|false
  DEPLOY_SERVICES="svc-a svc-b"
  DEPLOY_SHA=<40-char sha>  (trusted deploy-candidate calls only)
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
if [ "$#" -ne 1 ]; then
  echo "::error::Capacity commands accept exactly one operation and no positional arguments."
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

capacity_hotspot_for_path() {
  local scope_path="$1"
  local hotspot_path
  for hotspot_path in "${CAPACITY_HOTSPOTS[@]}"; do
    if [ "${scope_path}" = "${hotspot_path}" ] ||
      [[ "${scope_path}" == "${hotspot_path}/"* ]]; then
      printf '%s\n' "${hotspot_path}"
      return 0
    fi
  done
  return 1
}

capacity_hotspot_initialize() {
  local hotspot_path
  declare -gA CAPACITY_HOTSPOT_PRESENT=()
  declare -gA CAPACITY_HOTSPOT_PLANNED=()
  declare -gA CAPACITY_HOTSPOT_COMPLETED=()
  declare -gA CAPACITY_HOTSPOT_UNAVAILABLE=()
  declare -gA CAPACITY_HOTSPOT_OMITTED=()
  declare -gA CAPACITY_HOTSPOT_COMPLETED_BYTES=()
  declare -gA CAPACITY_HOTSPOT_PARTIAL=()
  for hotspot_path in "${CAPACITY_HOTSPOTS[@]}"; do
    if [ -e "${hotspot_path}" ] || [ -L "${hotspot_path}" ]; then
      CAPACITY_HOTSPOT_PRESENT["${hotspot_path}"]=true
    else
      CAPACITY_HOTSPOT_PRESENT["${hotspot_path}"]=false
    fi
    CAPACITY_HOTSPOT_PLANNED["${hotspot_path}"]=0
    CAPACITY_HOTSPOT_COMPLETED["${hotspot_path}"]=0
    CAPACITY_HOTSPOT_UNAVAILABLE["${hotspot_path}"]=0
    CAPACITY_HOTSPOT_OMITTED["${hotspot_path}"]=0
    CAPACITY_HOTSPOT_COMPLETED_BYTES["${hotspot_path}"]=0
    CAPACITY_HOTSPOT_PARTIAL["${hotspot_path}"]=false
  done
}

capacity_hotspot_mark_partial() {
  local scope_path="$1"
  local hotspot_path
  hotspot_path="$(capacity_hotspot_for_path "${scope_path}" 2>/dev/null || true)"
  [ -n "${hotspot_path}" ] || return 0
  CAPACITY_HOTSPOT_PARTIAL["${hotspot_path}"]=true
}

capacity_hotspot_mark_omitted() {
  local scope_path="$1"
  local omitted_count="${2:-1}"
  local hotspot_path
  hotspot_path="$(capacity_hotspot_for_path "${scope_path}" 2>/dev/null || true)"
  [ -n "${hotspot_path}" ] || return 0
  CAPACITY_HOTSPOT_OMITTED["${hotspot_path}"]=$((
    CAPACITY_HOTSPOT_OMITTED["${hotspot_path}"] + omitted_count
  ))
  CAPACITY_HOTSPOT_PARTIAL["${hotspot_path}"]=true
}

capacity_hotspot_mark_planned() {
  local scope_path="$1"
  local hotspot_path
  hotspot_path="$(capacity_hotspot_for_path "${scope_path}" 2>/dev/null || true)"
  [ -n "${hotspot_path}" ] || return 0
  CAPACITY_HOTSPOT_PLANNED["${hotspot_path}"]=$((
    CAPACITY_HOTSPOT_PLANNED["${hotspot_path}"] + 1
  ))
}

capacity_hotspot_mark_completed() {
  local scope_path="$1"
  local completed_bytes="$2"
  local hotspot_path
  hotspot_path="$(capacity_hotspot_for_path "${scope_path}" 2>/dev/null || true)"
  [ -n "${hotspot_path}" ] || return 0
  CAPACITY_HOTSPOT_COMPLETED["${hotspot_path}"]=$((
    CAPACITY_HOTSPOT_COMPLETED["${hotspot_path}"] + 1
  ))
  CAPACITY_HOTSPOT_COMPLETED_BYTES["${hotspot_path}"]=$((
    CAPACITY_HOTSPOT_COMPLETED_BYTES["${hotspot_path}"] + completed_bytes
  ))
}

capacity_hotspot_mark_unavailable() {
  local scope_path="$1"
  local hotspot_path
  hotspot_path="$(capacity_hotspot_for_path "${scope_path}" 2>/dev/null || true)"
  [ -n "${hotspot_path}" ] || return 0
  CAPACITY_HOTSPOT_UNAVAILABLE["${hotspot_path}"]=$((
    CAPACITY_HOTSPOT_UNAVAILABLE["${hotspot_path}"] + 1
  ))
  CAPACITY_HOTSPOT_PARTIAL["${hotspot_path}"]=true
}

capacity_emit_hotspot_aggregates() {
  local hotspot_path
  local coverage
  local accounted
  for hotspot_path in "${CAPACITY_HOTSPOTS[@]}"; do
    coverage=complete
    accounted=$((
      CAPACITY_HOTSPOT_COMPLETED["${hotspot_path}"] +
        CAPACITY_HOTSPOT_UNAVAILABLE["${hotspot_path}"]
    ))
    if [ "${CAPACITY_HOTSPOT_PARTIAL["${hotspot_path}"]}" = true ] ||
      [ "${accounted}" -ne "${CAPACITY_HOTSPOT_PLANNED["${hotspot_path}"]}" ]; then
      coverage=partial
    fi
    printf '  hotspot_path=%s present=%s completed_bytes_lower_bound=%s completed_scope_count=%s unavailable_scope_count=%s omitted_scope_lower_bound=%s coverage=%s\n' \
      "${hotspot_path}" \
      "${CAPACITY_HOTSPOT_PRESENT["${hotspot_path}"]}" \
      "${CAPACITY_HOTSPOT_COMPLETED_BYTES["${hotspot_path}"]}" \
      "${CAPACITY_HOTSPOT_COMPLETED["${hotspot_path}"]}" \
      "${CAPACITY_HOTSPOT_UNAVAILABLE["${hotspot_path}"]}" \
      "${CAPACITY_HOTSPOT_OMITTED["${hotspot_path}"]}" \
      "${coverage}"
  done
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
  local hotspot_path
  for hotspot_path in "${CAPACITY_HOTSPOTS[@]}"; do
    [ "$1" = "${hotspot_path}" ] && return 0
  done
  return 1
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
    capacity_hotspot_mark_omitted "${scope_path}" 1
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
  capacity_hotspot_mark_planned "${scope_path}"
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
    capacity_hotspot_mark_partial "${parent_path}"
    capacity_record_unavailable \
      "${error_file}" discovery_call_limit \
      "${CAPACITY_DU_MAX_DISCOVERY_CALLS}" "${parent_path}"
    return 0
  fi
  if [ "${remaining}" -le 0 ]; then
    CAPACITY_FRONTIER_TRUNCATED=true
    capacity_hotspot_mark_partial "${parent_path}"
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
    printf '%s\0' "${discovered_entries[entry_index]}" >> "${output_file}"
  done

  if [ "${#discovered_entries[@]}" -gt "${CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY}" ]; then
    CAPACITY_FRONTIER_TRUNCATED=true
    capacity_hotspot_mark_omitted "${parent_path}" 1
    capacity_record_unavailable \
      "${error_file}" discovery_scope_limit \
      "${CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY}" "${parent_path}"
  fi

  case "${find_status}" in
    0) ;;
    124 | 137)
      CAPACITY_FRONTIER_TRUNCATED=true
      capacity_hotspot_mark_partial "${parent_path}"
      capacity_record_unavailable \
        "${error_file}" discovery_timeout "${find_status}" "${parent_path}" \
        "${discovery_budget}"
      ;;
    141)
      # `head` intentionally closes the pipe after N+1 records. A SIGPIPE is
      # expected only when that bounded record proves truncation.
      if [ "${#discovered_entries[@]}" -le "${CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY}" ]; then
        CAPACITY_FRONTIER_TRUNCATED=true
        capacity_hotspot_mark_partial "${parent_path}"
        capacity_record_unavailable \
          "${error_file}" discovery_failed "${find_status}" "${parent_path}" \
          "${discovery_budget}"
      fi
      ;;
    *)
      CAPACITY_FRONTIER_TRUNCATED=true
      capacity_hotspot_mark_partial "${parent_path}"
      capacity_record_unavailable \
        "${error_file}" discovery_failed "${find_status}" "${parent_path}" \
        "${discovery_budget}"
      ;;
  esac
  if [ "${head_status}" -ne 0 ]; then
    CAPACITY_FRONTIER_TRUNCATED=true
    capacity_hotspot_mark_partial "${parent_path}"
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
    for hotspot_path in "${CAPACITY_HOTSPOTS[@]}"; do
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
    capacity_hotspot_mark_partial "${hotspot_path}"
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
  capacity_hotspot_initialize
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
      for hotspot_path in "${CAPACITY_HOTSPOTS[@]}"; do
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
  local expected_path_base64
  local result_scope
  local -a result_records=()
  local -a result_scopes=()

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
      capacity_hotspot_mark_unavailable "${scope_path}"
      if [ "${deadline_recorded}" = false ]; then
        capacity_record_unavailable \
          "${error_file}" global_deadline 0 "${scope_path}"
        deadline_recorded=true
      fi
      continue
    fi
    scope_timeout="${remaining}"
    if [ "${scope_timeout}" -gt "${CAPACITY_DU_SCOPE_TIMEOUT_SECONDS}" ]; then
      scope_timeout="${CAPACITY_DU_SCOPE_TIMEOUT_SECONDS}"
    fi

    started=$((started + 1))
    result_path="${work_dir}/result.${started}"
    path_base64="$(printf '%s' "${scope_path}" | base64 -w0)"
    result_scopes["${started}"]="${scope_path}"
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
      if [ "${local_head_status}" -ne 0 ]; then
        printf 'error\tdu_capture_failed\t%s\t%s\t%s\n' \
          "${local_head_status}" "${scope_timeout}" "${path_base64}"
      elif [ "${local_output_bytes}" -ge "${CAPACITY_DU_MAX_RESULT_BYTES}" ]; then
        printf 'error\tdu_output_limit\t%s\t%s\t%s\n' \
          "${CAPACITY_DU_MAX_RESULT_BYTES}" "${scope_timeout}" "${path_base64}"
      elif [ "${local_status}" -ne 0 ]; then
        case "${local_status}" in
          124 | 137) local_reason=du_timeout ;;
          *) local_reason=du_failed ;;
        esac
        printf 'error\t%s\t%s\t%s\t%s\n' \
          "${local_reason}" "${local_status}" "${scope_timeout}" "${path_base64}"
      elif [ "${local_record_status}" -eq 0 ]; then
        local_bytes=${local_record%%$'\t'*}
        local_path=${local_record#*$'\t'}
        if [[ "${local_bytes}" =~ ^[0-9]+$ ]] &&
          [ "${local_path}" != "${local_record}" ] &&
          [ "${local_path}" = "${scope_path}" ]; then
          local_path_base64="$(printf '%s' "${local_path}" | base64 -w0)"
          printf 'ok\t%s\t0\t0\t%s\n' "${local_bytes}" "${local_path_base64}"
        else
          printf 'error\tmalformed_output\t0\t%s\t%s\n' \
            "${scope_timeout}" "${path_base64}"
        fi
      else
        printf 'error\tmalformed_output\t0\t%s\t%s\n' \
          "${scope_timeout}" "${path_base64}"
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
    result_scope="${result_scopes[${result_index}]}"
    expected_path_base64="$(printf '%s' "${result_scope}" | base64 -w0)"
    if [ ! -f "${result_path}" ]; then
      capacity_hotspot_mark_unavailable "${result_scope}"
      capacity_record_unavailable \
        "${error_file}" worker_result_missing 0 "${result_scope}"
      continue
    fi
    if [ ! -s "${result_path}" ]; then
      capacity_hotspot_mark_unavailable "${result_scope}"
      capacity_record_unavailable \
        "${error_file}" worker_result_empty 0 "${result_scope}"
      continue
    fi
    mapfile -t result_records < "${result_path}"
    if [ "${#result_records[@]}" -ne 1 ]; then
      capacity_hotspot_mark_unavailable "${result_scope}"
      capacity_record_unavailable \
        "${error_file}" malformed_worker_result record_count "${result_scope}"
      continue
    fi
    IFS=$'\t' read -r \
      result_kind result_value result_detail result_timeout path_base64 \
      <<< "${result_records[0]}"
    if [ "${path_base64}" != "${expected_path_base64}" ]; then
      capacity_hotspot_mark_unavailable "${result_scope}"
      capacity_record_unavailable \
        "${error_file}" malformed_worker_result path_mismatch "${result_scope}"
      continue
    fi
    case "${result_kind}" in
      ok)
        if [[ ! "${result_value}" =~ ^[0-9]+$ ]] ||
          [ "${result_detail}" != 0 ] || [ "${result_timeout}" != 0 ]; then
          capacity_hotspot_mark_unavailable "${result_scope}"
          capacity_record_unavailable \
            "${error_file}" malformed_worker_result invalid_success "${result_scope}"
          continue
        fi
        printf '%s\t%s\n' "${result_value}" "${expected_path_base64}" >> "${snapshot_file}"
        capacity_hotspot_mark_completed "${result_scope}" "${result_value}"
        ;;
      error)
        capacity_hotspot_mark_unavailable "${result_scope}"
        capacity_record_unavailable_encoded \
          "${error_file}" "${result_value}" "${result_detail}" \
          "${expected_path_base64}" "${result_timeout}"
        ;;
      *)
        capacity_hotspot_mark_unavailable "${result_scope}"
        capacity_record_unavailable \
          "${error_file}" malformed_worker_result invalid_kind "${result_scope}"
        ;;
    esac
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
  capacity_emit_hotspot_aggregates
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
  for capacity_command in timeout base64 find head sha256sum sort wc; do
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
  local path_sha256
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
        if [[ "${decoded_path}" == /root/* ]]; then
          path_sha256="$(printf '%s' "${decoded_path}" | sha256sum | awk '{print $1}')"
          printf '    bytes=%s path_scope=/root path_sha256=%s\n' \
            "${bytes}" "${path_sha256}"
        else
          printf '    bytes=%s path=%q path_base64=%s\n' \
            "${bytes}" "${decoded_path}" "${path_base64}"
        fi
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
      if [[ "${decoded_path}" == /root/* ]]; then
        path_sha256="$(printf '%s' "${decoded_path}" | sha256sum | awk '{print $1}')"
        printf '    disk_usage_unavailable path_scope=/root path_sha256=%s reason=%s detail=%s global_timeout_seconds=%s %s=%s\n' \
          "${path_sha256}" "${unavailable_reason}" "${unavailable_detail}" \
          "${CAPACITY_DU_TIMEOUT_SECONDS}" "${timeout_label}" "${unavailable_timeout}"
      else
        printf '    disk_usage_unavailable path=%q reason=%s detail=%s global_timeout_seconds=%s %s=%s path_base64=%s\n' \
          "${decoded_path}" "${unavailable_reason}" "${unavailable_detail}" \
          "${CAPACITY_DU_TIMEOUT_SECONDS}" "${timeout_label}" "${unavailable_timeout}" \
          "${path_base64}"
      fi
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

  echo ""
  docker system df 2>/dev/null || true
}

capacity_diagnostic_snapshot() {
  disk_usage_snapshot || echo "  disk_usage_unavailable reason=unexpected_diagnostic_failure"
  docker_image_inventory || echo "  docker_image_inventory_unavailable reason=unexpected_diagnostic_failure"
  return 0
}

capacity_snapshot() {
  capacity_core_snapshot
  capacity_diagnostic_snapshot
}

write_capacity_json() {
  [ -n "${DEPLOY_STATE_DIR}" ] || return 0
  if [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" != exclusive ]; then
    echo "::error::capacity_state_write_requires_exclusive_control_plane_lock"
    return 1
  fi
  aqua_control_plane_lock_assert || return 1
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

dr_state_protected_image_ids() {
  local protected_file="$1"
  local dr_root="${AQUA_CONTROL_PLANE_DR_STATE_ROOT}"

  aqua_control_plane_guard_dr_state || return 1
  [ -e "${dr_root}" ] || return 0
  /usr/bin/python3 - \
    "${dr_root}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${protected_file}" <<'CAPACITY_DR_IMAGES_PY'
import json
import os
import pathlib
import re
import stat
import sys

root = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
output_path = pathlib.Path(sys.argv[3])
run_key = re.compile(r"^[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*$")
image_id = re.compile(r"^sha256:[0-9a-f]{64}$")
entries = list(root.iterdir())
if len(entries) > 513:
    raise SystemExit("DR image protection inventory is unbounded")
protected: set[str] = set()
for entry in entries:
    if entry.name == "postgres-dr-bootstrap.lock":
        continue
    info = os.lstat(entry)
    if (
        run_key.fullmatch(entry.name) is None
        or stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != expected_uid
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise SystemExit("DR image protection directory is invalid")
    phase_path = entry / "phase.json"
    phase_info = os.lstat(phase_path)
    if (
        stat.S_ISLNK(phase_info.st_mode)
        or not stat.S_ISREG(phase_info.st_mode)
        or phase_info.st_uid != expected_uid
        or phase_info.st_nlink != 1
        or stat.S_IMODE(phase_info.st_mode) != 0o400
        or phase_info.st_size > 8192
    ):
        raise SystemExit("DR image protection journal is unsafe")
    try:
        document = json.loads(phase_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit("DR image protection journal is corrupt") from error
    if not isinstance(document, dict) or document.get("phase") not in {"COMMITTED", "ROLLED_BACK"}:
        raise SystemExit("DR image protection journal is not terminal")
    for field in ("prior_image_id", "candidate_image_id"):
        value = document.get(field)
        if not isinstance(value, str) or image_id.fullmatch(value) is None:
            raise SystemExit("DR image protection identity is invalid")
        protected.add(value)

with output_path.open("a", encoding="ascii", newline="\n") as output:
    for value in sorted(protected):
        output.write(f"{value}\n")
CAPACITY_DR_IMAGES_PY
}

protected_image_ids_file() {
  local file="$1"
  local container_file
  local container_id
  local image_id
  : > "${file}"
  container_file="$(mktemp)" || return 1
  if ! docker ps -aq > "${container_file}" 2>/dev/null; then
    rm -f -- "${container_file}"
    echo "::error::capacity_gc_container_inventory_failed"
    return 1
  fi
  while IFS= read -r container_id; do
    [ -n "${container_id}" ] || continue
    if ! image_id="$(docker inspect --format='{{.Image}}' "${container_id}" 2>/dev/null)" ||
      [[ ! "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      rm -f -- "${container_file}"
      echo "::error::capacity_gc_container_image_unavailable container_id=${container_id}"
      return 1
    fi
    printf '%s\n' "${image_id}" >> "${file}"
  done < "${container_file}"
  rm -f -- "${container_file}"

  if ! rollback_state_protected_image_ids "${file}"; then
    echo "::error::capacity_gc_rollback_state_invalid"
    return 1
  fi
  if ! dr_state_protected_image_ids "${file}"; then
    echo "::error::capacity_gc_dr_state_invalid"
    return 1
  fi
  sort -u "${file}" -o "${file}"
}

capacity_load_canonical_image_repositories() {
  local catalog_path="${CAPACITY_SCRIPT_DIR}/../../infrastructure/deploy/service-catalog.deploy.vars"
  local service
  local -a services=()

  [ -f "${catalog_path}" ] && [ ! -L "${catalog_path}" ] || {
    echo "::error::capacity_gc_service_catalog_missing"
    return 1
  }
  # shellcheck source=infrastructure/deploy/service-catalog.deploy.vars
  source "${catalog_path}"
  read -r -a services <<< "${CATALOG_APPLICATION_IMAGE_SERVICES:?generated application image services missing}"
  if [ "${#services[@]}" -eq 0 ] || [ "${#services[@]}" -gt 64 ]; then
    echo "::error::capacity_gc_service_catalog_size_invalid"
    return 1
  fi

  CAPACITY_CANONICAL_IMAGE_REPOSITORIES=()
  for service in "${services[@]}"; do
    if [[ ! "${service}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
      [[ -n "${CAPACITY_CANONICAL_IMAGE_REPOSITORIES[${IMAGE_PREFIX}/${service}]+present}" ]]; then
      echo "::error::capacity_gc_service_catalog_entry_invalid"
      return 1
    fi
    CAPACITY_CANONICAL_IMAGE_REPOSITORIES["${IMAGE_PREFIX}/${service}"]=true
  done
}

capacity_write_bootstrap_gc_authority() {
  local requested_state="$1"
  local authority_path="${AQUA_CONTROL_PLANE_ROOT}/bootstrap-image-gc.json"
  /usr/bin/python3 - \
    "${authority_path}" "${AQUA_CONTROL_PLANE_ROOT}" \
    "${AQUA_CONTROL_PLANE_EXPECTED_UID}" "${DEPLOY_SHA}" \
    "${requested_state}" \
    "${AQUA_CONTROL_PLANE_BOOTSTRAP_ROLLOVER_AUTHORIZED:-false}" \
    "${AQUA_BOOTSTRAP_GC_PREDECESSOR_SHA:-}" \
    "${AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256:-}" <<'BOOTSTRAP_GC_AUTHORITY_PY'
import datetime
import json
import os
import pathlib
import re
import stat
import sys

path = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
expected_uid = int(sys.argv[3])
incoming_sha = sys.argv[4]
requested_state = sys.argv[5]
rollover_authorized = sys.argv[6] == "true"
predecessor_sha = sys.argv[7] or None
supersession_proof = sys.argv[8] or None
stage_path = root / ".bootstrap-image-gc.staging"
history = root / "bootstrap-image-gc-history"
sha40 = re.compile(r"^[0-9a-f]{40}$")
sha256 = re.compile(r"^[0-9a-f]{64}$")

if requested_state not in {"CLAIMED", "COMPLETED"}:
    raise SystemExit("bootstrap GC authority transition is invalid")
if sha40.fullmatch(incoming_sha) is None:
    raise SystemExit("bootstrap GC incoming SHA is invalid")


def read_safe(candidate: pathlib.Path, maximum_size: int = 4096) -> tuple[dict, bytes] | None:
    try:
        info = os.lstat(candidate)
    except FileNotFoundError:
        return None
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o400
        or not 0 < info.st_size <= maximum_size
    ):
        raise SystemExit(f"bootstrap GC authority file is unsafe: {candidate.name}")
    try:
        raw = candidate.read_bytes()
        document = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit("bootstrap GC authority file is corrupt") from error
    if not raw.endswith(b"\n"):
        raise SystemExit("bootstrap GC authority file is not canonical")
    return document, raw


def validate(document: object) -> tuple[str, str, int, str | None, str | None]:
    if not isinstance(document, dict):
        raise SystemExit("bootstrap GC authority document is invalid")
    state = document.get("state")
    version = document.get("schema_version")
    if version == 1:
        required = {"claimed_at", "incoming_sha", "schema_version", "state"}
        if state == "COMPLETED":
            required.add("completed_at")
        if set(document) != required:
            raise SystemExit("legacy bootstrap GC authority schema is invalid")
        epoch = 1
        previous = None
        proof = None
    elif version == 2:
        required = {
            "claimed_at",
            "epoch",
            "incoming_sha",
            "predecessor_sha",
            "schema_version",
            "state",
            "supersession_proof_sha256",
        }
        if state == "COMPLETED":
            required.add("completed_at")
        if set(document) != required:
            raise SystemExit("bootstrap GC authority schema is invalid")
        epoch = document.get("epoch")
        previous = document.get("predecessor_sha")
        proof = document.get("supersession_proof_sha256")
        if not isinstance(epoch, int) or isinstance(epoch, bool) or not 1 <= epoch <= 1000000:
            raise SystemExit("bootstrap GC epoch is invalid")
        if epoch == 1:
            if previous is not None or proof is not None:
                raise SystemExit("initial bootstrap GC epoch has predecessor metadata")
        elif (
            not isinstance(previous, str)
            or sha40.fullmatch(previous) is None
            or previous == document.get("incoming_sha")
            or not isinstance(proof, str)
            or sha256.fullmatch(proof) is None
        ):
            raise SystemExit("bootstrap GC rollover metadata is invalid")
    else:
        raise SystemExit("bootstrap GC authority schema version is invalid")
    recorded_sha = document.get("incoming_sha")
    if sha40.fullmatch(str(recorded_sha)) is None or state not in {"CLAIMED", "COMPLETED"}:
        raise SystemExit("bootstrap GC authority identity is invalid")
    for field in {"claimed_at", "completed_at"} & set(document):
        value = document.get(field)
        if not isinstance(value, str):
            raise SystemExit("bootstrap GC authority timestamp is invalid")
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    return state, str(recorded_sha), epoch, previous, proof


def fsync_directory(directory: pathlib.Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_exact(destination: pathlib.Path, staging: pathlib.Path, payload: bytes) -> None:
    existing_destination = read_safe(destination)
    if existing_destination is not None:
        if existing_destination[1] != payload:
            raise SystemExit(f"bootstrap GC evidence replay mismatch: {destination.name}")
        return
    existing_stage = read_safe(staging)
    if existing_stage is not None:
        if existing_stage[1] != payload:
            raise SystemExit(f"bootstrap GC staging replay mismatch: {destination.name}")
    else:
        descriptor = os.open(
            staging,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o400,
        )
        try:
            with os.fdopen(descriptor, "wb", closefd=False) as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
        finally:
            os.close(descriptor)
    os.replace(staging, destination)
    fsync_directory(destination.parent)


existing_result = read_safe(path)
existing = None if existing_result is None else existing_result[0]
existing_raw = None if existing_result is None else existing_result[1]
staged_result = read_safe(stage_path)

if requested_state == "CLAIMED":
    if existing is None:
        if rollover_authorized or predecessor_sha is not None or supersession_proof is not None:
            raise SystemExit("initial bootstrap GC claim cannot be a rollover")
        epoch = 1
        predecessor = None
        proof = None
    else:
        existing_state, existing_sha, existing_epoch, _existing_previous, _existing_proof = validate(existing)
        if existing_state != "COMPLETED":
            raise SystemExit("markerless bootstrap GC claim is incomplete")
        if existing_sha == incoming_sha:
            raise SystemExit("completed bootstrap GC epoch must be replayed without mutation")
        if (
            not rollover_authorized
            or predecessor_sha != existing_sha
            or sha256.fullmatch(str(supersession_proof)) is None
        ):
            raise SystemExit("bootstrap GC rollover authorization does not match the predecessor")
        epoch = existing_epoch + 1
        predecessor = existing_sha
        proof = supersession_proof
        if staged_result is not None:
            staged_document = staged_result[0]
            staged_state, staged_sha, staged_epoch, staged_previous, staged_proof = validate(
                staged_document
            )
            if (
                staged_state != "CLAIMED"
                or staged_sha != incoming_sha
                or staged_epoch != epoch
                or staged_previous != predecessor
                or staged_proof != proof
            ):
                raise SystemExit("bootstrap GC staged claim identity is invalid")
        try:
            history_info = os.lstat(history)
        except FileNotFoundError:
            os.mkdir(history, 0o700)
            fsync_directory(root)
            history_info = os.lstat(history)
        if (
            stat.S_ISLNK(history_info.st_mode)
            or not stat.S_ISDIR(history_info.st_mode)
            or history_info.st_uid != expected_uid
            or stat.S_IMODE(history_info.st_mode) != 0o700
        ):
            raise SystemExit("bootstrap GC history directory is unsafe")
        history_path = history / f"{existing_epoch:08d}-{existing_sha}.json"
        history_stage = history / f".{history_path.name}.staging"
        history_entries = sorted(history.iterdir())
        if len(history_entries) > 65:
            raise SystemExit("bootstrap GC history inventory is unbounded")
        final_history_entries: list[pathlib.Path] = []
        for entry in history_entries:
            if (
                re.fullmatch(r"[0-9]{8}-[0-9a-f]{40}\.json", entry.name) is None
                and entry != history_stage
            ):
                raise SystemExit("bootstrap GC history entry name is invalid")
            read_safe(entry)
            if entry != history_stage:
                final_history_entries.append(entry)
        if history_stage in history_entries:
            staged_history = read_safe(history_stage)
            assert staged_history is not None and existing_raw is not None
            if staged_history[1] != existing_raw:
                raise SystemExit("bootstrap GC history staging replay mismatch")
        if history_path in final_history_entries:
            recorded_history = read_safe(history_path)
            assert recorded_history is not None and existing_raw is not None
            if recorded_history[1] != existing_raw:
                raise SystemExit("bootstrap GC history replay mismatch")
        # Keep the history bounded even if a prior power cut landed after an
        # active-authority CAS but before its final audit-window pruning.
        # Make room before publishing this epoch's immutable predecessor so no
        # interruption can leave more than 64 completed history files.
        history_limit_before_publish = 64 if history_path in final_history_entries else 63
        while len(final_history_entries) > history_limit_before_publish:
            removable = next(
                (entry for entry in final_history_entries if entry != history_path),
                None,
            )
            if removable is None:
                raise SystemExit("bootstrap GC history has no safe retirement candidate")
            removable.unlink()
            final_history_entries.remove(removable)
            fsync_directory(history)
        assert existing_raw is not None
        publish_exact(history_path, history_stage, existing_raw)
    if staged_result is not None:
        document = staged_result[0]
        staged_state, staged_sha, staged_epoch, staged_previous, staged_proof = validate(document)
        if (
            staged_state != "CLAIMED"
            or staged_sha != incoming_sha
            or staged_epoch != epoch
            or staged_previous != predecessor
            or staged_proof != proof
        ):
            raise SystemExit("bootstrap GC staged claim identity is invalid")
    else:
        document = {
            "claimed_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "epoch": epoch,
            "incoming_sha": incoming_sha,
            "predecessor_sha": predecessor,
            "schema_version": 2,
            "state": "CLAIMED",
            "supersession_proof_sha256": proof,
        }
else:
    if existing is None:
        raise SystemExit("bootstrap GC completion has no claim")
    existing_state, existing_sha, existing_epoch, existing_previous, existing_proof = validate(existing)
    if existing_state != "CLAIMED" or existing_sha != incoming_sha:
        raise SystemExit("bootstrap GC completion does not match its claim")
    if staged_result is not None:
        document = staged_result[0]
        staged_state, staged_sha, staged_epoch, staged_previous, staged_proof = validate(document)
        if (
            staged_state != "COMPLETED"
            or staged_sha != existing_sha
            or staged_epoch != existing_epoch
            or staged_previous != existing_previous
            or staged_proof != existing_proof
        ):
            raise SystemExit("bootstrap GC staged completion identity is invalid")
    else:
        document = {
            **existing,
            "completed_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "state": "COMPLETED",
        }

payload = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
if staged_result is None:
    descriptor = os.open(stage_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(descriptor)
else:
    if staged_result[1] != payload:
        raise SystemExit("bootstrap GC staged transition payload mismatch")
os.replace(stage_path, path)
fsync_directory(root)
if history.exists():
    history_info = os.lstat(history)
    if (
        stat.S_ISLNK(history_info.st_mode)
        or not stat.S_ISDIR(history_info.st_mode)
        or history_info.st_uid != expected_uid
        or stat.S_IMODE(history_info.st_mode) != 0o700
    ):
        raise SystemExit("bootstrap GC history directory is unsafe")
    completed_history = sorted(history.iterdir())
    if len(completed_history) > 65:
        raise SystemExit("bootstrap GC history inventory is unbounded")
    for entry in completed_history:
        if re.fullmatch(r"[0-9]{8}-[0-9a-f]{40}\.json", entry.name) is None:
            raise SystemExit("bootstrap GC history entry name is invalid after transition")
        read_safe(entry)
    while len(completed_history) > 64:
        completed_history[0].unlink()
        completed_history.pop(0)
        fsync_directory(history)
BOOTSTRAP_GC_AUTHORITY_PY
}

capacity_read_bootstrap_gc_authority() {
  local authority_path="${AQUA_CONTROL_PLANE_ROOT}/bootstrap-image-gc.json"
  /usr/bin/python3 - \
    "${authority_path}" "${AQUA_CONTROL_PLANE_EXPECTED_UID}" <<'BOOTSTRAP_GC_AUTHORITY_READ_PY'
import datetime
import json
import os
import pathlib
import re
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
info = os.lstat(path)
if (
    stat.S_ISLNK(info.st_mode)
    or not stat.S_ISREG(info.st_mode)
    or info.st_uid != expected_uid
    or info.st_nlink != 1
    or stat.S_IMODE(info.st_mode) != 0o400
    or info.st_size <= 0
    or info.st_size > 1024
):
    raise SystemExit("bootstrap GC authority file is unsafe")
document = json.loads(path.read_text(encoding="utf-8"))
state = document.get("state")
required = {"claimed_at", "incoming_sha", "schema_version", "state"}
if state == "COMPLETED":
    required.add("completed_at")
version = document.get("schema_version")
if version == 2:
    required.update({"epoch", "predecessor_sha", "supersession_proof_sha256"})
if not isinstance(document, dict) or set(document) != required or version not in {1, 2}:
    raise SystemExit("bootstrap GC authority document is invalid")
incoming_sha = document.get("incoming_sha", "")
epoch = 1 if version == 1 else document.get("epoch")
predecessor = None if version == 1 else document.get("predecessor_sha")
proof = None if version == 1 else document.get("supersession_proof_sha256")
if (
    re.fullmatch(r"[0-9a-f]{40}", incoming_sha) is None
    or state not in {"CLAIMED", "COMPLETED"}
    or not isinstance(epoch, int)
    or isinstance(epoch, bool)
    or not 1 <= epoch <= 1000000
):
    raise SystemExit("bootstrap GC authority identity is invalid")
if epoch == 1:
    if predecessor is not None or proof is not None:
        raise SystemExit("initial bootstrap GC authority has rollover metadata")
elif (
    re.fullmatch(r"[0-9a-f]{40}", str(predecessor)) is None
    or predecessor == incoming_sha
    or re.fullmatch(r"[0-9a-f]{64}", str(proof)) is None
):
    raise SystemExit("bootstrap GC authority rollover metadata is invalid")
for field in required & {"claimed_at", "completed_at"}:
    value = document.get(field)
    if not isinstance(value, str):
        raise SystemExit("bootstrap GC authority timestamp is invalid")
    datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
print(f"{state}\t{incoming_sha}\t{epoch}\t{predecessor or '-'}\t{proof or '-'}")
BOOTSTRAP_GC_AUTHORITY_READ_PY
}

capacity_resolve_gc_release_authority() {
  local marker_json
  local marker_sha
  local marker_path="${AQUA_CONTROL_PLANE_ROOT}/current-release.json"
  local deploy_state_root
  local deploy_state_name
  local bootstrap_sha=''
  local verified_source_root=''

  CAPACITY_GC_BOOTSTRAP_AUTHORITY=false
  CAPACITY_GC_BOOTSTRAP_REPLAY=false
  CAPACITY_GC_BOOTSTRAP_ROLLOVER=false
  CAPACITY_GC_PROTECT_ALL_ROLLBACK_RELEASES=false

  # A present marker is always authoritative, including when a deploy
  # candidate is also supplied. Corrupt files and dangling symlinks fail
  # closed; they can never fall through into bootstrap authority.
  if [ -e "${marker_path}" ] || [ -L "${marker_path}" ]; then
    if ! marker_json="$(read_deploy_current_release)"; then
      echo "::error::capacity_gc_current_release_invalid"
      return 1
    fi
    marker_sha="$({ printf '%s' "${marker_json}" | /usr/bin/python3 -c '
import json
import re
import sys

document = json.load(sys.stdin)
sha = document.get("main_sha")
if not isinstance(sha, str) or re.fullmatch(r"[0-9a-f]{40}", sha) is None:
    raise SystemExit(2)
print(sha)
'; })" || {
      echo "::error::capacity_gc_current_release_invalid"
      return 1
    }
    DEPLOY_SHA="${marker_sha}"
    export DEPLOY_SHA
    echo "capacity_gc_release_authority=current-release-marker sha=${DEPLOY_SHA}"
    return 0
  fi

  if [ -n "${PRODUCTION_HOST_MAIN_SHA:-}" ] ||
    [ -n "${AQUA_PRODUCTION_SOURCE_ROOT:-}" ] ||
    [ -n "${AQUA_PRODUCTION_SOURCE_DIR:-}" ]; then
    [[ "${PRODUCTION_HOST_MAIN_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || {
      echo "::error::capacity_gc_bootstrap_source_sha_invalid"
      return 1
    }
    verified_source_root="${AQUA_CONTROL_PLANE_SOURCES_ROOT}/${PRODUCTION_HOST_MAIN_SHA}"
    if [ "${AQUA_PRODUCTION_SOURCE_ROOT:-}" != "${verified_source_root}" ] ||
      [ "${AQUA_PRODUCTION_SOURCE_DIR:-}" != "${verified_source_root}/repository" ]; then
      echo "::error::capacity_gc_bootstrap_source_path_invalid"
      return 1
    fi
    aqua_control_plane_verify_published_source \
      "${PRODUCTION_HOST_MAIN_SHA}" "${verified_source_root}" || {
      echo "::error::capacity_gc_bootstrap_source_proof_invalid"
      return 1
    }
    bootstrap_sha="${PRODUCTION_HOST_MAIN_SHA}"
  fi

  if [ -n "${DEPLOY_STATE_DIR}" ]; then
    [[ "${DEPLOY_SHA}" =~ ^[0-9a-f]{40}$ ]] || {
      echo "::error::capacity_gc_bootstrap_candidate_sha_invalid"
      return 1
    }
    deploy_state_root="$(capacity_deploy_state_root)" || return 1
    case "${DEPLOY_STATE_DIR}" in
      "${deploy_state_root}"/*) ;;
      *)
        echo "::error::capacity_gc_bootstrap_candidate_state_path_invalid"
        return 1
        ;;
    esac
    deploy_state_name=${DEPLOY_STATE_DIR##*/}
    [[ "${deploy_state_name}" =~ ^${DEPLOY_SHA}-[0-9]{8}T[0-9]{6}Z$ ]] || {
      echo "::error::capacity_gc_bootstrap_candidate_state_identity_invalid"
      return 1
    }
    capacity_require_root_owned_nonwritable_directory "${DEPLOY_STATE_DIR}" || {
      echo "::error::capacity_gc_bootstrap_candidate_state_directory_invalid"
      return 1
    }
    if [ -n "${bootstrap_sha}" ] && [ "${DEPLOY_SHA}" != "${bootstrap_sha}" ]; then
      echo "::error::capacity_gc_bootstrap_source_release_mismatch"
      return 1
    fi
    bootstrap_sha="${DEPLOY_SHA}"
  fi

  if [ -n "${bootstrap_sha}" ]; then
    DEPLOY_SHA="${bootstrap_sha}"
    export DEPLOY_SHA
    if [ -e "${AQUA_CONTROL_PLANE_ROOT}/bootstrap-image-gc.json" ] ||
      [ -L "${AQUA_CONTROL_PLANE_ROOT}/bootstrap-image-gc.json" ]; then
      local bootstrap_state
      local recorded_bootstrap_sha
      local recorded_bootstrap_epoch
      local recorded_predecessor_sha
      local recorded_supersession_proof
      if ! IFS=$'\t' read -r bootstrap_state recorded_bootstrap_sha \
        recorded_bootstrap_epoch recorded_predecessor_sha recorded_supersession_proof < <(
        capacity_read_bootstrap_gc_authority
      ); then
        echo "::error::capacity_gc_markerless_bootstrap_authority_invalid"
        return 1
      fi
      if [ "${recorded_bootstrap_sha}" != "${DEPLOY_SHA}" ]; then
        if [ "${bootstrap_state}" != COMPLETED ] || \
          [ "${AQUA_CONTROL_PLANE_BOOTSTRAP_ROLLOVER_AUTHORIZED:-false}" != true ] || \
          [ "${AQUA_BOOTSTRAP_GC_PREDECESSOR_SHA:-}" != "${recorded_bootstrap_sha}" ] || \
          [ "${AQUA_BOOTSTRAP_GC_PREDECESSOR_EPOCH:-}" != "${recorded_bootstrap_epoch}" ] || \
          [[ ! "${AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]; then
          echo "::error::capacity_gc_markerless_bootstrap_authority_sha_mismatch"
          return 1
        fi
        local published_rollover_proof
        published_rollover_proof=$(aqua_control_plane_descendant_source_proof \
          "${recorded_bootstrap_sha}") || {
          echo "::error::capacity_gc_markerless_bootstrap_descendant_proof_invalid"
          return 1
        }
        if [ "${published_rollover_proof}" != \
          "${AQUA_BOOTSTRAP_GC_SUPERSESSION_PROOF_SHA256}" ]; then
          echo "::error::capacity_gc_markerless_bootstrap_descendant_proof_mismatch"
          return 1
        fi
        CAPACITY_GC_BOOTSTRAP_AUTHORITY=true
        CAPACITY_GC_BOOTSTRAP_ROLLOVER=true
        CAPACITY_GC_PROTECT_ALL_ROLLBACK_RELEASES=true
        echo "capacity_gc_release_authority=markerless-bootstrap-rollover predecessor=${recorded_bootstrap_sha} sha=${DEPLOY_SHA} dry_run=${GC_DRY_RUN:-false}"
        return 0
      fi
      if [ "${bootstrap_state}" = COMPLETED ]; then
        CAPACITY_GC_BOOTSTRAP_REPLAY=true
        CAPACITY_GC_PROTECT_ALL_ROLLBACK_RELEASES=true
        echo "capacity_gc_release_authority=markerless-bootstrap-completed-replay sha=${DEPLOY_SHA}"
        return 0
      fi
      echo "::error::capacity_gc_markerless_bootstrap_claim_incomplete"
      return 1
    fi
    CAPACITY_GC_BOOTSTRAP_AUTHORITY=true
    CAPACITY_GC_PROTECT_ALL_ROLLBACK_RELEASES=true
    echo "capacity_gc_release_authority=markerless-bootstrap sha=${DEPLOY_SHA} dry_run=${GC_DRY_RUN:-false}"
    return 0
  fi

  echo "::error::capacity_gc_current_release_unavailable"
  return 1
}

capacity_require_root_owned_nonwritable_directory() {
  local directory_path="$1"
  local expected_uid
  local mode
  expected_uid="$(capacity_expected_uid)" || return 1
  [ -d "${directory_path}" ] || return 1
  [ ! -L "${directory_path}" ] || return 1
  [ "$(stat -c '%u' -- "${directory_path}")" -eq "${expected_uid}" ] || return 1
  mode="$(stat -c '%a' -- "${directory_path}")" || return 1
  (( (8#${mode} & 8#022) == 0 ))
}

capacity_require_root_owned_nonwritable_file() {
  local file_path="$1"
  local expected_uid
  local mode
  expected_uid="$(capacity_expected_uid)" || return 1
  [ -f "${file_path}" ] || return 1
  [ ! -L "${file_path}" ] || return 1
  [ "$(stat -c '%u' -- "${file_path}")" -eq "${expected_uid}" ] || return 1
  [ "$(stat -c '%h' -- "${file_path}")" -eq 1 ] || return 1
  mode="$(stat -c '%a' -- "${file_path}")" || return 1
  (( (8#${mode} & 8#022) == 0 ))
}

capacity_converge_legacy_release_file_mode() {
  [ "$#" -eq 2 ] || return 64
  local file_path="$1"
  local release_name="$2"
  aqua_control_plane_lock_assert || return 1
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || return 1
  /usr/bin/python3 - \
    "${file_path}" "$(capacity_expected_uid)" \
    "${CAPACITY_MAX_RELEASE_STATE_FILE_BYTES}" <<'CAPACITY_LEGACY_RELEASE_MODE_PY'
import os
import pathlib
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
maximum_size = int(sys.argv[3])
flags = os.O_RDWR | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    flags |= os.O_CLOEXEC
descriptor = os.open(path, flags)
try:
    before = os.fstat(descriptor)
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != expected_uid
        or before.st_nlink != 1
        or stat.S_IMODE(before.st_mode) != 0o644
        or before.st_size <= 0
        or before.st_size > maximum_size
    ):
        raise SystemExit("legacy release artifact is not an exact safe 0644 file")
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
    after = os.fstat(descriptor)
    current = os.lstat(path)
    if (
        (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
        or (current.st_dev, current.st_ino) != (after.st_dev, after.st_ino)
        or current.st_nlink != 1
        or current.st_uid != expected_uid
        or stat.S_IMODE(current.st_mode) != 0o600
    ):
        raise SystemExit("legacy release artifact identity changed during convergence")
finally:
    os.close(descriptor)

parent_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent_descriptor)
finally:
    os.close(parent_descriptor)
CAPACITY_LEGACY_RELEASE_MODE_PY
  echo "rollback_state_release_entry_legacy_mode_converged release=${release_name} entry=${file_path##*/}"
}

capacity_expected_uid() {
  local expected_uid="${AQUA_CONTROL_PLANE_EXPECTED_UID:-0}"
  [[ "${expected_uid}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${expected_uid}"
}

capacity_capture_immediate_entries() {
  local directory_path="$1"
  local maximum_entries="$2"
  local output_file="$3"
  local find_status
  local head_status
  local -a capture_status=()
  local -a captured_entries=()

  : > "${output_file}"
  set +e
  find "${directory_path}" -mindepth 1 -maxdepth 1 -print0 2>/dev/null |
    head -z -n "$((maximum_entries + 1))" > "${output_file}"
  capture_status=("${PIPESTATUS[@]}")
  set -e
  find_status="${capture_status[0]:-1}"
  head_status="${capture_status[1]:-1}"
  if [ "${head_status}" -ne 0 ]; then
    return 1
  fi
  mapfile -d '' -t captured_entries < "${output_file}"
  if [ "${#captured_entries[@]}" -gt "${maximum_entries}" ]; then
    return 2
  fi
  case "${find_status}" in
    0) return 0 ;;
    141)
      # SIGPIPE is valid only when N+1 records proved the bounded limit.
      return 1
      ;;
    *) return 1 ;;
  esac
}

capacity_recover_immutable_stage_residue() {
  [ "$#" -eq 2 ] || return 64
  local stage_path="$1"
  local release_name="$2"
  aqua_control_plane_lock_assert || return 1
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || return 1
  /usr/bin/python3 - \
    "${stage_path}" "$(capacity_expected_uid)" \
    "${CAPACITY_MAX_RELEASE_STATE_FILE_BYTES}" <<'CAPACITY_IMMUTABLE_STAGE_RECOVERY_PY'
import os
import pathlib
import re
import stat
import sys

path = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
maximum_size = int(sys.argv[3])
if re.fullmatch(r"\.(?:image-digests|immutable-images)\.[A-Za-z0-9_-]{6,32}\.tmp", path.name) is None:
    raise SystemExit("immutable release stage name is invalid")
parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    descriptor = os.open(path.name, flags, dir_fd=parent_fd)
    try:
        opened = os.fstat(descriptor)
        current = os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_uid != expected_uid
            or opened.st_nlink != 1
            or stat.S_IMODE(opened.st_mode) != 0o600
            or opened.st_size > maximum_size
            or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
        ):
            raise SystemExit("immutable release stage identity is unsafe")
    finally:
        os.close(descriptor)
    os.unlink(path.name, dir_fd=parent_fd)
    os.fsync(parent_fd)
finally:
    os.close(parent_fd)
CAPACITY_IMMUTABLE_STAGE_RECOVERY_PY
  echo "immutable_release_stage_recovered release=${release_name} stage=${stage_path##*/}"
}

capacity_deploy_state_root() {
  if [ "${NODE_ENV:-}" = test ] && [ -n "${AQUA_CONTROL_PLANE_ROOT:-}" ]; then
    printf '%s/releases\n' "${AQUA_CONTROL_PLANE_ROOT}"
  else
    printf '%s\n' "${DEPLOY_STATE_ROOT_DEFAULT}"
  fi
}

capacity_recover_rollback_stage_residue() {
  local stage_path="$1"
  local release_name="$2"
  local stage_name=${stage_path##*/}
  local stage_mode
  local stage_identity
  local current_identity
  local stage_inventory
  local stage_inventory_status
  local stage_entry
  local entry_name
  local entry_mode
  local entry_size

  [[ "${stage_name}" =~ ^\.rollback-state\.[A-Za-z0-9]{6}$ ]] || return 1
  aqua_control_plane_lock_assert || return 1
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || return 1
  capacity_require_root_owned_nonwritable_directory "${stage_path}" || return 1
  stage_mode="$(stat -c '%a' -- "${stage_path}")" || return 1
  [ "${stage_mode}" = 700 ] || return 1
  stage_identity="$(stat -Lc '%d:%i' -- "${stage_path}")" || return 1

  stage_inventory="$(mktemp)" || return 1
  set +e
  capacity_capture_immediate_entries "${stage_path}" 2 "${stage_inventory}"
  stage_inventory_status=$?
  set -e
  if [ "${stage_inventory_status}" -ne 0 ]; then
    rm -f -- "${stage_inventory}"
    return 1
  fi
  while IFS= read -r -d '' stage_entry; do
    entry_name=${stage_entry##*/}
    case "${entry_name}" in
      rollback-images.tsv | rollback-images.sha256) ;;
      *)
        rm -f -- "${stage_inventory}"
        return 1
        ;;
    esac
    capacity_require_root_owned_nonwritable_file "${stage_entry}" || {
      rm -f -- "${stage_inventory}"
      return 1
    }
    entry_mode="$(stat -c '%a' -- "${stage_entry}")" || {
      rm -f -- "${stage_inventory}"
      return 1
    }
    entry_size="$(stat -c '%s' -- "${stage_entry}")" || {
      rm -f -- "${stage_inventory}"
      return 1
    }
    if [ "${entry_mode}" != 600 ] || [[ ! "${entry_size}" =~ ^[0-9]+$ ]] ||
      [ "${entry_size}" -gt "${CAPACITY_MAX_RELEASE_STATE_FILE_BYTES}" ]; then
      rm -f -- "${stage_inventory}"
      return 1
    fi
  done < "${stage_inventory}"
  rm -f -- "${stage_inventory}"

  current_identity="$(stat -Lc '%d:%i' -- "${stage_path}")" || return 1
  [ "${current_identity}" = "${stage_identity}" ] || return 1
  rm -rf --one-file-system -- "${stage_path}" || return 1
  [ ! -e "${stage_path}" ] && [ ! -L "${stage_path}" ] || return 1
  sync -f "${stage_path%/*}"
  echo "rollback_state_stage_recovered release=${release_name} stage=${stage_name}"
}

capacity_cutover_legacy_rollback_state() {
  local release_directory="$1"
  local release_name="$2"

  aqua_control_plane_lock_assert || return 1
  [ "${AQUA_CONTROL_PLANE_LOCK_MODE:-}" = exclusive ] || return 1
  /usr/bin/python3 - \
    "${release_directory}" "$(capacity_expected_uid)" \
    "${CAPACITY_MAX_RELEASE_STATE_FILE_BYTES}" \
    "${CAPACITY_MAX_ROLLBACK_MANIFEST_ROWS}" <<'CAPACITY_ROLLBACK_CUTOVER_PY'
import hashlib
import os
import pathlib
import re
import secrets
import stat
import sys

release = pathlib.Path(sys.argv[1])
expected_uid = int(sys.argv[2])
maximum_file_bytes = int(sys.argv[3])
maximum_rows = int(sys.argv[4])
manifest_name = "rollback-images.tsv"
checksum_name = "rollback-images.sha256"
unit_name = "rollback-state"
service_pattern = re.compile(rb"^[a-z0-9][a-z0-9-]*$")
image_pattern = re.compile(rb"^sha256:[0-9a-f]{64}$")


def require_directory(path: pathlib.Path, modes: set[int]) -> os.stat_result:
    info = os.lstat(path)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != expected_uid
        or stat.S_IMODE(info.st_mode) not in modes
    ):
        raise SystemExit(f"legacy rollback directory is unsafe: {path}")
    return info


def read_regular(
    directory_fd: int, name: str, modes: set[int]
) -> tuple[bytes, tuple[int, int]]:
    info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_uid != expected_uid
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) not in modes
        or info.st_size > maximum_file_bytes
    ):
        raise SystemExit(f"legacy rollback file is unsafe: {name}")
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise SystemExit(f"legacy rollback file identity changed: {name}")
        chunks: list[bytes] = []
        remaining = maximum_file_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) > maximum_file_bytes:
            raise SystemExit(f"legacy rollback file is unbounded: {name}")
        return payload, (opened.st_dev, opened.st_ino)
    finally:
        os.close(descriptor)


def validate_manifest(payload: bytes) -> None:
    if not payload:
        return
    if not payload.endswith(b"\n"):
        raise SystemExit("legacy rollback manifest has no final newline")
    if any(byte not in {9, 10} and not 32 <= byte <= 126 for byte in payload):
        raise SystemExit("legacy rollback manifest contains an invalid byte")
    rows = payload[:-1].split(b"\n")
    if len(rows) > maximum_rows:
        raise SystemExit("legacy rollback manifest row limit exceeded")
    services: set[bytes] = set()
    for row in rows:
        fields = row.split(b"\t")
        if (
            len(fields) != 2
            or service_pattern.fullmatch(fields[0]) is None
            or image_pattern.fullmatch(fields[1]) is None
            or fields[0] in services
        ):
            raise SystemExit("legacy rollback manifest row is invalid")
        services.add(fields[0])


def validate_pair(manifest: bytes, checksum: bytes) -> None:
    validate_manifest(manifest)
    expected = hashlib.sha256(manifest).hexdigest().encode("ascii") + b"\n"
    if checksum != expected:
        raise SystemExit("legacy rollback checksum mismatch")


def write_regular(directory_fd: int, name: str, payload: bytes) -> None:
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory_fd,
    )
    try:
        os.fchmod(descriptor, 0o600)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short rollback-state write")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


release_info = require_directory(release, {0o700, 0o755})
release_fd = os.open(release, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
stage_name: str | None = None
try:
    opened_release = os.fstat(release_fd)
    if (opened_release.st_dev, opened_release.st_ino) != (release_info.st_dev, release_info.st_ino):
        raise SystemExit("legacy rollback release identity changed")
    names = set(os.listdir(release_fd))
    legacy_names = names & {manifest_name, checksum_name}
    unit_present = unit_name in names
    if not legacy_names:
        raise SystemExit(0)

    if unit_present:
        unit_info = require_directory(release / unit_name, {0o700})
        unit_fd = os.open(unit_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=release_fd)
        try:
            opened_unit = os.fstat(unit_fd)
            if (opened_unit.st_dev, opened_unit.st_ino) != (unit_info.st_dev, unit_info.st_ino):
                raise SystemExit("atomic rollback unit identity changed")
            if set(os.listdir(unit_fd)) != {manifest_name, checksum_name}:
                raise SystemExit("atomic rollback unit is incomplete")
            atomic_manifest, _ = read_regular(unit_fd, manifest_name, {0o600})
            atomic_checksum, _ = read_regular(unit_fd, checksum_name, {0o600})
            validate_pair(atomic_manifest, atomic_checksum)
        finally:
            os.close(unit_fd)
        expected_legacy = {
            manifest_name: atomic_manifest,
            checksum_name: atomic_checksum,
        }
        identities: dict[str, tuple[int, int]] = {}
        for name in sorted(legacy_names):
            payload, identity = read_regular(release_fd, name, {0o600, 0o644})
            if payload != expected_legacy[name]:
                raise SystemExit("legacy and atomic rollback authorities disagree")
            identities[name] = identity
        for name, identity in identities.items():
            current = os.stat(name, dir_fd=release_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != identity:
                raise SystemExit("legacy rollback cleanup identity changed")
            os.unlink(name, dir_fd=release_fd)
        os.fsync(release_fd)
        print("rollback_state_legacy_cutover_recovered")
        raise SystemExit(0)

    if manifest_name not in legacy_names:
        raise SystemExit("legacy rollback checksum has no manifest")
    manifest, manifest_identity = read_regular(release_fd, manifest_name, {0o600, 0o644})
    identities = {manifest_name: manifest_identity}
    if checksum_name in legacy_names:
        checksum, checksum_identity = read_regular(
            release_fd, checksum_name, {0o600, 0o644}
        )
        identities[checksum_name] = checksum_identity
        validate_pair(manifest, checksum)
    else:
        if manifest:
            raise SystemExit("non-empty legacy rollback manifest has no checksum")
        validate_manifest(manifest)
        checksum = hashlib.sha256(manifest).hexdigest().encode("ascii") + b"\n"

    for _attempt in range(32):
        candidate = f".rollback-state.{secrets.token_hex(3)}"
        try:
            os.mkdir(candidate, 0o700, dir_fd=release_fd)
            stage_name = candidate
            break
        except FileExistsError:
            continue
    if stage_name is None:
        raise SystemExit("cannot allocate rollback cutover stage")
    stage_fd = os.open(stage_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=release_fd)
    try:
        os.fchmod(stage_fd, 0o700)
        write_regular(stage_fd, manifest_name, manifest)
        write_regular(stage_fd, checksum_name, checksum)
        os.fsync(stage_fd)
    finally:
        os.close(stage_fd)
    os.rename(stage_name, unit_name, src_dir_fd=release_fd, dst_dir_fd=release_fd)
    stage_name = None
    os.fsync(release_fd)

    for name, identity in identities.items():
        current = os.stat(name, dir_fd=release_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != identity:
            raise SystemExit("legacy rollback cleanup identity changed")
        os.unlink(name, dir_fd=release_fd)
    os.fsync(release_fd)
    print("rollback_state_legacy_cutover_completed")
finally:
    if stage_name is not None:
        try:
            stage_fd = os.open(
                stage_name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=release_fd,
            )
            try:
                for name in os.listdir(stage_fd):
                    os.unlink(name, dir_fd=stage_fd)
            finally:
                os.close(stage_fd)
            os.rmdir(stage_name, dir_fd=release_fd)
            os.fsync(release_fd)
        except FileNotFoundError:
            pass
    os.close(release_fd)
CAPACITY_ROLLBACK_CUTOVER_PY
  local cutover_status=$?
  if [ "${cutover_status}" -ne 0 ]; then
    echo "::error::rollback_state_legacy_cutover_invalid release=${release_name}"
    return 1
  fi
}

rollback_state_protected_image_ids() {
  local protected_file="$1"
  local deploy_state_root
  local release_directory
  local release_name
  local state_entry
  local entry_name
  local entry_mode
  local entry_size
  local manifest_path
  local checksum_path
  local expected_checksum
  local actual_checksum
  local checksum_size
  local invalid_manifest_byte_count
  local manifest_last_byte
  local service_name
  local image_id
  local extra
  local service_key
  local manifest_present
  local checksum_present
  local rollback_unit_path
  local rollback_unit_present
  local rollback_unit_inventory
  local rollback_unit_inventory_status
  local rollback_stage_residue_count
  local immutable_stage_residue_count
  local manifest_row_count
  local release_matches_deploy_sha
  local release_inventory
  local release_inventory_status
  local state_inventory
  local state_inventory_status
  local -A seen_services=()

  deploy_state_root="$(capacity_deploy_state_root)" || return 1

  if [ ! -e "${deploy_state_root}" ] && [ ! -L "${deploy_state_root}" ]; then
    if [ "${deploy_state_root}" != "${AQUA_CONTROL_PLANE_ROOT}/releases" ] ||
      ! aqua_control_plane_require_safe_directory "${AQUA_CONTROL_PLANE_ROOT}" 700; then
      echo "::error::rollback_state_absent_root_parent_invalid path=${deploy_state_root}"
      return 1
    fi
    echo "rollback_state_inventory=empty reason=canonical_root_absent"
    return 0
  fi
  if ! capacity_require_root_owned_nonwritable_directory "${deploy_state_root}"; then
    echo "::error::rollback_state_root_invalid path=${deploy_state_root}"
    return 1
  fi
  release_inventory="$(mktemp)" || return 1
  set +e
  capacity_capture_immediate_entries \
    "${deploy_state_root}" "${CAPACITY_MAX_RELEASE_STATE_DIRECTORIES}" \
    "${release_inventory}"
  release_inventory_status=$?
  set -e
  if [ "${release_inventory_status}" -eq 2 ]; then
    rm -f -- "${release_inventory}"
    echo "::error::rollback_state_release_limit_exceeded limit=${CAPACITY_MAX_RELEASE_STATE_DIRECTORIES}"
    return 1
  fi
  if [ "${release_inventory_status}" -ne 0 ]; then
    rm -f -- "${release_inventory}"
    echo "::error::rollback_state_inventory_failed"
    return 1
  fi

  while IFS= read -r -d '' release_directory; do
    release_name=${release_directory##*/}
    if [[ ! "${release_name}" =~ ^[0-9a-f]{40}-[0-9]{8}T[0-9]{6}Z$ ]] ||
      ! capacity_require_root_owned_nonwritable_directory "${release_directory}"; then
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_release_directory_invalid"
      return 1
    fi
    release_matches_deploy_sha=false
    if [[ "${release_name}" =~ ^${DEPLOY_SHA}-[0-9]{8}T[0-9]{6}Z$ ]]; then
      release_matches_deploy_sha=true
    fi

    state_inventory="$(mktemp)" || {
      rm -f -- "${release_inventory}"
      return 1
    }
    set +e
    capacity_capture_immediate_entries \
      "${release_directory}" "${CAPACITY_MAX_RELEASE_STATE_ENTRIES}" "${state_inventory}"
    state_inventory_status=$?
    set -e
    if [ "${state_inventory_status}" -ne 0 ]; then
      rm -f -- "${release_inventory}" "${state_inventory}"
      echo "::error::rollback_state_release_inventory_invalid release=${release_name}"
      return 1
    fi
    rollback_stage_residue_count=0
    immutable_stage_residue_count=0
    while IFS= read -r -d '' state_entry; do
      entry_name=${state_entry##*/}
      case "${entry_name}" in
        rollback-images.tsv | rollback-images.sha256 | image-digests.tsv | immutable-images.override.yml | capacity-snapshot.json | release-transaction-terminal.json | superseded-transaction.json | .release-transaction-terminal.json.staging | .superseded-transaction.json.staging) ;;
        rollback-state)
          if ! capacity_require_root_owned_nonwritable_directory "${state_entry}" ||
            [ "$(stat -c '%a' -- "${state_entry}")" != 700 ]; then
            rm -f -- "${release_inventory}" "${state_inventory}"
            echo "::error::rollback_state_atomic_unit_invalid release=${release_name}"
            return 1
          fi
          continue
          ;;
        .rollback-state.*)
          rollback_stage_residue_count=$((rollback_stage_residue_count + 1))
          if [ "${rollback_stage_residue_count}" -gt "${CAPACITY_MAX_ROLLBACK_STAGE_RESIDUES}" ] ||
            ! capacity_recover_rollback_stage_residue "${state_entry}" "${release_name}"; then
            rm -f -- "${release_inventory}" "${state_inventory}"
            echo "::error::rollback_state_stage_residue_invalid release=${release_name}"
            return 1
          fi
          continue
          ;;
        .image-digests.*.tmp | .immutable-images.*.tmp)
          immutable_stage_residue_count=$((immutable_stage_residue_count + 1))
          if [ "${immutable_stage_residue_count}" -gt \
            "${CAPACITY_MAX_IMMUTABLE_STAGE_RESIDUES}" ] || \
            ! capacity_recover_immutable_stage_residue \
              "${state_entry}" "${release_name}"; then
            rm -f -- "${release_inventory}" "${state_inventory}"
            echo "::error::immutable_release_stage_residue_invalid release=${release_name}"
            return 1
          fi
          continue
          ;;
        *)
          rm -f -- "${release_inventory}" "${state_inventory}"
          echo "::error::rollback_state_release_contains_unexpected_entry release=${release_name}"
          return 1
          ;;
      esac
      if ! capacity_require_root_owned_nonwritable_file "${state_entry}"; then
        rm -f -- "${release_inventory}" "${state_inventory}"
        echo "::error::rollback_state_release_entry_invalid release=${release_name} entry=${entry_name}"
        return 1
      fi
      case "${entry_name}" in
        image-digests.tsv)
          entry_mode=$(stat -c '%a' -- "${state_entry}") || {
            rm -f -- "${release_inventory}" "${state_inventory}"
            return 1
          }
          if [ "${entry_mode}" = 644 ]; then
            if ! capacity_converge_legacy_release_file_mode \
              "${state_entry}" "${release_name}"; then
              rm -f -- "${release_inventory}" "${state_inventory}"
              echo "::error::rollback_state_release_entry_mode_convergence_failed release=${release_name} entry=${entry_name}"
              return 1
            fi
          elif [ "${entry_mode}" != 600 ]; then
            rm -f -- "${release_inventory}" "${state_inventory}"
            echo "::error::rollback_state_release_entry_mode_invalid release=${release_name} entry=${entry_name}"
            return 1
          fi
          ;;
        immutable-images.override.yml)
          if [ "$(stat -c '%a' -- "${state_entry}")" != 600 ]; then
            rm -f -- "${release_inventory}" "${state_inventory}"
            echo "::error::rollback_state_release_entry_mode_invalid release=${release_name} entry=${entry_name}"
            return 1
          fi
          ;;
        release-transaction-terminal.json | superseded-transaction.json | .release-transaction-terminal.json.staging | .superseded-transaction.json.staging)
          if [ "$(stat -c '%a' -- "${state_entry}")" != 400 ]; then
            rm -f -- "${release_inventory}" "${state_inventory}"
            echo "::error::rollback_state_release_entry_mode_invalid release=${release_name} entry=${entry_name}"
            return 1
          fi
          ;;
      esac
      entry_size="$(stat -c '%s' -- "${state_entry}")" || {
        rm -f -- "${release_inventory}" "${state_inventory}"
        echo "::error::rollback_state_release_entry_stat_failed release=${release_name} entry=${entry_name}"
        return 1
      }
      if [[ ! "${entry_size}" =~ ^[0-9]+$ ]] ||
        [ "${entry_size}" -gt "${CAPACITY_MAX_RELEASE_STATE_FILE_BYTES}" ]; then
        rm -f -- "${release_inventory}" "${state_inventory}"
        echo "::error::rollback_state_release_entry_size_invalid release=${release_name} entry=${entry_name}"
        return 1
      fi
    done < "${state_inventory}"
    rm -f -- "${state_inventory}"

    if [ -e "${release_directory}/rollback-images.tsv" ] ||
      [ -L "${release_directory}/rollback-images.tsv" ] ||
      [ -e "${release_directory}/rollback-images.sha256" ] ||
      [ -L "${release_directory}/rollback-images.sha256" ]; then
      if ! capacity_cutover_legacy_rollback_state \
        "${release_directory}" "${release_name}"; then
        rm -f -- "${release_inventory}"
        return 1
      fi
    fi

    manifest_path="${release_directory}/rollback-images.tsv"
    checksum_path="${release_directory}/rollback-images.sha256"
    rollback_unit_path="${release_directory}/rollback-state"
    manifest_present=false
    checksum_present=false
    rollback_unit_present=false
    { [ -e "${manifest_path}" ] || [ -L "${manifest_path}" ]; } && manifest_present=true
    { [ -e "${checksum_path}" ] || [ -L "${checksum_path}" ]; } && checksum_present=true
    { [ -e "${rollback_unit_path}" ] || [ -L "${rollback_unit_path}" ]; } && rollback_unit_present=true
    if [ "${manifest_present}" != "${checksum_present}" ]; then
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_manifest_pair_incomplete release=${release_name}"
      return 1
    fi
    if [ "${rollback_unit_present}" = true ] && [ "${manifest_present}" = true ]; then
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_multiple_authorities release=${release_name}"
      return 1
    fi
    if [ "${rollback_unit_present}" = true ]; then
      rollback_unit_inventory="$(mktemp)" || {
        rm -f -- "${release_inventory}"
        return 1
      }
      set +e
      capacity_capture_immediate_entries "${rollback_unit_path}" 2 "${rollback_unit_inventory}"
      rollback_unit_inventory_status=$?
      set -e
      if [ "${rollback_unit_inventory_status}" -ne 0 ]; then
        rm -f -- "${release_inventory}" "${rollback_unit_inventory}"
        echo "::error::rollback_state_atomic_unit_inventory_invalid release=${release_name}"
        return 1
      fi
      while IFS= read -r -d '' state_entry; do
        entry_name=${state_entry##*/}
        case "${entry_name}" in
          rollback-images.tsv | rollback-images.sha256) ;;
          *)
            rm -f -- "${release_inventory}" "${rollback_unit_inventory}"
            echo "::error::rollback_state_atomic_unit_contains_unexpected_entry release=${release_name}"
            return 1
            ;;
        esac
        if ! capacity_require_root_owned_nonwritable_file "${state_entry}" ||
          [ "$(stat -c '%a' -- "${state_entry}")" != 600 ]; then
          rm -f -- "${release_inventory}" "${rollback_unit_inventory}"
          echo "::error::rollback_state_atomic_unit_entry_invalid release=${release_name} entry=${entry_name}"
          return 1
        fi
        entry_size="$(stat -c '%s' -- "${state_entry}")" || {
          rm -f -- "${release_inventory}" "${rollback_unit_inventory}"
          return 1
        }
        if [[ ! "${entry_size}" =~ ^[0-9]+$ ]] ||
          [ "${entry_size}" -gt "${CAPACITY_MAX_RELEASE_STATE_FILE_BYTES}" ]; then
          rm -f -- "${release_inventory}" "${rollback_unit_inventory}"
          echo "::error::rollback_state_atomic_unit_entry_size_invalid release=${release_name} entry=${entry_name}"
          return 1
        fi
      done < "${rollback_unit_inventory}"
      rm -f -- "${rollback_unit_inventory}"
      manifest_path="${rollback_unit_path}/rollback-images.tsv"
      checksum_path="${rollback_unit_path}/rollback-images.sha256"
      if [ ! -f "${manifest_path}" ] || [ -L "${manifest_path}" ] ||
        [ ! -f "${checksum_path}" ] || [ -L "${checksum_path}" ]; then
        rm -f -- "${release_inventory}"
        echo "::error::rollback_state_atomic_unit_incomplete release=${release_name}"
        return 1
      fi
      manifest_present=true
    fi
    if [ "${manifest_present}" = false ]; then
      continue
    fi

    checksum_size="$(stat -c '%s' -- "${checksum_path}")" || {
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_checksum_stat_failed release=${release_name}"
      return 1
    }
    if [[ ! "${checksum_size}" =~ ^[0-9]+$ ]] || [ "${checksum_size}" -ne 65 ]; then
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_checksum_size_invalid release=${release_name}"
      return 1
    fi
    expected_checksum="$(tr -d '\n' < "${checksum_path}")" || {
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_checksum_read_failed release=${release_name}"
      return 1
    }
    if [[ ! "${expected_checksum}" =~ ^[0-9a-f]{64}$ ]]; then
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_checksum_invalid release=${release_name}"
      return 1
    fi
    if [ -s "${manifest_path}" ]; then
      manifest_last_byte="$(tail -c 1 -- "${manifest_path}" | od -An -tx1 | tr -d '[:space:]')" || {
        rm -f -- "${release_inventory}"
        echo "::error::rollback_state_manifest_tail_unavailable release=${release_name}"
        return 1
      }
      if [ "${manifest_last_byte}" != 0a ]; then
        rm -f -- "${release_inventory}"
        echo "::error::rollback_state_manifest_missing_final_newline release=${release_name}"
        return 1
      fi
    fi
    invalid_manifest_byte_count="$(
      LC_ALL=C tr -d '\011\012\040-\176' < "${manifest_path}" | wc -c
    )" || {
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_manifest_byte_scan_failed release=${release_name}"
      return 1
    }
    if [[ ! "${invalid_manifest_byte_count}" =~ ^[[:space:]]*0$ ]]; then
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_manifest_invalid_byte release=${release_name}"
      return 1
    fi
    actual_checksum="$(sha256sum --binary "${manifest_path}" | awk '{print $1}')" || {
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_manifest_hash_failed release=${release_name}"
      return 1
    }
    if [ "${actual_checksum}" != "${expected_checksum}" ]; then
      rm -f -- "${release_inventory}"
      echo "::error::rollback_state_checksum_mismatch release=${release_name}"
      return 1
    fi

    seen_services=()
    manifest_row_count=0
    while IFS=$'\t' read -r service_name image_id extra; do
      manifest_row_count=$((manifest_row_count + 1))
      if [ "${manifest_row_count}" -gt "${CAPACITY_MAX_ROLLBACK_MANIFEST_ROWS}" ]; then
        rm -f -- "${release_inventory}"
        echo "::error::rollback_state_manifest_row_limit_exceeded release=${release_name}"
        return 1
      fi
      if [ -n "${extra:-}" ] || [[ ! "${service_name:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]] ||
        { [ "${image_id:-}" != ABSENT ] && [[ ! "${image_id:-}" =~ ^sha256:[0-9a-f]{64}$ ]]; }; then
        rm -f -- "${release_inventory}"
        echo "::error::rollback_state_manifest_row_invalid release=${release_name}"
        return 1
      fi
      service_key="${service_name}"
      if [[ -n "${seen_services[${service_key}]+present}" ]]; then
        rm -f -- "${release_inventory}"
        echo "::error::rollback_state_manifest_duplicate_service release=${release_name}"
        return 1
      fi
      seen_services["${service_key}"]=1
      if [ "${image_id}" != ABSENT ] && \
        { [ "${release_matches_deploy_sha}" = true ] ||
          [ "${CAPACITY_GC_PROTECT_ALL_ROLLBACK_RELEASES}" = true ]; }; then
        printf '%s\n' "${image_id}" >> "${protected_file}"
      fi
    done < "${manifest_path}"
  done < "${release_inventory}"
  rm -f -- "${release_inventory}"
  return 0
}

capacity_recover_and_validate_rollback_state() {
  local validation_output
  validation_output="$(mktemp)" || return 1
  if ! rollback_state_protected_image_ids "${validation_output}"; then
    rm -f -- "${validation_output}"
    echo "::error::capacity_gc_rollback_state_invalid"
    return 1
  fi
  rm -f -- "${validation_output}"
}

gc_remove_ref() {
  # GC_DRY_RUN=true lists what WOULD be removed without touching the
  # daemon — operator-auditable enumeration before any destructive run.
  local ref="$1"
  if [ "${GC_DRY_RUN:-false}" = "true" ]; then
    echo "  [dry-run] would remove ${ref}"
    return 0
  fi
  if ! docker rmi "${ref}" 2>&1; then
    echo "::error::capacity_gc_remove_failed ref=${ref}"
    return 1
  fi
}

safe_image_gc() {
  echo "=== Safe image-only GC ==="
  echo "Policy: explicit unprotected application refs only; global prune, unknown dangling images, volumes, containers, networks, and build cache are untouched."
  local before after
  local protected
  local inventory
  local repo
  local tag
  local id
  local extra
  local ref
  local removed=0
  local removed_rollback=0
  local removed_unclassified=0
  local skipped=0
  local required_command
  local -A kept_image_ids=()
  local -A protected_image_ids=()
  declare -gA CAPACITY_CANONICAL_IMAGE_REPOSITORIES=()

  case "${GC_DRY_RUN:-false}" in
    true | false) ;;
    *)
      echo "::error::GC_DRY_RUN must be true or false."
      return 2
      ;;
  esac
  # Recovery is independent of deletion authority. In particular, an earlier
  # SIGKILL during rollback-state staging must not become a permanent scanner
  # wedge merely because the one-time markerless GC token was already used.
  capacity_recover_and_validate_rollback_state || return 2
  capacity_resolve_gc_release_authority || return 2
  if [ "${CAPACITY_GC_BOOTSTRAP_REPLAY}" = true ]; then
    echo "Safe GC already completed for markerless bootstrap sha=${DEPLOY_SHA}; replay_mutation=false"
    return 0
  fi
  capacity_load_canonical_image_repositories || return 2
  for required_command in awk docker find head mktemp od sha256sum sort stat tail tr wc; do
    if ! command -v "${required_command}" >/dev/null 2>&1; then
      echo "::error::capacity_gc_required_command_missing command=${required_command}"
      return 2
    fi
  done
  before=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1 || true)

  protected="$(mktemp)" || return 1
  inventory="$(mktemp)" || {
    rm -f -- "${protected}"
    return 1
  }
  if ! protected_image_ids_file "${protected}"; then
    rm -f -- "${protected}" "${inventory}"
    return 1
  fi
  while IFS= read -r id; do
    if [[ ! "${id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      rm -f -- "${protected}" "${inventory}"
      echo "::error::capacity_gc_protected_image_inventory_malformed"
      return 1
    fi
    protected_image_ids["${id}"]=true
  done < "${protected}"
  if ! docker image ls --no-trunc \
    --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}' > "${inventory}" 2>/dev/null; then
    rm -f -- "${protected}" "${inventory}"
    echo "::error::capacity_gc_image_inventory_failed"
    return 1
  fi

  while IFS=$'\t' read -r repo tag id extra; do
    if [ -n "${extra:-}" ] || [ -z "${repo:-}" ] || [ -z "${tag:-}" ] ||
      [[ ! "${id:-}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      rm -f -- "${protected}" "${inventory}"
      echo "::error::capacity_gc_image_inventory_malformed"
      return 1
    fi
    if [[ -n "${CAPACITY_CANONICAL_IMAGE_REPOSITORIES[${repo}]+present}" ]]; then
        if [[ -n "${protected_image_ids[${id}]+present}" ]]; then
          kept_image_ids["${id}"]=true
          continue
        fi
        case "${tag}" in
          latest | staging | buildcache-*) kept_image_ids["${id}"]=true ;;
          *)
            if [ -n "${DEPLOY_SHA}" ] && [ "${tag}" = "${DEPLOY_SHA}" ]; then
              kept_image_ids["${id}"]=true
            fi
            ;;
        esac
    fi
  done < "${inventory}"

  # Consume markerless bootstrap authority only after every protected-ID and
  # candidate image row has been validated, immediately before the first
  # possible Docker mutation. A claimed-but-incomplete file then proves that a
  # crash may have crossed the deletion boundary and makes retries fail closed.
  if [ "${CAPACITY_GC_BOOTSTRAP_AUTHORITY}" = true ] &&
    [ "${GC_DRY_RUN:-false}" = false ]; then
    capacity_write_bootstrap_gc_authority CLAIMED || {
      rm -f -- "${protected}" "${inventory}"
      echo "::error::capacity_gc_markerless_bootstrap_claim_failed"
      return 1
    }
  fi

  while IFS=$'\t' read -r repo tag id extra; do
    [[ -n "${CAPACITY_CANONICAL_IMAGE_REPOSITORIES[${repo}]+present}" ]] || continue
    if [ "${tag}" = '<none>' ]; then
      skipped=$((skipped + 1))
      continue
    fi
    if [[ -n "${kept_image_ids[${id}]+present}" ]]; then
      case "${tag}" in
        rollback-*) echo "  keep protected rollback retag ${repo}:${tag} ${id}" ;;
        *) echo "  keep protected application ref ${repo}:${tag} ${id}" ;;
      esac
      skipped=$((skipped + 1))
      continue
    fi
    ref="${repo}:${tag}"
    case "${tag}" in
      rollback-*)
        echo "  remove superseded rollback retag ${ref} ${id}"
        gc_remove_ref "${ref}" || {
          rm -f -- "${protected}" "${inventory}"
          return 1
        }
        removed_rollback=$((removed_rollback + 1))
        ;;
      *)
        if [[ "${tag}" =~ ^[0-9a-f]{40}$ ]]; then
          echo "  remove unprotected old application ref ${ref} ${id}"
          gc_remove_ref "${ref}" || {
            rm -f -- "${protected}" "${inventory}"
            return 1
          }
          removed=$((removed + 1))
        else
          echo "  keep unclassified application ref outside GC authority ${ref} ${id}"
          skipped=$((skipped + 1))
        fi
        ;;
    esac
  done < "${inventory}"

  rm -f -- "${protected}" "${inventory}"

  if [ "${CAPACITY_GC_BOOTSTRAP_AUTHORITY}" = true ] &&
    [ "${GC_DRY_RUN:-false}" = false ]; then
    capacity_write_bootstrap_gc_authority COMPLETED || {
      echo "::error::capacity_gc_markerless_bootstrap_completion_failed"
      return 1
    }
  fi

  after=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1 || true)
  echo "Safe GC complete; removed_tags=${removed} removed_rollback_retags=${removed_rollback} removed_unclassified=${removed_unclassified} skipped_protected=${skipped} global_prune=false dry_run=${GC_DRY_RUN:-false} before=${before:-unknown} after=${after:-unknown}"
}

host_artifact_audit() {
  local policy_id="$1"
  local candidate_path="$2"
  local predicate="$3"
  local result="$4"
  local detail="${5:-none}"
  printf '  host_artifact_policy=%s path_sha256=%s predicate=%s result=%s detail=%s\n' \
    "${policy_id}" \
    "$(printf '%s' "${candidate_path}" | sha256sum | awk '{print $1}')" \
    "${predicate}" "${result}" "${detail}"
}

host_artifact_block() {
  local policy_id="$1"
  local candidate_path="$2"
  local predicate="$3"
  local reason="$4"
  host_artifact_audit \
    "${policy_id}" "${candidate_path}" "${predicate}" blocked "${reason}"
  echo "::error::host_artifact_gc_blocked policy=${policy_id} predicate=${predicate} reason=${reason}"
  return 1
}

host_artifact_load_stat() {
  local candidate_path="$1"
  local stat_record
  local extra
  if ! stat_record="$(stat --printf='%u\t%f\t%d:%i\t%h\t%s\t%Y' -- "${candidate_path}" 2>/dev/null)"; then
    HOST_STAT_ERROR=stat_failed
    return 1
  fi
  IFS=$'\t' read -r \
    HOST_STAT_UID HOST_STAT_MODE_HEX HOST_STAT_DEVICE_INODE \
    HOST_STAT_LINKS HOST_STAT_SIZE HOST_STAT_MTIME extra <<< "${stat_record}"
  if [ -n "${extra:-}" ] ||
    [[ ! "${HOST_STAT_UID:-}" =~ ^[0-9]+$ ]] ||
    [[ ! "${HOST_STAT_MODE_HEX:-}" =~ ^[0-9a-fA-F]+$ ]] ||
    [[ ! "${HOST_STAT_DEVICE_INODE:-}" =~ ^[0-9]+:[0-9]+$ ]] ||
    [[ ! "${HOST_STAT_LINKS:-}" =~ ^[0-9]+$ ]] ||
    [[ ! "${HOST_STAT_SIZE:-}" =~ ^[0-9]+$ ]] ||
    [[ ! "${HOST_STAT_MTIME:-}" =~ ^-?[0-9]+$ ]]; then
    HOST_STAT_ERROR=malformed_stat_record
    return 1
  fi
  HOST_STAT_IDENTITY="${HOST_STAT_UID}:${HOST_STAT_MODE_HEX}:${HOST_STAT_DEVICE_INODE}:${HOST_STAT_LINKS}:${HOST_STAT_SIZE}:${HOST_STAT_MTIME}"
  HOST_STAT_ERROR=none
}

host_artifact_metadata_predicates() {
  local policy_id="$1"
  local candidate_path="$2"
  local phase="$3"
  local expected_uid
  local mode_value=$((16#${HOST_STAT_MODE_HEX}))
  local file_type=$((mode_value & 0170000))
  local now_epoch
  local age_seconds
  local canonical_candidate
  expected_uid="$(capacity_expected_uid)" || {
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_owner" expected_uid_unavailable
    return 1
  }

  if [ "${file_type}" -ne "$((0100000))" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_regular_file" "mode_${HOST_STAT_MODE_HEX}"
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_regular_file" pass "mode_${HOST_STAT_MODE_HEX}"
  if [ "${HOST_STAT_UID}" -ne "${expected_uid}" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_root_owner" "uid_${HOST_STAT_UID}_expected_${expected_uid}"
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_root_owner" pass "uid_${expected_uid}"
  if [ "$((mode_value & 0022))" -ne 0 ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_nonwritable" "mode_${HOST_STAT_MODE_HEX}"
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_nonwritable" pass "mode_${HOST_STAT_MODE_HEX}"
  if [ "${HOST_STAT_LINKS}" -ne 1 ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_single_link" "links_${HOST_STAT_LINKS}"
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_single_link" pass links_1
  if [ "${HOST_STAT_SIZE}" -lt "${CAPACITY_HOST_ARTIFACT_MIN_BYTES}" ] ||
    [ "${HOST_STAT_SIZE}" -gt "${CAPACITY_HOST_ARTIFACT_MAX_BYTES}" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_bounded_size" "bytes_${HOST_STAT_SIZE}"
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_bounded_size" pass "bytes_${HOST_STAT_SIZE}"
  if ! now_epoch="$(date +%s)" || [[ ! "${now_epoch}" =~ ^[0-9]+$ ]]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_minimum_age" clock_unavailable
    return 1
  fi
  age_seconds=$((now_epoch - HOST_STAT_MTIME))
  if [ "${age_seconds}" -lt "${CAPACITY_HOST_ARTIFACT_MIN_AGE_SECONDS}" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_minimum_age" "age_seconds_${age_seconds}"
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_minimum_age" pass "age_seconds_${age_seconds}"
  if ! canonical_candidate="$(realpath -e -- "${candidate_path}" 2>/dev/null)" ||
    [ "${canonical_candidate}" != "${candidate_path}" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_canonical_exact_path" canonical_path_mismatch
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_canonical_exact_path" pass exact
}

host_artifact_paths_overlap() {
  local left="$1"
  local right="$2"
  [ "${left}" = / ] || [ "${right}" = / ] ||
    [ "${left}" = "${right}" ] ||
    [[ "${left}" == "${right}/"* ]] ||
    [[ "${right}" == "${left}/"* ]]
}

host_artifact_protected_path_predicate() {
  local policy_id="$1"
  local candidate_path="$2"
  local protected_path
  local canonical_protected
  local current_checkout
  local -a protected_paths
  current_checkout="$(pwd -P)" || {
    host_artifact_block "${policy_id}" "${candidate_path}" \
      protected_paths cwd_unavailable
    return 1
  }
  protected_paths=(
    /var/aqua-saas
    /var/lib/aqua/deploy
    /var/lib/postgresql
    /var/lib/containerd
    /var/lib/docker
    "$(docker_root)"
    "${current_checkout}"
  )
  for protected_path in "${protected_paths[@]}"; do
    if ! canonical_protected="$(realpath -m -- "${protected_path}" 2>/dev/null)"; then
      host_artifact_block "${policy_id}" "${candidate_path}" \
        protected_paths protected_path_resolution_failed
      return 1
    fi
    if host_artifact_paths_overlap "${candidate_path}" "${canonical_protected}"; then
      host_artifact_block "${policy_id}" "${candidate_path}" \
        protected_paths overlaps_protected_path
      return 1
    fi
  done
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    protected_paths pass disjoint
}

host_artifact_mount_inventory_predicates() {
  local policy_id="$1"
  local candidate_path="$2"
  local phase="$3"
  local mount_inventory
  local loop_inventory
  local inventory_size
  local result

  # A filtered findmnt exit 1 conflates "no match" with fatal inventory
  # errors. Require one successful machine-readable inventory instead and
  # classify the exact candidate from that complete snapshot.
  mount_inventory="$(mktemp)" || {
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_mount_inventory" mount_inventory_stage_failed
    return 1
  }
  loop_inventory="$(mktemp)" || {
    rm -f -- "${mount_inventory}"
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_mount_inventory" loop_inventory_stage_failed
    return 1
  }
  if ! findmnt --json --list --output TARGET,SOURCE \
    > "${mount_inventory}" 2>/dev/null; then
    rm -f -- "${mount_inventory}" "${loop_inventory}"
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_mount_inventory" findmnt_inventory_failed
    return 1
  fi
  if ! losetup --json --list --output NAME,BACK-FILE \
    > "${loop_inventory}" 2>/dev/null; then
    rm -f -- "${mount_inventory}" "${loop_inventory}"
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_mount_inventory" losetup_inventory_failed
    return 1
  fi
  for inventory_size in \
    "$(stat -c '%s' -- "${mount_inventory}" 2>/dev/null || true)" \
    "$(stat -c '%s' -- "${loop_inventory}" 2>/dev/null || true)"; do
    if [[ ! "${inventory_size}" =~ ^[0-9]+$ ]] || \
      [ "${inventory_size}" -eq 0 ] || [ "${inventory_size}" -gt 1048576 ]; then
      rm -f -- "${mount_inventory}" "${loop_inventory}"
      host_artifact_block "${policy_id}" "${candidate_path}" \
        "${phase}_mount_inventory" inventory_size_invalid
      return 1
    fi
  done
  if ! result="$(/usr/bin/python3 /dev/fd/3 \
    "${candidate_path}" "${mount_inventory}" "${loop_inventory}" 3<<'PY'
import json
import os
import pathlib
import sys

candidate, mount_path, loop_path = sys.argv[1:]


def read_json(path: str, label: str) -> object:
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"invalid {label} JSON: {error}") from error


document = read_json(mount_path, "findmnt")
if not isinstance(document, dict) or set(document) != {"filesystems"}:
    raise SystemExit("findmnt inventory schema is invalid")
filesystems = document["filesystems"]
if not isinstance(filesystems, list) or not filesystems:
    raise SystemExit("findmnt inventory must contain the root mount")

for filesystem in filesystems:
    if not isinstance(filesystem, dict):
        raise SystemExit("findmnt inventory row is invalid")
    target = filesystem.get("target")
    source = filesystem.get("source")
    if not isinstance(target, str) or not isinstance(source, str):
        raise SystemExit("findmnt target/source is invalid")
    if os.path.normpath(target) == candidate:
        print("target")
        raise SystemExit(0)
    source_candidates = {source}
    if source.endswith("]") and "[" in source:
        source_candidates.add(source.rsplit("[", 1)[1][:-1])
    if candidate in {os.path.normpath(value) for value in source_candidates if value}:
        print("source")
        raise SystemExit(0)

loop_document = read_json(loop_path, "losetup")
if not isinstance(loop_document, dict) or set(loop_document) != {"loopdevices"}:
    raise SystemExit("losetup inventory schema is invalid")
loop_devices = loop_document["loopdevices"]
if not isinstance(loop_devices, list):
    raise SystemExit("losetup inventory rows are invalid")
for device in loop_devices:
    if not isinstance(device, dict) or set(device) != {"back-file", "name"}:
        raise SystemExit("losetup inventory row is invalid")
    name = device["name"]
    backing_file = device["back-file"]
    if not isinstance(name, str) or not name.startswith("/dev/loop"):
        raise SystemExit("losetup device name is invalid")
    if backing_file is not None and not isinstance(backing_file, str):
        raise SystemExit("losetup backing file is invalid")
    if backing_file and os.path.normpath(backing_file) == candidate:
        print("loop")
        raise SystemExit(0)
print("absent")
PY
)"; then
    rm -f -- "${mount_inventory}" "${loop_inventory}"
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_mount_inventory" findmnt_inventory_invalid
    return 1
  fi
  if ! rm -f -- "${mount_inventory}" "${loop_inventory}" || \
    [ -e "${mount_inventory}" ] || [ -e "${loop_inventory}" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_mount_inventory" inventory_cleanup_failed
    return 1
  fi
  case "${result}" in
    target)
      host_artifact_block "${policy_id}" "${candidate_path}" \
        "${phase}_not_mountpoint" active
      return 1
      ;;
    source)
      host_artifact_block "${policy_id}" "${candidate_path}" \
        "${phase}_not_mount_source" active
      return 1
      ;;
    loop)
      host_artifact_block "${policy_id}" "${candidate_path}" \
        "${phase}_not_loop_backing" active
      return 1
      ;;
    absent)
      host_artifact_audit "${policy_id}" "${candidate_path}" \
        "${phase}_not_mountpoint" pass absent
      host_artifact_audit "${policy_id}" "${candidate_path}" \
        "${phase}_not_mount_source" pass absent
      host_artifact_audit "${policy_id}" "${candidate_path}" \
        "${phase}_not_loop_backing" pass absent
      ;;
    *)
      host_artifact_block "${policy_id}" "${candidate_path}" \
        "${phase}_mount_inventory" findmnt_inventory_result_invalid
      return 1
      ;;
  esac
}

host_artifact_fuser_inactive() {
  local policy_id="$1"
  local candidate_path="$2"
  local phase="$3"
  local candidate_fd
  local candidate_status
  local expected_pid="${BASHPID}"
  local path_identity
  local descriptor_identity
  local stdout_path
  local stderr_path
  local normalized_pids
  local normalized_stderr

  stdout_path="$(mktemp)" || return 1
  stderr_path="$(mktemp)" || {
    rm -f -- "${stdout_path}"
    return 1
  }
  if ! exec {candidate_fd}< "${candidate_path}"; then
    rm -f -- "${stdout_path}" "${stderr_path}"
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_not_open" candidate_probe_open_failed
    return 1
  fi
  path_identity="$(stat -Lc '%d:%i' -- "${candidate_path}" 2>/dev/null || true)"
  descriptor_identity="$(stat -Lc '%d:%i' -- \
    "/proc/${BASHPID}/fd/${candidate_fd}" 2>/dev/null || true)"
  if [ "${path_identity}" != "${HOST_STAT_DEVICE_INODE}" ] || \
    [ "${descriptor_identity}" != "${HOST_STAT_DEVICE_INODE}" ]; then
    exec {candidate_fd}<&-
    rm -f -- "${stdout_path}" "${stderr_path}"
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_not_open" candidate_probe_identity_mismatch
    return 1
  fi
  set +e
  fuser -a -I "${candidate_path}" > "${stdout_path}" 2> "${stderr_path}"
  candidate_status=$?
  set -e
  path_identity="$(stat -Lc '%d:%i' -- "${candidate_path}" 2>/dev/null || true)"
  descriptor_identity="$(stat -Lc '%d:%i' -- \
    "/proc/${BASHPID}/fd/${candidate_fd}" 2>/dev/null || true)"
  normalized_pids="$(awk '
    { for (field = 1; field <= NF; field++) values[++count] = $field }
    END { for (field = 1; field <= count; field++) printf "%s%s", (field > 1 ? " " : ""), values[field] }
  ' "${stdout_path}")" || true
  normalized_stderr="$(< "${stderr_path}")"
  exec {candidate_fd}<&-
  if ! rm -f -- "${stdout_path}" "${stderr_path}" || \
    [ -e "${stdout_path}" ] || [ -e "${stderr_path}" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_not_open" candidate_probe_cleanup_failed
    return 1
  fi
  if [ "${candidate_status}" -ne 0 ] || \
    [ "${path_identity}" != "${HOST_STAT_DEVICE_INODE}" ] || \
    [ "${descriptor_identity}" != "${HOST_STAT_DEVICE_INODE}" ] || \
    [ "${normalized_pids}" != "${expected_pid}" ] || \
    [ "${normalized_stderr}" != "${candidate_path}:" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_not_open" candidate_fuser_evidence_invalid
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_not_open" pass positive_inode_probe
}

host_artifact_inactive_predicates() {
  local policy_id="$1"
  local candidate_path="$2"
  local phase="$3"
  local swap_output
  local swap_path
  host_artifact_mount_inventory_predicates \
    "${policy_id}" "${candidate_path}" "${phase}" || return 1
  if ! swap_output="$(swapon --noheadings --raw --show=NAME 2>/dev/null)"; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      "${phase}_not_active_swap" swapon_inventory_failed
    return 1
  fi
  while IFS= read -r swap_path; do
    [ -n "${swap_path}" ] || continue
    if [ "${swap_path}" = "${candidate_path}" ]; then
      host_artifact_block "${policy_id}" "${candidate_path}" \
        "${phase}_not_active_swap" active
      return 1
    fi
  done <<< "${swap_output}"
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    "${phase}_not_active_swap" pass absent
  host_artifact_fuser_inactive \
    "${policy_id}" "${candidate_path}" "${phase}"
}

reclaim_allowlisted_host_artifact() {
  local candidate_path="$1"
  local policy_id=swapfile-cleanup-20260610
  local initial_identity
  HOST_ARTIFACT_RESULT=blocked
  [ "${candidate_path}" = /swapfile-cleanup-20260610 ] || {
    host_artifact_block "${policy_id}" "${candidate_path}" \
      exact_allowlist not_allowlisted
    return 1
  }
  host_artifact_audit "${policy_id}" "${candidate_path}" exact_allowlist pass exact

  if [ ! -e "${candidate_path}" ] && [ ! -L "${candidate_path}" ]; then
    host_artifact_audit "${policy_id}" "${candidate_path}" presence pass already_absent
    HOST_ARTIFACT_RESULT=absent
    return 0
  fi
  if ! host_artifact_load_stat "${candidate_path}"; then
    host_artifact_block "${policy_id}" "${candidate_path}" initial_stat "${HOST_STAT_ERROR}"
    return 1
  fi
  host_artifact_metadata_predicates "${policy_id}" "${candidate_path}" preflight || return 1
  initial_identity="${HOST_STAT_IDENTITY}"
  host_artifact_protected_path_predicate "${policy_id}" "${candidate_path}" || return 1
  host_artifact_inactive_predicates "${policy_id}" "${candidate_path}" preflight || return 1

  if ! host_artifact_load_stat "${candidate_path}"; then
    host_artifact_block "${policy_id}" "${candidate_path}" \
      preunlink_identity "${HOST_STAT_ERROR}"
    return 1
  fi
  if [ "${HOST_STAT_IDENTITY}" != "${initial_identity}" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" preunlink_identity changed
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" \
    preunlink_identity pass stable
  host_artifact_metadata_predicates "${policy_id}" "${candidate_path}" preunlink || return 1
  host_artifact_inactive_predicates "${policy_id}" "${candidate_path}" preunlink || return 1

  if [ "${HOST_ARTIFACT_GC_DRY_RUN}" = true ]; then
    host_artifact_audit "${policy_id}" "${candidate_path}" unlink dry_run identity_stable
    HOST_ARTIFACT_RESULT=dry_run
    return 0
  fi
  if ! unlink -- "${candidate_path}"; then
    host_artifact_block "${policy_id}" "${candidate_path}" unlink command_failed
    return 1
  fi
  if [ -e "${candidate_path}" ] || [ -L "${candidate_path}" ]; then
    host_artifact_block "${policy_id}" "${candidate_path}" unlink path_still_present
    return 1
  fi
  host_artifact_audit "${policy_id}" "${candidate_path}" unlink pass exact_single_file
  HOST_ARTIFACT_RESULT=removed
}

safe_host_artifact_gc() {
  local required_command
  local candidate_path
  local executor_uid
  local expected_uid
  local considered=0
  local removed=0
  local absent=0
  local dry_run=0
  local blocked=0
  case "${HOST_ARTIFACT_GC_DRY_RUN}" in
    true | false) ;;
    *)
      echo "::error::HOST_ARTIFACT_GC_DRY_RUN must be true or false."
      return 2
      ;;
  esac
  for required_command in \
    date findmnt fuser id losetup mktemp realpath sha256sum stat swapon unlink; do
    command -v "${required_command}" >/dev/null 2>&1 || {
      echo "::error::host_artifact_gc_required_command_missing command=${required_command}"
      return 2
    }
  done
  executor_uid="$(id -u)" || return 2
  expected_uid="$(capacity_expected_uid)" || return 2
  if [ "${executor_uid}" != "${expected_uid}" ]; then
    echo "::error::host_artifact_gc_requires_root executor_uid=${executor_uid} expected_uid=${expected_uid}"
    return 2
  fi
  for candidate_path in "${CAPACITY_HOST_ARTIFACT_ALLOWLIST[@]}"; do
    considered=$((considered + 1))
    if reclaim_allowlisted_host_artifact "${candidate_path}"; then
      case "${HOST_ARTIFACT_RESULT}" in
        removed) removed=$((removed + 1)) ;;
        absent) absent=$((absent + 1)) ;;
        dry_run) dry_run=$((dry_run + 1)) ;;
        *) blocked=$((blocked + 1)) ;;
      esac
    else
      blocked=$((blocked + 1))
    fi
  done
  echo "Safe host-artifact GC complete; considered=${considered} removed=${removed} already_absent=${absent} dry_run=${dry_run} blocked=${blocked}"
  [ "${blocked}" -eq 0 ]
}

run_host_artifact_gc_dry_run() {
  # The command owns this mode. Bash's dynamic function scope makes the
  # readonly local visible to every predicate below while structurally
  # ignoring a caller-supplied environment value.
  local -r HOST_ARTIFACT_GC_DRY_RUN=true
  safe_host_artifact_gc
}

run_host_artifact_gc() {
  # Real deletion is a separate explicit command and cannot be silently
  # converted into, or selected by, an inherited environment value.
  local -r HOST_ARTIFACT_GC_DRY_RUN=false
  safe_host_artifact_gc
}

capacity_enter_control_plane() {
  local lock_mode="$1"
  local require_dr_guard="$2"
  local lock_timeout=60
  if [ "${NODE_ENV:-}" = test ]; then
    lock_timeout="${AQUA_CAPACITY_TEST_LOCK_TIMEOUT_SECONDS:-1}"
  fi
  if ! aqua_control_plane_lock_acquire "${lock_mode}" "${lock_timeout}"; then
    echo "::error::capacity_control_plane_lock_unavailable mode=${lock_mode}"
    return 1
  fi
  # The transaction and DR journals are the retention protected-set authority.
  # Validate them before any release directory can be renamed or unlinked; a
  # syntactically valid but schema-corrupt journal must fail closed without
  # weakening the protected set used by the collector.
  if [ "${require_dr_guard}" = true ] && ! aqua_control_plane_guard_dr_state; then
    echo "::error::capacity_control_plane_dr_state_blocked"
    return 1
  fi
  if [ "${lock_mode}" = exclusive ] && ! aqua_control_plane_prune_releases; then
    echo "::error::capacity_control_plane_release_retention_blocked"
    return 1
  fi
}

run_safe_image_gc() {
  CAPACITY_DISK_USAGE_MODE=off bash scripts/deploy/droplet-capacity.sh report
  bash scripts/deploy/droplet-capacity.sh gc
  CAPACITY_GC_MODE=off CAPACITY_DISK_USAGE_MODE=deep bash scripts/deploy/droplet-capacity.sh gate
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
    safe_image_gc
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
    capacity_enter_control_plane shared false
    capacity_snapshot
    write_capacity_json
    ;;
  gate)
    capacity_enter_control_plane exclusive true
    run_gate
    ;;
  gc)
    capacity_enter_control_plane exclusive true
    safe_image_gc
    ;;
  safe-image-gc)
    capacity_enter_control_plane exclusive true
    run_safe_image_gc
    ;;
  host-artifact-gc-dry-run)
    capacity_enter_control_plane exclusive true
    run_host_artifact_gc_dry_run
    ;;
  host-artifact-gc)
    capacity_enter_control_plane exclusive true
    run_host_artifact_gc
    ;;
  *)
    usage
    exit 2
    ;;
esac
