# sensor-service Ingestion Baseline — 2026-04

> **Status:** measurement protocol locked, numbers TBD on first execution. This
> document is the **gate artefact** for Faz 2 (`sensor-ingestion` Rust sidecar)
> per `docs/plans/sensor-rust-migration/PLAN.md` § Faz 0 PR-B.
>
> **Faz 2 is BLOCKED until the "Results" section below has real numbers and
> a recorded "Karar gate" verdict.**

---

## Why this exists

The migration plan claims a **5-10× ingestion-throughput win** in Faz 2 on the
**same 512 MB / 0.5 vCPU container budget**. Without baseline numbers,
the claim is a guess. This run produces those numbers reproducibly so the
post-Faz-2 run can be diff'd against the same hardware, broker, and tenant
fanout — apples-to-apples, not "Rust beats Node on synthetic benchmark".

It also exercises the decision gate the plan defines:

- Sustained sensor-service throughput **< 15K msg/s** → Faz 2 ROI is high,
  proceed.
- Sustained throughput **≥ 15K msg/s** → re-evaluate Faz 2 priority. Saha-uyumu
  (drift-zero `protocol-codec`) and security wins (memory-safe binary parsers)
  remain valid, but the performance argument weakens.

---

## Test rig

| Component | Source of truth |
|---|---|
| Host | DigitalOcean droplet, 7.8 GiB RAM, 4 vCPU "DO-Regular", local NVMe |
| Stack | `docker-compose.droplet.yml` — sensor-service 512 MB / 0.5 vCPU, postgres 1.5 GB / 1 vCPU, mosquitto 64 MB |
| Postgres | TimescaleDB-HA pg16 (image `timescale/timescaledb-ha:pg16`), `chunk_time_interval = 7d` (stock; retune is a Faz 2 deliverable) |
| sensor-service | Built from `main` HEAD at the time of run (record SHA in Results below) |
| Load generator | `tools/scripts/perf-baseline.ts` — Node 22 type-stripping, single-process MQTT publisher, paced via `process.hrtime.bigint()` |

Synthetic load:

| Knob | Default | Why |
|---|---|---|
| `--tenants` | 50 | Matches the existing schema-per-tenant fanout assumption (50+ tenants in production). Forces the sensor-topic-cache miss path on first contact with each (tenant, sensor) pair. |
| `--sensors-per-tenant` | 200 | Realistic for a mid-size farm operator. |
| `--channels-per-sensor` | 10 | Multi-channel sensors (ph, temp, do, ...). |
| `--qos` | 1 | Production posture; QoS-2 is not part of this protocol. |
| `--rate` | 1000 / 5000 / 10000 / 15000 | Each tier is one run. |
| `--duration` | 300 s | 5 min sustained — long enough to see V8 old-gen GC pauses. |
| `--burst-factor` | 2 | Followed by a 30 s burst at 2× the sustained rate. |
| `--burst-secs` | 30 | Catches QoS-1 inflight overflow + sensor-service backpressure behaviour. |

---

## Run protocol

Each tier (1K, 5K, 10K, 15K msg/s) is one independent run. Between tiers:

1. `docker compose -f docker-compose.droplet.yml restart sensor-service` (clean
   V8 heap, fresh sensor-topic-cache).
2. Wait 60 s for the service to settle (`/health` returns `200`, queue depth
   reported by metrics endpoint = 0).
3. Capture `docker stats --no-stream sensor-service` snapshot (idle baseline).
4. Run the load generator with the appropriate `--rate`.
5. After the run completes (drain phase finishes), capture another `docker stats`
   snapshot.
6. Run the latency SQL (below) and append the result to the table.

### Bring up the stack

```bash
# from /var/aqua-saas
docker compose -f docker-compose.droplet.yml up -d \
  postgres redis nats mosquitto sensor-service

# wait for health
docker compose -f docker-compose.droplet.yml ps
curl -fs http://localhost:3000/health
```

### Run the load generator

```bash
node --experimental-strip-types tools/scripts/perf-baseline.ts \
  --broker mqtt://localhost:1883 \
  --tenants 50 --sensors-per-tenant 200 --channels-per-sensor 10 \
  --rate 5000 --duration 300 \
  --burst-factor 2 --burst-secs 30 \
  --metrics-url http://localhost:3000/metrics \
  --output docs/perf/runs/2026-04-baseline-5krps.json
```

(Repeat with `--rate 1000`, `10000`, `15000` and adjust the `--output` filename.)

The script prints per-second progress (`sent=…`, `acked=…`, `err=…`) and writes
a JSON report to `docs/perf/runs/`. Per-run JSON files are gitignored — only
this doc is the durable artefact.

### Capture latency from Postgres

After each run, run this query inside the postgres container and paste the
output into the Results table:

```sql
-- Looks at the last 10 minutes of sensor_metrics rows. Adjust the window
-- if a previous run polluted the table.
SELECT
  percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (received_at - producer_ts)) * 1000) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (received_at - producer_ts)) * 1000) AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (received_at - producer_ts)) * 1000) AS p99_ms,
  count(*) AS rows,
  min(producer_ts) AS first_producer_ts,
  max(received_at) AS last_received_at
FROM sensor.sensor_metrics
WHERE received_at >= NOW() - INTERVAL '10 minutes';
```

(`received_at` and `producer_ts` are columns on `sensor.sensor_metrics`. If
the existing schema names them differently, adjust the query — the runbook
does not pretend to know the column names without checking.)

### Capture container stats

```bash
docker stats --no-stream --format \
  'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}\t{{.NetIO}}' \
  sensor-service postgres mosquitto
```

### Capture GC profile (optional, repeat run only)

```bash
docker compose -f docker-compose.droplet.yml stop sensor-service
docker compose -f docker-compose.droplet.yml run --rm \
  -e NODE_OPTIONS="--trace-gc --max-old-space-size=384" \
  sensor-service node dist/main.js \
  &> docs/perf/runs/2026-04-baseline-${RATE}krps-gc.log
```

---

## Results

> Measured 2026-10-25 on the legacy NestJS data plane (`SENSOR_SERVICE_PROFILE=legacy`).
> The 1K / 5K / 10K / 15K tiers were **not run**: the service tops out near
> 56 msg/s (see "Finding"), so higher offered rates only measure broker overflow.
> The Rust sidecar (`sensor-ingestion`) was not exercised.

Fixture: 68 tenants × 20 sensors × 7 channels (6 readings + `producer_ts_ms`), provisioned
through the stock `request_tenant_schema_provisioning` → `db-migrate tenant-schema-provisioner`
path. One MQTT message = one sensor reading = 7 `sensor_metrics` rows. Latency is
publish → service receive (`row.time − producer_ts_ms`). "Persisted" is messages
with rows in `sensor_metrics` ÷ messages published. Caps: sensor-service 0.5 vCPU / 512 MiB,
Postgres 1 vCPU / 1.5 GiB, Mosquitto 0.15 vCPU / 128 MiB (`max_inflight 20`, `max_queued 1000`).

| Run | Offered msg/s | Load | Persisted | p50 ms | p95 ms | p99 ms | sensor CPU avg/max % | PG CPU avg/max % | Notes |
|---|---|---|---|---|---|---|---|---|---|
| mt-50 | 50 | 120 s | 100 % | 58 | 2,730 | 2,971 | 43 / 52 (cap 50) | 56 / 80 | below the ceiling |
| mt-100 | 100 | 300 s | 63.4 % (19,025 / 30,001) | 16,801 | 18,606 | 19,744 | 47 / 53 (cap 50) | 58 / 101 | broker dropped the rest |
| solo-100 | 100 | 120 s | 65.9 % | 16,689 | 18,320 | 18,693 | 47 / 53 | 65 / 87 | 1 tenant, 1,000 sensors |
| mt-100-cpu2 | 100 | 120 s | 66.5 % | 16,914 | 18,396 | 18,624 | 49 / 83 (cap 200) | 72 / 102 | sensor-service at 2 vCPU |
| mt-100-idx | 100 | 120 s | 63.1 % | 17,689 | 20,265 | 21,239 | 47 / 53 | 39 / 61 | outbox pending-count index added |
| idx-cpu1-100 | 100 | 120 s | 69.9 % | 15,961 | 16,873 | 17,388 | 48 / 69 (cap 100) | 40 / 81 | index + 1 vCPU |
| idx-cpu2-200 | 200 | 120 s | 29.3 % | 15,352 | 51,629 | 57,688 | 46 / 77 (cap 200) | 41 / 77 | index + 2 vCPU |

### Finding: the ceiling is a serial ack gate, not a resource

- Sustained throughput is ≈ 56 msg/s = 1 / 17.7 ms. In-service timing (temporary
  instrumentation of the compiled `dist`, not committed): `dispatch → PUBACK` p50 17.7 ms
  (`findSensorByTopic` p50 6.3 ms + `saveReading` p50 10.7 ms), and handlers in flight at
  dispatch was **1 in every 5 s window** (max = 1).
- Cause: `MqttClientService` holds PUBACK until the durable write commits
  (SENSOR-CRITICAL-086) on a single MQTT connection, and mqtt.js 5.15.1 processes
  incoming packets one at a time (`client.js` `work()` → next packet only after the
  previous packet's callback). Every tenant's messages share that one queue.
- It is not CPU, Postgres, Redis or the broker: the rate is identical at 0.5 / 1 / 2 vCPU
  (throttling 0.4 % at 2 vCPU), `pg_stat_activity` showed ~95 % of backend time `idle`,
  Redis served 1 GET per message at 12 µs, and Mosquitto delivered 100 / 500 / 2,000 msg/s
  with the same limits to an instant-ack subscriber.
- Tenant count is irrelevant at this load: 1 tenant (solo-100) and 68 tenants (mt-100)
  give the same rate.
- Above the ceiling Mosquitto's per-client queue (`max_queued_messages 1000`) overflows and
  drops QoS 1 messages silently (`Outgoing messages are being dropped for client …`); queue
  wait ≈ 1000 / 56 ≈ 17.5 s explains the p50.

### Secondary finding: outbox pending-count is a Seq Scan

`OutboxWorkerService.pollAndPublish` (woken by every outbox NOTIFY) counts
`publishedAt IS NULL AND retryCount < 5`. `idx_sensor_outbox_poll` is partial on
`… AND isDeadLettered = false`, so the planner cannot use it: 27 ms / 6,559 buffers on
62,844 rows versus 0.019 ms / 1 buffer for the index-eligible form. It was 52 % of
Postgres statement time in a 40 s window and grows linearly with the table (published rows
are kept 7 days). It is not the throughput ceiling (mt-100-idx).

### After the fix (same rig, same fixture)

Three changes: the tenant-boundary binding is one statement instead of four
(`bindTenantTransactionContext`), the sensor is loaded inside the write transaction instead
of a separate read transaction, and the outbox gauges leave the NOTIFY-driven drain path
(one index-served statement, at most every 5 s; dead-letter partial index on all 13 outbox
tables).

| Run | vCPU | Offered msg/s | Persisted | p50 ms | Sustained msg/s |
|---|---|---|---|---|---|
| mt-100 (before) | 0.5 | 100 | 63.4 % | 16,801 | 58.7 |
| fix-100 | 0.5 | 100 | 89.4 % | 11,515 | 77.8 |
| fix-150 | 0.5 | 150 | 58.3 % | 12,406 | 72.8 |
| fix-250 | 0.5 | 250 | 37.8 % | 11,229 | 81.5 |
| fixcpu1-100 | 1 | 100 | 92.6 % | 10,864 | 80.5 |
| fixcpu1-150 | 1 | 150 | 64.1 % | 11,114 | 83.6 |

Sustained = persisted ÷ (load + drain seconds).

- SQL statements per message: 28.1 → 12.6 (`log_min_duration_statement = 0`, 40 s window,
  3,126 messages). Node CPU per message: ≈ 8.4 → ≈ 5.7 ms. Postgres CPU average 58 % → 42 %.
- The per-connection ceiling moved from ≈ 57 to ≈ 80 msg/s. **100 msg/s is still not met**
  (89 % persisted at 0.5 vCPU, 93 % at 1 vCPU).
- A second vCPU changes nothing (throttling 2 %, Node CPU 45 % average): with one message in
  flight per connection, a message's own CPU (≈ 5.7 ms) and database waits (≈ 6 ms) cannot
  overlap, so wall time per message ≈ 12 ms is the ceiling again.
- Reaching 100 msg/s needs ≤ ~8 ms per message, or a second consumer. Two consumers sharing
  one subscription (`$share/…`, measured before the fix) held 100 msg/s at 100 %
  (6,001 / 6,001, p50 19 ms) and the ceiling scaled linearly (two consumers at 160 msg/s:
  96.3 %, ≈ 2 × 57). That topology was not shipped: the broker's ACL path for a shared filter
  could not be exercised here (anonymous Mosquitto, no go-auth).
- Outbox gauges on a 3 M-row table: old predicates 1,776 ms, new statement 1.9 ms, all three
  sub-selects planned as index scans.

### Stock-provisioning gaps hit while measuring

Applied manually to the benchmark database only; not changed in the repo.

- `platform.list_active_tenant_schema_mappings()` is granted only to `farm_service`;
  sensor-service's topic cache calls it (`permission denied`).
- `sensor_schema_owner` has no USAGE on provisioned tenant schemas, so FK checks on
  `sensor_metrics` inserts fail (`permission denied for schema tenant_…`) on every tenant.

### Provisioning cost (schema-per-tenant)

68 tenants in 24 min with a single worker (~21 s each; two parallel workers deadlocked):
14,144 tables, 77,316 indexes, 1.17 GB empty database. Topic-cache warm-up for 68 tenants /
1,360 sensors: 2.6 s.

A release-wide `aqua-db-migrate` over those 68 tenants ran 490 schema passes in 38 minutes
(7 tenant-aware services × 68 tenants plus the source schemas), for a release whose only new
migrations are source-only. Every pass re-verifies the tenant schema's hardening, so the
cost scales with tenants × services, not with the size of the release.

### Deviations from production

Sandbox VM (4 vCPU, fsync 0.3 ms); `NODE_ENV=production` for log levels; Mosquitto
anonymous (no go-auth HTTP ACL calls, which production makes with the cache disabled);
NATS token auth instead of mTLS; Postgres stock `shared_buffers` (128 MB), no WAL archive,
no TLS. `tools/scripts/perf-baseline.ts` was not used: it publishes `{value, channelId}`
but the listener reads each channel by `channel_key`, so it would persist no metrics.

### Profiling artefacts

For the run that surfaces the kink in the latency curve (likely 10K or
15K), capture a flame graph and a `--trace-gc` log so the Faz 2 design
doc can cite the exact hotspots:

- `clinic.js flame -- node dist/main.js` — flamegraph of the sensor-service
  process under load. Output → `docs/perf/runs/<tier>-flame.html`.
- `pg_stat_statements` snapshot — the SQL is in the runbook above; output
  → table appended to this doc, per run.

### Karar gate verdict

| Outcome | Decision |
|---|---|
| All tiers ≤ 10K msg/s sustained | Faz 2 proceeds as planned. Performance is the dominant motivator. |
| 10–15K msg/s sustained | Faz 2 proceeds. Performance still wins, but the gap is smaller; allocate extra time for benchmarking the sidecar against the same load profile to prove the 5–10× claim. |
| ≥ 15K msg/s sustained AND p99 < 50 ms across all tiers | Faz 2 priority drops. Saha + güvenlik kazanımları (`protocol-codec` SSoT, memory-safe binary parsers) still justify the migration but the order of operations changes — Faz 1 ships first, Faz 2 reordered after another roadmap item. Open a follow-up plan PR. |

Recorded verdict: legacy path sustained ≈ 57 msg/s before the fix and ≈ 80 msg/s after it
(≤ 10K row either way). The limit is the serial PUBACK gate on one MQTT connection, not CPU
or language. The sidecar was not measured here, so its capacity relative to this baseline is
still open. Sign-off by Okan pending.

---

## Why we are not chasing 100K msg/s in this run

The plan's 100K msg/s headline is an **infrastructure-readiness target**,
not a same-hardware claim. The current droplet (8 GB / 4 vCPU shared,
Postgres alongside everything) is provably too small for 100K (chunk
size at 7-day default → 60B-row chunks; WAL fsync caps writes long
before the application ever does). The baseline establishes where we
**actually are today** so Faz 2 has an anchor and Faz 4 has a "before"
to compare against once the chunk retune + sharding land.

---

## References

- `tools/scripts/perf-baseline.ts` — load generator
- `docs/plans/sensor-rust-migration/PLAN.md` § Faz 0 PR-B + § Verification
- `docs/adr/_draft/025-rust-sidecar-architecture.md`
- `docker-compose.droplet.yml`
- TigerData blog: "Testing Postgres Ingest: INSERT vs Batch INSERT vs COPY"
  (referenced in PLAN.md for the COPY 50–100× claim that this baseline
  will be measured against in Faz 2)
