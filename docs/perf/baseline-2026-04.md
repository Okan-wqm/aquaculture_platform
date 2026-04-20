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

> Replace **TBD** with measured values once each run completes. Commit per
> tier (one commit = one tier) so the bisect history records progress.

| Tier | Run-id | Sustained achieved | p50 ms | p95 ms | p99 ms | Drops | RSS peak | CPU peak | GC pause max | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1K msg/s | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | |
| 5K msg/s | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | |
| 10K msg/s | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | |
| 15K msg/s | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | |
| 5K + 30 s 2× burst | TBD | TBD (burst) | — | — | TBD | TBD | TBD | TBD | TBD | recovery time after burst |

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

Recorded verdict: **TBD** (write here once the runs complete and Okan has
signed off).

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
