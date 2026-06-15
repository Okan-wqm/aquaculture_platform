# Runbook — Watchdog

**Alert:** `Watchdog` (severity: none — deadman) · **Rule:** `infrastructure/monitoring/droplet/rules/50-monitoring-self.yml`

**Meaning.** This alert ALWAYS fires (`vector(1)`) and Alertmanager routes it to the `heartbeat` receiver on a tight 1-minute repeat. It is a **deadman switch**: an EXTERNAL uptime monitor (healthchecks.io / Better Uptime / a cron ping) expects this heartbeat. When the heartbeat **stops arriving**, the external monitor pages — that is the only way to learn the droplet's Prometheus or Alertmanager has itself died (a dead monitoring stack cannot alert on anything else).

**If the EXTERNAL monitor pages (heartbeat missing):**
1. The monitoring stack is down or partitioned. SSH to the droplet.
2. `docker compose -p aqua-monitoring -f docker-compose.monitoring.yml ps` — are `aqua-prometheus` + `aqua-alertmanager` up?
3. `docker logs aqua-prometheus --tail=100` / `aqua-alertmanager` — OOM (it has `oom_score_adj=500`, the kernel kills it FIRST under memory pressure — by design, apps survive), config error, or volume issue.
4. Restart via `scripts/monitoring/monitoring-up.sh` (re-runs the `MemAvailable` preflight).

**Note:** apps are unaffected while monitoring is down (separate compose project) — but you are flying blind until it is back.
