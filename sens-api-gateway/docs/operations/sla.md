# SLA — `sens-api-gateway` v1.6.0

**Purpose:** define the commitments a customer contract can reference — availability per tier, MTBF / MTTR targets, RTO / RPO, SLA-credit schedule.

**Reading rule:** every number below is either **measured** (with date and method) or **targeted** (with an owner and a measurement program). No unqualified guarantees.

---

## 1. Commitment tiers

Availability tiers are a **contractual commitment** on the edge-agent software, excluding hardware, network, and third-party IoT-hub availability. Hardware guarantees belong to the hardware vendor; network guarantees belong to the carrier.

| Tier | Target availability (monthly) | Max downtime / month | Max downtime / year |
|------|-------------------------------|----------------------|---------------------|
| Bronze | 95.0% | 36h 00m | 18d 06h |
| Silver | 99.0% | 7h 18m | 3d 15h |
| Gold | 99.5% | 3h 39m | 1d 19h |
| Platinum | 99.9% | 43m 12s | 8h 45m |

**Definitions:**

- **Availability** = `1 - (unplanned_downtime_sec / measurement_window_sec)`. Measurement window = rolling 30 days on the monitoring backend, reset at calendar month boundary for reporting.
- **Unplanned downtime** starts when the agent's `/healthz` endpoint returns non-200 OR heartbeat absent from the broker for **≥ 60 seconds continuously**, and ends when it recovers to 200 / heartbeat present for **≥ 120 seconds continuously** (hysteresis band to suppress flapping).
- **Planned maintenance** (announced ≥ 72 h in advance) is excluded from the numerator. Cap: 4 h / month.
- **Force majeure** (carrier outage, power outage, site access denied by customer) is excluded; the onus is on the provider to evidence the external cause.

**Source of metric:** Prometheus `up{job="sens-api-gateway"}` on the cloud-side scrape + broker `$SYS/broker/clients/connected` count. See [`observability.md`](./observability.md#availability-calculation).

---

## 2. MTBF — mean time between failures

| Class | Target | Status | Measurement plan |
|-------|--------|--------|------------------|
| Software-only MTBF (panic / crash / OOM, systemd restart) | **10,000 h** (≈ 417 days) on RPi 4 with `systemd Restart=always`, `StartLimitBurst=5/30s` | NOT YET COMMITTED — target Q3 2026 | Roll up `process_start_time_seconds` deltas per device, windowed 90 d, filter out planned restarts (OTA, config reload). Dashboard: `edge-mtbf.json`. |
| Hardware MTBF | HARDWARE-VENDOR RESPONSIBILITY (RPi / RevPi / IPC) | Out of this doc | Vendor datasheet. |
| End-to-end MTBF (software + hardware + link) | Not committed | Not measured | Requires paired hardware telemetry — ROADMAP Q1 2027. |

**Current signal (sanity, not a commitment):** soak run in `docs/testing/soak-report.md` (when available) reported zero unplanned restarts during the 1000-hour run. A single 1000 h observation is not an MTBF; a population-level measurement program is required before a contractual MTBF figure can be published.

---

## 3. MTTR — mean time to recover

MTTR is split by scenario because the recovery path is different.

| Scenario | Target MTTR | Bound | Notes |
|----------|-------------|-------|-------|
| Operator-initiated restart (`systemctl restart sens-api-gateway`) | **< 5 minutes** end to end | 95th percentile measured on a running production fleet | includes cold-start cost + initial heartbeat. |
| Cold-start (process launch to healthy heartbeat) | **< 90 seconds** | 95th percentile | Argon2id keystore derivation adds 2–5 s (see ORPHAN finding on Argon2 parameters); MQTT TLS handshake ≈ 1 s; Modbus pre-poll ≈ 2 s. |
| OTA rollback (signature / health-check fail) | **< 120 seconds** | auto-triggered by `updater` | See `deployment/ota.md` for the decision tree. |
| Cert rotation after revocation | **≤ 15 minutes** (RTO, see §4) | manual re-provision path | See `deployment/provisioning.md`. |

**Measurement:** `process_start_time_seconds` + `device_first_heartbeat_seconds` histograms exposed by the agent (wiring pending per `observability.md`).

---

## 4. RTO — recovery time objective

**Definition:** maximum allowed time between the decision to recover a device and the device being operational again on the chain of trust.

| Recovery scenario | RTO target | Procedure |
|-------------------|------------|-----------|
| Device lost / stolen → cert revoked → replacement provisioned | **≤ 15 minutes** | see `deployment/provisioning.md#emergency-reprovision`. |
| Corrupted keystore (Argon2id derivation fails) | **≤ 30 minutes** | keystore reset + re-provision; bound by on-site presence. |
| Broker CA rotation | **≤ 60 minutes** fleet-wide | staged rollout, see `deployment/pki-rotation.md`. |
| Site-wide power loss | **≤ 120 seconds** per device after power return | systemd auto-restart + offline-queue drain. |

---

## 5. RPO — recovery point objective

**Definition:** maximum telemetry / command-ack loss the customer tolerates on WAN disconnect.

| Path | RPO target | Mechanism | Bound |
|------|-----------|-----------|-------|
| Sensor telemetry → cloud | **≤ 10 seconds** under graceful disconnect, **up to offline-queue capacity** under extended outage | `src/offline_queue.rs` — disk-backed FIFO, capacity configured per site | 10 s is the scrape-interval lower bound; the true bound is queue capacity × tag rate. |
| Command ack → cloud | **≤ 5 seconds** online; queued on outage | `src/command_envelope/` | acks replay on reconnect. |
| Audit chain (HMAC) | **zero loss** targeted | ROADMAP — audit chain HMAC verification in [`../security/`](../security/) | Not enforced at runtime today. |

**Offline-queue capacity guidance:** sized to survive the site's worst-observed WAN outage × 1.5 safety margin. See [`capacity-planning.md`](./capacity-planning.md) for the sizing formula per site profile.

---

## 6. SLA credits (template)

Credits are a **template**. Actual values are filled per customer MSA. Values below use the industry-standard step schedule.

| Monthly availability achieved | Tier: Silver (99.0% target) | Tier: Gold (99.5% target) | Tier: Platinum (99.9% target) |
|-------------------------------|-----------------------------|---------------------------|-------------------------------|
| ≥ target | 0% credit | 0% credit | 0% credit |
| ≥ target − 0.5 pp | 10% of monthly fee | 10% | 10% |
| ≥ target − 1.0 pp | 25% | 25% | 25% |
| ≥ target − 2.0 pp | 50% | 50% | 50% |
| < target − 2.0 pp | 100% | 100% | 100% |

Bronze carries no SLA-credit clause by default; availability is best-effort.

**Credit request window:** customer submits a credit claim within 30 days of the affected month. Provider confirms or contests within 15 business days. Uncontested claims auto-approve.

**Credit form:** service credit applied to the next invoice. No cash refund.

---

## 7. Scope exclusions

The following are excluded from every availability calculation:

1. Hardware failures (vendor responsibility).
2. Local network failures upstream of the edge device (LAN switches, site routers, carrier outage).
3. Third-party IoT-hub outages (if the customer bridges to MindSphere / AWS IoT Core / Azure IoT Hub).
4. Customer-induced outages (wrong configuration, expired customer-owned cert, deleted cloud-side endpoint).
5. Force majeure.
6. Planned maintenance windows announced ≥ 72 h in advance, capped at 4 h / month.

---

## 8. Measurement artefacts (contract exhibit)

A Siemens procurement reviewer will ask for these. Each is an artefact the provider must produce on request.

| Artefact | Cadence | Source |
|----------|---------|--------|
| Monthly availability report per device | monthly, automated | Grafana dashboard `edge-availability.json` — wiring pending (see `observability.md#dashboards`). |
| Monthly MTBF rollup (once program is live) | monthly | `edge-mtbf.json` — ROADMAP Q3 2026. |
| Incident list (SEV-1 / SEV-2) | monthly | `incident-response.md` — postmortem registry. |
| Planned-maintenance calendar | quarterly (72 h pre-notice per event) | `deployment/maintenance-calendar.md`. |

---

## 9. Evidence & open items

- `src/health.rs:32-75` — `HealthResponse`, `ReadinessResponse`, `ReadinessChecks` structures that drive `/healthz` and `/readyz`.
- `src/telemetry.rs:79-162` — telemetry publication loop that drives the uptime / resource signals.
- Open: MTBF measurement program not started. Owner: SRE lead. Target start: Q3 2026.
- Open: availability calculation today relies on cloud-side `up{job=...}` — cloud-side SLO probe not yet deployed per alert-catalogue status. Owner: observability-expert + SRE.
- Open: tenant-scoped availability rollup (per-customer dashboards) requires the tenant label contract described in [`observability.md`](./observability.md#cost-attribution).
