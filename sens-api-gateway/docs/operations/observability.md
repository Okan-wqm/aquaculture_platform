# Observability — `sens-api-gateway` v1.6.0

**Purpose:** declare the metric / log / trace policy for edge devices so Plant-IT can size storage, set scrape intervals, and budget cost.

**Authority boundary:** the SaaS-side observability authority is Lane-A `observability-expert`. This chapter consumes that policy and applies it to the edge agent. Where the edge and SaaS policies diverge, the divergence is called out explicitly and tracked as a finding.

---

## 1. Metric cardinality policy

### 1.1 Label-set allowlist per metric

Cardinality is a cost — every unique label-value combination is a separate time-series. The edge agent MUST hold total active series per device under **10,000** at steady state.

| Metric family | Allowed labels | Forbidden labels | Budget (active series / device) |
|---------------|----------------|------------------|--------------------------------|
| `edge_uptime_seconds` | `device_id`, `firmware_version` | tenant_id at raw scrape (attach at cloud ingest) | 2 |
| `edge_cpu_usage_percent` | `device_id` | none | 1 |
| `edge_memory_usage_percent` | `device_id` | none | 1 |
| `edge_disk_usage_percent` | `device_id`, `mount_point` (fixed set: `/`, `/var`) | none | ≤ 4 |
| `edge_mqtt_publish_total` | `device_id`, `topic_class` (fixed enum: `telemetry` / `command_ack` / `event` / `alarm`) | full topic path (unbounded) | ≤ 4 |
| `edge_mqtt_reconnect_total` | `device_id`, `reason` (fixed enum: `timeout` / `auth` / `network` / `clean_close`) | `peer_addr` | ≤ 4 |
| `edge_modbus_ops_total` | `device_id`, `result` (enum: `ok` / `timeout` / `crc_err` / `proto_err`), `unit_id_bucket` (0-15, 16-127, 128-247) | raw `unit_id`, register address | ≤ 12 |
| `edge_offline_queue_depth` | `device_id` | none | 1 |
| `edge_offline_queue_capacity` | `device_id` | none | 1 |
| `edge_cert_days_to_expiry` | `device_id`, `cert_role` (enum: `client` / `server` / `ca`) | serial number | ≤ 3 |
| `edge_alarm_active_total` | `device_id`, `class` (enum: `priority1..4`) | alarm_name | ≤ 4 |
| `edge_panic_total` | `device_id` | thread_name, panic_payload (leak risk) | 1 |

**Hard forbidden labels** (dropped by relabel rule at ingest):

- `tenant_id` at raw scrape — attach in cloud-side enrichment keyed by `device_id → tenant_id` table.
- `device_id` as an unbounded label on a multi-device aggregate metric (only use `device_id` on per-device metrics; do NOT add `device_id` to site-level rollups).
- PII-bearing labels (`operator_name`, `email`, IPv4 of operator workstation).

### 1.2 Cardinality enforcement

- Agent compile-time: metric name + label-set is defined at construction and frozen (Rust type system enforces).
- Cloud-side ingest: relabel rule drops disallowed labels; alert `EdgeCardinalityBudgetBreached` fires when series per device > 10k. See [`alert-catalogue.md`](./alert-catalogue.md) (DESIGN — not wired).

---

## 2. Log volume SLO

| Level | Target volume / device / day | Compression assumption | Basis |
|-------|------------------------------|------------------------|-------|
| `ERROR` | ≤ 5 MB | gzip on rotation | rare by design |
| `WARN` | ≤ 20 MB | gzip | bounded by alarm/alert paths |
| `INFO` | ≤ 50 MB | gzip | normal steady-state |
| `DEBUG` | ≤ 500 MB | gzip | diagnostic only — not a steady-state run level |
| `TRACE` | unbounded | never — off in production | requires explicit operator enable with 24 h TTL |

**Runtime level:** production default is `INFO`. Customer support can flip to `DEBUG` for a single device via the control-plane command envelope, with an automatic revert to `INFO` after 24 h (TTL-bounded).

**Structured-log contract:** JSON lines, one object per event. Required top-level fields: `timestamp` (RFC3339Nano), `level`, `device_id`, `trace_id`, `span_id`, `msg`. PII masking via the central `maskPii()` contract mirrored from the SaaS side — see `@.claude/agents/observability-expert.md`.

---

## 3. Trace sampling

OpenTelemetry tracing is opt-in per device. Default rates when enabled:

| Span type | Sample rate |
|-----------|-------------|
| Any span with span status `ERROR` | **100%** (tail-based) |
| `edge.mqtt.publish` normal | **1%** head-based |
| `edge.modbus.poll` normal | **5%** head-based |
| `edge.command.execute` (operator-initiated) | **100%** — every commanded write must be traceable |
| `edge.ota.*` | **100%** |
| `edge.provision.*` | **100%** |

Sample rates are runtime-configurable via the control plane. Tail-based sampling on ERROR requires a collector-side policy (OpenTelemetry Collector `tail_sampling` processor — ROADMAP).

---

## 4. Retention

| Signal | Local (on-device) | Cloud |
|--------|-------------------|-------|
| Metrics | 30 days (Prometheus WAL + local TSDB if enabled) | 13 months (rolling) |
| Logs | 7 days (journald + log rotation) | 90 days (warm) + 1 year cold |
| Traces | 3 days | 30 days |
| Alarms (ISA-18.2 journal) | **retained indefinitely on-device** until cloud-acknowledged, then rotated | indefinite warm (regulatory) |
| Audit chain (HMAC) | indefinite until rotated | indefinite (tamper-evident append-only) — ROADMAP |

**Regulatory overlay:** customers in the EU regulated food / feed space may require longer retention (traceability). Site-specific retention overrides are set per site profile in `deployment/site-profile.md`.

---

## 5. Cost attribution

**Requirement:** every metric, log, trace must be attributable to a tenant for per-tenant cost rollup.

**Current state:** the `device_id → tenant_id` mapping is resolved at cloud ingest via an enrichment table maintained by the provisioning service. The label `tenant_id` is NOT attached at the edge (per §1.1 hard-forbidden rule) because the edge device may migrate between tenants (re-provision flow).

**Gap:** end-to-end cost attribution through logs + traces is NOT UNIFORMLY WIRED today. The metric path is wired (cloud-side enrichment); the log path requires a `device_id` → `tenant_id` decoration in the log pipeline; the trace path requires a resource-attribute decoration. Owner: observability-expert + edge-docs-orchestrator joint. Target: v1.7.0.

---

## 6. Availability calculation

The availability number in [`sla.md`](./sla.md) is computed as follows:

```
availability = 1 - (sum_over_window(unplanned_downtime_sec) / window_sec)

unplanned_downtime_sec = sum_over_window(
  time where up{job="sens-api-gateway", device_id=X} == 0
  AND NOT in planned_maintenance(X)
  AND continuous_duration >= 60s  -- hysteresis
)
```

- `up{...}` is the cloud-side Prometheus black-box probe (HTTP GET `/healthz`) OR the broker-side `$SYS/broker/clients/connected` presence check, whichever is lower.
- Hysteresis: 60 s fall, 120 s recovery (see SLA §1).
- Planned-maintenance windows are recorded in `maintenance_window{device_id}` (cloud-side recording rule).

**Wiring status:** cloud-side `up{job="sens-api-gateway"}` probe NOT YET deployed per SaaS observability plan. Owner: observability-expert. Target: v1.7.0.

---

## 7. Dashboards

The reference dashboard set lives in `infrastructure/monitoring/grafana/edge/` (directory creation pending — tracked under ORPHAN-EDGE-008). Planned dashboards:

| Dashboard | Purpose |
|-----------|---------|
| `edge-fleet-overview.json` | fleet-level active / degraded / offline counts, MTBF rollup, cert-expiry leaderboard |
| `edge-availability.json` | per-device availability, SLA-tier compliance, planned-maintenance overlay |
| `edge-performance.json` | CPU / RAM / disk / network per device, Modbus latency p50/p95/p99, MQTT publish rate |
| `edge-offline-queue.json` | queue depth vs capacity, drain time, backlog survivors |
| `edge-alarm-journal.json` | ISA-18.2 alarm class mix, active alarm heatmap |
| `edge-mtbf.json` | MTBF rolling 90 d (pending measurement program, Q3 2026) |

---

## 8. PII masking at the edge

The edge agent runs `StructuredLoggerService`-equivalent masking at emit time (Rust side). Fields matched by the central masker list (email, phone, IMEI, serial, lat/long below 4-decimal precision) are replaced with a salted hash. Salt rotates per device on every cold start; the hash is stable within a single run to preserve correlation but non-stable across restarts to limit long-term re-identification risk.

---

## 9. Evidence & open items

- `src/telemetry.rs:79-162` — current telemetry metric set (CPU / memory / disk / temperature / network / GPIO / Modbus).
- `src/health.rs:32-75` — `/healthz` + `/readyz` + `/metrics` endpoint structures.
- Open: `tenant_id` end-to-end attribution through logs + traces. Owner: observability-expert. Target: v1.7.0.
- Open: cloud-side black-box probe deployment. Owner: SRE. Target: v1.7.0.
- Open: Grafana dashboard JSON set under `infrastructure/monitoring/grafana/edge/`. Owner: SRE. Target: v1.7.0.
- Open: OpenTelemetry tail-sampling collector policy. Owner: observability-expert. Target: v1.8.0.
