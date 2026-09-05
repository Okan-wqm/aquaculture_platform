# Runbook — HostMemoryLow

**Alert:** `HostMemoryLow` (warning) · **Rule:**
`infrastructure/monitoring/droplet/rules/35-broker-jetstream.yml`

**Meaning.** Available memory dropped below 25% of physical RAM for 10 minutes (the envelope gate:
working set ≤ 75%). The droplet compose manifest already declares ~9.75GiB of memory limits on
7.8GiB physical — crossing this line means the kernel OOM-killer is choosing victims imminently.

**First actions:**

1. `free -m` and `docker stats --no-stream | sort -k2 -h | tail -8` — identify the top working sets;
   compare each against its compose limit (`HighMemoryUsage` for container-level breaching).
2. Page-cache vs working set: `grep -E 'Cached|MemAvailable' /proc/meminfo` — reclaimable cache
   under a file-store JetStream stream is normal; MemAvailable below 25% with low cache is the real
   signal.
3. If PostgreSQL: check shared_buffers work and Timescale memory; a telemetry load test at 15K will
   legitimately push this — the envelope gate is defined at 2K steady.

**Likely causes:** envelope overshoot, a memory leak in one service (check its trend line), or the
15K stress test running.

**Escalation:** if the top consumer is near its own limit and still growing, restart it before the
OOM-killer picks a worse victim (NATS or PG). Sustained at honest load = the resize branch (plan
Task 0.5).
