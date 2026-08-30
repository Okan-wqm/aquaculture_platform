#!/usr/bin/env bash
# =============================================================================
# scripts/deploy/droplet-bootstrap-env.sh
#
# Idempotently populates /var/aqua-saas/.env from REQUIRED_ENV_SECRET_SPECS
# that are currently missing. For each required secret the script greps
# for an existing `^NAME=` line and skips if present — a pre-existing
# PASSWORD_PEPPER or INTERNAL_SERVICE_SECRET is NEVER overwritten. On a
# fully-provisioned droplet the script is a no-op that exits 0.
#
# Invoked from two places:
#
#   1. droplet-up.sh Phase A4 (automatic, every deploy). Safe because of
#      the "generate if absent, never rotate" semantics described above —
#      running on every deploy amortises to "run once per droplet's
#      lifetime" in practice. This keeps deploys fully automated even on
#      the very first rollout to a fresh droplet.
#
#   2. Manual invocation during disaster recovery / onboarding:
#
#        ssh root@<droplet>
#        cd /var/aqua-saas
#        sudo bash scripts/deploy/droplet-bootstrap-env.sh
#
# The distinction that MUST be preserved: "generate if absent" is safe;
# "rotate" (overwriting a pre-existing secret) is not — rotating
# PASSWORD_PEPPER invalidates every stored bcrypt hash and locks every
# user out of the platform. See docs/runbooks/secret-rotation.md
# §"Password pepper" for the rotation path (explicit incident response).
#
# Exit codes:
#   0 — all required secrets are present (either pre-existing or just
#       generated). A subsequent droplet-up.sh preflight will pass.
#   1 — invocation error (ENV_FILE unreadable or SSoT lib missing, or
#       a generator function itself failed).
# =============================================================================

set -euo pipefail

ENV_FILE="${ENV_FILE:-/var/aqua-saas/.env}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "${REPO_ROOT}/scripts/deploy/lib/required-env-secrets.sh"

info() { echo -e "\033[0;34m[INFO]\033[0m  $1"; }
ok()   { echo -e "\033[0;32m[OK]\033[0m    $1"; }
skip() { echo -e "\033[0;90m[SKIP]\033[0m  $1 (already set)"; }
gen()  { echo -e "\033[0;33m[GEN]\033[0m   $1"; }

if [ ! -e "${ENV_FILE}" ]; then
  # Create an empty file with tight perms rather than letting `>>` produce
  # it with default umask — the pepper and HMAC keys are the highest-value
  # secrets on the droplet.
  info "Creating ${ENV_FILE} (new file, mode 600)"
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

# A readable .env is a non-negotiable precondition; refuse to continue
# blindly if the operator can't inspect what's already there.
if [ ! -r "${ENV_FILE}" ]; then
  echo "::error::${ENV_FILE} exists but is not readable; aborting before any generation."
  exit 1
fi

info "Bootstrapping required secrets into ${ENV_FILE}"
REQUIRED_SECRET_COUNT="$(required_env_secret_count)"
info "Required set: ${REQUIRED_SECRET_COUNT} secrets (SSoT: scripts/deploy/lib/required-env-secrets.sh)"

ADDED=0
for ((secret_index = 0; secret_index < ${#REQUIRED_ENV_SECRET_SPECS[@]}; secret_index += 2)); do
  name="${REQUIRED_ENV_SECRET_SPECS[secret_index]}"
  generator="${REQUIRED_ENV_SECRET_SPECS[secret_index + 1]}"

  if grep -q "^${name}=" "${ENV_FILE}" 2>/dev/null; then
    skip "${name}"
    continue
  fi

  gen "${name}  (via: ${generator})"
  # Generate into a temp var first so a generator crash doesn't
  # half-append an invalid line.
  if ! value="$("${generator}")"; then
    echo "::error::Generator failed for ${name}: ${generator}"
    exit 1
  fi

  # Ensure trailing newline before appending (otherwise a .env that
  # didn't end with \n gets our line glued to the previous one).
  if [ -s "${ENV_FILE}" ] && [ "$(tail -c 1 "${ENV_FILE}" | wc -l)" -eq 0 ]; then
    printf '\n' >> "${ENV_FILE}"
  fi

  printf '%s=%s\n' "${name}" "${value}" >> "${ENV_FILE}"
  ADDED=$((ADDED + 1))
  ok "${name}  (appended)"
done

info "----"
if [ "${ADDED}" -eq 0 ]; then
  ok "No changes — every required secret was already present."
else
  ok "Appended ${ADDED} secret(s) to ${ENV_FILE}"
  info "Next step: re-run the deploy workflow; droplet-up.sh preflight will now pass."
fi
