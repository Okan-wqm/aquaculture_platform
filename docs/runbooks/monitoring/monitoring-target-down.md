# Runbook — MonitoringTargetDown

**Alert:** `MonitoringTargetDown` (critical) · **Rule:** `infrastructure/monitoring/droplet/rules/50-monitoring-self.yml`

**Meaning.** A monitoring-infrastructure scrape target — `cadvisor`, `node-exporter`, `prometheus-self`, or `alertmanager` — has been unreachable for 3 minutes. Observability is degraded: while these are down, the corresponding signal class is blind (no container metrics → resource alerts cannot fire; no self-scrape → Prometheus health is unknown).

**First actions:**
1. Identify which: `{{ $labels.job }}` / `{{ $labels.instance }}`.
2. `docker compose -p aqua-monitoring -f docker-compose.monitoring.yml ps` — is `aqua-<job>` up?
3. `docker logs aqua-cadvisor` / `aqua-node-exporter` — common causes: cAdvisor failing on a kernel/cgroup mount, node-exporter on a host-path permission, OOM (these have `oom_score_adj=500`).
4. Restart the affected container; if it crash-loops, check the host mounts (`/sys`, `/var/lib/docker`) and kernel/cgroup version compatibility with the pinned image.

**Escalation:** if `prometheus-self` or `alertmanager` is the down target, the stack is partly failed — pair with the `Watchdog` runbook; if both are healthy but cAdvisor/node-exporter flap, schedule an image-version review.
