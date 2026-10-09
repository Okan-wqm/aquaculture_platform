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

## What it removes

A worktree is removed only when every one of these holds:

1. It lies strictly under an allow-listed root (default `<repo>/.worktrees` and `/root/wt`).
2. It is not the main checkout, not under `/var/lib/aqua/deploy` (deploy checkout and rollback
   worktrees; this guard cannot be configured away), and not `locked`.
3. It contains no other worktree.
4. Its HEAD is an ancestor of `origin/main`, after a `git fetch origin --prune` that succeeded.
5. `git status --porcelain --untracked-files=all` is empty. Ignored files such as
   `node_modules` do not count.
6. Its HEAD reflog and its index have not changed for the grace period (default 6 h).
7. No process has its cwd, an open file, or a mapped file inside it (`/proc/*/cwd`, `fd`,
   `maps`).

Removal is `git worktree remove <path>` without `--force`, followed by `git worktree prune`.
Branches are never deleted, local or remote: a removed worktree can be re-created from its
branch with `git worktree add <path> <branch>`.

## What it keeps, and why

Every check that cannot be answered keeps the worktree. The summary names the reason.

| Reason               | Meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `merged_but_dirty`   | Merged, but holds uncommitted or untracked files: someone's work. |
| `unmerged`           | HEAD is not in `origin/main` (open PR, abandoned or squashed).    |
| `recently_active`    | HEAD reflog or index changed inside the grace period.             |
| `process_held`       | A live process has its cwd or a file inside it.                   |
| `proc_unreadable`    | `/proc` could not be read in full; nothing is removed.            |
| `locked`             | `git worktree lock` was used on it.                               |
| `outside_roots`      | Not under an allow-listed root (`/tmp` scratchpads, `/var/...`).  |
| `protected_path`     | Under `/var/lib/aqua/deploy` or `WORKTREE_GC_EXTRA_PROTECTED`.    |
| `contains_worktree`  | Another worktree lives inside it; collected on a later pass.      |
| `missing`            | git records it but the directory is gone (prune cleans it).       |
| `activity_unknown`   | Neither the reflog nor the index could be read.                   |
| `status_failed`      | `git status` failed (for example a dubious-ownership refusal).    |
| `merge_check_failed` | `git merge-base --is-ancestor` errored.                           |

The collector never resolves these. A `merged_but_dirty` worktree needs its owner: commit,
stash or discard, then the next pass collects it.

## Exit codes and the summary line

One JSON line per pass on stdout, schema `aqua/worktree-gc/v1`: `counts` (by decision and
kept-reason), `bytes_reclaimed_estimate`, `prune`, and one entry per worktree with
`decision`, `reason` and, where useful, `detail` and `bytes`.

- **0** — the pass completed.
- **3** — the pass completed but a removal or the prune failed. The failing worktree carries
  `decision: remove_failed` and git's message. The unit lists 3 in `SuccessExitStatus`, so a
  real result does not also look like a broken timer.
- **1** — the pass could not run (`fatal.kind`: `fetch_failed`, `not_a_repo`, `no_base`,
  `worktree_list_failed`, `bad_config`). Nothing was removed.

`bytes_reclaimed_estimate` is `du` of each removed worktree, measured before removal within a
time budget (`WORKTREE_GC_SIZE_BUDGET_SECONDS`, default 120). When the budget runs out the
unmeasured entries carry `bytes: null` and the total is `null`.

```bash
journalctl -u aqua-worktree-gc.service --since today -o cat | tail -1 | jq '.counts'
journalctl -u aqua-worktree-gc.service -o cat | tail -1 \
  | jq -r '.worktrees[] | select(.reason=="merged_but_dirty") | .path'
```

## Configuration

`/etc/default/aqua-worktree-gc` (all optional):

| Variable                          | Default                          |
| --------------------------------- | -------------------------------- |
| `AQUA_REPO`                       | `/var/aqua-saas`                 |
| `WORKTREE_GC_ROOTS`               | `<repo>/.worktrees:/root/wt`     |
| `WORKTREE_GC_GRACE_HOURS`         | `6` (values below 1 are refused) |
| `WORKTREE_GC_DRY_RUN`             | unset (`1` or `true` = dry run)  |
| `WORKTREE_GC_SIZE_BUDGET_SECONDS` | `120` (`0` = do not measure)     |
| `WORKTREE_GC_EXTRA_PROTECTED`     | unset (colon-separated paths)    |

`WORKTREE_GC_PROC_ROOT` exists for the test suite. Do not set it on a host.

Claude Code session worktrees live under `<repo>/.claude/worktrees`. They are not a default
root; add it to `WORKTREE_GC_ROOTS` only after confirming the same rules suit them.

## Installing or reinstalling

```bash
sudo cp infrastructure/host-maintenance/aqua-worktree-gc.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
# First pass by hand, in dry run, and read the decisions before enabling.
sudo WORKTREE_GC_DRY_RUN=1 systemctl start aqua-worktree-gc.service
journalctl -u aqua-worktree-gc.service -n 1 -o cat | jq '.counts'
sudo systemctl enable --now aqua-worktree-gc.timer
systemctl list-timers aqua-worktree-gc.timer
```

`systemctl start` does not pass the caller's environment; for a dry run through the unit put
`WORKTREE_GC_DRY_RUN=1` in `/etc/default/aqua-worktree-gc`, or run the script directly:

```bash
node --experimental-strip-types tools/host-maintenance/worktree-gc.ts --dry-run | jq '.counts'
```

## Unit hardening, and what it deliberately omits

The unit runs with `Nice=10` and `IOSchedulingClass=idle`, so it never competes with the
production containers, plus `NoNewPrivileges=yes` and `ProtectSystem=full`.

It does **not** use `ProtectHome=yes` or `PrivateTmp=yes`. The collector has to write under
`/var/aqua-saas` and `/root/wt`, and git's worktree records also point into `/root` and `/tmp`.
A mount namespace that hides `/root` or replaces `/tmp` makes those worktrees look deleted to
git, and `git worktree prune` would then destroy the records of worktrees other sessions are
using. The tool itself refuses to prune while a missing worktree lies outside its roots
(`prune: skipped_prunable_outside_roots`), but the unit must not create that situation.

## When the pass fails

**`fetch_failed`** — the host could not reach `origin`. Nothing is removed until it can.
`git -C /var/aqua-saas fetch origin` by hand shows why.

**`remove_failed`** — git refused, usually because the worktree became dirty between the check
and the removal, or it contains a submodule. Read `detail`; the next pass retries.

**Disk still tight after a pass** — read the kept list. Dirty and unmerged worktrees are owned
work and need their owners; the collector will not decide that for them.

## Known limits

- A process inside a container that bind-mounts a worktree shows its in-container path in
  `/proc`, so the hold is not seen. No container on the droplet mounts a worktree today.
- An agent that only reads files, with its cwd elsewhere, does not hold a worktree. After the
  grace period a clean, merged worktree it reads from can be removed; nothing unsaved is lost.
