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
# 120s (was 60): with the docker/containerd subtrees excluded below the scan
# is usually seconds, but a cold page cache on a busy droplet still needs
# headroom — 60s produced disk_usage_unavailable exactly when the diagnostic
# was needed (capacity incident triage). Bounded by the SSoT contract to stay
# well under the deploy preflight command timeout.
CAPACITY_DU_TIMEOUT_SECONDS="${CAPACITY_DU_TIMEOUT_SECONDS:-120}"

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
  CAPACITY_DU_TIMEOUT_SECONDS=60
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

disk_usage_paths() {
  case "${CAPACITY_DISK_USAGE_MODE}" in
    off)
      return 0
      ;;
    deep)
      unique_paths "/" "/var" "/var/lib" "$(docker_root)" "/var/lib/containerd" "/var/log" "/var/aqua-saas" "/tmp"
      ;;
    summary)
      unique_paths "/"
      ;;
    *)
      echo "::warning::unknown_capacity_disk_usage_mode mode=${CAPACITY_DISK_USAGE_MODE}; using summary" >&2
      unique_paths "/"
      ;;
  esac
}

du_scope_snapshot() {
  local path="$1"
  local snapshot_file="$2"

  # Docker/containerd subtrees are EXCLUDED from the walk: their bytes are
  # already itemized by `docker system df`, and traversing overlay2's
  # hundreds of thousands of inodes is precisely what blew the du timeout —
  # leaving the NON-docker usage (the part only this walk can attribute)
  # invisible during capacity incidents.
  if command -v timeout >/dev/null 2>&1; then
    timeout "${CAPACITY_DU_TIMEOUT_SECONDS}s" du -x -B1 -d1 \
      --exclude="$(docker_root)" --exclude=/var/lib/containerd \
      "${path}" > "${snapshot_file}" 2>/dev/null
  else
    du -x -B1 -d1 \
      --exclude="$(docker_root)" --exclude=/var/lib/containerd \
      "${path}" > "${snapshot_file}" 2>/dev/null
  fi
}

disk_usage_snapshot() {
  echo ""
  echo "Top-level disk usage (same filesystem only):"
  echo "  disk_usage_mode=${CAPACITY_DISK_USAGE_MODE}"
  if [ "${CAPACITY_DISK_USAGE_MODE}" = "off" ]; then
    echo "  disk_usage_unavailable reason=disabled"
    return 0
  fi

  local snapshot_file
  if ! snapshot_file="$(mktemp "${TMPDIR:-/tmp}/aqua-capacity-du.XXXXXX")"; then
    echo "  disk_usage_unavailable reason=mktemp_failed"
    return 0
  fi

  local path
  local du_status
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    [ -d "${path}" ] || continue
    echo "  scope=${path}"
    if du_scope_snapshot "${path}" "${snapshot_file}"; then
      if ! sort -nr "${snapshot_file}" | awk 'NR <= 20 {printf "    bytes=%s path=%s\n", $1, $2}'; then
        echo "    disk_usage_unavailable path=${path} reason=sort_or_format_failed"
      fi
    else
      du_status=$?
      echo "    disk_usage_unavailable path=${path} exit_status=${du_status} timeout_seconds=${CAPACITY_DU_TIMEOUT_SECONDS}"
    fi
  done < <(disk_usage_paths)

  rm -f "${snapshot_file}"
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
  disk_usage_snapshot
  docker_image_inventory
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
  : > "${file}"

  docker ps -aq 2>/dev/null | while IFS= read -r cid; do
    [ -n "${cid}" ] || continue
    docker inspect --format='{{.Image}}' "${cid}" 2>/dev/null || true
  done >> "${file}"

  if [ -n "${ROLLBACK_MANIFEST}" ] && [ -s "${ROLLBACK_MANIFEST}" ]; then
    awk -F '\t' 'NF >= 2 {print $2}' "${ROLLBACK_MANIFEST}" >> "${file}" || true
  fi

  if [ -n "${DEPLOY_SHA}" ]; then
    docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null |
      awk -v sha="${DEPLOY_SHA}" '$1 ~ ":" sha "$" {print $2}' >> "${file}" || true
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
  local before after reclaimed
  before=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1 || true)

  if [ "${GC_DRY_RUN:-false}" != "true" ]; then
    docker image prune -f --filter "dangling=true" 2>&1 || true
  fi

  local protected
  protected="$(mktemp)"
  protected_image_ids_file "${protected}"

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
  done < <(docker image ls --format '{{.Repository}} {{.Tag}} {{.ID}}' 2>/dev/null)

  local removed=0 removed_untagged=0 removed_unclassified=0
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
  done < <(docker image ls --format '{{.Repository}} {{.Tag}} {{.ID}}' 2>/dev/null)

  rm -f "${protected}"

  # Untagging alone reclaims nothing while sibling tags or freshly
  # orphaned layers remain — the historical before=after symptom. A final
  # dangling-only prune converts the untag passes into actual bytes.
  if [ "${GC_DRY_RUN:-false}" != "true" ]; then
    docker image prune -f --filter "dangling=true" 2>&1 || true
  fi

  after=$(docker system df --format '{{.Size}}' 2>/dev/null | head -1 || true)
  echo "Safe GC complete; removed_tags=${removed:-0} removed_untagged=${removed_untagged:-0} removed_rollback_retags=${removed_rollback:-0} removed_unclassified=${removed_unclassified:-0} skipped_protected=${skipped:-0} dry_run=${GC_DRY_RUN:-false} before=${before:-unknown} after=${after:-unknown}"
}

run_gate() {
  capacity_core_snapshot
  write_capacity_json

  set +e
  capacity_failures
  local rc=$?
  set -e

  if [ "${rc}" -eq 0 ]; then
    capacity_diagnostic_snapshot
    echo "Capacity preflight: PASS"
    return 0
  fi

  if [ "${CAPACITY_GC_MODE}" = "auto" ]; then
    echo "Capacity preflight: warning/failure before GC; running one safe image-only GC pass."
    safe_image_gc
    capacity_core_snapshot
    write_capacity_json
    set +e
    capacity_failures
    rc=$?
    set -e
  fi

  capacity_diagnostic_snapshot

  if [ "${rc}" -eq 0 ]; then
    echo "Capacity preflight: PASS after safe GC"
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
