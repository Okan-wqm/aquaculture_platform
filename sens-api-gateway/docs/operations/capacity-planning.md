# Capacity Planning — `sens-api-gateway` v1.6.0

**Audience:** pre-sales engineer, solution architect, plant-IT sizing a new site.

**Purpose:** give a defensible sizing recommendation per site profile — hardware class, sensor count, tag rate, offline-queue capacity, broker throughput expectation.

**Numbers discipline:** each sizing figure below is either **measured** on a test rig (date + reference) or **conservatively projected** from the per-protocol throughput in [`../architecture/performance-envelope.md`](../architecture/performance-envelope.md) with a clear safety margin. No untested numbers appear as committed figures.

---

## 1. Site profile matrix

| Profile | Sensor count | Peak tag rate | Hardware class | Edge agent instances | Redundancy | Example customer shape |
|---------|--------------|---------------|----------------|----------------------|------------|------------------------|
| **Small farm** | < 50 | < 100 tags/s | RPi 4 2 GB + 16 GB SD (or 32 GB for longer offline buffer) | 1 | optional hot-spare | single-pond aquaculture, small hydroponic greenhouse |
| **Medium farm** | 50–500 | 100 tags/s – 1 k tags/s | RPi 5 4 GB OR RevPi Connect 4 | 1 (active) + optional 1 (passive) | recommended passive-replica | multi-pond farm, medium greenhouse, small processing line |
| **Large farm / multi-pond** | 500–5 000 | 1 k tags/s – 10 k tags/s | x86 industrial PC (4-core 8 GB RAM min) | 2+ per site (zone split) | active/active pair | multi-site aquaculture operation, large hydroponic facility |
| **Process plant** | > 5 000 | > 10 k tags/s | custom sizing | per-process-area architecture | active/active per zone + HA broker | food / feed processing, chemical-dosing plant — consultation required |

---

## 2. Hardware class sizing detail

### 2.1 Small farm — RPi 4 2 GB / 16 GB SD

**Workload assumption:** ≤ 50 sensors, ≤ 100 tags/s peak, 8 protocol-mix scenarios.

| Resource | Target baseline | Peak budget | Headroom |
|----------|-----------------|-------------|----------|
| CPU | < 15% | < 40% | 60% free for OTA / safe-state / spikes |
| RAM | < 600 MB | < 1.2 GB | 800 MB free |
| Disk `/var` | < 30% | < 60% | offline-queue WAL sized per §3 |
| Network out | < 50 KB/s | < 200 KB/s | wifi / cell links comfortable |

**Notes:**
- 16 GB SD is the floor. For sites with > 1-day WAN outage history, bump to 32 GB (offline-queue survival, see §3).
- SD-card wear: use industrial-grade (SLC or pSLC) SD. Consumer SD cards fail within 6–12 months at this write volume.

### 2.2 Medium farm — RPi 5 4 GB OR RevPi Connect 4

**Workload assumption:** 50–500 sensors, 100 tags/s – 1 k tags/s.

RevPi Connect 4 is preferred for regulated / industrial sites (CE-industrial enclosure, DIN-rail, dual Ethernet). RPi 5 is acceptable for non-regulated use.

| Resource | Target baseline | Peak budget |
|----------|-----------------|-------------|
| CPU | < 25% | < 55% |
| RAM | < 1.2 GB | < 2.4 GB |
| Disk | 64 GB min (eMMC or industrial SD) | 128 GB recommended |
| Network out | < 300 KB/s | < 1 MB/s |

**Redundancy recommendation:** a passive-replica edge agent on a second device, sharing the broker ACL. Cold-standby (manual failover) is acceptable at this tier; automatic active-passive requires the v1.8 HA work (ROADMAP).

### 2.3 Large farm / multi-pond — x86 industrial PC

**Workload assumption:** 500–5 000 sensors, 1 k tags/s – 10 k tags/s.

| Resource | Target baseline | Peak budget |
|----------|-----------------|-------------|
| CPU (4-core 2.4 GHz+) | < 30% | < 60% |
| RAM | < 3 GB | < 6 GB |
| Disk (SSD, 256 GB min) | < 30% | < 60% |
| Network out | < 2 MB/s | < 10 MB/s |

**Zone split:** a single agent instance does NOT scale past 10 k tags/s in the v1.6.0 runtime. Split sensors across 2–4 agent instances per site, each owning a "zone" (subset of sensors + one MQTT client-id). Coordinate via the control plane.

**Broker:** site-local MQTT broker recommended (Mosquitto cluster, 2-node) to localise the reconnect path. Agent → local broker → site-uplink bridge → cloud broker.

### 2.4 Process plant — custom

Process plants (feed mills, chemical dosing, pharma-adjacent) carry safety and regulatory constraints not covered by a generic sizing guide. Engage the solution architect team for:

- Redundancy target (N+1 vs 2oo3 per safety instrumented function, if applicable).
- On-site HA broker vs edge-to-cloud direct.
- Audit-chain retention requirements (regulated data tends to need longer retention and formal tamper-evidence).
- EMC / Ex / ATEX zone classification for the hardware.

---

## 3. Offline-queue sizing

The offline queue (`src/offline_queue.rs`) is the edge-side buffer that protects against WAN outages. Sizing is driven by three inputs:

```
capacity_bytes = (tag_rate_per_sec)
               × (avg_payload_bytes)
               × (worst_observed_wan_outage_sec)
               × (safety_margin)
```

Recommended inputs:

| Input | Small farm | Medium farm | Large farm | Process plant |
|-------|------------|-------------|------------|---------------|
| `tag_rate_per_sec` | 100 | 1 000 | 10 000 | custom |
| `avg_payload_bytes` | 300 (JSON + headers) | 300 | 300 | custom |
| `worst_observed_wan_outage_sec` | 24 h = 86 400 | 24 h = 86 400 | 4 h = 14 400 (large farms typically have better links) | site-specific |
| `safety_margin` | 1.5× | 1.5× | 1.5× | 2.0× |
| → **capacity_bytes** | ≈ 3.9 GB | ≈ 39 GB | ≈ 65 GB | custom |
| → **recommended disk provision** | 8 GB disk region | 64 GB disk region | 128 GB disk region | custom |

Disk provision is a region, not a number exactly matching capacity — the queue co-exists with logs, OTA staging, and backup snapshots. Provision the region at **2× computed capacity** to leave operational headroom.

**Worst-observed-outage guidance:** pull the last 12 months of WAN uptime data for the site. If data is unavailable, start with 24 h and adjust after 90 days of production telemetry.

---

## 4. Protocol-mix sensitivity

Capacity planning scales by **tag rate**, not just sensor count. A 50-sensor site polling at 10 Hz is 500 tags/s; a 500-sensor site polling at 1 Hz is the same 500 tags/s load.

| Protocol | Typical tag rate per peer | Capacity multiplier vs Modbus-TCP baseline |
|----------|---------------------------|--------------------------------------------|
| Modbus-TCP (reference) | 20–100 tags/s per peer | 1.0× |
| Modbus-RTU (serial) | 5–50 tags/s per peer | 1.2× (serial framing overhead) |
| OPC UA subscriptions | 50–500 tags/s per connection | 0.8× (push model, lower CPU) |
| S7comm (Siemens) | 20–100 tags/s | 1.1× |
| MQTT subscribe (bridged PLC → MQTT) | 100–1000 tags/s | 0.7× (streaming, lowest CPU) |
| I2C / SPI / GPIO direct | 1–10 tags/s per device | 1.5× (kernel-call overhead) |
| Atlas EZO | 1 tag/s per sensor | 1.0× (low rate) |

A protocol-heavy mix (e.g. many Modbus-RTU chains) pushes sizing upward; an OPC UA / MQTT-bridged mix pushes it downward.

---

## 5. Broker throughput budget

| Profile | MQTT publish rate (device → broker) | Broker sizing recommendation |
|---------|-------------------------------------|------------------------------|
| Small farm | < 200 msgs/s | single Mosquitto, 1 GB RAM, cloud-side |
| Medium farm | 200–2 000 msgs/s | single Mosquitto, 4 GB RAM, cloud-side, plus site-local bridge option |
| Large farm | 2 000–20 000 msgs/s | Mosquitto cluster (2 nodes) site-local + cloud-side cluster; bridge topology |
| Process plant | > 20 000 msgs/s | Production-grade broker (EMQX / HiveMQ) cluster, site-local + cloud-side, with MQTT v5 shared subscriptions for load distribution |

**Note:** `sens-api-gateway` is broker-agnostic over MQTT v3.1.1 / v5. Broker choice is a customer decision; the edge agent's contract is on the wire (see [`../protocols/mqtt.md`](../protocols/)).

---

## 6. Growth headroom rule

A sized site should run at **< 50% of its peak budget** at steady state. The delta is growth headroom and absorbs:

- Year-on-year sensor additions (typical 15–25% growth).
- New protocol driver onboarding (adds steady CPU baseline).
- Safety-adjacent features that land over the v1.6 → v1.8 window (audit chain, HA failover).
- Seasonal traffic peaks.

At steady-state > 60% of peak budget, a capacity review is triggered (regardless of absolute numbers).

---

## 7. Sizing worksheet (pre-sales template)

A copy of this table is attached to every sizing proposal:

```
Site name: _______________________
Site profile (small / medium / large / process): _______________________

Sensor inventory:
  Modbus-TCP sensors: ____  × avg poll rate: ____ Hz → ____ tags/s
  Modbus-RTU sensors: ____  × avg poll rate: ____ Hz → ____ tags/s
  OPC UA subscriptions: ____ × rate: ____ Hz → ____ tags/s
  S7comm / EtherNet/IP / other: ____ × ____ → ____ tags/s
  MQTT-bridged: ____ × ____ → ____ tags/s
  Direct I/O (I2C / GPIO / SPI / PWM / Atlas EZO): ____ × ____ → ____ tags/s

Total tag rate (sum): ____ tags/s   ← use this to pick hardware class
Worst observed WAN outage (last 12 mo): ____ sec
Offline-queue capacity required: ____ GB   ← formula in §3
Disk provision (2× capacity): ____ GB

Hardware class recommended: ____
Redundancy tier: _________ (single / passive-replica / active-active)
Broker topology: _________ (cloud-only / site-local single / site-local cluster)
```

---

## 8. Evidence & open items

- `src/offline_queue.rs` — disk-backed FIFO, the primary buffer that sizing protects.
- `src/telemetry.rs:79-162` — the resource signals that confirm whether a sized device is within budget.
- Open: per-protocol throughput numbers in §4 are conservative estimates; the v1.7.0 performance-envelope chapter ([`../architecture/performance-envelope.md`](../architecture/performance-envelope.md)) formalises measured values per protocol. Until that chapter is authoritative, treat §4 as a planning estimate + apply the 50% headroom rule.
- Open: process-plant sizing annex (ATEX / SIL classification) — ROADMAP Q4 2026.
