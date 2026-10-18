#!/usr/bin/env bash
# provision_gateway.sh — install/drift-check ARIA's host services outside the
# runner habitat: the event gateway and the telemetry export (Plan 032 Faz
# 032e/032f). Companion to docs/runbooks/aria-gateway.md. `--dry-run` only
# REPORTS (checks print ✓/✗; exit 0 = machine matches, exit 1 = drift). Apply
# mode (root) installs the repo copies and enables the gateway and the timer.
#
# WHY a script of its own (ARIA-HIGH-247): these units are not the runner's
# habitat. scripts/aria/provision_runner.sh installed and enabled them in its
# apply mode, so applying the habitat also started a gateway the operator had
# not chosen to run, and its drift gate could not pass on a host that runs the
# habitat without them. Each provisioner now installs only what it names.
#
# Secrets are handled by NAME only: /etc/aria/aria.env is checked for the
# names the gateway refuses ingress without; no value is read out or printed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
DRIFT=0
ok()   { printf '  \342\234\223 %s\n' "$1"; }
bad()  { printf '  \342\234\227 %s\n' "$1"; DRIFT=1; }
section() { printf '\n== %s\n' "$1"; }

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "apply mode must run as root (dry-run works unprivileged)"; exit 2
fi

section "ARIA gateway + telemetry units (Plan 032 Faz 032e/032f — repo copy is the SSoT)"
for unit in aria-gateway.service aria-telemetry.service aria-telemetry.timer; do
  src="$REPO_ROOT/infrastructure/aria/$unit"
  if [ ! -f "$src" ]; then bad "missing $src"; continue; fi
  if [ "$DRY_RUN" -eq 1 ]; then
    if cmp -s "$src" "/etc/systemd/system/$unit"; then ok "$unit installed (matches repo)"; else bad "$unit not installed or drifted from repo"; fi
  else
    install -m 0644 "$src" "/etc/systemd/system/$unit" && ok "$unit installed"
  fi
done
if [ -f /etc/aria/aria.env ]; then
  for name in ARIA_GITHUB_WEBHOOK_SECRET ARIA_ALERTMANAGER_BEARER ARIA_OPERATOR_BEARER ARIA_GATEWAY_ACTOR_ALLOWLIST; do
    if grep -q "^${name}=" /etc/aria/aria.env; then ok "aria.env carries $name"; else bad "aria.env lacks $name (gateway refuses that ingress)"; fi
  done
else
  bad "/etc/aria/aria.env missing (mode 0600, owner gharunner; names only are checked here)"
fi
if [ "$DRY_RUN" -eq 0 ]; then
  systemctl daemon-reload && systemctl enable --now aria-telemetry.timer aria-gateway.service && ok "gateway + telemetry timer enabled"
fi

printf '\n'
if [ "$DRIFT" -ne 0 ]; then echo "DRIFT: the gateway and telemetry units do not match the repository (see ✗ above)"; exit 1; fi
echo "OK: gateway and telemetry units match the repository"
