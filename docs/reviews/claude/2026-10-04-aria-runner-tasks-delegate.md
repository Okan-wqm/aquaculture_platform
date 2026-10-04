# ARIA runner unit — task ceiling and cgroup delegation (2026-10-04)

Owner: claude (implementation), okan (review). Deadline 2026-10-18. Plan rev3.1 item 10 (SRE attack
R5).

## ARIA-MEDIUM-338

The self-hosted runner's drop-in (`scripts/aria/runner-habitat/systemd/actions-runner.limits.conf`)
caps CPU and memory but not tasks, and does not delegate its cgroup. Live on the droplet (`systemctl
show`): `TasksMax=38090` (the systemd default derived from the host PID limit) and `Delegate=no`.

- A job that forks without bound — the 2026-10-02 program session hit a fork bomb from a spec shim —
  can exhaust the PID space the production compose stack on the same host needs. CPU and memory are
  capped; tasks are not.
- Without delegation a job cannot put the test commands it runs (the planned red_today executor,
  K35-lite) into a child cgroup with their own `MemoryMax`/`TasksMax`, so a runaway test shares the
  runner job's cgroup and its OOM.

Measured during the 2026-10-04 observe burn-in: `pids.peak` 106, `pids.current` 41. A cycle that
spawns a Claude Code session plus `nx` tests stays well under 1,000 tasks.

Rule: every resource the runner job shares with the production stack has a cgroup ceiling, and the
job can confine its own children.

Fix: `TasksMax=4096` (about 40x the measured peak, about 1/9 of the host default) and `Delegate=yes`
in the same drop-in that `provision_runner.sh` installs and drift-checks byte for byte.

Rollout: the change takes effect only after `provision_runner.sh` apply mode installs the drop-in
and the runner is restarted (`systemctl daemon-reload && systemctl restart <runner unit>`).
Restarting cancels the running job, so the install happens between ARIA runs, not during the first
live run. Until it is installed, the drift check reports this file as drifted.
