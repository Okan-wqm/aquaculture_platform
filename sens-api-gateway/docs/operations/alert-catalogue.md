# Alert Catalogue — `sens-api-gateway` v1.6.0

**Audience:** SRE, on-call, Plant-IT.

**Purpose:** declare every alert rule that governs edge-device operation — PromQL expression, severity, runbook pointer, on-call target.

---

## 1. Wiring status — READ FIRST

The 13 alert rules below are **DESIGN, NOT DEPLOYED**.

- No `prometheus.rules.yaml` or equivalent Alertmanager rule file ships in `sens-api-gateway/` today.
- No `infrastructure/monitoring/` tree exists for the edge agent as of HEAD `3413db47`.
- The underlying metric sources (`src/telemetry.rs`, `src/health.rs`) populate the data; the alert layer on top of them is NOT wired.

This gap is tracked under **ORPHAN-EDGE-007** (alert-rule wiring) and **ORPHAN-EDGE-008** (monitoring-stack absence). Owner: SRE lead. Target wiring: v1.7.0.

Until wiring lands, the catalogue serves as a **contract** — the alert IDs, severities, conditions, and on-call targets below are the committed shape of the v1.7.0 alert layer. Changes to the catalogue require an ADR.

One of the 13 (`EdgeAuditChainBroken`) is **ROADMAP-v1.8+** pending the audit-chain HMAC enforcement in the security roadmap.

---

## 2. Severity scale

| Severity | Customer impact | Response target (Gold tier) | Paging |
|----------|-----------------|-----------------------------|--------|
| `critical` | Device down OR data loss imminent OR safety-system impact | 15 min | page on-call primary |
| `high` | Device degraded OR cert expiry imminent OR protocol failure storm | 1 h | page on-call primary |
| `medium` | Slow drift, resource pressure, single anomaly | 4 h business hours | ticket |
| `low` | Informational, trend-watch | next business day | ticket |

---

## 3. Alert rule table

All PromQL expressions below assume the cloud-side Prometheus with a job named `sens-api-gateway` and the metric-name / label contract in [`observability.md`](./observability.md#metric-cardinality-policy). Runbook column points into [`monitoring-runbook.md`](./monitoring-runbook.md) sections.

| # | Alert name | Severity | Condition (PromQL) | For | Runbook | On-call target | Status |
|---|------------|----------|--------------------|-----|---------|----------------|--------|
| 1 | `EdgeDeviceUnreachable` | critical | `up{job="sens-api-gateway"} == 0` | 5m | `monitoring-runbook.md#32-disk-red` → incident SEV-2 | primary-oncall | DESIGN (not wired) |
| 2 | `EdgeMqttReconnectStorm` | high | `increase(edge_mqtt_reconnect_total[10m]) >= 10` | 0m | `monitoring-runbook.md#33-offline-queue-80` | primary-oncall | DESIGN (not wired) |
| 3 | `EdgeOfflineQueueBacklog` | high | `edge_offline_queue_depth / edge_offline_queue_capacity >= 0.8` | 2m | `monitoring-runbook.md#33-offline-queue-80` | primary-oncall | DESIGN (not wired) |
| 4 | `EdgeCertExpiresSoon` | high (< 30 d) / critical (< 7 d) | `edge_cert_days_to_expiry < 30` (high) OR `< 7` (critical) | 10m | `monitoring-runbook.md#34-cert-days-to-expiry-30` | primary-oncall | DESIGN (not wired) |
| 5 | `EdgeSafeStateApplyFailed` | critical | `increase(edge_safe_state_apply_failed_total[5m]) > 0` | 0m | `../deployment/safe-state.md#apply-failure-playbook` | primary-oncall + safety-officer | DESIGN (not wired) |
| 6 | `EdgeWatchdogMiss` | high | `increase(edge_watchdog_miss_total[10m]) >= 2` | 0m | `monitoring-runbook.md#35-watchdog-miss-2-in-10-min` | primary-oncall | DESIGN (not wired) |
| 7 | `EdgeModbusTimeoutStorm` | high | `increase(edge_modbus_ops_total{result="timeout"}[1m]) >= 20` | 2m | `monitoring-runbook.md` (Modbus error rate ≥ 5%) | primary-oncall | DESIGN (not wired) |
| 8 | `EdgePlcSessionStuck` | high | `(time() - edge_plc_last_response_timestamp_seconds) >= 120` | 0m | `../deployment/plc-session-recovery.md` | primary-oncall | DESIGN (not wired) |
| 9 | `EdgeNtpDriftHigh` | medium | `abs(edge_ntp_drift_seconds) > 5` | 10m | `../deployment/time-sync.md` | secondary-oncall | DESIGN (not wired) |
| 10 | `EdgeDiskAlmostFull` | high | `edge_disk_usage_percent >= 90` | 5m | `monitoring-runbook.md#32-disk-red-90` | primary-oncall | DESIGN (not wired) |
| 11 | `EdgePanicObserved` | critical | `increase(edge_panic_total[5m]) > 0` | 0m | `monitoring-runbook.md#36-panic-count-1` | primary-oncall + PSIRT-CC | DESIGN (not wired) |
| 12 | `EdgeAuditChainBroken` | critical | `increase(edge_audit_hmac_mismatch_total[5m]) > 0` | 0m | `../security/audit-chain-incident.md` | primary-oncall + PSIRT-CC | ROADMAP-v1.8 (depends on audit-chain HMAC enforcement) |
| 13 | `AlwaysFiring` (dead-man switch) | low | `vector(1)` (synthetic) | 0m | `../deployment/dead-man-switch.md` | alertmanager health monitor | DESIGN (not wired) |

---

## 4. Rule-by-rule notes

### 4.1 `EdgeDeviceUnreachable`

**Trigger:** the cloud-side `up{job="sens-api-gateway"}` probe returns `0` for ≥ 5 minutes continuously. Mirrors the SLA's unplanned-downtime definition (60 s fall + hysteresis — the 5 min `for` clause builds in extra suppression of brief blips).

**Correlate with:** heartbeat loss on the broker side (`$SYS/broker/clients/connected` drop). Both absent = real device outage; broker-only absent = edge WAN path broken; probe-only absent = reverse-proxy / probe-host issue, not an edge problem.

### 4.2 `EdgeMqttReconnectStorm`

**Trigger:** ≥ 10 reconnects in 10 minutes. Steady-state baseline is ≤ 1 reconnect/hour; 10 in 10 min is a hard departure.

**Common causes:** broker restart, certificate rotation gone wrong, wifi / cell flapping, client-id collision. The label `reason` on `edge_mqtt_reconnect_total` narrows the cause.

### 4.3 `EdgeOfflineQueueBacklog`

**Trigger:** queue depth ≥ 80% of capacity for ≥ 2 minutes. Below 80% is considered "absorbing a normal WAN blip". Above 80% signals the blip is now extended or the queue is undersized (see [`capacity-planning.md`](./capacity-planning.md#offline-queue-sizing)).

### 4.4 `EdgeCertExpiresSoon`

**Trigger:** the minimum of all monitored cert days-to-expiry on the device drops below the threshold. `high` at < 30 d allows a full planned-rotation lead time; `critical` at < 7 d is last-chance.

Covers three cert roles (see `src/mtls/`): client cert to broker, server cert for local health/metrics endpoints, CA bundle validity.

### 4.5 `EdgeSafeStateApplyFailed`

**Trigger:** any increment of `edge_safe_state_apply_failed_total`. Safe-state must apply on every safety-triggering condition; a failure is a **safety-system regression** and gets a dual page to the safety officer.

Source: `src/safe_state.rs` + `src/safe_state_v2.rs`.

### 4.6 `EdgeWatchdogMiss`

**Trigger:** ≥ 2 watchdog misses in 10 minutes. One miss = investigate; two = systemic.

### 4.7 `EdgeModbusTimeoutStorm`

**Trigger:** ≥ 20 Modbus timeouts in one minute. Typical signatures: peer PLC restarting, RS-485 cable fault on a gateway, a serial-to-TCP converter dying.

### 4.8 `EdgePlcSessionStuck`

**Trigger:** the last PLC response is older than 2 minutes. Captures an alive-but-silent PLC connection (transport layer fine, protocol-layer stuck), which the timeout-storm rule may miss.

### 4.9 `EdgeNtpDriftHigh`

**Trigger:** |drift| > 5 s for 10 minutes. Event-ordering across a fleet depends on time agreement. At > 5 s, cross-device correlation in the SIEM becomes unreliable.

### 4.10 `EdgeDiskAlmostFull`

**Trigger:** `/` OR `/var` at or above 90% for 5 minutes. Pairs with the disk response pattern in the monitoring runbook.

### 4.11 `EdgePanicObserved`

**Trigger:** any increment of `edge_panic_total` within 5 minutes. The agent is panic-free by design at steady state; any panic is an incident. Dual-paging PSIRT in case the panic was triggered by externally supplied data.

### 4.12 `EdgeAuditChainBroken` — ROADMAP-v1.8

**Trigger (planned):** any HMAC mismatch in the append-only audit chain. Fires dual-page to PSIRT because a mismatch is evidence of tampering or a storage-integrity failure.

Depends on the audit-chain HMAC verification roadmap item in [`../security/`](../security/). Not wired because the enforcement primitive is not yet present in the agent.

### 4.13 `AlwaysFiring` — dead-man switch

**Trigger:** `vector(1)` — always true. If this rule stops firing, the alerting pipeline itself is broken.

Alertmanager watches for the absence of `AlwaysFiring` and alerts a separate channel (alert-health). Standard pattern for self-monitoring the alerting stack.

---

## 5. Alert routing

| Destination | Channel | Rules routed |
|-------------|---------|--------------|
| `primary-oncall` | PagerDuty escalation "Edge Fleet Primary" | rules #1–8, #10, #11 |
| `secondary-oncall` | PagerDuty escalation "Edge Fleet Secondary" (business-hours) | rule #9 |
| `PSIRT-CC` | security channel + email | rules #5 (safety-adjacent), #11 (panic), #12 (audit chain) |
| `alert-health` | infra internal channel | rule #13 (dead-man switch) |

Routing is configured in `infrastructure/monitoring/alertmanager.yaml` — file NOT YET CREATED (ORPHAN-EDGE-008).

---

## 6. Silencing policy

- Maintenance windows (planned) — alert rules `Edge*` suppressed for a device during the window. Silence window is bounded by the scheduled maintenance end time (hard TTL, no open-ended silences).
- Incident-scoped silencing — if an active incident is masking downstream alerts, the on-call may silence the downstream rules for the incident duration. Silence TTL = MTTR window target + 1 h grace.
- **No open-ended silences.** Alertmanager rejects `endsAt` in the far future (> 14 d) per infra policy.

---

## 7. Evidence & open items

- `src/telemetry.rs:79-162`, `src/health.rs:32-75, 421-448` — underlying metric sources.
- `src/safe_state.rs`, `src/safe_state_v2.rs` — source of `edge_safe_state_apply_failed_total`.
- Open: `prometheus.rules.yaml` creation — ORPHAN-EDGE-007. Owner: SRE. Target: v1.7.0.
- Open: `infrastructure/monitoring/` tree creation + Alertmanager config — ORPHAN-EDGE-008. Owner: SRE. Target: v1.7.0.
- Open: audit-chain HMAC enforcement primitive — ROADMAP-v1.8. Owner: security-architecture-writer + edge maintainer.
- Open: the underlying metric names in the table must be emitted by the agent's `/metrics` endpoint; wiring the Prometheus exposition is a prerequisite to the whole catalogue going live.
