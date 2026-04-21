# Runbook: Per-Tenant Sensor Ingest Rollout (Rust Sidecar)

**Owner:** platform team (Okan-Wqm + sensor-service maintainers)
**Related ADRs:** ADR-022 (control / data plane separation), ADR-025 (Rust sidecar architecture), ADR-027 (per-tenant `IngestBackend` toggle)
**Plan reference:** `docs/plans/sensor-rust-migration/PLAN.md`

## Purpose

Operate the strangler-fig rollout of the Rust ingestion sidecar
(`apps/sensor-ingestion`) tenant by tenant, while the legacy NestJS
MQTT path (`sensor-service`) continues to serve every other tenant.
Steps are reversible at the tenant level — a misbehaving rollout is
flipped back to the NestJS path with one config edit + restart.

This runbook is **NOT destructive**. The dual-write contract
(Faz 2 stage 11's PostgresSink + Faz 3 stage 2's
NatsIngestionConsumer → BatchProcessor) preserves an `INSERT ... ON
CONFLICT DO UPDATE` on the same `(time, sensor_id, channel_id)` key,
so a tenant routed through both backends produces a single canonical
row regardless of which backend's write hits first.

---

## Pre-rollout checklist

Confirm ALL of the following BEFORE the first tenant flips:

- [ ] **Faz 2 + Faz 3 PRs merged to `main`** — PR #16 (sidecar) and
      PR #17 (control plane). The sidecar image must be tagged on
      GHCR; the sensor-service image must include the
      `NatsIngestionConsumerService`.
- [ ] **Sidecar healthy on staging** — `aqua-sensor-ingestion-staging`
      container running, `RUST_LOG=info` shows the boot-time
      self-smoke check pass, the `topic cache constructed` log line
      surfaced.
- [ ] **NATS subject ACL in place** — `infrastructure/nats/services.yaml`
      contains the `sensor_ingestion` CN with publish on `events.>`
      (Faz 2 stage 14). Re-run
      `python3 scripts/nats/generate-nats-conf.py` if any drift; the
      CI invariant test catches this anyway.
- [ ] **Postgres schema bootstrapped** — every tenant in the rollout
      has the `<tenant>.sensor_metrics_stage` UNLOGGED table that the
      sidecar's PostgresSink expects (Faz 2 stage 11 ADR-025 Option A).
      Sensor-service's schema-bootstrap path creates it; verify via
      `\dt tenant_<32hex>.sensor_metrics_stage` on a sample tenant.
- [ ] **Per-tenant cert minted** — the sidecar's `[mqtt]` and `[nats]`
      cert paths in `infrastructure/sensor-ingestion/config.toml`
      point at certs the platform CA actually signed for the
      `sensor_ingestion` CN.
- [ ] **Staging dual-write equivalence soak green** — the e2e gate
      `e2e/tests/sensor-ingest-equivalence.e2e.spec.ts` ran with
      `SENSOR_INGEST_EQUIVALENCE_E2E=1` against the staging dual-
      write window for at least 24 hours, drift counter = 0.
- [ ] **Operator buddy identified** — a second engineer reviews each
      tenant flip. Single-operator unattended rollouts are forbidden.

---

## The per-tenant flip (5-minute change window)

For each tenant `<TENANT_UUID>` you want to migrate, in order:

### 1. Confirm the tenant is healthy on the legacy path

```bash
# Last metric arrival time on the legacy path:
psql "$DATABASE_URL" -c "
  SELECT MAX(time) AS last_metric, COUNT(*) AS rows_24h
  FROM tenant_$(echo $TENANT_UUID | tr -d '-').sensor_metrics
  WHERE time > now() - interval '24 hours';
"
```

`last_metric` should be within the past 5 minutes for any tenant whose
sensors are actually publishing. Stale metrics → diagnose the upstream
edge device first; do NOT flip a tenant whose legacy path is already
broken.

### 2. Add the tenant to the sidecar's `[ingest_backend]` overrides

Edit `infrastructure/sensor-ingestion/config.toml` on the sidecar host:

```toml
[ingest_backend]
default_backend = "node"
tenant_overrides = {
  "<TENANT_UUID>" = "rust",
  # ... previously migrated tenants stay here ...
}
```

Reload the sidecar — restart the `sensor-ingestion` container is the
operational primitive (the config is bind-mounted; `docker compose
restart sensor-ingestion` picks up the change in <5 s):

```bash
cd /var/aqua-saas
docker compose -f docker-compose.droplet.yml restart sensor-ingestion
```

Confirm the tenant is recognised:

```bash
docker logs aqua-sensor-ingestion --tail 200 | grep "ingest_backend\|tenant_overrides"
```

The boot log must enumerate the override list size; the new tenant
must appear in the count.

### 3. Watch the dual-write window for 5 minutes

Both backends are now processing the tenant's MQTT publishes. The
ON CONFLICT DO UPDATE produces a single canonical row per
`(time, sensor_id, channel_id)` regardless of which backend writes
first.

```bash
# Sidecar metric counter:
docker logs aqua-sensor-ingestion --tail 200 | grep "mqtt drain complete"

# NestJS BatchProcessor flush counter:
docker logs aqua-sensor --tail 200 | grep "BatchProcessor.*flushed\|metrics from sensor"

# NATS event flow on the sidecar's publish path:
nats sub "events.<TENANT_UUID>.SensorMetricIngested" --count 10

# NATS consumer enrichment + typed re-emit:
docker logs aqua-sensor --tail 200 | grep "NatsIngestionConsumer stats"
```

For a 5-minute window the operator MUST see:

1. Sidecar `count` log incrementing (it's processing the tenant's MQTT).
2. NestJS `NatsIngestionConsumer stats` showing `received > 0`,
   `enqueued > 0`, `published > 0`. (The `skippedNoSensor` and
   `skippedNoChannel` counters should stay at 0 for a healthy tenant.)
3. The hypertable row count for the tenant continues to climb at
   roughly the legacy rate (run the query in step 1 again — `rows_24h`
   should be increasing in real time).
4. Alert engine for the tenant continues to fire on threshold breaches
   (the typed `SensorReading` event the consumer re-emits is what
   alert-engine subscribes to).

### 4. Promote the tenant after the 24h soak

If the 5-minute window above is clean and the tenant continues to
publish without anomalies for the next 24 hours, the rollout for that
tenant is complete. No further config change needed — the tenant is
permanently in the override list.

---

## Rollback (per-tenant, 2-minute change window)

If ANY of the following symptoms appear during the dual-write window
or the 24h soak:

- Sidecar `count` is incrementing but the hypertable row count stops
  climbing (the sidecar is publishing but the consumer is dropping).
- NestJS `NatsIngestionConsumer stats` shows `skippedNoSensor` or
  `skippedNoChannel` > 0 for the tenant's sensor / channel ids.
- Alert engine stops firing for the tenant.
- The tenant's metric latency (`now() - producer_ts`) grows past
  10 seconds.

**Rollback:**

1. Edit `infrastructure/sensor-ingestion/config.toml` and REMOVE the
   tenant from `tenant_overrides`. The sidecar will route the tenant
   to `node` on the next restart (the default backend).
2. `docker compose restart sensor-ingestion` — <5 seconds. The legacy
   NestJS MQTT path is still running for that tenant (it never
   stopped — that's the strangler-fig invariant), so traffic continues
   to flow without intervention.
3. File a finding in `docs/reviews/orphan-findings.md` with the
   tenant id, the symptom, the per-minute counter values when the
   symptom appeared, and (if known) the suspected root cause.

The tenant stays on the legacy path until the root cause is
diagnosed and a follow-on commit ships. No data loss occurs because
the legacy path never stopped processing.

---

## Cutover (when every tenant is on the sidecar)

Once `tenant_overrides` enumerates every active tenant (or the
operator decides to flip the default), the cutover is a one-line
config edit + restart:

```toml
[ingest_backend]
default_backend = "rust"
tenant_overrides = {}
```

```bash
docker compose restart sensor-ingestion
```

Then flip the NestJS sensor-service profile to control-plane:

```bash
# /var/aqua-saas/.env or docker-compose env override
SENSOR_SERVICE_PROFILE=control-plane
SENSOR_SERVICE_MEMORY=192M
SENSOR_SERVICE_CPUS=0.2

docker compose up -d sensor-service
```

After cutover:

- The sensor-service container drops to the ADR-022 budget
  (192 MB / 0.2 vCPU). The Rust sidecar takes the freed budget
  (256 MB / 0.35 vCPU). Total platform footprint stays under the
  legacy 512 MB / 0.5 vCPU envelope for sensor work, with the data
  plane now in Rust.
- The MQTT listener inside sensor-service skips boot
  (`MqttListenerService.onModuleInit` returns early when the profile
  is control-plane). The protocol-adapter classes stay loaded for
  the GraphQL CRUD path that probes connectivity.
- The NATS consumer (`NatsIngestionConsumerService`) continues to
  bridge sidecar events into the BatchProcessor + typed-event
  publish path. ADR-022's invariant is preserved.

---

## Observability

Pin these dashboards / log queries during ANY rollout:

- **Sidecar log queries** (set `RUST_LOG=info` for steady-state,
  `RUST_LOG=debug` during the 5-minute window):
  - `mqtt drain complete count=N` — every flush window logs N. A
    drop in N for an active tenant is the leading indicator.
  - `topic parse failed (dropping)` — the per-message parse-failure
    counter. Should be 0 for any well-formed MQTT publish.
  - `payload validate failed (dropping)` — same, for payload-side
    validation. A spike means an upstream device firmware change.
- **NestJS sensor-service log queries**:
  - `NatsIngestionConsumer stats — received=R skippedNoSensor=S
    skippedNoChannel=C enqueued=E published=P` — minute roll-up.
    `received == enqueued == published` for a healthy tenant. `S` or
    `C` > 0 is the signal that the tenant has sensor / channel rows
    missing from the DB; investigate before promoting the tenant.
- **TimescaleDB queries**:
  - `SELECT COUNT(*) FROM tenant_<hex>.sensor_metrics WHERE time >
    now() - interval '5 minutes'` — instantaneous row count.
  - `SELECT MAX(time) FROM tenant_<hex>.sensor_metrics` — last
    metric arrival.

---

## Known limits

- **Per-tenant config-edit-then-restart** is the rollout primitive
  this commit ships. A future "dynamic policy" backed by NATS
  request-reply (`sensor.lookup.tenant_settings`) replaces this with
  a no-restart config update — but adding a tenant under the static
  policy is a 5-minute change window with `docker compose restart`,
  not a deploy.
- **The sidecar does NOT enrich farm_id / pond_id from sensor-meta**
  — that lookup happens in the NestJS consumer (which has the cache).
  Until the sidecar's own cache-miss responder ships, the
  `SensorMetricIngested` events on the wire carry only the tenant +
  sensor + channel + value tuple. Downstream consumers that need
  farm_id / pond_id must subscribe to the typed `SensorReading`
  event (which the NestJS consumer publishes after enrichment) — same
  contract as the legacy path.
- **The 60-second sensor + channel cache TTL** is the maximum
  staleness for an operator change that bypasses the lifecycle event
  path (e.g. raw SQL UPDATE). Routine changes via the GraphQL CRUD
  path publish `SensorConfigurationUpdated` and the
  `SensorCacheInvalidationHandler` drops the cache entry within
  milliseconds.

---

## Escalation

If the rollback procedure does NOT restore the tenant's metric flow,
escalate to the on-call platform engineer with:

1. The tenant UUID.
2. The 5-minute counter snapshot from the sidecar + NestJS logs.
3. The `SELECT MAX(time)` output from the tenant's hypertable.
4. The output of `docker compose ps sensor-ingestion sensor-service`.

The escalation path includes flipping the entire platform back to
legacy by setting `SENSOR_SERVICE_PROFILE=legacy` and emptying the
sidecar's `tenant_overrides` — both backends fall back to their
pre-rollout posture.
