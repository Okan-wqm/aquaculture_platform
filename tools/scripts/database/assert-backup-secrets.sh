#!/usr/bin/env bash
# Fail fast when the production-backup GitHub Environment did not resolve the
# least-privilege secret profile required by the current control-plane job.

set +x
set -euo pipefail

BACKUP_SECRET_PROFILE="${BACKUP_SECRET_PROFILE:-backup-runtime}"

SSH_SECRETS=(
  DROPLET_HOST
  DROPLET_USER
  DROPLET_SSH_KEY
  DROPLET_SSH_FINGERPRINT
)

DATABASE_SECRETS=(
  BACKUP_POSTGRES_USER
  BACKUP_POSTGRES_DB
  BACKUP_POSTGRES_PASSWORD
)

WALG_SECRETS=(
  WALG_SPACES_ACCESS_KEY_ID
  WALG_SPACES_SECRET_ACCESS_KEY
  WALG_LIBSODIUM_KEY_B64
)

PITR_WALG_SECRETS=(
  PITR_WALG_SPACES_ACCESS_KEY_ID
  PITR_WALG_SPACES_SECRET_ACCESS_KEY
  PITR_WALG_LIBSODIUM_KEY_B64
)

WALG_VARIABLES=(
  WALG_SPACES_BUCKET
  WALG_BACKUP_EPOCH
)

PITR_WALG_VARIABLES=(
  PITR_WALG_SPACES_BUCKET
  PITR_WALG_BACKUP_EPOCH
)

PITR_SECRETS=(
  PITR_SOURCE_SYSTEM_IDENTIFIER
)

LOGICAL_BACKUP_SECRETS=(
  LOGICAL_BACKUP_SPACES_BUCKET
  LOGICAL_BACKUP_SPACES_ACCESS_KEY_ID
  LOGICAL_BACKUP_SPACES_SECRET_ACCESS_KEY
  LOGICAL_BACKUP_GPG_RECIPIENT
)

EVIDENCE_PUBLISHER_SECRETS=(
  SPACES_ENDPOINT
  SPACES_REGION
  EVIDENCE_SPACES_BUCKET
  EVIDENCE_PUBLISHER_SPACES_ACCESS_KEY_ID
  EVIDENCE_PUBLISHER_SPACES_SECRET_ACCESS_KEY
)

EVIDENCE_VERIFIER_SECRETS=(
  SPACES_ENDPOINT
  SPACES_REGION
  EVIDENCE_SPACES_BUCKET
  EVIDENCE_VERIFIER_SPACES_ACCESS_KEY_ID
  EVIDENCE_VERIFIER_SPACES_SECRET_ACCESS_KEY
)

REQUIRED_BACKUP_SECRETS=()
REQUIRED_BACKUP_VARIABLES=()
case "${BACKUP_SECRET_PROFILE}" in
  backup-runtime)
    REQUIRED_BACKUP_SECRETS=(
      "${SSH_SECRETS[@]}"
      SPACES_ENDPOINT
      SPACES_REGION
      "${DATABASE_SECRETS[@]}"
      "${WALG_SECRETS[@]}"
      "${LOGICAL_BACKUP_SECRETS[@]}"
    )
    REQUIRED_BACKUP_VARIABLES=("${WALG_VARIABLES[@]}")
    ;;
  pitr-runtime)
    REQUIRED_BACKUP_SECRETS=(
      "${SSH_SECRETS[@]}"
      SPACES_ENDPOINT
      SPACES_REGION
      "${DATABASE_SECRETS[@]}"
      "${PITR_WALG_SECRETS[@]}"
      "${PITR_SECRETS[@]}"
    )
    REQUIRED_BACKUP_VARIABLES=("${PITR_WALG_VARIABLES[@]}")
    ;;
  evidence-publisher)
    REQUIRED_BACKUP_SECRETS=("${EVIDENCE_PUBLISHER_SECRETS[@]}")
    ;;
  evidence-verifier)
    REQUIRED_BACKUP_SECRETS=("${EVIDENCE_VERIFIER_SECRETS[@]}")
    ;;
  archive-freshness)
    REQUIRED_BACKUP_SECRETS=("${SSH_SECRETS[@]}")
    ;;
  *)
    echo "::error::Unknown BACKUP_SECRET_PROFILE: ${BACKUP_SECRET_PROFILE}"
    exit 2
    ;;
esac

missing=()
for secret_name in "${REQUIRED_BACKUP_SECRETS[@]}"; do
  if [ -z "${!secret_name:-}" ]; then
    missing+=("${secret_name}")
  fi
done

missing_variables=()
for variable_name in "${REQUIRED_BACKUP_VARIABLES[@]}"; do
  if [ -z "${!variable_name:-}" ]; then
    missing_variables+=("${variable_name}")
  fi
done

# The manifest already carries a plain-English `meaning` and a `safeExample`
# for every secret and variable. Until now the failure printed a bare list of
# names, so an operator reading "Missing ... WALG_LIBSODIUM_KEY_B64" had to go
# find out what that is and what shape a valid value takes. Nothing about that
# was undiscoverable — it was just three files away from the error, and this
# workflow has failed every scheduled run for months without anyone acting on
# it. Guidance printed where the failure happens costs one jq call.
MANIFEST_PATH="${MANIFEST_PATH:-.github/manifests/backup-secrets.json}"
RUNBOOK_PATH='docs/runbooks/secret-rotation.md'

explain_missing() {
  # $1 = manifest key (requiredSecrets|requiredVariables), rest = names
  manifest_key="$1"
  shift
  if [ ! -r "${MANIFEST_PATH}" ] || ! command -v jq > /dev/null 2>&1; then
    return 0
  fi
  for name in "$@"; do
    meaning=$(jq -r --arg k "${manifest_key}" --arg n "${name}" \
      '.[$k][] | select(.name == $n) | .meaning // empty' "${MANIFEST_PATH}")
    example=$(jq -r --arg k "${manifest_key}" --arg n "${name}" \
      '.[$k][] | select(.name == $n) | .safeExample // empty' "${MANIFEST_PATH}")
    if [ -n "${meaning}" ]; then
      printf '  %s — %s\n' "${name}" "${meaning}"
      if [ -n "${example}" ]; then
        printf '      shape: %s\n' "${example}"
      fi
    else
      printf '  %s — not described in %s; that is itself a defect worth fixing.\n' \
        "${name}" "${MANIFEST_PATH}"
    fi
  done
  printf 'How each value is obtained and rotated: %s\n' "${RUNBOOK_PATH}"
}

if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::Missing required resolved Actions secrets for production-backup environment: ${missing[*]}"
  explain_missing requiredSecrets "${missing[@]}"
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    echo "Provision them at: https://github.com/${GITHUB_REPOSITORY}/settings/environments"
  else
    echo "Provision them at: Settings -> Environments -> production-backup -> Environment secrets"
  fi
  exit 1
fi

if [ "${#missing_variables[@]}" -gt 0 ]; then
  echo "::error::Missing required resolved Actions variables for production-backup environment: ${missing_variables[*]}"
  explain_missing requiredVariables "${missing_variables[@]}"
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    echo "Provision them at: https://github.com/${GITHUB_REPOSITORY}/settings/environments"
  else
    echo "Provision them at: Settings -> Environments -> production-backup -> Environment variables"
  fi
  exit 1
fi

echo "All ${#REQUIRED_BACKUP_SECRETS[@]} secrets and ${#REQUIRED_BACKUP_VARIABLES[@]} variables required by ${BACKUP_SECRET_PROFILE} resolved for production-backup environment."
