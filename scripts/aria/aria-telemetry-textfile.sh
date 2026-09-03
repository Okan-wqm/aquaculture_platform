#!/usr/bin/env bash
# Plan 032 Faz 032e — export the ARIA store's Prometheus series into the
# node-exporter textfile collector directory. Run by
# infrastructure/aria/aria-telemetry.timer on the droplet; safe to run by hand.
#
#   ARIA_TOOLS_DIR      tools store root (default: <repo>/aria-tools)
#   ARIA_REPO_ROOT      checkout the kernel lives in (default: /var/aqua-saas)
#   ARIA_TEXTFILE_DIR   node-exporter --collector.textfile.directory
#                       (default: /var/lib/node_exporter/textfile_collector)
set -euo pipefail
repo="${ARIA_REPO_ROOT:-/var/aqua-saas}"
tools="${ARIA_TOOLS_DIR:-$repo/aria-tools}"
out_dir="${ARIA_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
mkdir -p "$out_dir"
tmp="$(mktemp "$out_dir/.aria.prom.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
(
  cd "$repo"
  PYTHONPATH="$repo/aria-kernel" python3 -m aria_kernel telemetry export \
    --format prometheus --workspace-root "$repo" --tools-dir "$tools" --output "$tmp"
)
# atomic replace: node-exporter never reads a half-written file
mv -f "$tmp" "$out_dir/aria.prom"
trap - EXIT
