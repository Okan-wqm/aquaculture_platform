# Runbook — HighMemoryUsage

**Alert:** `HighMemoryUsage` (warning) · **Rule:** `infrastructure/monitoring/droplet/rules/30-resources.yml`

**Meaning.** cAdvisor reports `{{ $labels.name }}` using >85% of its `mem_limit` for 10 minutes. Left unchecked the container OOM-kills → `ServiceDown`.

**First actions:**
1. `docker stats {{ $labels.name }} --no-stream` — confirm the working set; `docker inspect {{ $labels.name }} --format '{{.HostConfig.Memory}}'` for the limit.
2. Leak vs legitimate growth: is memory monotonically climbing (leak) or load-correlated? Check the heap-growth baseline if it is a Node service.
3. Short-term: `docker restart {{ $labels.name }}` reclaims the leak and clears the alert (note it — restarts mask leaks).

**Likely causes:** unbounded cache/Map, event-listener orphan, WebSocket connection leak, or an under-sized `mem_limit` for real load.

**Escalation:** repeated OOM kills on a critical service → raise a memory-leak finding and consider a limit bump (mind the 8GB droplet total until resize).
