# CE / UL / FCC / RED — Regulatory Mapping

**Scope:** Regulatory marks applicable to `suderra-agent` v1.6.0 as a software component sold alongside OEM hardware. Where a mark is hardware-vendor responsibility, this chapter records the interface boundary and cites the hardware partner's evidence path.

## CE Marking — Machinery Directive 2023/1230 (EU)

**Status:** PARTIAL — cyber-security clauses of the new Machinery Regulation (EU) 2023/1230 map directly to the IEC 62443-4-2 FR3 evidence in [iec62443-4-2-gap.md](./iec62443-4-2-gap.md). Final CE dossier compilation is the OEM integrator's responsibility; this chapter supplies the software-component half.

| Annex III clause (cyber) | Requirement | Status | Evidence |
|--------------------------|-------------|--------|----------|
| 1.1.9 Protection against corruption | Safety functions shall not be compromised by intentional or unintentional corruption | PASS | `src/process_image.rs` typed tag system, `src/bounded.rs` domain-bound numeric types, `src/config_integrity/` signed config manifest (ADR-026), HMAC-chained audit (ADR-020). See FR3 row of [iec62443-4-2-gap.md](./iec62443-4-2-gap.md). |
| 1.1.9 RE — Continuity of safe behaviour | The machinery / system shall remain in a safe state if corruption is detected | PASS | `src/safe_state.rs:1-414` + `src/safe_state_v2.rs` — fail-safe actuator state on fault |
| 1.2.1 Safety + reliability of control systems | Control systems shall ensure that, in the event of component failure, a hazardous situation does not arise | PASS | `src/resilience/` circuit breakers + retry budgets, `src/watchdog` integration in `src/main.rs`, systemd `WatchdogSec` |
| 1.2.2 Control devices | Control devices shall be designed to prevent unintentional operation | PASS | Multi-party authorization for high-severity actuator writes is ROADMAP (see FR1 SL3 row of [iec62443-4-2-gap.md](./iec62443-4-2-gap.md)); single-operator RBAC + signed envelope PASS at SL2. |
| 1.2.4 Stopping | Emergency stop shall override all other functions | HARDWARE-VENDOR RESPONSIBILITY | E-stop is a hardware-wired safety circuit — not a software function. The agent observes E-stop state via GPIO input and transitions to safe state; it does not *implement* E-stop. Partner: OEM integrator (owner: edge-agent maintainers, deadline: per-deployment commissioning). |

**CE cyber dossier delivery:** The FR1-FR7 gap table in [iec62443-4-2-gap.md](./iec62443-4-2-gap.md) is the primary artefact a notified body reviews for the Machinery Regulation cyber clauses. The RED Art 3.3 dossier below is the other half (radio equipment).

## UL 2900-2-2 — Network-Connectable Products in Industrial Automation

**Status:** PARTIAL — IEC 62443-4-2 FR1-FR7 evidence is the primary body of evidence UL auditors accept. Formal UL 2900-2-2 certification is ROADMAP 12-month horizon.

| UL 2900-2-2 clause | Requirement | Mapped evidence |
|--------------------|-------------|-----------------|
| §5 Software weakness analysis | Assessment against CWE / SANS Top 25 | `cargo audit` + `cargo deny` CI gates; SVV-3 / SVV-4 row of [iec62443-4-1-sdla.md](./iec62443-4-1-sdla.md) (pentest ROADMAP-Q3) |
| §6 Security risk controls | Authentication, authorization, remote-comm security, software updates | FR1 / FR2 / FR4 / FR5 rows of [iec62443-4-2-gap.md](./iec62443-4-2-gap.md) |
| §7 Cryptographic requirements | Algorithms must meet NIST SP 800-131A Rev 2 | `docs/security/crypto-inventory.md` (FR4 evidence) — TLS 1.3, Ed25519, HKDF-SHA-256, BLAKE3, ChaCha20-Poly1305, AES-256-GCM |
| §8 Structured penetration testing | Independent penetration test | GAP — ROADMAP-Q3 (paired with SVV-4 from SDLA) |

## FCC Part 15 — Radio-Frequency Devices (United States)

**Status:** HARDWARE-VENDOR RESPONSIBILITY.

FCC Part 15 applies to unintentional radiators (Part 15 Subpart B) and intentional radiators (Part 15 Subpart C — LoRa, Wi-Fi, Bluetooth). `suderra-agent` is a software component; the FCC Part 15 declaration is filed by the OEM hardware partner for the specific platform SKU (ARMv7 gateway, aarch64 gateway). This chapter records the software-side obligations:

- LoRaWAN regional configuration (`src/lora/`) must restrict transmit-power, duty-cycle, and channel plan to the hardware partner's certified values — configured per device via provisioning, not adjustable post-deployment.
- Wi-Fi / Bluetooth radio management is handled by the host OS (systemd-networkd / iwd / bluetoothd) — not by the agent — and inherits the hardware partner's certified radio firmware.

**Deliverable:** the hardware partner's FCC Part 15 ID is recorded on the unit nameplate; this software does not alter the certified radio configuration. (Owner: edge-agent maintainers + OEM partner, deadline: per-SKU certification.)

## Radio Equipment Directive (RED) Article 3.3(d)(e)(f) — Mandatory since 2025-08-01 (EU)

**Status:** PARTIAL — cyber dossier assembled from IEC 62443 evidence; ROADMAP work: RED-specific test report format (ETSI EN 303 645 + EN 18031-1/-2/-3) and notified-body engagement.

| RED clause | Requirement (summary) | Evidence |
|------------|-----------------------|----------|
| Art 3.3(d) — Network harm prevention | Radio equipment shall not harm the network or its functioning nor misuse network resources | FR5 (Restricted Data Flow) + FR7 (Resource Availability) rows of [iec62443-4-2-gap.md](./iec62443-4-2-gap.md); outbound-only MQTT; circuit breakers + retry budgets in `src/resilience/` |
| Art 3.3(e) — Protection of personal data & privacy | Radio equipment incorporates safeguards to ensure protection of personal data and privacy | `docs/compliance/gdpr-kvkk-dpia.md` — MAC-address SHA-256 hashing via `src/provisioning.rs`, operator-PIN + RBAC actor masking in audit-log (`src/audit/entry.rs`), per-purpose key derivation (`src/keystore/purpose.rs`) |
| Art 3.3(f) — Fraud prevention | Radio equipment supports certain features ensuring protection from fraud | FR1 (Identification & Authentication) + FR3 (System Integrity) — mTLS cert identity, signed command envelope (ADR-024), HMAC-chained audit (ADR-020), signed config manifest (ADR-026) |

**Harmonized standards for RED 3.3 evidence:**

- **EN 18031-1** (common security requirements for radio equipment) — PARTIAL, mapped via IEC 62443-4-2 FR1-FR7.
- **EN 18031-2** (radio equipment processing personal data) — PARTIAL, mapped via GDPR / KVKK DPIA chapter.
- **EN 18031-3** (radio equipment handling virtual money / monetary value transfer) — NOT APPLICABLE (no payment or wallet function in the agent).
- **ETSI EN 303 645** (consumer-IoT baseline) — not strictly required for an industrial gateway but adopted as good practice; 13 / 13 top-level provisions mapped below.

### ETSI EN 303 645 provisional mapping

| Provision | Summary | Status | Evidence |
|-----------|---------|--------|----------|
| 5.1 — No universal default passwords | Device shall not ship with universal default credentials | PASS | Device identity is provisioned per-unit via mTLS cert + per-device SQLCipher key (`src/keystore/`); no factory default password exists |
| 5.2 — Vulnerability disclosure policy | Maintain disclosure contact + CVD process | PASS | `docs/security/cvd-policy.md` (ISO/IEC 30111 aligned), `.github/SECURITY.md` |
| 5.3 — Keep software updated | Security update mechanism + defined support period | GAP | OTA channel ORPHAN-EDGE-018; support-period SLA ROADMAP-Q3 |
| 5.4 — Securely store sensitive security parameters | Credentials + keys not stored in clear | PASS | `src/keystore/secret.rs` + SQLCipher at-rest encryption (AES-256) |
| 5.5 — Communicate securely | In-transit encryption for security-relevant data | PASS | TLS 1.3 everywhere; OpenSSL banned at Cargo deny layer |
| 5.6 — Minimize exposed attack surfaces | Only necessary services enabled by default | PASS | Outbound-only cloud uplink; no inbound WAN listener; systemd sandbox `SystemCallFilter` |
| 5.7 — Ensure software integrity | Verify software integrity via secure-boot + runtime checks | PARTIAL | Secure-boot hooks (ADR-019) — runtime verification ROADMAP paired with ORPHAN-EDGE-018 |
| 5.8 — Ensure personal data is secure | Protect personal data in processing | PASS | GDPR / KVKK DPIA chapter |
| 5.9 — Make systems resilient to outages | Continue operating during network outages | PASS | `src/offline_queue.rs`, `src/mqtt_failover.rs`, `src/safe_state.rs` |
| 5.10 — Examine system telemetry data | Telemetry available to operator + protected against tampering | PASS | HMAC-chained audit (`src/audit/chain.rs`) |
| 5.11 — Make it easy for users to delete personal data | Data deletion mechanism | PARTIAL | Tenant-termination cascade (ORPHAN-EDGE `eraseTenantData` handler) ROADMAP — see GDPR/KVKK chapter |
| 5.12 — Make installation and maintenance easy | Install + update usability | PARTIAL | `deployment-runbook-writer` owns — ROADMAP-Q2 |
| 5.13 — Validate input data | Input validation per protocol | PASS | `src/bounded.rs`, `src/process_image.rs`, protocol codecs in `sensorprotocols/` |

## Environmental & EMC Standards — out of this chapter

IEC 60068 environmental testing and IEC 61000-4 EMC testing are handled by `test-evidence-writer` and the hardware partner's certification dossier. This chapter does not duplicate. Reference: `docs/testing/environmental-emc.md` (ROADMAP by `test-evidence-writer`).

## Cross-references

- [iec62443-4-2-gap.md](./iec62443-4-2-gap.md) — primary FR evidence consumed by CE + UL + RED dossiers.
- [gdpr-kvkk-dpia.md](./gdpr-kvkk-dpia.md) — RED Art 3.3(e) + EN 303 645 §5.8 + §5.11 evidence.
- `docs/security/crypto-inventory.md` — UL 2900-2-2 §7 + RED 3.3(f) + EN 303 645 §5.5 evidence.
- `docs/reviews/orphan-findings.md#ORPHAN-018` (OTA signing) — blocker for EN 303 645 §5.7.

Compliance snapshot: 2026-04-24, v1.6.0, HEAD=3413db47
