# Farm Service Operations Runbook

## Probes

- Live: `GET /health/live`. Process-only. DB loss must not fail this probe.
- Ready: `GET /health/ready`. Fails when DB-critical dependencies are unavailable.
- Metrics: `GET /metrics`. Exposes Node, HTTP, and farm domain metrics.

## Startup Checks

1. Confirm `INTERNAL_SERVICE_SECRET` is set in production.
2. Confirm `JWT_PUBLIC_KEY` or `JWT_PUBLIC_KEY_FILE` is set.
3. Confirm database migration job has completed.
4. Confirm NATS connectivity and outbox relay health.
5. Confirm object storage credentials when upload paths are enabled.

## Incident Triage

- 403 on GraphQL: check service identity v2 headers from gateway.
- Tenant read mismatch: inspect tenant context logs and strip-header middleware order.
- Event delay: inspect farm outbox pending count and relay logs.
- Ready probe 503: inspect DB, NATS, cache, and storage checks.

## Rollback

Rollback application image only after verifying database migration compatibility. If event relay is paused, resume it after rollback and monitor duplicate no-op handling.
