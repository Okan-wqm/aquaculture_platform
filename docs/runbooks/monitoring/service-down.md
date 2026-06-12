# Runbook — ServiceDown

**Alert:** `ServiceDown` (critical) · **Rule:** `infrastructure/monitoring/droplet/rules/10-service-health.yml`

**Meaning.** `up{namespace="aquaculture"} == 0` for >1m — Prometheus could not scrape `{{ $labels.app }}`'s `/metrics` endpoint. The container is down, crash-looping, or unreachable on the scrape network.

**First actions (droplet):**
1. `docker ps -a --filter name=aqua-<service>` — is the container up / restarting / exited?
2. `docker logs aqua-<service> --tail=200` — boot failure (DI error, migration block, secret missing)?
3. `curl -s localhost:<containerPort>/health` from inside the app network (`docker exec aqua-gateway curl …`) — does the process answer at all?
4. Confirm it is a real outage, not a scrape-path issue: is the service on `aqua-internal` and is `aqua-prometheus` attached to it?

**Likely causes:** crash loop after a bad deploy (roll back via the deploy workflow), OOM kill (check `dmesg` / `HighMemoryUsage`), failed boot signal (db-migrate / schema-drift / NATS mTLS).

**Escalation:** if a critical service (gateway-api, auth-service) is down >5m, this is a customer-facing outage — page the on-call lead and consider a rollback.
