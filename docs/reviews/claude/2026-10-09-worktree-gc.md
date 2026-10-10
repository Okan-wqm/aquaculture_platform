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
  textfile (`aqua_worktree_gc_last_exit_code`, last run time, outcomes). Alert rules followed
  in the re-review round (MEDIUM-011).
- **MEDIUM-008** — prune re-lists the worktrees first and is skipped while a missing worktree
  lies outside the roots; a spec proves a vanished scratchpad worktree keeps its record.
- **LOW** — fake `/proc` cases for cwd and maps; a `core.bare=true` main checkout; other
  worktrees' symlinks into a candidate keep it (`symlink_target`); one journal line per
  worktree plus a summary that lists only removals and non-routine keeps.

Each new case was mutation-checked: reverting the rule it pins fails its test.

The first unarmed pass after these fixes removed nothing: the 15 previously removable
worktrees all held `aria-findings/`, `.aria-ci/` or `aria-tools/*.jsonl`. The ARIA owner then
decided (2026-10-09) that inside `<repo>/.worktrees` those three are disposable byproducts of
local runs and that canonical ARIA state lives elsewhere. They joined the allow-list for
`.worktrees` only, with two guards: `/root/aria-8b`, `/var/lib/aria*`, `/home/gharunner/**` and
any `.aria-state-store` path are hard exclusions, and an `aria-tools/` holding `state.git` or
`.aria-state-store`, or over 50 MB, keeps its worktree (`aria_store`).

### Infra re-review → fixes

A re-review of 8f7e46f7e blocked it again:

- **HIGH-009** — a refused removal was finished with `--force` on the next pass, and `du` ran
  between the final `/proc` scan and the move, so a session entering during `du` could lose its
  work. `du` now runs before the final re-check. When git refuses (not a timeout), the tree is
  moved back to its original path and kept (`remove_refused`, exit 3). A quarantine leftover
  gets `--force` only while its status shows nothing but ` D` lines and allow-listed caches and
  its HEAD, operation, refs and reflog checks pass; any other change keeps it.
- **MEDIUM-010** — a leftover whose `.git` file git had already deleted read as `missing` and
  waited for a global prune that this host skips. It is now `quarantine_stranded`: the
  collector deletes the directory (no symlink following, real path checked to be inside the
  quarantine) and removes git's admin directory for it by id.
- **MEDIUM-011** — `infrastructure/monitoring/droplet/rules/65-host-maintenance.yml` alerts on
  a non-zero exit for two passes, any exit 3, no completed pass in 3 h, and 7 days unarmed;
  `docs/runbooks/monitoring/worktree-gc.md` is their runbook. Every pass writes the textfile,
  including a bad-config pass (exit 1) and a pass the unit skips because the deployed checkout
  lacks the script (exit 4, written by the `ExecCondition`).

With the ARIA allow-list and these fixes, an unarmed pass on 2026-10-09 marked 6 worktrees
removable, about 1.3 GB.

### Final review, and the user's ARIA decision

- A removal that fails after git began deleting (EBUSY/EPERM, not a timeout) is no longer moved
  back: if `git status` in the quarantined tree shows ` D` lines it stays there for the leftover
  rules. Creating the quarantine is guarded, and the whole pass is wrapped so an unanticipated
  exception (ENOSPC) still prints a fatal summary and writes the textfile with exit 1.
  `WorktreeGcNeverCompleted` (absent success stamp while passes run) closes the alerting gap.
- The user decided on 2026-10-09: "ARIA'ya özgü yapılar silinmemeli" — ARIA-specific
  structures must never be deleted. That replaced the ARIA allow-list above (and the
  `aria-tools/secrets|memory|audit` carve-out an infra review had asked for) with an explicit
  keep rule, not an inference: a worktree on a branch with a segment starting `aria`, with `aria`
  in any directory name of its path, or holding an untracked or ignored file under
  `aria-findings`, `.aria-ci`, `aria-tools`, `aria-worktrees`, `.aria-state-store`, `state.git`,
  `.claude/agents/.dispatch-log.jsonl` or a top-level `aria-agent-outputs*` entry is kept
  (`kept_aria`), never removed or quarantined. Tracked, unmodified files under those paths are
  ARIA's committed code, preserved in git, and do not keep a worktree (a first version counted
  them and kept every checkout). The hard exclusions for canonical ARIA state stay.

### The user's second ARIA decision, 2026-10-10

Under the 2026-10-09 rule the collector freed nothing on this host: almost every merged agent
worktree is on a `fix/aria-*` or `train/aria-*` branch, and the name alone kept it. The user
then decided "bitmiş ARIA worktree'leri silinsin" — finished ARIA worktrees may be removed. The
name rule is gone; an ARIA-named worktree is judged by every other rule (current HEAD merged,
clean, idle, no process, no reflog-only commit, no git operation, no symlink dependents). ARIA's
own records still keep a worktree: any untracked or ignored file under an ARIA artifact path.

### Resolution of the two ARIA decisions, 2026-10-10: preserve, don't keep

The coordinator resolved the two decisions as "preserve, don't keep". A worktree that passes
every other rule but holds untracked or ignored ARIA records is removed only after exactly those
files are archived to `/var/lib/aqua/worktree-gc/archive/<day>/<dir>-<HEAD12>.tar.zst` with a
manifest (sizes, sha256), fsynced, and verified by extraction against the manifest; any failure
keeps the worktree (`archive_failed`). A real ARIA store (`state.git`, `.aria-state-store`,
aria-tools over 50 MB) is kept (`aria_store`) and never archived. The archive root is outside
the roots and ARIA state, and the tool never deletes it; retention is manual.

An infra review of the archive path (67fe1707a) then added: a re-check in quarantine (ARIA
records re-hashed against the manifest, `/proc` re-scanned; any change moves the tree back as
`changed_during_removal`); a 200 MB per-worktree cap (`aria_large`); a free-space floor of
twice the records plus 2 GiB (`low_space`); streamed hashing; `.partial` files renamed only
after verification, failed attempts deleted; the archive's own sha256 in the manifest; 0700
directories and 0600 files, set by the tool; `MemoryMax=1G` and `TasksMax=64` on the unit.

The final review (aa9c6593c) removed the unit's `UMask=0077`, which would also have made the
hourly `git fetch` write root-only packs and refs into the shared repository, and added the
quarantine re-check to the `--force` path for a leftover as well.

### Not done here

- The units are not installed on the droplet; installation is the runbook's first dry-run
  pass, an operator step.
- Dirty, ignored-content and unmerged worktrees are reported, not resolved. They are owned
  work.
