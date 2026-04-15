# Runbook: PostgreSQL Connection-Budget Capacity

Closes `docs/reviews/infra-expert/2026-04-14-infrastructure-hardening.md#INFRA-DB-POOL-001`.

This runbook explains the platform's PostgreSQL connection budget, the
invariant the `tools/scripts/database/capacity-check.sh` script enforces,
and the procedure for resolving a capacity breach.

## TL;DR

- Every backend service holds a TypeORM pool. Pool size × replica count =
  connections that can be in flight against PostgreSQL at peak.
- `max_connections` on PostgreSQL is a HARD cap. Once exceeded, every new
  connection request is rejected; under HPA scale-up the symptom is
  cascading 500s across the platform within seconds.
- The platform default is `DATABASE_POOL_SIZE=10`. Per-service overrides
  are passed as `defaultPoolSize:` to `createServiceTypeOrmConfig` at the
  call site with a documented reason.
- The capacity script fails when single-replica total > 70 % of
  `max_connections`. That is a deliberate signal that the platform is
  approaching the cliff and Track B (RDS Proxy on K8s) becomes load-bearing.

## Today's budget

| Service | `defaultPoolSize` | Reason |
|---|---:|---|
| `sensor` | **50** | MEDIUM-006: continuous MQTT ingestion + concurrent HTTP. Pool churn under burst causes >100 ms tail latency. |
| `admin-api` | **40** | MEDIUM-007: dashboard fans out 5 parallel metric queries; 10 was tight under concurrent superadmin sessions. |
| `auth`, `farm`, `hr`, `messaging`, `billing`, `notification`, `event-store`, `ai`, `alert`, `hydroponics`, `config`, `observability` | 10 | Platform default — fits the connection budget under single-replica deployment. |
| `db-migrate` | 2 | One-shot CLI job; hand-rolled outside the factory. |

**Single-replica total: 212 connections.**
**`POSTGRES_MAX_CONNECTIONS` (droplet): 300.**
**Headroom: 88 connections (29 % spare). Threshold: 70 % (210). Status: AT CLIFF.**

Run the script to see the live numbers:

```bash
bash tools/scripts/database/capacity-check.sh
# Optional: tighten the threshold or override max_connections
HEADROOM_PCT=60 POSTGRES_MAX_CONNECTIONS=300 bash tools/scripts/database/capacity-check.sh
```

## Why the script fails today

The script reports 212 / 300 (71 %), one connection above the 70 % threshold.
This is INTENDED — the script is the canary that surfaces the architectural
gap. With single-replica deployment on the droplet, 88 free connections is
enough headroom for migrations, ad-hoc psql sessions, and the bootstrap
churn of a redeploy. With Kubernetes + HPA (gateway max 10 replicas, sensor
max 15 — `infrastructure/helm/aquaculture/values.yaml:58-130`), the same
per-service pools become:

```
14 services × 10 (avg) × 5 (avg replicas) ≈ 700 connections
sensor:   15 × 50 = 750 connections (alone)
admin-api: 5 × 40 = 200 connections
TOTAL ≈ ~1500 connections vs RDS default ~400
```

The K8s scenario is well past `max_connections` regardless of how we tune
per-service pools. Increasing `max_connections` is a band-aid (each
connection consumes 5–10 MB of shared memory). The architectural answer
is **RDS Proxy** (Track B in the hardening plan): the proxy multiplexes
many client connections to fewer backend connections and pins sessions
that need session state (search_path, advisory locks, LISTEN/NOTIFY,
prepared statements — see the INFRA-DB-POOL-001 finding for the full list).

## Resolution paths (in order of preference)

1. **Don't change the per-service pool.** The two overrides above are
   measured (MEDIUM-006, MEDIUM-007). Reducing them re-introduces the
   contention they were raised to fix.
2. **Raise `POSTGRES_MAX_CONNECTIONS`** on the droplet from 300 → 400.
   Edit `docker-compose.droplet.yml`'s postgres command:
   `-c max_connections=400`. Trade-off: ~1 GB extra shared memory budget.
   Acceptable on a droplet with ≥4 GB of free RAM.
3. **Land RDS Proxy** (Track B): `infrastructure/terraform/modules/rds-proxy/`
   gated behind `var.enable_rds_proxy=false`. This is the durable answer
   for the K8s migration.

## Operator procedure when the script fails

1. Run `bash tools/scripts/database/capacity-check.sh` locally and confirm
   the failing total.
2. Check whether a recent commit raised a `defaultPoolSize:` value:
   ```bash
   git log --since='30 days' -p -- 'apps/*/src/app.module.ts' \
     | grep -B 5 'defaultPoolSize'
   ```
3. If the raise is documented (MEDIUM-NNN comment at the call site) and
   the platform is still on the droplet, raise `max_connections` (path
   #2 above) and re-run the script.
4. If the platform is on Kubernetes, switch on RDS Proxy
   (`var.enable_rds_proxy=true`) and re-run against the proxy endpoint.

## Drift detection

The capacity script is currently MANUAL (no CI gate). Wiring it as a
required PR check is INFRA-DB-POOL-002 (follow-up). Until then, please
run the script before merging any change that touches
`apps/*/src/app.module.ts` (`defaultPoolSize` adjustment) or
`infrastructure/helm/aquaculture/values.yaml` (replicaCount /
autoscaling.maxReplicas).
