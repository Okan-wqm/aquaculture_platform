# Runbook — HighErrorRate

**Alert:** `HighErrorRate` (warning) · **Rule:** `infrastructure/monitoring/droplet/rules/10-service-health.yml`

**Meaning.** `{{ $labels.app }}` returned 5xx (`status_code=~"5.."`) for >5% of requests over 5 minutes, at >1 req/s (the traffic guard suppresses single-error noise on idle services).

**First actions:**
1. `docker logs aqua-<service> --tail=300 | grep -iE "error|exception|5[0-9][0-9]"` — what is failing? One route or all?
2. Check the dependency it fans out to: Postgres (connection pool — see `DatabaseConnectionPoolExhausted`), Redis, NATS, an upstream service (`ServiceDown` on a dependency).
3. Correlate with a recent deploy: `docker inspect aqua-<service> --format '{{.Config.Image}}'` — did the image SHA change in the last hour?

**Likely causes:** a regression in the last deploy, a degraded dependency, or a partial outage cascading. If error rate keeps climbing it will trip `CriticalErrorRate` (page).

**Escalation:** sustained >5% with growth, or any 5xx on a checkout/auth path → notify on-call; prepare a rollback.
