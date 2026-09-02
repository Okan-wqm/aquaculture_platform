#!/usr/bin/env bash

# Deployment-mode authority shared by the droplet rollout and its executable
# contract tests. FULL_DEPLOY describes image selection size. Only this policy
# decides whether a rollout may replace persistent data infrastructure.

validate_data_infrastructure_policy() {
  case "${PRESERVE_DATA_INFRASTRUCTURE:-false}" in
    true|false) ;;
    *)
      echo "::error::PRESERVE_DATA_INFRASTRUCTURE must be exactly true or false" >&2
      return 1
      ;;
  esac

  if [ "${DEPLOY_MODE:-production}" = "development" ] && \
     [ "${PRESERVE_DATA_INFRASTRUCTURE:-false}" != "true" ]; then
    echo "::error::development deploys must preserve data infrastructure" >&2
    return 1
  fi

  if [ "${PRESERVE_DATA_INFRASTRUCTURE:-false}" = "true" ] && \
     [ "${DEPLOY_MODE:-production}" != "development" ]; then
    echo "::error::data infrastructure preservation is restricted to development deploys" >&2
    return 1
  fi
}

deploy_uses_full_stack_path() {
  [ "${FULL_DEPLOY:-false}" = "true" ] && \
    [ "${PRESERVE_DATA_INFRASTRUCTURE:-false}" != "true" ]
}

is_infrastructure_image_service() {
  local service="$1"

  case " ${INFRA_IMAGE_SERVICES:-} " in
    *" ${service} "*) return 0 ;;
    *) return 1 ;;
  esac
}

rollout_image_services() {
  local service

  for service in ${DEPLOY_SERVICES:-}; do
    if [ "${PRESERVE_DATA_INFRASTRUCTURE:-false}" = "true" ] && \
       is_infrastructure_image_service "${service}"; then
      continue
    fi
    echo "${service}"
  done
}

restartable_deploy_services() {
  local service

  while IFS= read -r service; do
    [ -n "${service}" ] || continue
    [ "${service}" = "db-migrate" ] && continue
    echo "${service}"
  done < <(rollout_image_services)
}

deployment_policy_env_value() {
  local name="$1"
  local env_file="$2"

  if [ -r "${env_file}" ]; then
    grep -E "^${name}=" "${env_file}" 2>/dev/null | tail -1 | cut -d= -f2- || true
  fi
}

configure_preserved_compose_interpolation() {
  if [ "${PRESERVE_DATA_INFRASTRUCTURE:-false}" != "true" ]; then
    return 0
  fi

  local env_file="${1:-}"

  # Compose interpolates every service before applying a command's explicit
  # --no-deps target. The running PostgreSQL intentionally predates the WAL-G
  # activation stop-line, so development needs inert coordinates solely to
  # parse the model while that container is preserved. The policy above and
  # rollout service filter make those coordinates unreachable by a container.
  WALG_BACKUP_EPOCH="${WALG_BACKUP_EPOCH:-$(deployment_policy_env_value WALG_BACKUP_EPOCH "${env_file}")}"
  WALG_BACKUP_EPOCH="${WALG_BACKUP_EPOCH:-development-preserved}"
  WALG_SPACES_BUCKET="${WALG_SPACES_BUCKET:-$(deployment_policy_env_value WALG_SPACES_BUCKET "${env_file}")}"
  WALG_SPACES_BUCKET="${WALG_SPACES_BUCKET:-development-preserved}"
  SPACES_ENDPOINT="${SPACES_ENDPOINT:-$(deployment_policy_env_value SPACES_ENDPOINT "${env_file}")}"
  SPACES_ENDPOINT="${SPACES_ENDPOINT:-https://development-preserved.invalid}"
  SPACES_REGION="${SPACES_REGION:-$(deployment_policy_env_value SPACES_REGION "${env_file}")}"
  SPACES_REGION="${SPACES_REGION:-development-preserved}"
  export WALG_BACKUP_EPOCH WALG_SPACES_BUCKET SPACES_ENDPOINT SPACES_REGION
}

assert_preserved_migration_infrastructure() {
  local container
  local state
  local running
  local health

  for container in aqua-postgres aqua-redis aqua-minio; do
    state="$(docker inspect \
      --format='{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "${container}" 2>/dev/null || true)"
    read -r running health <<< "${state}"
    if [ "${running:-false}" != "true" ] || [ "${health:-missing}" != "healthy" ]; then
      echo "::error::Preserved infrastructure container ${container} is not healthy (running=${running:-missing} health=${health:-missing})" >&2
      return 1
    fi
  done
}
