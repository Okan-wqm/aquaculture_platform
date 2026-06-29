#!/usr/bin/env bash
# =============================================================================
# scripts/deploy/deploy-paths.sh
#
# SSoT for the production deploy's filesystem layout + the routine that
# materializes the immutable, SHA-pinned source checkout the deploy runs from.
#
# WHY THIS EXISTS (root-cause architectural fix):
#   The deploy used to `cd /var/aqua-saas; git checkout -f "$DEPLOY_SHA"` and run
#   everything from that directory. But /var/aqua-saas is ALSO the interactive
#   working tree that engineering/agent sessions check feature branches into.
#   The deploy's force-checkout fought live sessions, and post-deploy-verify.sh's
#   `git rev-parse HEAD == TARGET_SHA` guard FALSE-FAILED whenever a session had
#   drifted HEAD to a feature branch — even though the deployed images + running
#   app were correct (real incident: expected=<sha> actual=<feature-branch-sha>).
#
#   The fix decouples the deployed artifacts from interactive scratch entirely:
#   the deploy materializes a DEDICATED, deploy-owned git worktree pinned
#   (detached) to the exact DEPLOY_SHA and runs from there. The interactive
#   /var/aqua-saas HEAD is NEVER touched by the deploy anymore — `git fetch`
#   only populates the shared object store; the detached worktree carries the
#   deploy's own HEAD.
#
# SOURCED BY:
#   - scripts/deploy/droplet-up.sh         (deploy executor on the droplet)
#   - scripts/deploy/post-deploy-verify.sh (deploy verifier on the droplet)
#   - .github/workflows/deploy-digitalocean.yml SSH blocks forward/use the
#     same default DEPLOY_CHECKOUT_DIR before invoking the scripts above.
#
# This file MUST be sourced (it `export`s vars + defines functions); it does
# nothing on its own when executed.
# =============================================================================

# ──────────────────────────────────────────────────────────────────────────
# SSoT path constants. Single definition — every consumer sources this file
# rather than hardcoding a duplicate path.
#
#   DEPLOY_SOURCE_REPO  — the persistent interactive checkout that owns the git
#                         object store + remotes + the gitignored secrets .env.
#                         The deploy READS from it (fetch + worktree add) but
#                         NEVER force-checkouts its HEAD.
#   DEPLOY_CHECKOUT_DIR — the dedicated, deploy-owned, SHA-pinned worktree the
#                         deploy actually runs from. Sibling of the existing
#                         DEPLOY_STATE_ROOT (/var/lib/aqua/deploy/releases): the
#                         deploy already owns /var/lib/aqua/deploy.
#   DEPLOY_ENV_FILE     — persistent secrets SSoT (gitignored, NOT in the
#                         SHA-pinned tree). Symlinked into the checkout so
#                         cwd-relative `docker compose` finds it; no secrets
#                         migration ever happens.
#   DEPLOY_CERTS_DIR    — persistent TLS material (gitignored ./certs/: NATS
#                         mTLS, redis/postgres TLS, JWT RS256 keys). Generated
#                         once and persisted across deploys by skip-if-exists;
#                         docker-compose.droplet.yml bind-mounts it via RELATIVE
#                         `./certs/...` paths (resolved against the compose cwd).
#                         Symlinked into the checkout so both the cwd-relative
#                         compose mounts AND generate-internal-certs.sh (which
#                         derives its output dir from its own BASH_SOURCE under
#                         the checkout) resolve to the stable persistent dir —
#                         a recreated checkout never loses or regenerates certs.
#   COMPOSE_PROJECT_NAME — SAFETY-CRITICAL pin. Compose derives its project name
#                         (and therefore EVERY named volume/network: postgres
#                         data, NATS JetStream, MinIO objects, redis) from the
#                         cwd basename by default. The live droplet's volumes are
#                         `aqua-saas_*` (project `aqua-saas` = basename of the old
#                         /var/aqua-saas cwd). Running compose from the isolated
#                         checkout (basename `checkout`) WITHOUT this pin would
#                         re-derive empty `checkout_*` volumes = catastrophic data
#                         loss. Pinned to `aqua-saas` so the isolated-checkout
#                         deploy reuses the existing volumes/networks/containers.
# ──────────────────────────────────────────────────────────────────────────
export DEPLOY_SOURCE_REPO="${DEPLOY_SOURCE_REPO:-/var/aqua-saas}"
export DEPLOY_CHECKOUT_DIR="${DEPLOY_CHECKOUT_DIR:-/var/lib/aqua/deploy/checkout}"
export DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-${DEPLOY_SOURCE_REPO}/.env}"
export DEPLOY_CERTS_DIR="${DEPLOY_CERTS_DIR:-${DEPLOY_SOURCE_REPO}/certs}"
# Pin the compose project to the live droplet's existing identity (was the cwd
# basename `aqua-saas`) so the cwd change to the isolated checkout cannot
# re-derive empty volumes. The `:-` keeps an operator/.env override authoritative.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aqua-saas}"

# ──────────────────────────────────────────────────────────────────────────
# materialize_deploy_checkout <sha>
#
# Idempotent, robust routine that produces a dedicated git worktree at
# $DEPLOY_CHECKOUT_DIR pinned (detached) to <sha>. Safe to re-run on every
# deploy and resilient to stale/corrupt worktree state.
#
# Edge handling:
#   - `git worktree prune` first clears stale administrative records (e.g. a
#     prior checkout dir deleted out-of-band) so `worktree add` cannot fail
#     with "already registered".
#   - fetch goes into the SHARED object store via DEPLOY_SOURCE_REPO; it does
#     NOT touch the interactive working tree's HEAD/index.
#   - if the dir is missing → `worktree add --detach --force`.
#   - if the dir exists but is not a valid git worktree (corrupt/partial) →
#     remove it (worktree remove if known, else rm -rf + prune) and recreate.
#   - if the dir is a healthy worktree → `checkout -f --detach <sha>` re-pins it
#     (force discards any drift; --detach keeps it off any branch).
#   - a stale `index.lock` left by a crashed prior run is cleared before
#     checkout so a re-deploy is never wedged.
# ──────────────────────────────────────────────────────────────────────────
materialize_deploy_checkout() {
  local sha="${1:?materialize_deploy_checkout requires a commit SHA}"
  local src="${DEPLOY_SOURCE_REPO}"
  local dir="${DEPLOY_CHECKOUT_DIR}"

  echo "=== Materializing deploy checkout (${dir} @ ${sha}) ==="

  # Fetch into the shared object store. --force/--prune mirror the prior
  # deploy behavior; this updates refs/objects only, NOT the interactive tree.
  git -C "${src}" fetch --force --prune origin

  # Clear stale worktree admin records before any add/remove decision.
  git -C "${src}" worktree prune

  mkdir -p "$(dirname "${dir}")"

  if [ ! -e "${dir}" ]; then
    git -C "${src}" worktree add --detach --force "${dir}" "${sha}"
  elif git -C "${dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Healthy existing worktree — clear any crashed-run index.lock, then re-pin.
    rm -f "$(git -C "${dir}" rev-parse --git-path index.lock 2>/dev/null)" 2>/dev/null || true
    git -C "${dir}" fetch --force --prune origin
    git -C "${dir}" checkout -f --detach "${sha}"
  else
    # Path exists but is not a usable worktree (corrupt/partial). Remove and
    # recreate so the deploy always runs from a clean SHA-pinned tree.
    echo "  WARN: ${dir} exists but is not a valid git worktree; recreating."
    git -C "${src}" worktree remove --force "${dir}" 2>/dev/null || rm -rf "${dir}"
    git -C "${src}" worktree prune
    git -C "${src}" worktree add --detach --force "${dir}" "${sha}"
  fi

  # Secrets stay persistent: symlink the gitignored .env + certs/ so
  # cwd-relative `docker compose` bind-mounts and cert generation resolve to
  # the stable persistent location. The SHA-pinned tree never carries secrets,
  # and recreating the checkout never loses TLS material or .env.
  mkdir -p "${DEPLOY_CERTS_DIR}"
  ln -sfn "${DEPLOY_ENV_FILE}" "${dir}/.env"
  ln -sfn "${DEPLOY_CERTS_DIR}" "${dir}/certs"

  # node_modules provisioning (ORPHAN-HIGH-218): the deploy checkout is a bare
  # SHA-pinned worktree that never runs `npm ci`, but the deploy now executes
  # third-party-importing TS scripts via Node 22 type-stripping (e.g.
  # check-service-health.ts → `import js-yaml`). Node resolves node_modules by
  # walking up from the script's dir, which never reaches the source repo's
  # tree, so those imports died with ERR_MODULE_NOT_FOUND — the health gate
  # crashed, reported a false "critical service health check failed", and the
  # rollback ran the same broken gate (rollback_failed). Symlink the source
  # repo's already-installed node_modules (gitignored, so the SHA checkout never
  # carries it) so the deploy scripts resolve their declared deps. Guarded:
  # absent only on a never-installed droplet, where the scripts can't run anyway.
  if [ -d "${src}/node_modules" ]; then
    ln -sfn "${src}/node_modules" "${dir}/node_modules"
  fi

  local head
  head="$(git -C "${dir}" rev-parse HEAD)"
  if [ "${head}" != "${sha}" ]; then
    echo "::error::deploy checkout failed to pin ${dir} to ${sha} (HEAD=${head})." >&2
    return 1
  fi
  echo "  Deploy checkout pinned: ${dir} @ ${head}"
}
