#!/usr/bin/env bash
# ADR-0023 / K-2′ (ARIA-HIGH-281) — run the T2 boundary probe as the runner
# account. Run hourly by runner-habitat/systemd/aria-t2-probe.timer; safe to run
# by hand: `sudo -u gharunner scripts/aria/aria-t2-probe.sh` (exit 0 = held,
# 3 = breached; the JSON verdict names every violation, never a secret).
#
#   ARIA_REPO_ROOT            root-owned checkout the kernel and the anchor are
#                             read from (default: /var/lib/aria/code)
#   ARIA_RUNNER_ROOT          runner root (default: /home/gharunner/actions-runner)
#   ARIA_RUNNER_WORKSPACE     the runner's checkout, where cycle keys are minted
#   ARIA_T2_PROBE_TOOLS_DIR   the runner's store, whose signer registry names
#                             the keys ARIA's runner holds
#   ARIA_T2_PROBE_TEXTFILE    write the verdict for node-exporter (optional)
set -euo pipefail
repo="${ARIA_REPO_ROOT:-/var/lib/aria/code}"
runner_root="${ARIA_RUNNER_ROOT:-/home/gharunner/actions-runner}"
workspace="${ARIA_RUNNER_WORKSPACE:-$runner_root/_work/aquaculture_platform/aquaculture_platform}"
tools="${ARIA_T2_PROBE_TOOLS_DIR:-$workspace/.aria-state-store/tools}"
args=(--workspace-root "$repo" --tools-dir "$tools" --runner-env "$runner_root/.env"
      --key-dir "$HOME/.ssh" --key-dir "$workspace/aria-debts/keys")
if [ -n "${ARIA_T2_PROBE_TEXTFILE:-}" ]; then
  args+=(--textfile "$ARIA_T2_PROBE_TEXTFILE")
fi
cd "$repo"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$repo/aria-kernel" exec python3 -m aria_kernel habitat t2-probe "${args[@]}"
