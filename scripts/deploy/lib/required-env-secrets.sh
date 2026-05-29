# shellcheck shell=bash
# =============================================================================
# scripts/deploy/lib/required-env-secrets.sh
#
# Single source of truth for droplet-side `.env` secrets that MUST exist
# before `droplet-up.sh` runs. Sourced by:
#
#   - scripts/deploy/droplet-up.sh (preflight check; aborts on missing)
#   - scripts/deploy/droplet-bootstrap-env.sh (idempotent generator; only
#     runs on initial droplet provisioning, never from the deploy path)
#
# Keeping both consumers sourced from this file makes it impossible for
# the preflight list and the bootstrap generator to drift (Tier-1
# architectural fix per CLAUDE.md "make the wrong state impossible").
#
# Generator format: each entry is "VAR_NAME:openssl_command". The
# bootstrap script eval-invokes the command and appends its output to
# `.env` only if the var is absent. Rotating a pepper or HMAC key
# outside incident response is explicitly forbidden — this generator
# runs exactly once per droplet's lifetime.
# =============================================================================

# Format: "ENV_VAR_NAME:generator-command"
# WHY each secret is required:
#   POSTGRES_PASSWORD       — postgres superuser; database containers refuse to start without it
#   REDIS_PASSWORD          — redis requirepass; all clients use `redis://:<pw>@redis:6379`
#   INTERNAL_SERVICE_SECRET — HMAC key for signed inter-service HTTP (libs/backend-common
#                             service-identity util binds tenantId into the signature;
#                             ADR service-identity-v3)
#   PASSWORD_PEPPER         — HMAC pepper applied before bcrypt on user passwords
#                             (b0ec61f0; rotation invalidates every stored hash — see
#                             docs/runbooks/secret-rotation.md#password-pepper)
#   MFA_ENCRYPTION_KEY      — AES-256-GCM root key for auth-service TOTP secrets
#                             (production auth-service fails closed without it)
REQUIRED_ENV_SECRETS=(
  "POSTGRES_PASSWORD:openssl rand -base64 32"
  "REDIS_PASSWORD:openssl rand -base64 32"
  "INTERNAL_SERVICE_SECRET:openssl rand -base64 32"
  "PASSWORD_PEPPER:openssl rand -base64 48"
  "MFA_ENCRYPTION_KEY:openssl rand -hex 32"
)

# Convenience helper: extract just the names, for preflight checks.
# Usage: names=( $(required_env_secret_names) )
required_env_secret_names() {
  local entry
  for entry in "${REQUIRED_ENV_SECRETS[@]}"; do
    printf '%s\n' "${entry%%:*}"
  done
}
