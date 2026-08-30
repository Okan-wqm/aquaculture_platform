# Runbook — T0 runtime supervisor

`tools/supervisor/runtime-supervisor.ts`, run by `aqua-supervisor.timer`
every two minutes on the droplet.

## What it is for

Docker's restart policy is a retry, not a supervisor: it gives up, and when
it gives up nobody is told. Two incidents came from that gap.

- **2026-08-03** — six containers exited on a full disk at 02:07 and the
  `docker ps` text listing kept printing "Up 2 weeks" for two days. The
  listing reports the container record; `State.Running` reports reality.
- **2026-08-06** — `aqua-tenant-schema-provisioner` was found dead since
  2026-07-31. Its policy is `unless-stopped`, it died on a DNS failure,
  Docker stopped retrying, and nothing asked again for six days.

The supervisor keeps asking. Every two minutes it compares each container's
`State.Running` against the restart policy Docker itself was given, revives
what should be running, and reports what it could not fix.

## What it will and will not do

**Will:** start a container whose policy is `always` or `unless-stopped` and
which is not running; cap that at three attempts per container per hour;
report disk and swap pressure; write an evidence envelope and a Prometheus
textfile every pass.

**Will not:** touch a container whose policy is `no` — `aqua-db-migrate`
exits 0 when its work is done and is not a casualty. Delete images, prune
volumes, or free disk in any way: choosing what is safe to lose is a
judgement, and this process is deliberately too dumb to make it. Call any
network service, read the repository state, or invoke an LLM — it has to
work when the platform is down, which is the only time it matters.

## RuntimeSupervisorCannotRevive (critical)

One of three things:

1. **A supervised container will not start.** The envelope names it with the
   `docker start` error. Read the container's own logs first — the
   supervisor only knows that the start failed, not why.
2. **The restart cap is exhausted** (three attempts in an hour). This is a
   crash-loop. Restarting again is what the cap exists to prevent; find the
   cause. `docker inspect -f '{{.State.ExitCode}}'` plus the container logs
   from the last exit are the starting point.
3. **Disk at or above 92%.** This is the condition that produced the
   2026-08-03 outage. Reclaiming is manual and deliberate:

   ```bash
   docker system df                 # what is actually large
   docker image ls --filter dangling=true
   ```

   Check what an image is before removing it — a locally built image that
   was never pushed cannot be pulled back.

## RuntimeSupervisorStale (high)

No pass in 15 minutes, which is seven missed turns.

```bash
systemctl status aqua-supervisor.timer
systemctl status aqua-supervisor.service
journalctl -u aqua-supervisor.service -n 50
```

A stale supervisor means container deaths go unnoticed again. Treat the gap
as unmonitored time.

## Installing or reinstalling

```bash
sudo cp infrastructure/supervisor/aqua-supervisor.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aqua-supervisor.timer
systemctl list-timers aqua-supervisor.timer
```

If the checkout is not at `/var/aqua-saas`, put `AQUA_REPO=/path/to/repo`
in `/etc/default/aqua-supervisor`.

## Reading a pass by hand

```bash
npm run supervisor:run          # prints the evidence envelope
journalctl -u aqua-supervisor.service --since '1 hour ago'
```

Exit code 3 means "found something CRITICAL it could not fix" — a result,
not a crash. The unit declares it a success status for exactly that reason,
so a real problem does not also look like a broken timer.
