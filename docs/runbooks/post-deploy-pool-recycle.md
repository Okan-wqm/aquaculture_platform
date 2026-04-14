# Runbook: Post-Deploy Connection Pool Recycle

When schema migrations move tables between schemas (`ALTER TABLE ...
SET SCHEMA`), every PostgreSQL connection in every service's pool may
hold a cached query plan that references the old schema location. The
plan is `pg_class` OID-bound, so unqualified-name queries continue to
resolve correctly via search_path, BUT schema-qualified queries that
got planned before the move stay pointed at the old (now-empty)
schema until the connection is recycled.

This runbook covers when and how to recycle pools after a teardown-
class deploy.

## When to recycle

  - **Always after P6-P10 of the 2026-04-14 teardown** (the `SET SCHEMA`
    moves) — even though the moves are sub-millisecond, the stale plan
    cache is a real risk for any service that emits schema-qualified
    SQL (e.g. admin-api-service's `INSERT INTO shared.audit_logs`
    statements introduced in P9).
  - **Always when a migration alters a heavily-shared table** (e.g.
    audit_logs, user_permissions) — the plan cache for SELECT/INSERT
    against these tables is the busiest in the pool.
  - **Optionally after non-structural migrations** — adding a column to
    a low-traffic table (Plan.deleted_at via P2b) is unlikely to hit
    the cached-plan issue but a recycle is cheap insurance.

## How to recycle

### Production (Kubernetes)

```bash
# Rolling restart of every backend service with at least 2 replicas
# so there's no downtime window. The K8s controller terminates pods
# one at a time, and the pg pool dies with each pod.

for svc in auth farm sensor billing notification alert ai hr \
           messaging hydroponics admin-api gateway-api config; do
  kubectl rollout restart deployment/aquaculture-${svc} -n aquaculture
  kubectl rollout status deployment/aquaculture-${svc} -n aquaculture --timeout=5m
done
```

The rollout-status wait between services is intentional: serialise the
restarts so the gateway always has a healthy upstream for every
subgraph (no 503s during the window).

### Production (Docker Compose, droplet)

```bash
# Rolling restart per service. With one replica each, this is a brief
# downtime per service — acceptable for the brief recycling window.
# If sub-second downtime is unacceptable, do the K8s rollout style
# above with HAProxy or nginx upstream draining.

for svc in aqua-auth aqua-farm aqua-sensor aqua-billing aqua-notification \
           aqua-alert aqua-ai aqua-hr aqua-messaging aqua-hydroponics \
           aqua-admin-api aqua-gateway aqua-config; do
  docker restart "${svc}"
  # Wait for healthy before moving on
  while [ "$(docker inspect "${svc}" --format '{{.State.Health.Status}}')" != "healthy" ]; do
    sleep 2
  done
done
```

### Staging / dev

Skip the wait — `docker compose restart` parallel-restarts everything.
A few seconds of GraphQL federation rebuilds is fine in non-prod.

## What if you skip the recycle?

The pool's cached plans for moved tables will eventually invalidate on
their own:

  - **Per-pool TTL:** the default postgres `connection_idle_timeout`
    of 30s in our pool config means an idle connection is recycled
    automatically. A service with continuous traffic may hold the same
    physical connection for hours.
  - **First failed query:** PostgreSQL returns a clean error
    (`relation "old_schema.X" does not exist`) which TypeORM surfaces
    as a `QueryFailedError`. A retry-on-error wrapper would
    transparently recover, but our app does not have such a wrapper —
    so the user sees a 500 until that connection happens to recycle.

Net: skipping the recycle creates a window where some fraction of
requests fail while the pool churns through its stale connections.
Worst-case: hours, depending on traffic shape. Recycle takes
~30 seconds. Always recycle.

## Verification

After recycle:

  1. `docker logs aqua-<svc> | grep "PostgreSQL connection pool patched"`
     — confirms RlsConnectionBootstrap re-ran (pool fresh).
  2. Manually issue a query that exercises the moved table:
     ```sql
     -- For P9 audit_logs move:
     SELECT COUNT(*) FROM shared.audit_logs;
     -- Expected: numeric result, not "relation does not exist"
     ```
  3. Watch service error rates in Grafana for 5 minutes — should stay
     at baseline.
