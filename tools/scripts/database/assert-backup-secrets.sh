#!/usr/bin/env bash
# Fail fast when the production-backup GitHub Environment did not resolve
# every secret required by the droplet backup workflow.

set -euo pipefail

REQUIRED_BACKUP_SECRETS=(
  DROPLET_HOST
  DROPLET_USER
  DROPLET_SSH_KEY
  SPACES_BUCKET
  SPACES_ENDPOINT
  SPACES_ACCESS_KEY_ID
  SPACES_SECRET_ACCESS_KEY
  BACKUP_POSTGRES_USER
  BACKUP_POSTGRES_DB
  BACKUP_POSTGRES_PASSWORD
)

missing=()
for secret_name in "${REQUIRED_BACKUP_SECRETS[@]}"; do
  if [ -z "${!secret_name:-}" ]; then
    missing+=("${secret_name}")
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

echo "All ${#REQUIRED_BACKUP_SECRETS[@]} required backup secrets resolved for production-backup environment."
