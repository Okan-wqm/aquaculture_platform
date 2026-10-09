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
- Removal is `git worktree remove` without `--force` (after a move into quarantine);
  branches are never deleted.
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
--porcelain -z` (including `bare`, `detached`, `locked`, `prunable`). The inventory audit
  moved from `tools/worktree-audit` (ts-node CommonJS) to `tools/host-maintenance/
worktree-audit.ts` (ESM, same strip-types runner, same Nx project, so the shared import does
  not cross a project boundary) and uses it instead of its own copy. Its inventory output is
  byte-identical on a fixture, and its spec now runs in `tools:test`, which takes it off the
  `KNOWN_UNRUNNABLE_SPECS` ratchet.
- Runbook: `docs/runbooks/maintenance/worktree-gc.md`.

### Independent review → fixes

An independent infra review of e237adbe3 blocked it. Each item and its fix:

- **HIGH-001** — `git worktree remove` deletes ignored files, and `git status` without
  `--ignored` never saw them (`.full-review/state.json`, `aria-tools/*.jsonl`,
  `aria-findings/` sit in most worktrees). Status now runs with `--ignored=matching`; any
  ignored path outside a named cache allow-list (`node_modules`, `.nx`, `dist`, `out-tsc`,
  `coverage`, `target`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.turbo`,
  `*.pyc`, `*.tsbuildinfo`, `.eslintcache`) keeps the worktree as `ignored_content`.
- **HIGH-002** — the runbook's `WORKTREE_GC_DRY_RUN=1 systemctl start` dry run would have
  deleted, because systemctl passes no environment. The collector is now unarmed by default
  and removes nothing unless `/etc/default/aqua-worktree-gc` sets `WORKTREE_GC_ARMED=1`.
- **MEDIUM-003** — removals are capped per pass, stop 60 s before a 20 min pass budget, carry
  a timeout, and go through `<root>/.gc-quarantine/` first; the next pass finishes a leftover
  with `--force` and repairs a tree whose move was interrupted.
- **MEDIUM-004** — every check, plus a fresh `/proc` scan, re-runs per candidate immediately
  before it is moved.
- **MEDIUM-005** — a reflog commit no branch, tag or remote holds, an unfinished
  rebase/merge/cherry-pick/revert/bisect, or `refs/worktree/*` keeps the worktree.
- **MEDIUM-006** — the unit runs the script from the deploy checkout (deployed SHA) and skips
  with a message, without failing, until a deploy carries it.
- **MEDIUM-007** — `HOME=/root` for the gh credential helper; every pass writes a node-exporter
  textfile (`aqua_worktree_gc_last_exit_code`, last run time, outcomes). No alert rule yet: a
  rule's `runbook_url` must point under `docs/runbooks/monitoring/`, and this runbook lives
  under `maintenance/`.
- **MEDIUM-008** — prune re-lists the worktrees first and is skipped while a missing worktree
  lies outside the roots; a spec proves a vanished scratchpad worktree keeps its record.
- **LOW** — fake `/proc` cases for cwd and maps; a `core.bare=true` main checkout; other
  worktrees' symlinks into a candidate keep it (`symlink_target`); one journal line per
  worktree plus a summary that lists only removals and non-routine keeps.

Each new case was mutation-checked: reverting the rule it pins fails its test.

The first unarmed pass on the droplet after these fixes (2026-10-09) removes nothing: the 15
worktrees that were removable before now all hold `aria-findings/`, `.aria-ci/` or
`aria-tools/*.jsonl`. Whether any of those are regenerable is the owner's call; until one is
added to the allow-list deliberately, they keep their worktrees.

### Not done here

- The units are not installed on the droplet; installation is the runbook's first dry-run
  pass, an operator step.
- Dirty, ignored-content and unmerged worktrees (24, 15 and 70 in the post-review dry run)
  are reported, not resolved. They are owned work.
