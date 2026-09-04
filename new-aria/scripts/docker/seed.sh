#!/usr/bin/env bash
# WHY: a console over an empty tools root shows nothing; the kernel must have
# observed a workspace at least once. This is the same bootstrap + cycle the
# aria-kernel CI lane performs, pointed at the durable /data volume.
# WHAT: (1) bootstrap /data/aria-tools if it is not bound yet, (2) resolve the
# workspace (mounted git repo, or a throwaway git repo built from this tree),
# (3) run one full kernel cycle, (4) verify every ledger chain.
set -euo pipefail

ARIA_HOME="${ARIA_HOME:-/opt/new-aria}"
TOOLS_DIR="${ARIA_TOOLS_DIR:-/data/aria-tools}"
WORKSPACE_BASE="${ARIA_WORKSPACE_BASE:-/data/workspaces}"
WORKSPACE="${ARIA_WORKSPACE_ROOT:-/workspace}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$TOOLS_DIR" "$WORKSPACE_BASE"

if ! git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # A bind mount of a sub-folder has no .git of its own: observe a committed
  # copy of the tree under /data so the snapshot mode can stay `committed`.
  WORKSPACE="/data/seed-workspace"
  if [ ! -d "$WORKSPACE/.git" ]; then
    mkdir -p "$WORKSPACE"
    tar -C "$ARIA_HOME" --exclude=node_modules --exclude=.git -cf - . | tar -C "$WORKSPACE" -xf -
    git -C "$WORKSPACE" init -q
    git -C "$WORKSPACE" -c user.name=aria-seed -c user.email=aria-seed@localhost add -A
    git -C "$WORKSPACE" -c user.name=aria-seed -c user.email=aria-seed@localhost commit -q -m "aria seed workspace ${STAMP}"
  fi
  # The kernel runs TypeScript adapters with cwd = the workspace and, by design,
  # only accepts a REPO-LOCAL node_modules/ts-node (tool_runner
  # _runner_missing_node_deps); a global install does not count. The image
  # already carries the exact pinned toolchain, so the throwaway workspace
  # borrows it. Untracked + gitignored, so the snapshot never sees it.
  [ -e "$WORKSPACE/node_modules" ] || ln -s "$ARIA_HOME/node_modules" "$WORKSPACE/node_modules"
fi

if [ ! -f "$TOOLS_DIR/repo_identity.json" ]; then
  "$ARIA_HOME/bin/aria" integrity migrate-tools-bootstrap \
    --tools-dir "$TOOLS_DIR" \
    --workspace-root "$WORKSPACE" \
    --acknowledge \
    --reason "docker seed bootstrap of the durable tools root ${STAMP}"
fi

echo "seed: workspace=${WORKSPACE} head=$(git -C "$WORKSPACE" rev-parse HEAD) tools=${TOOLS_DIR}"

if [ ! -e "$WORKSPACE/node_modules/ts-node/dist/bin.js" ]; then
  echo "WARN: $WORKSPACE has no node_modules/ts-node — every TypeScript adapter will report environment_unavailable until 'npm install' runs in that workspace" >&2
fi
"$ARIA_HOME/bin/aria" cycle run \
  --cycle-id "seed-${STAMP}" \
  --workspace-root "$WORKSPACE" \
  --workspace-base "$WORKSPACE_BASE" \
  --tools-dir "$TOOLS_DIR" > "$TOOLS_DIR/seed-${STAMP}.cycle.json" || echo "seed: cycle run exited non-zero (ledgers written; see $TOOLS_DIR/seed-${STAMP}.cycle.json)"

"$ARIA_HOME/bin/aria" integrity verify \
  --workspace-root "$WORKSPACE" \
  --workspace-base "$WORKSPACE_BASE" \
  --tools-dir "$TOOLS_DIR" > "$TOOLS_DIR/seed-${STAMP}.verify.json"
python3 - "$TOOLS_DIR/seed-${STAMP}.verify.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
print("seed: integrity valid =", v.get("valid"), "| errors =", len(v.get("errors") or []))
raise SystemExit(0 if v.get("valid") else 2)
PY
# Legal pack demo: when the pack ships its inventory adapter, run it once over
# the synthetic fixture archive so the console shows a case. Same stdin/stdout
# contract as every ARIA adapter; artifacts land under the durable tools root.
LEGAL_ADAPTER="$ARIA_HOME/packs/legal/adapters/legal-document-inventory.ts"
LEGAL_FIXTURE="$ARIA_HOME/packs/legal/fixtures/case-synthetic"
if [ -f "$LEGAL_ADAPTER" ] && [ -d "$LEGAL_FIXTURE" ]; then
  (cd "$ARIA_HOME" && printf '{"archive_root":"%s","case_id":"demo-synthetic","title":"Sentetik demo davası","exclude_roots":["Ikke laste opp"],"out_dir":"%s"}' "$LEGAL_FIXTURE" "$TOOLS_DIR" \
    | npx ts-node --project tools/gates/tsconfig.json "$LEGAL_ADAPTER" > "$TOOLS_DIR/seed-${STAMP}.legal.json") \
    && echo "seed: legal demo case written under $TOOLS_DIR/packs/legal/cases/case_demo-synthetic" \
    || echo "seed: legal adapter run exited non-zero (see $TOOLS_DIR/seed-${STAMP}.legal.json)"
fi
echo "seed: ok"
