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

if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::Missing required resolved Actions secrets for production-backup environment: ${missing[*]}"
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    echo "Provision them at: https://github.com/${GITHUB_REPOSITORY}/settings/environments"
  else
    echo "Provision them at: Settings -> Environments -> production-backup -> Environment secrets"
  fi
  exit 1
fi

if [ "${#missing_variables[@]}" -gt 0 ]; then
  echo "::error::Missing required resolved Actions variables for production-backup environment: ${missing_variables[*]}"
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    echo "Provision them at: https://github.com/${GITHUB_REPOSITORY}/settings/environments"
  else
    echo "Provision them at: Settings -> Environments -> production-backup -> Environment variables"
  fi
  exit 1
fi

echo "All ${#REQUIRED_BACKUP_SECRETS[@]} secrets and ${#REQUIRED_BACKUP_VARIABLES[@]} variables required by ${BACKUP_SECRET_PROFILE} resolved for production-backup environment."
