# Runbook — CriticalErrorRate

**Alert:** `CriticalErrorRate` (critical, pages) · **Rule:** `infrastructure/monitoring/droplet/rules/10-service-health.yml`

**Meaning.** `{{ $labels.app }}` exceeded a 10% 5xx error rate for 2 minutes at >1 req/s. This is a live, customer-impacting failure — the warning-level twin (`HighErrorRate`) is inhibited while this fires.

**First actions (fast):**
1. Decide rollback vs forward-fix in the first 5 minutes. If the error onset lines up with a deploy, **roll back** via the `Deploy to DigitalOcean` workflow to the previous SHA (the release ledger has it).
2. While rolling back: `docker logs aqua-<service> --tail=300` to capture the failure signature for the post-incident note.
3. Check fan-out dependencies (`ServiceDown` / `DatabaseConnectionPoolExhausted`) — the root cause may be downstream, not in this service.

**Escalation:** page immediately (this rule routes to the `page` receiver). Open an incident; if gateway-api/auth-service, treat as Sev-1.
