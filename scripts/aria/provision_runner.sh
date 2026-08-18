#!/usr/bin/env bash
# provision_runner.sh — rebuild/drift-check ARIA's self-hosted runner habitat (HB-1).
# Companion to docs/runbooks/aria-runner-rebuild.md; the runbook is the WHY, this
# is the check. `--dry-run` only REPORTS (checks print ✓/✗; exit 0 = machine
# matches, exit 1 = drift). Apply mode (root) installs ONLY missing pieces.
#
# Constraints this script encodes:
#   * Secrets are handled by NAME only. It never reads, prints, or writes a
#     secret value; the registration token arrives via env RUNNER_REG_TOKEN,
#     is consumed by config.sh once, and is never stored.
#   * It never bootstraps aria/state (auto-creating the branch is exactly the
#     ORPHAN-CRITICAL-484 failure) and never authenticates Claude (a
#     credential act is the operator's — ORPHAN-CRITICAL-591).
set -euo pipefail

RUNNER_USER="${RUNNER_USER:-gharunner}"
RUNNER_ROOT="${RUNNER_ROOT:-/home/${RUNNER_USER}/actions-runner}"
REPO_SLUG="${REPO_SLUG:-Okan-wqm/aquaculture_platform}"
RUNNER_NAME="${RUNNER_NAME:-suderra-droplet-claude}"
SERVICE_NAME="actions.runner.${REPO_SLUG//\//-}.${RUNNER_NAME}.service"
WORKSPACE_COPY="${RUNNER_ROOT}/_work/${REPO_SLUG##*/}/${REPO_SLUG##*/}"
CLAUDE_FLOOR="2.1.197" # both lanes' preflight reject older — keep in lockstep with the workflows
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
POLICY_REL="aria-config/genesis_policy.json" # genesis_policy.OVERRIDE_RELPATH — resolved per repo root, hence TWO copies

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
DRIFT=0
ok()   { printf '  \342\234\223 %s\n' "$1"; }
bad()  { printf '  \342\234\227 %s\n' "$1"; DRIFT=1; }
note() { printf '    - %s\n' "$1"; }
section() { printf '\n== %s\n' "$1"; }

# Apply mode mutates system state (apt, useradd, systemd), so it must be root.
# Dry-run stays runnable unprivileged, but some probes (runner-home files) then
# report what THIS user can see — run as root for an authoritative verdict.
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "apply mode must run as root (dry-run works unprivileged)"; exit 2
fi

section "OS dependencies (bubblewrap = fail-closed sandbox backend; jq used by the executor lane)"
missing_pkgs=()
for pair in bwrap:bubblewrap jq:jq git:git curl:curl python3:python3; do
  bin="${pair%%:*}"; pkg="${pair##*:}"
  if command -v "$bin" >/dev/null 2>&1; then ok "$bin present"; else
    if [ "$DRY_RUN" -eq 1 ]; then bad "$bin missing (apt: $pkg)"; else missing_pkgs+=("$pkg"); fi
  fi
done
if [ "${#missing_pkgs[@]}" -gt 0 ]; then
  apt-get update -qq && apt-get install -y --no-install-recommends "${missing_pkgs[@]}"
  ok "installed: ${missing_pkgs[*]}"
fi

section "Unprivileged user namespaces (capability, not presence — a bwrap binary on a userns-disabled host fails every invocation)"
clone_knob=/proc/sys/kernel/unprivileged_userns_clone
if [ ! -e "$clone_knob" ]; then
  ok "unprivileged_userns_clone knob absent (kernel default-enabled)"
elif [ "$(cat "$clone_knob")" = "1" ]; then
  ok "unprivileged_userns_clone=1"
elif [ "$DRY_RUN" -eq 1 ]; then
  bad "unprivileged_userns_clone=0 (bubblewrap cannot build namespaces)"
else
  printf 'kernel.unprivileged_userns_clone=1\n' > /etc/sysctl.d/99-aria-userns.conf
  sysctl --system >/dev/null && ok "unprivileged_userns_clone enabled (persisted in sysctl.d)"
fi
max_ns="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unreadable)"
if [ "$max_ns" != "unreadable" ] && [ "$max_ns" -gt 0 ] 2>/dev/null; then
  ok "max_user_namespaces=${max_ns}"
else
  bad "max_user_namespaces=${max_ns} (want > 0; fix via sysctl.d — not auto-set, a cap of 0 is usually a deliberate hardening choice to review)"
fi
# Final authority: the accessor the runtime itself consults before any write-capable spawn.
if [ -d "${REPO_ROOT}/aria-kernel" ]; then
  backend="$(cd "$REPO_ROOT" && PYTHONPATH=aria-kernel python3 -c \
    'from aria_kernel.implementation_safety import sandbox_backend; print(sandbox_backend() or "")' 2>/dev/null || echo probe_failed)"
  case "$backend" in
    probe_failed) note "kernel probe failed here (likely missing python deps outside a job) — the capability-probe workflow is the authoritative check" ;;
    "") bad "aria_kernel.sandbox_backend() verified NO backend — write-capable spawns will be refused" ;;
    *) ok "aria_kernel.sandbox_backend()=${backend}" ;;
  esac
fi

section "Runner install + registration (${RUNNER_ROOT})"
id "$RUNNER_USER" >/dev/null 2>&1 && ok "user ${RUNNER_USER} exists" || {
  if [ "$DRY_RUN" -eq 1 ]; then bad "user ${RUNNER_USER} missing"; else
    useradd -m -s /bin/bash "$RUNNER_USER" && ok "user ${RUNNER_USER} created"; fi; }
if [ -f "${RUNNER_ROOT}/.runner" ]; then
  ok "runner configured at ${RUNNER_ROOT}"
elif [ "$DRY_RUN" -eq 1 ]; then
  bad "no configured runner at ${RUNNER_ROOT}"
else
  # RUNNER_REG_TOKEN is required only on this one path; it expires in ~1h and
  # must never be persisted — config.sh trades it for the runner credential.
  [ -n "${RUNNER_REG_TOKEN:-}" ] || { echo "RUNNER_REG_TOKEN not set; mint one (Settings > Actions > Runners) and re-run"; exit 2; }
  mkdir -p "$RUNNER_ROOT" && cd "$RUNNER_ROOT"
  ver="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name | ltrimstr("v")')"
  curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${ver}/actions-runner-linux-x64-${ver}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
  chown -R "${RUNNER_USER}:${RUNNER_USER}" "$RUNNER_ROOT"
  # --labels claude yields the pinned set self-hosted,linux,claude (first two implicit).
  sudo -u "$RUNNER_USER" env RUNNER_REG_TOKEN="$RUNNER_REG_TOKEN" bash -c \
    "cd '$RUNNER_ROOT' && ./config.sh --url 'https://github.com/${REPO_SLUG}' --token \"\$RUNNER_REG_TOKEN\" --name '${RUNNER_NAME}' --labels claude --unattended"
  ok "runner registered as ${RUNNER_NAME}"
fi

section "systemd service (${SERVICE_NAME})"
if systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
  ok "service unit installed"
  systemctl is-active --quiet "$SERVICE_NAME" && ok "service active" || {
    if [ "$DRY_RUN" -eq 1 ]; then bad "service not active"; else systemctl start "$SERVICE_NAME" && ok "service started"; fi; }
elif [ "$DRY_RUN" -eq 1 ] || [ ! -f "${RUNNER_ROOT}/svc.sh" ]; then
  bad "service unit missing (install: cd ${RUNNER_ROOT} && ./svc.sh install ${RUNNER_USER} && ./svc.sh start)"
else
  (cd "$RUNNER_ROOT" && ./svc.sh install "$RUNNER_USER" && ./svc.sh start) && ok "service installed + started"
fi
# Labels live SERVER-side (not in .runner), so verify via API when gh is usable; never guess.
if command -v gh >/dev/null 2>&1 && labels="$(gh api "repos/${REPO_SLUG}/actions/runners" \
    --jq ".runners[] | select(.name==\"${RUNNER_NAME}\") | [.labels[].name] | sort | join(\",\")" 2>/dev/null)"; then
  case "$labels" in
    *claude*linux*self-hosted*|*claude*self-hosted*) ok "labels on GitHub: ${labels}" ;;
    "") bad "runner ${RUNNER_NAME} not registered on GitHub" ;;
    *) bad "labels on GitHub: ${labels} (want self-hosted,linux,claude)" ;;
  esac
else
  note "labels unverifiable here (gh missing/unauthenticated) — check Settings > Actions > Runners"
fi

section "Runner .env secret key PRESENCE (names only — values are never read or printed)"
env_file="${RUNNER_ROOT}/.env"
for key in ARIA_GH_TOKEN ARIA_OBSERVABILITY_API_KEY; do
  if [ -f "$env_file" ] && grep -q "^${key}=" "$env_file" 2>/dev/null; then
    ok "$key present in ${env_file}"
  else
    # No apply action on purpose: minting/copying secret values is an operator
    # act (runbook step 3), and the service must be restarted after the edit.
    bad "$key missing from ${env_file} (mint per runbook step 3, then restart ${SERVICE_NAME})"
  fi
done

section "Claude Code CLI (managed login required; floor ${CLAUDE_FLOOR})"
if claude_ver="$(sudo -n -u "$RUNNER_USER" claude --version 2>/dev/null | awk '{print $1}')" && [ -n "$claude_ver" ]; then
  ok "claude present as ${RUNNER_USER}: ${claude_ver} (floor ${CLAUDE_FLOOR} — workflows enforce it)"
else
  bad "claude CLI not runnable as ${RUNNER_USER} (install + login per runbook step 4)"
fi
cred_dir="/home/${RUNNER_USER}/.claude"
if [ -f "${cred_dir}/.credentials.json" ] || [ -f "${cred_dir}/config.json" ]; then
  # Presence != a live session (OAuth expires — ORPHAN-CRITICAL-591); the real
  # smoke is `sudo -u gharunner claude -p "say OK"`, deliberately not run here
  # because a drift check must not spawn an LLM call.
  ok "managed-login evidence present (${cred_dir}) — presence only; smoke-test per runbook step 4 if a lane reported auth failure"
else
  bad "no managed-login evidence in ${cred_dir} (run the login checklist, runbook step 4)"
fi

section "Policy override — both roots (genesis_policy resolves ${POLICY_REL} per repo root)"
if [ -f "${REPO_ROOT}/${POLICY_REL}" ]; then ok "operator clone copy: ${REPO_ROOT}/${POLICY_REL}"
else bad "operator clone copy missing: ${REPO_ROOT}/${POLICY_REL}"; fi
if [ -f "${WORKSPACE_COPY}/${POLICY_REL}" ]; then
  if cmp -s "${REPO_ROOT}/${POLICY_REL}" "${WORKSPACE_COPY}/${POLICY_REL}" 2>/dev/null; then
    ok "workspace copy present and identical"
  else
    bad "workspace copy differs from operator clone (must stay byte-identical — reconcile by hand; auto-overwrite could destroy the newer edit)"
  fi
elif [ "$DRY_RUN" -eq 1 ] || [ ! -f "${REPO_ROOT}/${POLICY_REL}" ]; then
  bad "workspace copy missing: ${WORKSPACE_COPY}/${POLICY_REL}"
else
  install -o "$RUNNER_USER" -g "$RUNNER_USER" -D "${REPO_ROOT}/${POLICY_REL}" "${WORKSPACE_COPY}/${POLICY_REL}"
  ok "workspace copy mirrored from operator clone"
fi

section "State store (aria/state branch — pointer only, NEVER bootstrapped from here)"
if git -C "$REPO_ROOT" ls-remote --exit-code origin refs/heads/aria/state >/dev/null 2>&1; then
  ok "aria/state reachable on origin"
else
  bad "aria/state NOT reachable — do not re-bootstrap; follow docs/runbooks/aria-state-branch-bootstrap.md (recovery before bootstrap)"
fi

printf '\n'
if [ "$DRIFT" -ne 0 ]; then echo "DRIFT: the machine does not match the ARIA runner habitat (see ✗ above)"; exit 1; fi
echo "OK: machine matches the ARIA runner habitat"
