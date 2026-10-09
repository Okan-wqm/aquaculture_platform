# Runbook — git-worktree garbage collector

`tools/host-maintenance/worktree-gc.ts`, run by `aqua-worktree-gc.timer` hourly on the droplet.
Finding: INFRA-HIGH-208.

## Why it exists

The droplet is both the production host and the development/agent box. Every agent session
that lands a PR leaves a git worktree behind, and one with its own `npm ci` carries about 2 GB
of `node_modules`. On 2026-10-09 merged worktrees under `/var/aqua-saas/.worktrees` and
`/root/wt` had taken enough of the root filesystem that the development deploy's capacity
preflight (`scripts/deploy/droplet-capacity.sh`, `capacity_failures`: at least 35 GiB and
20 % free, and free space minus projected image pulls above the reserve) refused to deploy.
Cleanup depended on someone remembering it. The collector makes it the default.

## Armed and unarmed passes

The collector removes nothing unless `/etc/default/aqua-worktree-gc` contains
`WORKTREE_GC_ARMED=1`. Without it every pass is a dry run: same checks, same decisions,
reported as `would_remove`, nothing touched, no prune. `--dry-run` forces the same on an armed
host. Arming is a deliberate operator step, taken after reading at least one unarmed pass.

## What it removes

A worktree is removed only when every one of these holds:

1. It lies strictly under an allow-listed root (default `<repo>/.worktrees` and `/root/wt`).
2. It is not the main checkout, not under `/var/lib/aqua/deploy` (deploy checkout and rollback
   worktrees; this guard cannot be configured away), and not `locked`.
3. It contains no other worktree.
4. Its HEAD is an ancestor of `origin/main`, after a `git fetch origin --prune` that succeeded.
5. Its HEAD reflog and its index have not changed for the grace period (default 6 h).
6. No rebase, merge, cherry-pick, revert or bisect is half done, and it has no per-worktree
   refs (`refs/worktree/*`, `refs/bisect/*`).
7. `git status --porcelain --ignored=matching --untracked-files=all` shows no tracked change and
   no untracked file, and every ignored path is a rebuildable cache: a path through
   `node_modules`, `.nx`, `dist`, `out-tsc`, `coverage`, `target`, `__pycache__`,
   `.pytest_cache`, `.mypy_cache`, `.ruff_cache` or `.turbo`, or a `*.pyc`, `*.tsbuildinfo` or
   `.eslintcache` file. Any other ignored content — review state, ARIA ledgers, local evidence,
   keys — is somebody's data and keeps the worktree.
8. Its HEAD reflog reaches no commit that no branch, tag or remote-tracking ref holds (work
   that was committed and then reset away). Reflogs longer than 2000 entries keep the worktree.
9. No process has its cwd, an open file, or a mapped file inside it (`/proc/*/cwd`, `fd`,
   `maps`).
10. No other worktree's top-level symlinks or npm-workspace `node_modules` links point into it.

Every check runs once for the report and again for each candidate immediately before it is
touched. A candidate is then moved with `git worktree move` into
`<root>/.gc-quarantine/<time>-<name>` and removed with `git worktree remove` (no `--force`).
Branches are never deleted, local or remote: a removed worktree can be re-created from its
branch with `git worktree add <path> <branch>`.

## Interrupted removals and pass limits

A pass starts at most `WORKTREE_GC_MAX_REMOVALS` removals (default 20) and starts none with
less than 60 s left of `WORKTREE_GC_PASS_BUDGET_SECONDS` (default 1200, under the unit's
30 min timeout). Each `git worktree remove` has its own timeout.

Whatever a pass leaves in `.gc-quarantine` — a removal that was refused, timed out or killed —
is finished by the next pass with `git worktree remove --force`. Only this tool moves trees
there, and only after every check passed, so a half-deleted tree in quarantine is never
mistaken for somebody's dirty work. A tree in quarantine that git has no record of (a move
killed between the rename and git's bookkeeping) is reported `quarantine_orphan`; an armed pass
runs `git worktree repair` on it and the pass after removes it.

## What it keeps, and why

Every check that cannot be answered keeps the worktree. Each worktree's line names the reason.

| Reason                  | Meaning                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `merged_but_dirty`      | Merged, but holds uncommitted or untracked files: someone's work.   |
| `ignored_content`       | Ignored files that are not rebuildable caches; `detail` names them. |
| `unreachable_reflog`    | The reflog holds a commit nothing else does.                        |
| `operation_in_progress` | A rebase, merge, cherry-pick, revert or bisect is unfinished.       |
| `worktree_refs`         | It has refs of its own under `refs/worktree/` or `refs/bisect/`.    |
| `symlink_target`        | Another worktree links into it (shared `node_modules`).             |
| `unmerged`              | HEAD is not in `origin/main` (open PR, abandoned or squashed).      |
| `recently_active`       | HEAD reflog or index changed inside the grace period.               |
| `process_held`          | A live process has its cwd or a file inside it.                     |
| `proc_unreadable`       | `/proc` could not be read in full; nothing is removed.              |
| `locked`                | `git worktree lock` was used on it.                                 |
| `outside_roots`         | Not under an allow-listed root (`/tmp` scratchpads, `/var/...`).    |
| `protected_path`        | Under `/var/lib/aqua/deploy` or `WORKTREE_GC_EXTRA_PROTECTED`.      |
| `contains_worktree`     | Another worktree lives inside it; collected on a later pass.        |
| `missing`               | git records it but the directory is gone (prune cleans it).         |
| `pass_cap`              | Eligible, but this pass reached its removal cap.                    |
| `pass_budget`           | Eligible, but this pass had too little time left.                   |
| `quarantine_orphan`     | An interrupted move; repaired now, removed on the next pass.        |
| `activity_unknown`      | Neither the reflog nor the index could be read.                     |
| `status_failed`         | `git status` failed (for example a dubious-ownership refusal).      |
| `merge_check_failed`    | HEAD could not be read or `git merge-base --is-ancestor` errored.   |
| `ref_check_failed`      | The reflog or per-worktree refs could not be read.                  |

The collector never resolves these. A `merged_but_dirty` or `ignored_content` worktree needs
its owner: commit, move or delete the files, then the next pass collects it.

## Output, exit codes and alerting

Each pass writes one JSON line per worktree (schema `aqua/worktree-gc/worktree/v1`: `path`,
`decision`, `reason`, `detail`, `bytes`) and then one summary line (schema
`aqua/worktree-gc/v1`): `armed`, `dry_run`, `counts` by decision and kept reason,
`bytes_reclaimed_estimate`, `prune`, `removals`, and `attention` — every kept worktree whose
reason is not routine (routine: main checkout, outside roots, protected, unmerged, recently
active, locked). Every line stays far below journald's 48 KiB line limit.

- **0** — the pass completed.
- **3** — the pass completed but a removal or the prune failed. The worktree carries
  `decision: remove_failed` and git's message. The unit lists 3 in `SuccessExitStatus`, so a
  real result does not also look like a broken timer.
- **1** — the pass could not run (`fatal.kind`: `fetch_failed`, `not_a_repo`, `no_base`,
  `worktree_list_failed`, `bad_config`). Nothing was removed. The unit fails and shows in
  `systemctl --failed`.

Each pass also writes `/var/lib/node_exporter/textfile/aqua_worktree_gc.prom`
(`aqua_worktree_gc_last_run_timestamp_seconds`, `_last_exit_code`, `_armed`,
`aqua_worktree_gc_worktrees{outcome=...}`, `_bytes_reclaimed_estimate`), which the droplet's
node exporter already collects. No alert rule reads it yet. The useful expressions are
`aqua_worktree_gc_last_exit_code != 0` and
`time() - aqua_worktree_gc_last_run_timestamp_seconds > 3 * 3600`.

`bytes_reclaimed_estimate` is `du` of each removed worktree, measured before removal within a
time budget (`WORKTREE_GC_SIZE_BUDGET_SECONDS`, default 120). When the budget runs out the
unmeasured entries carry `bytes: null` and the total is `null`.

```bash
journalctl -u aqua-worktree-gc.service --since today -o cat | tail -1 | jq '.counts'
journalctl -u aqua-worktree-gc.service --since today -o cat | tail -1 | jq '.attention'
```

## Configuration

`/etc/default/aqua-worktree-gc` (all optional):

| Variable                          | Default                              |
| --------------------------------- | ------------------------------------ |
| `WORKTREE_GC_ARMED`               | unset: dry run (`1` arms it)         |
| `AQUA_REPO`                       | `/var/aqua-saas`                     |
| `WORKTREE_GC_ROOTS`               | `<repo>/.worktrees:/root/wt`         |
| `WORKTREE_GC_GRACE_HOURS`         | `6` (values below 1 are refused)     |
| `WORKTREE_GC_MAX_REMOVALS`        | `20` per pass                        |
| `WORKTREE_GC_PASS_BUDGET_SECONDS` | `1200`                               |
| `WORKTREE_GC_SIZE_BUDGET_SECONDS` | `120` (`0` = do not measure)         |
| `WORKTREE_GC_EXTRA_PROTECTED`     | unset (colon-separated paths)        |
| `WORKTREE_GC_TEXTFILE_PATH`       | node exporter textfile (empty = off) |

`WORKTREE_GC_PROC_ROOT` and `AQUA_GIT_BIN` exist for the test suite. Do not set them on a host.

Claude Code session worktrees live under `<repo>/.claude/worktrees`. They are not a default
root; add it to `WORKTREE_GC_ROOTS` only after confirming the same rules suit them.

## Which code the unit runs

`ExecStart` runs the script from `/var/lib/aqua/deploy/checkout`, the SHA the deploy pinned
from `main`, not from `/var/aqua-saas`. The shared checkout's HEAD is whatever an agent
session left there (on 2026-10-09 it was even configured `core.bare=true`), and a tool that
deletes directories must run reviewed, deployed code. Until a deploy carries the script, the
unit's `ExecCondition` skips the pass and logs why; the unit does not fail.

## Installing, the first pass, and arming

```bash
sudo cp infrastructure/host-maintenance/aqua-worktree-gc.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
# Unarmed: this pass only reports. Read the decisions before going further.
sudo systemctl start aqua-worktree-gc.service
journalctl -u aqua-worktree-gc.service -n 1 -o cat | jq '.counts, .attention'
sudo systemctl enable --now aqua-worktree-gc.timer
```

Arming is a separate decision, made once the unarmed passes look right:

```bash
echo 'WORKTREE_GC_ARMED=1' | sudo tee -a /etc/default/aqua-worktree-gc
```

A one-off dry run on an armed host, without editing the file:

```bash
sudo node --experimental-strip-types \
  /var/lib/aqua/deploy/checkout/tools/host-maintenance/worktree-gc.ts --dry-run | tail -1 | jq
```

`systemctl start` never passes the caller's environment, so `VAR=1 systemctl start` changes
nothing; use the file or the `--dry-run` command above.

## Unit hardening, and what it deliberately omits

The unit runs with `Nice=10` and `IOSchedulingClass=idle`, so it never competes with the
production containers, plus `NoNewPrivileges=yes` and `ProtectSystem=full`. `HOME=/root` is
set because `origin` authenticates through `gh auth git-credential`.

It does **not** use `ProtectHome=yes` or `PrivateTmp=yes`. The collector has to write under
`/var/aqua-saas` and `/root/wt`, and git's worktree records also point into `/root` and
`/tmp`. A mount namespace that hides `/root` or replaces `/tmp` makes those worktrees look
deleted to git, and `git worktree prune` would then destroy the records of worktrees other
sessions are using. The tool itself re-lists the worktrees right before pruning and refuses to
prune while a missing worktree lies outside its roots (`prune: skipped_prunable_outside_roots`),
but the unit must not create that situation. Prune stays because it clears the record of a
removal killed after git deleted the directory.

## When the pass fails

**`fetch_failed`** — the host could not reach `origin`. Nothing is removed until it can.
`git -C /var/aqua-saas fetch origin` by hand shows why.

**`remove_failed`** — git refused or timed out. The tree is in `.gc-quarantine`; read
`detail`, and the next pass finishes it.

**Disk still tight after a pass** — read `attention`. Dirty, ignored-content and unmerged
worktrees are owned work and need their owners; the collector will not decide that for them.

## Known limits

- A process inside a container that bind-mounts a worktree shows its in-container path in
  `/proc`, so the hold is not seen. No container on the droplet mounts a worktree today.
- An agent that only reads files, with its cwd elsewhere, does not hold a worktree. After the
  grace period a clean, merged worktree it reads from can be removed. Nothing unsaved is lost:
  every ignored file that is not a rebuildable cache keeps the worktree.
