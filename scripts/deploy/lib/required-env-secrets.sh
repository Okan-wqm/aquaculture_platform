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
#   SERVICE_IDENTITY_KEYRING — v2 HMAC keyring (JSON array) consumed by
#                             libs/backend-common service-identity.util's
#                             parseServiceIdentityKeyring(); twelve droplet
#                             services interpolate it as `:?` required in
#                             docker-compose.droplet.yml. Missing it aborts
#                             the deploy at compose interpolation
#                             (INFRA-HIGH-006, 2026-06-11 deploy red). Same
#                             generate-if-absent / never-rotate semantics as
#                             the other entries. The keyring transports ONLY
#                             secret material (kid / secret / status).
#                             Authorization POLICY (callers / audiences) is
#                             deliberately NOT carried here: the SSoT is the
#                             service-catalog (serviceIdentityCallers +
#                             matchesExpectedAudience), which the verifier reads.
#                             A bootstrap entry with no policy fields is correct
#                             AND fail-closed — the verifier derives the caller
#                             allowlist from the catalog and rejects unknown
#                             callers. (It is NOT "unrestricted": regression #388
#                             shipped exactly such an entry while the verifier
#                             still required INLINE callers → caller-not-allowed
#                             on every gateway→subgraph call → full login outage.
#                             Fixed by making the verifier catalog-derive policy;
#                             do not re-add policy fields to this generator.)

# Generator for SERVICE_IDENTITY_KEYRING — a shell function (not an inline
# command string) because the value is structured JSON; quoting a printf
# template inside the array literal would force escaped-quote soup AND
# expand the $(...) substitutions at source time instead of generation
# time. The function body runs only when the bootstrap loop eval-invokes
# it for an absent var.
generate_service_identity_keyring() {
  local kid secret
  kid="k-$(date -u +%Y%m%d)"
  secret="$(openssl rand -hex 32)"
  printf '[{"kid":"%s","secret":"%s","status":"active"}]' "${kid}" "${secret}"
}

# Generator for SERVICE_IDENTITY_SIGNING_KID — NOT an independent secret:
# signed-http-client selects its signing key from the keyring by this
# kid, so the value MUST reference an existing keyring entry. Derives
# the first kid from the SERVICE_IDENTITY_KEYRING line already in
# ${ENV_FILE}; array ordering below guarantees the keyring is generated
# first on a fresh droplet. Fail-closed: a missing/unparseable keyring
# aborts the bootstrap rather than emitting a dangling kid.
generate_service_identity_signing_kid() {
  local keyring kid
  keyring="$(grep '^SERVICE_IDENTITY_KEYRING=' "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -z "${keyring}" ]; then
    echo "generate_service_identity_signing_kid: SERVICE_IDENTITY_KEYRING absent from ${ENV_FILE} — ordering bug" >&2
    return 1
  fi
  kid="$(printf '%s' "${keyring}" | sed -n 's/.*"kid":"\([^"]*\)".*/\1/p' | head -1)"
  if [ -z "${kid}" ]; then
    echo "generate_service_identity_signing_kid: could not extract a kid from SERVICE_IDENTITY_KEYRING" >&2
    return 1
  fi
  printf '%s' "${kid}"
}

# This key may already protect legacy tenant Sentinel credential rows. Creating
# a different value during a normal deploy would make those rows
# undecryptable. Fresh environments and existing installations must provision
# it deliberately before the environmental-monitoring release is deployed.
require_preprovisioned_sentinel_hub_key() {
  echo "SENTINEL_HUB_ENCRYPTION_KEY must be provisioned explicitly; it may protect existing legacy Sentinel rows" >&2
  return 1
}

# WHY the two 2026-06-11 additions:
#   SERVICE_IDENTITY_SIGNING_KID — active signing key selector for
#                             signed-http-client (must match a keyring kid;
#                             derived, see generator above). Required :? by
#                             auth-service in docker-compose.droplet.yml.
#   CONFIG_ENCRYPTION_KEY   — config-service AES master key
#                             (configuration/services/encryption.service.ts
#                             fail-closed in production without it).
#   AI_TENANT_SECRET_ENCRYPTION_KEY — ai-service AES-256-GCM key for per-tenant
#                             BYOK AI credentials at rest (agent-config.entity.ts
#                             createEncryptedColumnTransformer). Required :? by
#                             ai-service; the transformer accepts a 64-hex key as
#                             32 bytes. MUST stay stable — rotating it makes every
#                             stored tenant AI key undecryptable.
REQUIRED_ENV_SECRETS=(
  "POSTGRES_PASSWORD:openssl rand -base64 32"
  "REDIS_PASSWORD:openssl rand -base64 32"
  "INTERNAL_SERVICE_SECRET:openssl rand -base64 32"
  "PASSWORD_PEPPER:openssl rand -base64 48"
  "MFA_ENCRYPTION_KEY:openssl rand -hex 32"
  "SERVICE_IDENTITY_KEYRING:generate_service_identity_keyring"
  "SERVICE_IDENTITY_SIGNING_KID:generate_service_identity_signing_kid"
  "CONFIG_ENCRYPTION_KEY:openssl rand -hex 32"
  "AI_TENANT_SECRET_ENCRYPTION_KEY:openssl rand -hex 32"
  "SENTINEL_HUB_ENCRYPTION_KEY:require_preprovisioned_sentinel_hub_key"
)

# Convenience helper: extract just the names, for preflight checks.
# Usage: names=( $(required_env_secret_names) )
required_env_secret_names() {
  local entry
  for entry in "${REQUIRED_ENV_SECRETS[@]}"; do
    printf '%s\n' "${entry%%:*}"
  done
}
