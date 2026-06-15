# Runbook — CriticalLatency

**Alert:** `CriticalLatency` (critical, pages) · **Rule:** `infrastructure/monitoring/droplet/rules/20-latency.yml`

**Meaning.** p99 request latency for `{{ $labels.app }}` exceeded 5s for 2 minutes — requests are effectively timing out for the slowest 1% of users.

**First actions (fast):**
1. `docker stats --no-stream` — is the droplet CPU/memory saturated? A single-node deploy under load degrades every service at once.
2. Check Postgres: `SlowQueries`, `DatabaseConnectionPoolExhausted`, and `SELECT * FROM pg_stat_activity WHERE state='active'` for long-running queries to cancel.
3. If onset matches a deploy, roll back to the previous SHA.

**Escalation:** page (routes to `page`). If multiple apps are critical-latency simultaneously, suspect host-level saturation (the droplet needs the resize that gates B4/B5 activation) — escalate to the platform owner.
