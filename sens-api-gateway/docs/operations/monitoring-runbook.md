# Monitoring Runbook — `sens-api-gateway` v1.6.0

**Audience:** NOC operator, shift supervisor, first-line Plant-IT.

**Purpose:** what to watch on each edge device, threshold bands, and the response action for each red condition. Pair with [`alert-catalogue.md`](./alert-catalogue.md) for the machine-readable alert rules.

---

## 1. Signals to watch (per device)

| Signal | Source | Scrape interval | Aggregation window |
|--------|--------|-----------------|--------------------|
| CPU usage % | `edge_cpu_usage_percent` (`src/telemetry.rs:97-102`) | 30 s | 5 min rolling |
| RAM usage % | `edge_memory_usage_percent` (`src/telemetry.rs:106-116`) | 30 s | 5 min |
| Disk usage % (`/` and `/var`) | `edge_disk_usage_percent` (`src/telemetry.rs:118-133`) | 60 s | 15 min |
| CPU temperature °C | `edge_temperature_celsius` (`src/telemetry.rs:135`) | 60 s | 5 min |
| Network Rx / Tx MB/s | `edge_network_rx_mb` / `edge_network_tx_mb` (`src/telemetry.rs:138-145`) | 30 s | 5 min |
| Offline queue depth / capacity | `edge_offline_queue_depth` / `edge_offline_queue_capacity` (`src/health.rs:421-432`) | 30 s | 1 min |
| MQTT publish rate | `edge_mqtt_publish_total` | 30 s | 5 min |
| MQTT reconnect count | `edge_mqtt_reconnect_total` | 30 s | 10 min |
| Modbus read OK count | `edge_modbus_ops_total{result="ok"}` (`src/health.rs:363-366`) | 30 s | 5 min |
| Modbus error count | `edge_modbus_ops_total{result!="ok"}` (`src/health.rs:373-376`) | 30 s | 5 min |
| Active alarm count / class | `edge_alarm_active_total{class=...}` | 30 s | 1 min |
| Cert days-to-expiry | `edge_cert_days_to_expiry` | 3600 s | raw |
| Watchdog miss count | `edge_watchdog_miss_total` | 30 s | 10 min |
| NTP drift (s) | `edge_ntp_drift_seconds` | 60 s | 5 min |
| Panic count | `edge_panic_total` | 30 s | 24 h |

**Wiring status:** the metric structures in `src/telemetry.rs` + `src/health.rs` populate the underlying signal; Prometheus `/metrics` export wiring plus the cloud-side scrape job are part of the v1.7.0 observability rollout tracked under ORPHAN-EDGE-007.

---

## 2. Threshold bands (green / yellow / red)

Thresholds are a **baseline**. Per-site overrides are applied via the site profile when the hardware class or workload differs (e.g. a process-plant IPC runs a higher baseline CPU and its thresholds shift up).

| Signal | Green | Yellow | Red | Rationale |
|--------|-------|--------|-----|-----------|
| CPU usage % (5 min p95) | < 60 | 60–79 | ≥ 80 | Rust async runtime under steady load should stay < 40% on RPi 4. Red = saturation; scheduling jitter affects Modbus timing. |
| RAM usage % | < 60 | 60–79 | ≥ 80 | leaves headroom for `updater` staging + OTA unpack. |
| Disk `/` % | < 70 | 70–89 | ≥ 90 | journald + log rotation triggers at 85%; 90% risks write-fail. |
| Disk `/var` % | < 70 | 70–89 | ≥ 90 | offline-queue WAL lives here. |
| CPU temperature °C (RPi class) | < 65 | 65–79 | ≥ 80 | RPi throttles at 80 °C. |
| Offline queue depth / capacity | < 50% | 50–79% | ≥ 80% | red = WAN outage nearing capacity; data-loss risk on full. |
| MQTT reconnect count (10 min) | 0 | 1–4 | ≥ 10 | steady link reconnects ≤ 1/hour under normal conditions. |
| Modbus error rate (5 min) | < 1% | 1–4% | ≥ 5% | 5% sustained = likely wiring / power / peer-PLC issue. |
| Active alarm count (priority 1) | 0 | 1–2 | ≥ 3 | ISA-18.2 operator-load guidance. |
| Cert days-to-expiry | > 60 | 30–60 | < 30 | red = rotate NOW. |
| Watchdog miss (10 min) | 0 | 1 | ≥ 2 | any miss = investigate; ≥ 2 = systemic. |
| NTP drift | < 500 ms | 500 ms – 5 s | > 5 s | event-ordering across fleet depends on clock agreement. |
| Panic count (24 h) | 0 | 1 | ≥ 2 | any panic = incident SEV-3; ≥ 2 in 24 h = SEV-2. |

---

## 3. Response pattern per red

For every red threshold: **acknowledge → triage → act → verify → document**. The acknowledge-to-act timer starts at alert receipt and is measured against the support-tier response clock (see [`support-tiers.md`](./support-tiers.md)).

### 3.1 CPU / RAM red (≥ 80% for 5 min)

1. **Acknowledge** in the on-call tool within tier SLA.
2. **Triage**: open `/diag/process` (see `src/health.rs:80-145` — `DiagnosticsResponse`). Look for runaway Modbus retries, alarm flood, or script-runtime loop.
3. **Act**: if a single subsystem is the cause, disable it via control-plane command (e.g. pause Modbus polling on a failing unit). If no single cause, schedule a restart within the operator-initiated-restart MTTR window (< 5 min).
4. **Verify**: confirm CPU / RAM back to green within 15 minutes post-action.
5. **Document**: open a finding if a repeat within 7 days.

### 3.2 Disk red (≥ 90%)

1. Acknowledge. **Criticality: HIGH** — risk of write-fail.
2. Check `du -sh /var/lib/sens-api-gateway/*` (on-device via ops shell). Main cullers: offline queue WAL, journald logs, OTA staging.
3. If offline queue ≥ 80% AND WAN is up: trigger drain (control-plane command). If offline queue is full AND WAN is down: **data-loss risk** — escalate per [`incident-response.md`](./incident-response.md) SEV-2.
4. If journald: `journalctl --vacuum-size=100M`.
5. If OTA staging: confirm no rollback in progress; if clean, remove stale staging dir.

### 3.3 Offline queue ≥ 80%

1. Root cause is always **WAN / broker unreachable**. Validate before acting.
2. Check `edge_mqtt_reconnect_total` and `$SYS/broker/clients/connected` from the cloud side.
3. If broker-side issue: handle broker incident per its own runbook.
4. If edge-side link: check `ip route`, `ping` gateway, check carrier status.
5. **Do not clear the queue**. Queued messages are customer-owned data; only the agent's drain-on-reconnect path should remove them.

### 3.4 Cert days-to-expiry < 30

1. Raise a **scheduled rotation ticket** immediately — rotation is a planned, not emergency, activity.
2. Follow `deployment/provisioning.md#cert-rotation`.
3. Fleet-wide rotation requires the staged rollout in `deployment/pki-rotation.md`.

### 3.5 Watchdog miss ≥ 2 in 10 min

1. **Criticality: HIGH** — the agent's main loop is stalling.
2. Pull last 5 minutes of logs at `DEBUG` (via the TTL-bounded log level flip in [`observability.md`](./observability.md#log-volume-slo)).
3. Look for blocked `tokio::spawn` tasks, long-running Modbus poll (timeout not honoured), or SCADA server starvation.
4. If root cause unclear within 30 minutes: restart the agent (documented operator-initiated restart) and open a SEV-3 incident.

### 3.6 Panic count ≥ 1

1. **Any panic is an incident.** The Rust agent's policy is panic-free by design at steady state.
2. Capture the panic payload from the journal: `journalctl -u sens-api-gateway -p err --since "-1h"`.
3. File a SEV-3 (single) or SEV-2 (≥ 2 in 24 h) incident.
4. Preserve the core dump if enabled. Symbolicate against the release debug-info package.
5. PSIRT check: confirm the panic is not triggered by externally supplied data (payload parser, command-envelope); if yes, treat as a potential security finding per CVD policy in [`../security/`](../security/).

---

## 4. Dashboards to open during triage

| Scenario | Dashboard |
|----------|-----------|
| "Is this device up?" | `edge-fleet-overview.json` → device filter |
| "Why is CPU red?" | `edge-performance.json` |
| "WAN issue?" | `edge-offline-queue.json` |
| "Protocol health?" | `edge-performance.json` → Modbus tab |
| "Alarm flood?" | `edge-alarm-journal.json` |

Dashboards listed are DESIGN (see `observability.md#dashboards`).

---

## 5. Evidence & open items

- `src/telemetry.rs:79-162` — source of CPU / RAM / disk / temperature / network signals.
- `src/health.rs:32-75, 80-145` — `/healthz`, `/readyz`, `/diag` endpoints and their data shape.
- `src/health.rs:421-448` — offline-queue signals.
- Open: `/metrics` Prometheus exposition and the cloud-side scrape job are part of the v1.7.0 rollout (ORPHAN-EDGE-007).
- Open: per-site threshold override mechanism (site profile schema). Owner: deployment-runbook-writer + SRE. Target: v1.7.0.
