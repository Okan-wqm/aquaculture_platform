# Merged development worktrees on the production droplet, 2026-10-09

The development deploy's capacity preflight refused to deploy on 2026-10-09. The droplet is
both the production host and the development/agent box, and the root filesystem had been
filled by git worktrees that agent sessions left behind after their PRs merged.

## INFRA-HIGH-208 — merged development worktrees fill the droplet and block deploys

- `scripts/deploy/droplet-capacity.sh:61` and `:66` set the full-deploy floor at 35 GiB and
  20 % free; `:1030`, `:1038` and `:1043` refuse the deploy when free bytes, free percent or
  free space minus projected pulls fall below it.
- About 150 worktrees are registered against `/var/aqua-saas`, 108 of them under
  `.worktrees`. One with its own `npm ci` carries about 2 GB of `node_modules`.
- Nothing collects them. `safe_tmp_gc` (`droplet-capacity.sh:1434`) states that it never
  touches git worktrees, and the runtime supervisor only reports disk pressure.
- Rated HIGH rather than CRITICAL: the failure stops deploys; the running production stack
  keeps serving.

### Fix

- `tools/host-maintenance/worktree-gc.ts`, run hourly by `aqua-worktree-gc.timer`
  (`infrastructure/host-maintenance/`). It removes a worktree only when it is under an
  allow-listed root, not locked, not the main checkout, not under `/var/lib/aqua/deploy`,
  contains no other worktree, is merged into a freshly fetched `origin/main`, has a clean
  `git status`, is held by no process (`/proc` cwd, fd and maps), and has been idle for the
  grace period. Every unanswerable check keeps the worktree; a failed fetch removes nothing.
- Removal is `git worktree remove` without `--force`; branches are never deleted.
- `git status` runs with optional locks off, so the collector's own check cannot refresh the
  index and make a worktree look active on every later pass. The spec pins this.
- The unit omits `ProtectHome` and `PrivateTmp`: a namespace that hides `/root` or `/tmp`
  would make other sessions' worktrees look deleted, and `git worktree prune` would destroy
  their records. The tool also refuses to prune while a missing worktree lies outside its
  roots.
- `tools/host-maintenance/worktree-gc.spec.ts` runs the script against real throwaway git
  repositories. It is reached through `npm run tools:test` in `quality-gates.yml`, and
  `tests/invariants/helpers/spec-runners.ts` declares the directory as that runner's.
- `tools/host-maintenance/worktree-list.ts` is the one parser of `git worktree list
--porcelain -z` (including `bare`, `detached`, `locked`, `prunable`). `tools/worktree-audit`
  moved to ESM under the same strip-types runner and uses it instead of its own copy; its
  inventory output is byte-identical on a fixture, and its spec now runs in `tools:test`,
  which takes it off the `KNOWN_UNRUNNABLE_SPECS` ratchet.
- Runbook: `docs/runbooks/maintenance/worktree-gc.md`.

### Not done here

- The units are not installed on the droplet; installation is the runbook's first dry-run
  pass, an operator step.
- Dirty and unmerged worktrees (24 and 69 in the 2026-10-09 dry run) are reported, not
  resolved. They are owned work.
