#!/usr/bin/env bash
# WHY: "runs independently in Docker" has to be a measured fact, not a claim.
# WHAT: the same three kernel steps the aria-kernel CI lane runs against a
# real checkout — bootstrap the tools root, run committed-mode discovery over a
# git workspace, verify every ledger/index hash chain — executed inside the
# container against either the mounted /workspace or, when that is not a git
# repository, a throwaway git repository built from this tree.
set -euo pipefail

ARIA_HOME="${ARIA_HOME:-/opt/new-aria}"
WORKSPACE="${ARIA_WORKSPACE_ROOT:-/workspace}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TOOLS_DIR="${SMOKE_TOOLS_DIR:-$(mktemp -d /tmp/aria-smoke-tools.XXXXXX)}"
WORKSPACE_BASE="$(mktemp -d /tmp/aria-smoke-workspaces.XXXXXX)"

if ! git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # No repository mounted: observe this very tree as a fresh git repository.
  WORKSPACE="$(mktemp -d /tmp/aria-smoke-workspace.XXXXXX)"
  tar -C "$ARIA_HOME" --exclude=node_modules --exclude=.git -cf - . | tar -C "$WORKSPACE" -xf -
  git -C "$WORKSPACE" init -q
  git -C "$WORKSPACE" -c user.name=aria-smoke -c user.email=aria-smoke@localhost add -A
  git -C "$WORKSPACE" -c user.name=aria-smoke -c user.email=aria-smoke@localhost commit -q -m "aria smoke workspace ${STAMP}"
fi
HEAD_SHA="$(git -C "$WORKSPACE" rev-parse HEAD)"

echo "smoke: workspace=${WORKSPACE} head=${HEAD_SHA} tools=${TOOLS_DIR}"

"$ARIA_HOME/bin/aria" integrity migrate-tools-bootstrap \
  --tools-dir "$TOOLS_DIR" \
  --workspace-root "$WORKSPACE" \
  --acknowledge \
  --reason "docker smoke bootstrap ${STAMP}"

"$ARIA_HOME/bin/aria" discovery run \
  --workspace-root "$WORKSPACE" \
  --workspace-base "$WORKSPACE_BASE" \
  --tools-dir "$TOOLS_DIR" \
  --cycle-id "docker-smoke-${STAMP}" \
  --snapshot-mode committed

"$ARIA_HOME/bin/aria" integrity verify \
  --workspace-root "$WORKSPACE" \
  --workspace-base "$WORKSPACE_BASE" \
  --tools-dir "$TOOLS_DIR"

echo "smoke: ok (bootstrap -> discovery -> integrity verify) tools=${TOOLS_DIR}"
