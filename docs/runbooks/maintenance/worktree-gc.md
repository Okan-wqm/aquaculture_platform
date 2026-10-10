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
   worktrees), not canonical ARIA state (`/root/aria-8b`, `/var/lib/aria*`,
   `/home/gharunner/**`, or any path through a `.aria-state-store` directory), and not
   `locked`. The deploy and ARIA guards are hard-coded; no root setting widens past them.
3. It is not a real ARIA store (`aria_store`): no `.aria-state-store` or `state.git` at the top
   level or under the ARIA paths, and an `aria-tools/` of at most 50 MB.
4. It contains no other worktree.
5. Its HEAD is an ancestor of `origin/main`, after a `git fetch origin --prune` that succeeded.
6. Its HEAD reflog and its index have not changed for the grace period (default 6 h).
7. No rebase, merge, cherry-pick, revert or bisect is half done, and it has no per-worktree
   refs (`refs/worktree/*`, `refs/bisect/*`).
8. `git status --porcelain --ignored=matching --untracked-files=all` shows no tracked change and
   no untracked file, and every ignored path is a rebuildable cache: a path through
   `node_modules`, `.nx`, `dist`, `out-tsc`, `coverage`, `target`, `__pycache__`,
   `.pytest_cache`, `.mypy_cache`, `.ruff_cache` or `.turbo`, or a `*.pyc`, `*.tsbuildinfo` or
   `.eslintcache` file. Any other ignored content — review state, local evidence, keys — is
   somebody's data and keeps the worktree.
9. Its HEAD reflog reaches no commit that no branch, tag or remote-tracking ref holds (work
   that was committed and then reset away). Reflogs longer than 2000 entries keep the worktree.
10. No process has its cwd, an open file, or a mapped file inside it (`/proc/*/cwd`, `fd`,
    `maps`).
11. No other worktree's top-level symlinks or npm-workspace `node_modules` links point into it.

## ARIA records: preserve, don't keep

Two user decisions apply. 2026-10-09: "ARIA'ya özgü yapılar silinmemeli" — ARIA's structures
must not be deleted. 2026-10-10: "bitmiş ARIA worktree'leri silinsin" — finished ARIA worktrees
should be deleted. The resolution (2026-10-10): an ARIA branch or directory name keeps nothing;
a worktree that passes every other rule but holds untracked or ignored files under
`aria-findings/`, `.aria-ci/`, `aria-tools/`, `aria-worktrees/`, `aria-agent-outputs*/` or
`.claude/agents/.dispatch-log.jsonl` has exactly those files archived first, to
`/var/lib/aqua/worktree-gc/archive/<YYYY-MM-DD>/<worktree-dir>-<HEAD12>.tar.zst` (`.tar.gz` when
`zstd` is missing), with a `.manifest.json` beside it (worktree path, branch, HEAD, every file
with size and sha256, created_at). Symlinks are stored, not followed. The archive is fsynced,
extracted again and compared with the manifest entry by entry before anything is removed; any
failure keeps the worktree (`archive_failed`, exit 3). The worktree is then removed as
`removed_with_archive`, and the journal line names the archive. Tracked, unmodified files under
those paths are ARIA's committed code, preserved in git, and are not archived.

Safeguards around the archive:

- Records over 200 MB per worktree (`WORKTREE_GC_ARIA_MAX_BYTES`) keep the worktree unarchived
  (`aria_large`); the archive filesystem must have twice the records' size plus 2 GiB free
  (`WORKTREE_GC_ARCHIVE_RESERVE_BYTES`), else `low_space` (exit 3).
- The archive is written as `<name>.partial` and renamed only after it verified; a failed
  attempt's `.partial` is deleted, so every file without that suffix is an archive of record.
  The manifest records the archive's own sha256.
- Directories are 0700, archives and manifests 0600 (the unit also sets `UMask=0077`): ARIA
  records may include key material.
- After the move into quarantine the ARIA records are hashed again against the manifest and
  `/proc` is scanned again; any difference moves the tree back (`changed_during_removal`), so a
  ledger appended to after the archive is never lost.

The collector never deletes an archive of record. Retention is manual: review and delete old
day directories by hand once their contents are no longer needed.

Every check runs once for the report and again for each candidate immediately before it is
touched. Its size is measured (`du`) before that final re-check, so nothing slow sits between
the re-check and the move. The candidate is then moved with `git worktree move` into
`<root>/.gc-quarantine/<time>-<name>` and removed with `git worktree remove` (no `--force`).
If git refuses — something appeared in the tree after the re-check — the tree is moved back to
its original path and kept (`remove_refused`, exit 3).
Branches are never deleted, local or remote: a removed worktree can be re-created from its
branch with `git worktree add <path> <branch>`.

## Interrupted removals and pass limits

A pass starts at most `WORKTREE_GC_MAX_REMOVALS` removals (default 20) and starts none with
less than 60 s left of `WORKTREE_GC_PASS_BUDGET_SECONDS` (default 1200, under the unit's
30 min timeout). Each `git worktree remove` has its own timeout.

A tree a pass leaves in `.gc-quarantine` — a removal that timed out or was killed — is judged
again by the next pass. It is finished with `git worktree remove --force` only while its HEAD is
still merged, no operation or per-worktree ref appeared, `git status` shows nothing but deleted
tracked files (` D`, what an interrupted removal leaves) and allow-listed caches, and no
reflog-only commit exists. Anything else — an untracked file, an edit, a new commit — keeps it
as somebody's work.

A tree in quarantine without its `.git` file (git deleted it before the removal was killed) is
`quarantine_stranded`: git can no longer remove it, and the global prune is often skipped on
this host, so the collector deletes the directory itself — without following symlinks, and only
when its real path is inside the quarantine — and removes git's record of it by id. A tree
that git has no record of but that still has its `.git` file (a move killed between the rename
and git's bookkeeping) is `quarantine_orphan`: an armed pass runs `git worktree repair` and the
next pass judges it as above.

## What it keeps, and why

Every check that cannot be answered keeps the worktree. Each worktree's line names the reason.

| Reason                   | Meaning                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| `merged_but_dirty`       | Merged, but holds uncommitted or untracked files: someone's work.     |
| `ignored_content`        | Ignored files that are not rebuildable caches; `detail` names them.   |
| `aria_store`             | A real ARIA store (`state.git`, `.aria-state-store`, over 50 MB).     |
| `archive_failed`         | ARIA records not archived and verified; nothing removed.              |
| `aria_large`             | ARIA records over the per-worktree cap; not archived, kept.           |
| `low_space`              | Too little free space on the archive filesystem; kept.                |
| `changed_during_removal` | Changed after the archive or final check; moved back, kept.           |
| `unreachable_reflog`     | The reflog holds a commit nothing else does.                          |
| `operation_in_progress`  | A rebase, merge, cherry-pick, revert or bisect is unfinished.         |
| `worktree_refs`          | It has refs of its own under `refs/worktree/` or `refs/bisect/`.      |
| `symlink_target`         | Another worktree links into it (shared `node_modules`).               |
| `unmerged`               | HEAD is not in `origin/main` (open PR, abandoned or squashed).        |
| `recently_active`        | HEAD reflog or index changed inside the grace period.                 |
| `process_held`           | A live process has its cwd or a file inside it.                       |
| `proc_unreadable`        | `/proc` could not be read in full; nothing is removed.                |
| `locked`                 | `git worktree lock` was used on it.                                   |
| `outside_roots`          | Not under an allow-listed root (`/tmp` scratchpads, `/var/...`).      |
| `protected_path`         | Deploy state, canonical ARIA state, or `WORKTREE_GC_EXTRA_PROTECTED`. |
| `contains_worktree`      | Another worktree lives inside it; collected on a later pass.          |
| `missing`                | git records it but the directory is gone (prune cleans it).           |
| `pass_cap`               | Eligible, but this pass reached its removal cap.                      |
| `pass_budget`            | Eligible, but this pass had too little time left.                     |
| `remove_refused`         | git refused the removal; moved back to its original path.             |
| `quarantine_orphan`      | An interrupted move; repaired now, judged on the next pass.           |
| `activity_unknown`       | Neither the reflog nor the index could be read.                       |
| `status_failed`          | `git status` failed (for example a dubious-ownership refusal).        |
| `merge_check_failed`     | HEAD could not be read or `git merge-base --is-ancestor` errored.     |
| `ref_check_failed`       | The reflog or per-worktree refs could not be read.                    |

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
- **3** — the pass completed but a removal was refused (`remove_refused`) or failed
  (`decision: remove_failed`), or the prune failed; the line carries git's message. The unit
  lists 3 in `SuccessExitStatus`, so a real result does not also look like a broken timer.
- **1** — the pass could not run (`fatal.kind`: `fetch_failed`, `not_a_repo`, `no_base`,
  `worktree_list_failed`, `bad_config`). Nothing was removed. The unit fails and shows in
  `systemctl --failed`.

Every pass — armed, unarmed, or refused for bad configuration — writes
`/var/lib/node_exporter/textfile/aqua_worktree_gc.prom`: `_last_run_timestamp_seconds`,
`_last_exit_code`, `_armed`, `aqua_worktree_gc_worktrees{outcome=...}`,
`_bytes_reclaimed_estimate`, `_last_success_timestamp_seconds` (carried from pass to pass) and,
while unarmed, `_unarmed_since_timestamp_seconds`. When the deployed checkout lacks the
script, the unit's `ExecCondition` writes exit code 4. The droplet's node exporter collects the
file; `infrastructure/monitoring/droplet/rules/65-host-maintenance.yml` alerts on it
(`WorktreeGcFailing`, `WorktreeGcPartial`, `WorktreeGcStale`, `WorktreeGcUnarmed`), with the
response in [the alert runbook](../monitoring/worktree-gc.md).

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
| `WORKTREE_GC_ARCHIVE_ROOT`        | `/var/lib/aqua/worktree-gc/archive`  |

`WORKTREE_GC_PROC_ROOT`, `AQUA_GIT_BIN` and `WORKTREE_GC_TAR_BIN` exist for the test suite. Do
not set them on a host. The archive root may not overlap a collection root, the deploy tree or
ARIA's canonical state; such a configuration is refused.

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

**`remove_refused`** — git found new content at the last moment; the tree is back where it
was. Nothing to do unless it repeats.

**`remove_failed`** — read `detail`. A tree left in `.gc-quarantine` is judged again on the
next pass.

**Disk still tight after a pass** — read `attention`. Dirty, ignored-content and unmerged
worktrees are owned work and need their owners; the collector will not decide that for them.

## Known limits

- A process inside a container that bind-mounts a worktree shows its in-container path in
  `/proc`, so the hold is not seen. No container on the droplet mounts a worktree today.
- An agent that only reads files, with its cwd elsewhere, does not hold a worktree. After the
  grace period a clean, merged worktree it reads from can be removed. Nothing unsaved is lost:
  every ignored file that is not a rebuildable cache keeps the worktree.
