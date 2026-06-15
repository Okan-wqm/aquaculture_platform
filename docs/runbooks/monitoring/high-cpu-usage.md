# Runbook — HighCpuUsage

**Alert:** `HighCpuUsage` (warning) · **Rule:** `infrastructure/monitoring/droplet/rules/30-resources.yml`

**Meaning.** cAdvisor reports `{{ $labels.name }}` using >80% of its CPU limit (`cpus`) for 10 minutes.

**First actions:**
1. `docker stats {{ $labels.name }} --no-stream` — confirm sustained CPU; correlate with `HighLatency` for the same app (CPU starvation usually shows as latency first).
2. Traffic-driven or runaway? Check `rate(http_requests_total[5m])` — a load surge vs a hot loop / tight retry storm.
3. On a single droplet, one CPU-bound container starves its neighbours — check whether OTHER apps are also alerting (host-level saturation).

**Likely causes:** load surge beyond the per-container `cpus` budget, a busy-loop / unbounded retry, or expensive synchronous work that belongs on a queue.

**Escalation:** if host CPU is saturated across services, the droplet needs the resize that gates B4/B5 activation — escalate to the platform owner.
