#!/usr/bin/env bash
# =============================================================================
# scripts/deploy/lib/release-rollback.sh
#
# Release image references and the droplet image rollback (ORPHAN-HIGH-381,
# INFRA-HIGH-230). Sourced by scripts/deploy/droplet-up.sh after
# deployment-mode-policy.sh and compose-recreate.sh; defines functions only.
#
# Two rules, both learned in production:
#
# 1. A release tag names exactly one image. `<svc>:<DEPLOY_SHA>` (what compose
#    resolves through TAG) and `<svc>:latest` are written only by
#    droplet-up.sh's pull_deploy_image_required, from the release's immutable
#    digest. The rollback never rewrites them: it captures the running images
#    under `<svc>:rollback-<DEPLOY_RELEASE_ID>` and recreates through
#    compose_recreate_services with TAG set to that generation. Until
#    2026-10-17 the rollback re-pointed `<svc>:<DEPLOY_SHA>` at the pre-release
#    image before `compose up`; when compose then failed, the release tag kept
#    naming old code and the pulled release image was left untagged (CI -
#    Affected run 38990686731, attempt 4).
#
# 2. An image is restored only if it booted against the current schema.
#    SchemaDriftValidator and the schema-version gate run at cold start, so an
#    image that booted before a migration can run for days and still crash-loop
#    the moment it is recreated (the 2026-07-12 farm_documents outage). The
#    count of migrations THIS attempt applied is not enough: attempt 3 of run
#    38990686731 applied the release's 2 migrations and failed, attempt 4
#    applied 0, passed the old guard and restored pre-release images. Capture
#    therefore keeps only containers started after the latest schema advance,
#    read from the release ledger (schema_advanced_at below), and restore still
#    refuses when this attempt's own count is anything but a proven 0.
# =============================================================================

image_ref_for_service() {
  local svc="$1"
  local image_service
  image_service="$(image_service_for_compose_service "${svc}")"
  echo "${IMAGE_PREFIX}/${image_service}:latest"
}

deploy_tag_ref_for_service() {
  local svc="$1"
  local image_service
  image_service="$(image_service_for_compose_service "${svc}")"
  echo "${IMAGE_PREFIX}/${image_service}:${DEPLOY_SHA}"
}

# The TAG under which compose resolves this release's rollback generation.
rollback_image_tag() {
  echo "rollback-${DEPLOY_RELEASE_ID:?DEPLOY_RELEASE_ID is required for rollback tags}"
}

rollback_tag_ref_for_service() {
  local svc="$1"
  local image_service
  image_service="$(image_service_for_compose_service "${svc}")"
  echo "${IMAGE_PREFIX}/${image_service}:$(rollback_image_tag)"
}

# RFC 3339 (Docker's StartedAt/FinishedAt) -> epoch seconds, fraction dropped.
# An empty input fails: GNU date reads "" as today's midnight.
epoch_of() {
  [ -n "${1:-}" ] || return 1
  date -u -d "$1" +%s 2>/dev/null
}

# Latest schema advance the release ledger records, in epoch seconds; 0 when the
# ledger has no rows. Rows written since INFRA-HIGH-230 carry
# deploy_metadata.schemaAdvancedAt: an epoch when that attempt's db-migrate
# applied migrations or did not prove it applied none, JSON null when it proved
# zero. Older rows lack the key and count at created_at, the moment db-migrate
# (or a failure write after it) created the row: never earlier than the
# migrations it recorded. Returns 1 when the ledger cannot be read.
ledger_schema_advanced_at() {
  local value

  if ! docker ps --format '{{.Names}}' | grep -qx 'aqua-postgres'; then
    return 1
  fi
  value="$(docker exec -i aqua-postgres psql \
    -U "${POSTGRES_USER:-aquaculture}" \
    -d "${POSTGRES_DB:-aquaculture}" \
    -v ON_ERROR_STOP=1 -tA 2>/dev/null <<'SQL'
SELECT COALESCE(MAX(
  CASE
    WHEN deploy_metadata ? 'schemaAdvancedAt'
      THEN (deploy_metadata->>'schemaAdvancedAt')::bigint
    ELSE EXTRACT(EPOCH FROM created_at)::bigint
  END
), 0)
FROM platform.release_ledger;
SQL
)" || return 1
  value="$(printf '%s' "${value}" | tr -d '[:space:]')"
  case "${value}" in
    '' | *[!0-9]*) return 1 ;;
  esac
  echo "${value}"
}

# A db-migrate run that is still running or did not exit 0 may have committed
# migrations without the ledger recording it (the failure write is best-effort
# when Postgres itself is the failure). Prints that run's finish time (now while
# it runs); prints nothing for a clean last run or when no run is on the host.
db_migrate_unproven_at() {
  local state running exit_code finished_at

  state="$(docker inspect --format '{{.State.Running}} {{.State.ExitCode}} {{.State.FinishedAt}}' \
    aqua-db-migrate 2>/dev/null)" || return 0
  read -r running exit_code finished_at <<< "${state}"
  if [ "${running}" = "true" ]; then
    date -u +%s
  elif [ "${exit_code}" != "0" ]; then
    epoch_of "${finished_at}" || date -u +%s
  fi
}

# The latest moment the database schema may have changed, in epoch seconds.
# Returns 1 when it cannot be established; callers fail closed.
schema_advanced_at() {
  local ledger unproven

  ledger="$(ledger_schema_advanced_at)" || return 1
  unproven="$(db_migrate_unproven_at)"
  if [ -n "${unproven}" ] && [ "${unproven}" -gt "${ledger}" ]; then
    echo "${unproven}"
  else
    echo "${ledger}"
  fi
}

capture_rollback_manifest() {
  echo "=== Capturing current application image digests for rollback ==="
  : > "${ROLLBACK_MANIFEST}"

  local boundary=""
  if boundary="$(schema_advanced_at)"; then
    echo "  Latest schema advance: $(date -u -d "@${boundary}" +%Y-%m-%dT%H:%M:%SZ) (${boundary})"
  else
    boundary=""
    echo "::warning::The latest schema advance cannot be established (release ledger unreadable); no running container can be proven to have booted against the current schema, so this release has no rollback point."
  fi

  local -A rollback_ref_image=()
  local svc
  local container_id
  local image_id
  local health
  local running
  local restarts
  local started
  local rollback_ref
  while IFS= read -r svc; do
    [ -n "${svc}" ] || continue
    container_id=$(docker compose -f docker-compose.droplet.yml ps -q "$svc" 2>/dev/null || true)
    if [ -z "${container_id}" ]; then
      continue
    fi
    # ORPHAN-HIGH-381: a rollback point must be a PROVEN-GOOD image. Capturing a
    # crash-looping container (2026-07-12: farm-service fatal at bootstrap) poisons
    # the manifest, and every later rollback restores the broken image — a
    # self-sustaining outage. Skip anything not verifiably healthy; rollback then
    # leaves that service alone, which is strictly safer.
    health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${container_id}" 2>/dev/null || echo "unknown")
    running=$(docker inspect --format='{{.State.Running}}' "${container_id}" 2>/dev/null || echo "false")
    restarts=$(docker inspect --format='{{.RestartCount}}' "${container_id}" 2>/dev/null || echo "0")
    if [ "${running}" != "true" ] || { [ "${health}" != "healthy" ] && [ "${health}" != "none" ]; }; then
      echo "  WARN: ${svc} is not a valid rollback point (running=${running} health=${health} restarts=${restarts}) — NOT captured."
      continue
    fi
    # INFRA-HIGH-230: healthy is not enough. The container must have booted
    # after the latest schema advance; otherwise recreating its image re-runs
    # the boot-time schema checks against a schema it never booted against.
    # Equal whole seconds are ambiguous and therefore not proof.
    started="$(epoch_of "$(docker inspect --format '{{.State.StartedAt}}' "${container_id}" 2>/dev/null || true)" || true)"
    if [ -z "${boundary}" ] || [ -z "${started}" ] || [ "${started}" -le "${boundary}" ]; then
      echo "  WARN: ${svc} booted before the latest schema advance (started=${started:-unknown} schema_advanced_at=${boundary:-unknown}) — NOT captured."
      continue
    fi
    image_id=$(docker inspect --format='{{.Image}}' "${container_id}" 2>/dev/null || true)
    if [ -z "${image_id}" ]; then
      continue
    fi
    # Services that share an image repository share its rollback tag, so they
    # can only be captured on the same image.
    rollback_ref="$(rollback_tag_ref_for_service "${svc}")"
    if [ -n "${rollback_ref_image[${rollback_ref}]:-}" ] && \
       [ "${rollback_ref_image[${rollback_ref}]}" != "${image_id}" ]; then
      echo "  WARN: ${svc} would re-point ${rollback_ref}, already captured for another service on ${rollback_ref_image[${rollback_ref}]} — NOT captured."
      continue
    fi
    if ! docker tag "${image_id}" "${rollback_ref}"; then
      echo "  WARN: ${svc} rollback tag ${rollback_ref} could not be written — NOT captured."
      continue
    fi
    rollback_ref_image[${rollback_ref}]="${image_id}"
    printf '%s\t%s\n' "$svc" "$image_id" >> "${ROLLBACK_MANIFEST}"
  done < <(DEPLOY_SERVICES="${APPLICATION_IMAGE_SERVICES}" restartable_deploy_services)

  local captured
  captured=$(wc -l < "${ROLLBACK_MANIFEST}" 2>/dev/null || echo 0)
  echo "  Captured ${captured} service image(s) in ${ROLLBACK_MANIFEST}"

  if [ -s "${ROLLBACK_MANIFEST}" ]; then
    sha256sum "${ROLLBACK_MANIFEST}" | awk '{print $1}' > "${DEPLOY_STATE_DIR}/rollback-images.sha256"
    echo "  Rollback manifest sha256: $(cat "${DEPLOY_STATE_DIR}/rollback-images.sha256")"
  fi
}

rollback_deployed_services() {
  local reason="${1:-deploy failure}"

  echo "=== Rolling back application images (${reason}) ==="

  # ORPHAN-HIGH-381: image rollback is only safe when the database did NOT move
  # forward in this release. Migrations are forward-only (blue-green discipline);
  # restoring a pre-release image against a schema that just dropped or reshaped
  # its tables boots straight into a SchemaDriftValidator fatal and the service
  # crash-loops until a human intervenes (2026-07-12 farm_documents outage).
  # Only a proven integer 0 permits rollback: every rollback caller runs after
  # db-migrate, so anything else means the boundary cannot be proven uncrossed.
  # Earlier attempts of the same release are covered by capture, which keeps
  # only images that booted after the latest recorded schema advance.
  case "${MIGRATIONS_APPLIED_THIS_RELEASE:-unknown}" in
    0) ;;
    *[!0-9]*)
      echo "::error::Rollback refused: applied-migration count for this release is unknown (${MIGRATIONS_APPLIED_THIS_RELEASE:-unset}), so image rollback cannot be proven safe. Fix forward (repair the failing gate and redeploy)."
      export ROLLBACK_SKIPPED_REASON="migration_boundary_unknown"
      return 1
      ;;
    *)
      echo "::error::Rollback refused: this release applied ${MIGRATIONS_APPLIED_THIS_RELEASE} database migration(s). Restoring pre-release images against a forward-migrated schema is the crash-loop class that took farm-service down on 2026-07-12 (ORPHAN-HIGH-381). Fix forward (repair the failing gate and redeploy this or a newer release)."
      export ROLLBACK_SKIPPED_REASON="migration_boundary_crossed"
      return 1
      ;;
  esac

  if [ ! -s "${ROLLBACK_MANIFEST}" ]; then
    echo "::error::Rollback refused: no captured image is proven to boot against the current schema (see the capture warnings above). Fix forward (repair the failing gate and redeploy)."
    export ROLLBACK_SKIPPED_REASON="no_schema_compatible_rollback_point"
    return 1
  fi

  local scope_services=()
  local svc
  if deploy_uses_full_stack_path; then
    while IFS= read -r svc; do
      [ -n "$svc" ] || continue
      scope_services+=("$svc")
    done < <(DEPLOY_SERVICES="${APPLICATION_IMAGE_SERVICES}" restartable_deploy_services)
  else
    while IFS= read -r svc; do
      [ -n "$svc" ] || continue
      scope_services+=("$svc")
    done < <(restartable_deploy_services)
  fi

  if [ "${#scope_services[@]}" -eq 0 ]; then
    echo "  No long-running service images were changed; rollback has no restart scope."
    return 0
  fi

  # Restore only what the rollback generation provably holds: the captured
  # image under this release's rollback tag. The release tags stay on the
  # release; compose is pointed at the rollback generation by TAG alone.
  local restored=()
  local image_id
  local rollback_ref
  local tagged_image
  for svc in "${scope_services[@]}"; do
    image_id="$(awk -F "$(printf '\t')" -v svc="${svc}" '$1 == svc {print $2; exit}' "${ROLLBACK_MANIFEST}")"
    if [ -z "${image_id}" ]; then
      echo "::warning::Rollback manifest has no prior image for ${svc}; it is not restored."
      continue
    fi
    rollback_ref="$(rollback_tag_ref_for_service "${svc}")"
    tagged_image="$(docker image inspect --format '{{.Id}}' "${rollback_ref}" 2>/dev/null || true)"
    if [ "${tagged_image}" != "${image_id}" ]; then
      echo "::warning::${svc}: ${rollback_ref} resolves to ${tagged_image:-no image}, not the captured ${image_id}; it is not restored."
      continue
    fi
    echo "  ${svc}: restoring ${rollback_ref} (${image_id})"
    restored+=("${svc}")
  done

  if [ "${#restored[@]}" -eq 0 ]; then
    echo "::error::Rollback scope had no restorable images."
    return 1
  fi

  compose_recreate_services "$(rollback_image_tag)" "${restored[@]}"
}
