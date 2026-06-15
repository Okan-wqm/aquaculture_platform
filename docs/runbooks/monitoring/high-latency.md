# Runbook — HighLatency

**Alert:** `HighLatency` (warning) · **Rule:** `infrastructure/monitoring/droplet/rules/20-latency.yml`

**Meaning.** p95 request latency for `{{ $labels.app }}` exceeded 2s for 5 minutes.

**First actions:**
1. Is it CPU/memory pressure? Check `HighCpuUsage` / `HighMemoryUsage` for the same container, and `docker stats aqua-<service> --no-stream`.
2. Is it a slow dependency? Check `SlowQueries` (Postgres) and the latency of upstream services it calls.
3. Is traffic spiking? `rate(http_requests_total[5m])` for the app — a load surge on a single-droplet deployment can saturate CPU.

**Likely causes:** N+1 query / missing index, connection-pool contention, GC pressure under load, or a noisy-neighbour container on the shared droplet.

**Escalation:** if p99 follows into `CriticalLatency` (page), or latency breaches a customer SLA, notify on-call.
