# sens-api-gateway — Use Cases

**Version:** 1.6.0 (`Cargo.toml:6`) · **Date:** 2026-04-24 · **Source commit:** `3413db47`
**Audience:** customer IT/OT team scoping a pilot; Siemens procurement validating market fit; systems-integrator sizing an install.
**Scope:** seven concrete deployment scenarios, each grounded in a real customer profile and the Rust features that serve it. Numbers shown as ranges are engineering estimates — every per-deal number is pending per-deal (quote-bound). Where a scenario depends on a feature not yet shipping, the row names the ROADMAP-Qx milestone and the tracker ID.

Each scenario declares:

1. Industry + site shape
2. Protocols on the wire
3. Expected throughput (tags × sample rate)
4. Alarm criticality class (IEC 61511 SIL-mapping hint where relevant)
5. Regulatory framework applicable
6. Why sens-api-gateway is the fit (receipts)
7. Known gaps + their ROADMAP

---

## Use-case 1 — Norwegian salmon sea-pen farm, Tier-1 producer

**Site shape.** 12 sea pens, 500 000 fish, 4 feed barges, 1 shore station. Feed-barge PLCs are a mixed fleet (Siemens S7-1200, Schneider M340, custom Modbus-TCP aerators). Network uplink: redundant 4G + Starlink, measurable minutes-per-day of loss during weather events.

**Protocols.** Modbus-TCP to aerator + O₂ injector PLCs; S7comm to feed-barge Siemens (`src/plc_programming/s7comm.rs`); MQTT v5 uplink to cloud (`Cargo.toml:33`); LoRaWAN uplink from lightweight pen-mounted sensors (`Cargo.toml:341` feature `lorawan`, `src/lora/`).

**Throughput.** ~ 2 000 tags per pen × 1 sample / 5 s = ~ 400 tags/s sustained per agent; peak during feeding window ~ 1 500 tags/s.

**Alarm criticality.** Oxygen depletion = loss of stock = CRITICAL (mapping to SIL-2 interlock). Feed-system runaway = HIGH. Biomass sonar fault = MEDIUM.

**Regulatory.** Norwegian Food Safety Authority (Mattilsynet) + ASC certification — daily water-quality submission, mortality logs, medicine use traceability. GDPR applies to crew data.

**Why sens-api-gateway.** Offline queue + SQLCipher at rest (`src/offline_queue.rs`, `Cargo.toml:94`) handles Starlink drops without losing a single reading. Signed command envelope (`src/command_envelope/`, ADR-018 §7) means a remote "adjust aerator duty-cycle" command is cryptographically accountable. HMAC audit chain (`src/audit/chain.rs`, ADR-020 §1) gives the regulator a 7-year tamper-evident record of every control action. Weather-adaptive feeding scenario (`docs/SCENARIOS_BEYOND_SCADA.md` §1) reduces FCR from ~ 1.6 to ~ 1.3 on the pilot footprint.

**Known gaps + ROADMAP.** MQTT broker authentication is user/pass today (`src/mqtt.rs:203-237`) — ROADMAP-Q2 migration to cert-is-identity per ADR-015 pattern. MindSphere uplink from the operator's head-office integration — ROADMAP per `integration/siemens/` (owned by `siemens-integration-writer`).

---

## Use-case 2 — Turkish sea-bass RAS facility (recirculating aquaculture system), Tier-2

**Site shape.** Single land-based RAS plant, 12 tanks, 120 t/yr production, full freshwater recirculation with denitrification + protein skimmer + UV + O₃ loop. Local staffing: 6 operators, 1 biologist. Network: single fibre + 4G backup.

**Protocols.** Atlas Scientific EZO pH / DO / EC / ORP / RTD (`src/atlas_ezo.rs`); Modbus-TCP to pump + blower VFDs (`src/modbus.rs`); GPIO for relay + alarm beacons (`src/gpio.rs`); MQTT v5 uplink; local SCADA display for operator HMI (`src/scada_server.rs`, feature `scada-display` — `Cargo.toml:338`).

**Throughput.** ~ 300 tags × 1 sample / 2 s = ~ 150 tags/s sustained; instantaneous bursts during dosing events.

**Alarm criticality.** DO < set-point = CRITICAL (fish die in 20 min). pH swing > 0.3 in 10 min = HIGH. Pump overload = HIGH. Chemical pump level low = MEDIUM.

**Regulatory.** Turkish KVKK (local GDPR-equivalent, crew data pseudonymisation — handled by `Cargo.toml:130` `sha2` MAC-address pseudonymisation + zeroize-on-drop secrets at `Cargo.toml:47, 293-296`); Tarım ve Orman Bakanlığı water-quality submission; HACCP for food-safety chain.

**Why sens-api-gateway.** IEC 61131-3 ST bytecode VM (`Cargo.toml:367` feature `st-bytecode`, `src/st_validator.rs`, ADR-017) lets the biologist author deterministic interlocks (e.g. "if DO < 5.5 AND pump-run-time > 30 s, open emergency aerator") without a PLC programmer. Function-block registry (`src/scripting/fb_registry.rs`, `src/scripting/function_blocks/`) has PID / MAVG / HYSTERESIS primitives. Multi-task scheduler (`Cargo.toml:372` feature `multi-task-scheduler`) keeps DO-control loop independent of alarm-broadcast loop — scan-cycle jitter is bounded. Compliance reporting scenario (`docs/SCENARIOS_BEYOND_SCADA.md` §4) auto-submits to the government portal.

**Known gaps + ROADMAP.** Modbus defense-in-depth per-register allow-list is type-only today per `docs/reviews/edge-expert/2026-04-05-s2-high-findings.md:141-198` — ROADMAP-Q2 runtime enforcement. Modbus write routing bug (`docs/reviews/orphan-findings.md#ORPHAN-008`) and analog-write truncation (`#ORPHAN-009`) — both ROADMAP-Q1 closure. Customers running mission-critical writes pre-Q1 must follow the runbook mitigation (single-device Modbus config).

---

## Use-case 3 — European freshwater trout farm with PROFINET retrofit, Tier-2

**Site shape.** Hatchery + 24 raceways + 2 offline tanks. Incoming water from spring + recirculation blend. Customer has existing Siemens S7-1500 with PROFINET-IO to the aeration controllers. A parallel non-PROFINET instrument rail carries Atlas EZO probes + older Modbus-TCP instruments.

**Protocols.** S7comm to Siemens S7-1500 (`src/plc_programming/s7comm.rs`); OPC UA client to the Siemens S7-1500 OPC UA server if the customer prefers it (`Cargo.toml:266`, `src/plc_programming/opcua.rs`, feature `opc-ua-server` — `Cargo.toml:379`); Atlas EZO (`src/atlas_ezo.rs`); Modbus-TCP (`src/modbus.rs`); MQTT v5 uplink.

**Throughput.** ~ 800 tags × 1 sample / 5 s = ~ 160 tags/s sustained.

**Alarm criticality.** Aeration loss = CRITICAL. Pump fail = HIGH. Temperature drift over hours = MEDIUM. Sediment-filter pressure rising = MEDIUM.

**Regulatory.** EU Animal Welfare + water-framework directive + national-authority traceability; EU Machinery Directive on retrofit interaction; future EU Cyber Resilience Act.

**Why sens-api-gateway.** Works alongside the S7-1500 without replacing it — sens-api-gateway is the cloud/intelligence peer, the Siemens PLC remains the safety controller. S7comm + OPC UA + Modbus + Atlas EZO in one binary avoids a second partner-component stack. Signed OTA firmware update path (`src/updater/`, ADR-019) allows controlled roll-out across the 24-raceway fleet — tracked publicly as ORPHAN-018 for documentation completeness.

**Known gaps + ROADMAP.** Native PROFINET device / IO-Device is **NOT-PLANNED** (feature-matrix §B) — the customer keeps Siemens PROFINET-IO on the S7-1500 and we peer via S7comm / OPC UA instead. Customers who require PROFINET device on the gateway itself should evaluate MindConnect Nano per `positioning.md`. Siemens-specific integration (TIA Portal GSDML export, MindSphere bridge, WinCC tag bridge) — ROADMAP owned by `integration/siemens/` (owned by `siemens-integration-writer`).

---

## Use-case 4 — Process-industry water-treatment plant (municipal)

**Site shape.** 40 ML/day potable-water treatment plant: coagulation + flocculation + sedimentation + sand + GAC + UV + chlorination. Mixed vintage PLCs (Allen-Bradley ControlLogix, Siemens S7-400, Schneider Modicon M580). Historian: legacy OSIsoft PI; customer wants modern MQTT uplink to a utility-cloud without ripping out the PLCs.

**Protocols.** EtherNet/IP to Allen-Bradley (`src/plc_programming/ethernet_ip.rs`); S7comm to Siemens (`src/plc_programming/s7comm.rs`); Modbus-TCP to Schneider + secondary VFDs (`src/modbus.rs`); MQTT uplink with signed envelopes; OPC UA server exposed to the plant HMI (`src/plc_programming/opcua.rs`, feature `opc-ua-server`).

**Throughput.** ~ 5 000 tags × 1 sample / 2 s = ~ 2 500 tags/s sustained per agent. Multi-agent deployment (one agent per process area) preferred over a single fat agent.

**Alarm criticality.** Chlorine residual out of band = CRITICAL (public-health). Turbidity exceedance = HIGH. Coagulant dose-pump fail = HIGH. Filter-run time = MEDIUM.

**Regulatory.** US SDWA (Safe Drinking Water Act) + EPA compliance reporting; EU Drinking Water Directive for EU sites. IEC 62443-4-2 SL2 expected in municipal RFPs. Customer-side: ISA-18.2 alarm KPIs.

**Why sens-api-gateway.** Multi-protocol + signed-command audit = the value proposition municipal utilities have been waiting for. Every chlorine-dose set-point change from the cloud is Ed25519-signed (`Cargo.toml:145`, `src/command_envelope/`, ADR-018 §7) and appended to the HMAC audit chain (`src/audit/chain.rs`, ADR-020 §1) — directly satisfies the "who changed that dose at 03:14 last Tuesday?" question that SDWA auditors ask.

**Known gaps + ROADMAP.** IEC 62443-4-2 SL2 badge is not held today — ROADMAP-Q3/Q4 evidence build owned by `compliance-evidence-writer`. ISA-18.2 alarm KPI report is shape-only today (`src/alarm_engine.rs:14-245`) — ROADMAP-Q3 owned by `operations-sla-writer`. Alarm-flood suppression is not yet wired — ROADMAP-Q2 (see `feature-matrix.md` §E).

---

## Use-case 5 — Pharmaceutical cleanroom HVAC + utility monitoring

**Site shape.** GMP cleanroom cluster (ISO 14644-1 class 5-8). HVAC + chilled water + compressed air + WFI (water-for-injection) loop. Monitoring feeds a 21 CFR Part 11 electronic-batch-record system.

**Protocols.** Modbus-TCP to HVAC VFDs + chiller controllers; OPC UA client to Siemens S7 PCS + Beckhoff TwinCAT via ADS (`src/plc_programming/ads.rs`); MQTT uplink with signed + chained audit; LoRaWAN for battery-powered differential-pressure sensors (`Cargo.toml:341` feature `lorawan`).

**Throughput.** ~ 1 500 tags × 1 sample / 10 s = ~ 150 tags/s sustained; 5× burst on alarm.

**Alarm criticality.** Pressure-cascade reversal in aseptic zone = CRITICAL (batch loss). Differential-pressure drop = HIGH. Chiller fault = HIGH. Filter-life countdown = MEDIUM.

**Regulatory.** 21 CFR Part 11 (electronic records + signatures); EU Annex 11; ISPE GAMP 5 computerised-systems validation; ISO 14644-1 + ISO 14644-2.

**Why sens-api-gateway.** 21 CFR Part 11 maps almost line-for-line onto the HMAC audit chain (ADR-020 §1 + §3a fcntl immutable + §10a 7-yr retention), signed command envelope (ADR-018 §7), and the `i_accept_file_backed_keystore_risk` operator-acceptance gate in the Tier 3 keystore path (`src/keystore/acceptance.rs`, ADR-019 §7). The audit chain's Forward-Secure Sealing path via `tracing-journald` (`Cargo.toml:234`, ADR-019 §5) gives the validation team the tamper-evidence primitive GAMP 5 assessors ask about.

**Known gaps + ROADMAP.** The IEC 62443-4-1 SDLA evidence build is in progress (ROADMAP-Q3 owned by `compliance-evidence-writer`) — customers running a formal GxP qualification must review the evidence package status at contract time. OTA firmware update documentation is under construction per `docs/reviews/orphan-findings.md#ORPHAN-018` — ROADMAP-Q2.

---

## Use-case 6 — Microalgae photobioreactor multi-site producer

**Site shape.** 5 sites × 4 photobioreactors each (20 PBRs total). Each PBR has turbidity, pH, DO, CO₂ injection, light-panel control, harvest valve. Electricity is the dominant operating cost; renewable + grid blend varies by site.

**Protocols.** Modbus-TCP to PBR controller + CO₂ mass-flow; Atlas EZO for pH / DO (`src/atlas_ezo.rs`); PWM for light-panel dimming (`src/pwm.rs`); MQTT v5 uplink with per-site tenant separation; cloud-to-device recipe push via signed command envelope.

**Throughput.** ~ 400 tags × 1 sample / 10 s = ~ 40 tags/s sustained per agent; 20 agents → ~ 800 tags/s aggregate.

**Alarm criticality.** CO₂ line fault = HIGH (batch loss). pH swing = HIGH. Turbidity flatline (dead batch) = MEDIUM. Light-panel failure = LOW.

**Regulatory.** Regional food/feed-grade regulator (EFSA / FDA depending on product target); trace-matrix for food-grade output; EU Cyber Resilience Act posture relevant for product claim.

**Why sens-api-gateway.** Electricity-spot-price optimisation (`docs/SCENARIOS_BEYOND_SCADA.md` §2) translates to ~ 20-30 % energy savings on the light-panel + CO₂-blower load when paired with a spot-price API. Multi-site comparison (scenario §3) benchmarks OD/day and yield across the 20-reactor fleet — the cloud pushes best-practice recipes back to the laggards via signed envelopes (`src/command_envelope/`). Harvest-date prediction (scenario §5) shifts harvest timing to hit market-price windows.

**Known gaps + ROADMAP.** Algorithm-confusion-safe JWT validation for licence claims is PRESENT (`Cargo.toml:245-252`, `Validation::new(Algorithm::EdDSA)` pinned) — but the CI AST grep gate (`tests/invariants/jwt_alg_pinning.rs`) is per BATCH-001-FINDING-005 closure; customers running a third-party audit should confirm the gate is green at contract time. Prometheus metrics are wired as crates (`Cargo.toml:310-311`) but currently unused — ROADMAP-Q3.

---

## Use-case 7 — Greenhouse / controlled-environment agriculture (tomato / leafy greens)

**Site shape.** 5 ha Venlo-style greenhouse, 6 climate zones, 2 irrigation loops, CHP unit + thermal-storage buffer. Existing climate computer (Priva / Hoogendoorn). Owner wants modern multi-zone analytics + ERP/supplier integration without replacing the climate computer.

**Protocols.** Modbus-TCP to climate computer gateway; OPC UA client to the climate computer's OPC UA server where available (`src/plc_programming/opcua.rs`); GPIO + PWM for ancillary relays (`src/gpio.rs`, `src/pwm.rs`); MQTT uplink.

**Throughput.** ~ 1 200 tags × 1 sample / 5 s = ~ 240 tags/s sustained.

**Alarm criticality.** Temperature runaway = HIGH. Irrigation pump fail = HIGH. CO₂ level drift = MEDIUM. Screen-actuator jam = LOW.

**Regulatory.** GlobalG.A.P. traceability; EU Integrated Pest Management directive; national water-abstraction permits.

**Why sens-api-gateway.** Weather-adaptive operation scenario (`docs/SCENARIOS_BEYOND_SCADA.md` §1) feeds forecast data into set-point optimisation. Supply-chain integration scenario (§7) auto-creates purchase requisitions for CO₂ + fertigation nutrients when silo levels fall below days-remaining threshold. Multi-channel alerting (§6) dispatches to the grower's phone + the agronomist's Slack simultaneously.

**Known gaps + ROADMAP.** No direct Priva / Hoogendoorn native integration — agent peers via the climate computer's Modbus + OPC UA surfaces. Customers requiring a direct Priva integration should engage commercial evaluation (handled in `commercial/`, owned by `commercial-legal-writer`). GlobalG.A.P. certification scope at the edge is not-a-direct-claim; the evidence trail (HMAC audit chain) supports auditor requests.

---

## Summary — scenario × feature fit

| Scenario | Core agent features used today | Features pending per ROADMAP |
|----------|-------------------------------|------------------------------|
| 1. Salmon sea-pen | Offline queue, LoRaWAN, signed envelope, audit chain | MQTT mTLS (Q2), MindSphere (siemens-integration-writer) |
| 2. Turkish RAS | ST bytecode, multi-task scheduler, SCADA display, Atlas EZO | Modbus allow-list runtime (Q2), ORPHAN-008 / ORPHAN-009 (Q1) |
| 3. EU trout + S7 retrofit | S7comm, OPC UA client, OTA updater | OTA doc (Q2 / ORPHAN-018), MindSphere bridge |
| 4. Municipal water treatment | EtherNet/IP, S7comm, signed envelope, audit chain | IEC 62443-4-2 SL2 (Q3/Q4), ISA-18.2 KPI (Q3) |
| 5. Pharma cleanroom | Beckhoff ADS, LoRaWAN, audit chain, keystore Tier 3 | IEC 62443-4-1 SDLA (Q3), OTA doc (Q2) |
| 6. Microalgae multi-site | Spot-price script, signed recipe push, multi-site bench | Prometheus metrics (Q3), SBOM (Q2) |
| 7. Greenhouse / CEA | Weather-adaptive, ERP supply chain, multi-channel alert | Direct Priva integration (commercial evaluation) |

## Evidence

- `Cargo.toml:6, 33, 47, 70, 94, 116, 130, 145, 234, 252, 266, 286-296, 293-296, 310-311, 326, 328, 338, 341, 355, 361, 367, 372, 379, 392-397`
- `sens-api-gateway/src/alarm_engine.rs:14-245`
- `sens-api-gateway/src/atlas_ezo.rs`
- `sens-api-gateway/src/audit/chain.rs`, `src/audit/entry.rs`
- `sens-api-gateway/src/command_envelope/` (canonical.rs, envelope.rs, jti.rs, mutating.rs)
- `sens-api-gateway/src/gpio.rs`, `src/i2c.rs`, `src/spi.rs`, `src/pwm.rs`
- `sens-api-gateway/src/keystore/` (acceptance.rs, error.rs, purpose.rs, secret.rs)
- `sens-api-gateway/src/lora/` (codec.rs, crypto.rs, mac.rs, session.rs, sx1302.rs, types.rs)
- `sens-api-gateway/src/modbus.rs`, `src/mqtt.rs:203-237`, `src/offline_queue.rs`, `src/scada_db.rs`
- `sens-api-gateway/src/mtls/` (cipher.rs, mode.rs, pinning.rs, verify.rs)
- `sens-api-gateway/src/plc_programming/` (ads.rs, codesys.rs, ethernet_ip.rs, opcua.rs, s7comm.rs)
- `sens-api-gateway/src/scada_server.rs`, `src/scada_types.rs`
- `sens-api-gateway/src/scripting/` (engine.rs, actions.rs, conflict.rs, fb_registry.rs, function_blocks/, limits.rs, parallel.rs, persistence.rs, storage.rs, triggers.rs)
- `sens-api-gateway/src/st_validator.rs`
- `sens-api-gateway/src/updater/` (error.rs, manifest.rs, partition.rs, verify.rs)
- `sens-api-gateway/docs/SCENARIOS_BEYOND_SCADA.md` — seven scenario catalogue
- `docs/adr/017-st-bytecode-runtime.md`, `018-edge-rbac-abac-model.md`, `019-edge-firmware-signing-ab-partition.md`, `020-audit-log-hmac-chain.md`, `021-platform-key-ceremony-lifecycle.md`, `023-sl3-upgrade-path.md`
- `docs/reviews/edge-expert/2026-04-05-s2-high-findings.md:141-198` — Modbus defense-in-depth runtime status
- `docs/reviews/orphan-findings.md#ORPHAN-008`, `#ORPHAN-009`, `#ORPHAN-018` — tracked work referenced above
