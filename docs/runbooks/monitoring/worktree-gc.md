# Runbook — worktree collector alerts

Alerts from `infrastructure/monitoring/droplet/rules/65-host-maintenance.yml` about
`aqua-worktree-gc` (`tools/host-maintenance/worktree-gc.ts`). How the collector decides,
installs and is armed: [maintenance runbook](../maintenance/worktree-gc.md).

```bash
systemctl status aqua-worktree-gc.timer aqua-worktree-gc.service
journalctl -u aqua-worktree-gc.service --since today -o cat | tail -1 | jq '.fatal, .counts'
cat /var/lib/node_exporter/textfile/aqua_worktree_gc.prom
```

## WorktreeGcFailing (warning)

The last exit code has been non-zero for two passes.

- **1** — the pass could not run. `fatal.kind` in the summary line says why: `fetch_failed`
  (`git -C /var/aqua-saas fetch origin` by hand), `not_a_repo`, `no_base`,
  `worktree_list_failed`, `bad_config` (read `/etc/default/aqua-worktree-gc`).
- **3** — see WorktreeGcPartial.
- **4** — the unit skipped the pass: `/var/lib/aqua/deploy/checkout` does not carry the script.
  It runs once a deploy includes it.

## WorktreeGcPartial (warning)

A pass exited 3. Find the worktree:

```bash
journalctl -u aqua-worktree-gc.service --since today -o cat \
  | jq -c 'select(.decision=="remove_failed" or .reason=="remove_refused")'
```

`remove_refused` means git found new files at the last moment; the tree was moved back to its
original path and kept, which is the safe outcome. `remove_failed` names git's error; a tree
left in `.gc-quarantine` is judged again on the next pass.

## WorktreeGcStale (warning)

No pass has completed in three hours. Check that the timer is enabled and that the service is
not hanging (`TimeoutStartSec=30min`). Until it runs, merged worktrees accumulate on the
production disk.

## WorktreeGcNeverCompleted (warning)

The collector has a last-run stamp but no pass has ever completed: every pass since install or
deploy failed (exit 1) or was skipped because the deployed checkout lacks the script (exit 4).
Read `aqua_worktree_gc_last_exit_code` and follow WorktreeGcFailing.

## WorktreeGcUnarmed (warning)

Every pass for seven days has been a dry run. Read the last pass's `counts` and `attention`,
then either arm it (`WORKTREE_GC_ARMED=1` in `/etc/default/aqua-worktree-gc`) or disable the
timer; a collector that never removes anything only hides the disk problem.
