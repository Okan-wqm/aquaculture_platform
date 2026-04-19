# ADR-023: SL-3 Upgrade Path — Secure Boot + dm-verity + Remote Attestation + Advanced Hardening

**Status:** Proposed (opened 2026-04-19; Faz 11 opsiyonel; activation gated by trigger conditions §2)
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + security-auditor + edge-industrial-auditor + compliance-expert
**Owner:** Okan (temp — PROC-001)
**Deadline:** Activation deadline N/A (conditional opt-in); internal readiness artifacts 2026-09-30
**Related findings:** DEC-017 (SL-3 upgrade path + WASM re-eval trigger), STL-002 (IEC 62443 SL-2 → SL-3 transition)
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §5 Faz 11, §6 SL-3 opsiyonel; `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §Future Work
**Supersedes:** N/A (new capability tier)

---

## Context (WHY)

### Problem
ADR-017/018/019/020/022 toplamı **IEC 62443 SL-2 adversarial** baseline hedefliyor. ADR-020 §9 threat model table açıkça bir residual risk dokümante ediyor:

> *"Full master-key compromise → forge tail (unrelayed) → Cloud anchor exclusion (24h SLO) — NOT DETECTABLE WITHIN 24h before anchor. Within-epoch tampering after master-key compromise + before cloud relay is undetectable by device-local mechanisms. SL-2 baseline accepts this; **ADR-023 SL-3 remote attestation closes it**."*

Ek residual gaps SL-2 baseline'da kabul edilen ama SL-3 hedefleyen tenantlar için kapatılması gereken:
- Firmware binary integrity sadece ed25519 signature; saldırgan compile-time backdoor + valid signature mümkün (supply chain compromise)
- Rootfs runtime mutation mümkün (agent compromise → write to /usr, /opt); dm-verity ile read-only enforcement yok
- Time sync NTS (SL-2 baseline) precision milliseconds; PTP sub-microsecond SIL-2 hardware alignment ile uyumsuz
- Physical tamper detection yok; enclosure-open → attacker quiet SD extraction window
- Network segmentation edge fiziksel LAN'daki diğer cihazlara cross-talk serbest
- Post-quantum adversary Phase 2 migration başlanmadı (Ed25519-only)

### User direktifi + IEC 62443 SL tier model
User *"en kaliteli + güvenli + performanslı + mimari; çelik gibi"* direktifi → SL-3 hazır olmak. Ama SL-3 hardware refresh + OTP fuse factory-programming + OS re-image pipeline gerektirir — şu an kurulu fleet'te sıfır-cost değildir. Doğru architectural stance: **Faz 11 opsiyonel, tetikleyici tabanlı activation**.

### IEC 62443 SL tier farkı (SL-2 → SL-3)

| FR | SL-2 baseline (current ADRs) | SL-3 requirement (this ADR) |
|----|------------------------------|---------------------------|
| FR1 IAC | mTLS + per-operator ed25519 | + Hardware-attested identity (TPM EK) |
| FR2 UC | ABAC + two-person integrity | + Remote attestation gate on every privileged command |
| FR3 SI | ed25519 firmware + dm-verity boot_flag hash | + dm-verity full rootfs + secure boot chain OTP-rooted |
| FR4 DC | TPM sealed master + mlock | + Per-session ephemeral keys + forward secrecy |
| FR5 RDF | per-tenant MQTT topics + RLS | + Network segmentation (OT VLAN) + optional data diode |
| FR6 TRE | HMAC chain + cloud anchor | + Signed remote attestation on anomaly; sub-minute response SLO |
| FR7 RA | Gas metering + rate limits | + Physical tamper response + PTP sub-μs safety timing |

---

## Decision (WHAT)

**Faz 11 opsiyonel SL-3 upgrade — 9 component architectural roadmap; activation per-deployment conditional; not-zero-cost hardware refresh required.**

### 1. Activation triggers (§Context'te dokümante; resmi prerequisites)

SL-3 path **sadece şu koşullar gerçekleşirse tetiklenir:**

| Trigger | Threshold | Rationale |
|---------|-----------|-----------|
| **Fleet scale** | ≥500 aktif cihaz | Operational blast radius SL-3 investment justifies; under 500 SL-2 + insurance risk acceptance daha ekonomik |
| **Explicit regulatory SL-3 requirement** | Tenant contract / jurisdiction mandate | US DoD / NATO-standard mandatorily SL-3; aquaculture typical değil ama kritik altyapı listelenirse |
| **SL-2 adversarial-audit gap material** | Post-incident finding identifying within-epoch tampering residual as exploitable | Reactive activation post real-world attack |
| **High-value tenant opt-in** | Enterprise contract + premium tier | Commercial decision; per-tenant activation possible (not fleet-global) |
| **Hardware refresh cycle** | Scheduled replacement of 30%+ fleet | Opportunity to factory-program OTP fuses + TPM-enabled hardware deploy |

Activation < any threshold = SL-2 baseline remains; SL-3 work on-hold.

### 2. Secure Boot Chain (FR3 enhancement)

```
Power-on
  ↓
Boot ROM (factory-immutable)
  ↓ verifies signature
Signed Bootloader Stage 1 (U-Boot SPL) — pubkey pinned in OTP fuses
  ↓ verifies signature
Signed Bootloader Stage 2 (U-Boot) — pubkey in OTP
  ↓ verifies signature
Signed Kernel + initramfs — signed by firmware_signing_key (ADR-021 slot 1)
  ↓ verifies dm-verity root hash
Signed Rootfs (dm-verity hash tree) — read-only; tamper detected at block-read time
  ↓
/init → systemd → suderra-agent
```

**OTP fuse programming:**
- Factory-only operation; one-time programmable (irreversible)
- Pubkey SHA-256 hash burned into SoC OTP (RPi5 has OTP support; RPi4 limited)
- Post-manufacturing tampering with bootloader = signature fail = brick
- Rescue firmware provisioning requires DIFFERENT OTP key (chain of trust split)

**Hardware requirements:**
- RPi 5 + CM4 (OTP support mature)
- Revolution Pi Connect 4 (RevPi has signed-boot feature since 2024)
- Legacy RPi 4 — limited OTP; SL-3 NOT AVAILABLE on RPi 4 without external secure element (e.g., ATECC608 co-processor)

**Implementation effort:** 4-6 weeks post-hardware-refresh; requires manufacturing line integration + SSoT key ceremony ADR-021.

### 3. dm-verity Read-Only Rootfs (FR3 enhancement beyond boot_flag)

```
Signed firmware manifest (ADR-019 §1 FirmwareManifest.dmverity_root_hash)
  ↓ signed by slot 1 firmware_signing_key
Rootfs block device (/dev/mmcblk0p2 or p3)
  ↓ dm-verity layer
Read-only rootfs (runtime)
  - Every block read verified against hash tree
  - Tamper → kernel panic → auto-rollback (ADR-019 §4 install_attempts cap)
  - Writable overlay only on /var/lib/suderra + /etc/suderra (per ADR-019 §5)
```

**Difference from ADR-019 §4 boot_flag dm-verity hash:**
- ADR-019 §4: single hash over entire rootfs at boot-flag level — signed commit gate
- ADR-023: **continuous block-level verification during runtime** — detects RAM-cached tamper that survived boot
- Requires kernel config `CONFIG_DM_VERITY=y` + `CONFIG_DM_VERITY_FEC=y` (Forward Error Correction for read-error resilience)

**Operational impact:**
- Read latency overhead ~5-10% (kernel benchmark); acceptable
- Update path: dm-verity hash tree rebuilt per firmware release (CI pipeline automation)
- Debug / hot-patch DENIED at runtime; all changes via firmware update cycle

### 4. Remote Attestation (FR2 enhancement + closes ADR-020 §9 residual)

```rust
// WHY: Closes "within-epoch post-compromise tamper" residual (ADR-020 §9).
//      Platform verifies device boot chain integrity via TPM PCR quote before
//      issuing session credentials or accepting privileged commands.
// WHAT: TPM 2.0 PCR[0..11] quote signed by TPM EK (Endorsement Key); cloud verifies
//       against expected PCR values per firmware_version + firmware_signing_epoch.
// INVARIANT: tests/invariants/remote_attestation_gate.rs — simulated tampered firmware
//            → cloud rejects session credentials → edge degrades to emergency mode.

pub struct AttestationRequest {
    pub device_id: [u8; 16],
    pub firmware_version: SemVer,
    pub firmware_signing_epoch: u32,
    pub pcr_quote: PcrQuote,           // TPM2_Quote output signed by EK
    pub tpm_ek_certificate: Vec<u8>,   // X.509 cert chaining to manufacturer TPM CA
    pub nonce: [u8; 32],               // platform-provided; prevents replay
    pub timestamp_unix_ms: i64,
}

pub struct PcrQuote {
    pub pcr_indices: Vec<u8>,          // [0, 1, 2, 3, 7, 8, 9, 10, 11]
    pub pcr_values: Vec<[u8; 32]>,
    pub quote_signature: Vec<u8>,      // ed25519 or RSA per TPM
    pub nonce: [u8; 32],
}

// Cloud verification pipeline:
// 1. Verify tpm_ek_certificate chains to manufacturer TPM CA (NVIDIA / Infineon / NXP)
// 2. Verify quote_signature with EK public key
// 3. Check nonce matches platform-issued nonce (freshness)
// 4. Look up expected PCR values from edge.firmware_releases (ADR-022 §2.5)
// 5. Compare actual PCR values → mismatch = attestation FAIL
// 6. If FAIL: deny session credentials; raise CRITICAL alarm; trigger rescue firmware cutover
// 7. If PASS: issue short-lived session credentials (1-hour TTL);
//    next privileged command re-attests

// Attestation cadence:
// - On boot: mandatory attestation before first MQTT connection
// - Periodic: every 1 hour refresh (session credential expiry)
// - On anomaly: force attestation on security event (ADR-020 §9 any trigger)
// - On privileged command: UpdateFirmware / DeployProgram / ForceValue re-attest first
```

**Dependencies:**
- Hardware TPM 2.0 (RPi 5 supports; RPi 4 via external I2C TPM like SLB 9670 or Infineon Optiga SLM)
- Manufacturer TPM CA cert chain (procurement step)
- Platform-side attestation service (`apps/attestation-service/` new NestJS app)

**Closes ADR-020 §9 residual:** Before any command dispatch, platform verifies device rootfs integrity. Compromised firmware → PCR mismatch → attestation fail → no session credential → no command reaches device → no tampered audit entries generated.

### 5. Network Segmentation (FR5 enhancement)

```
Edge device network topology (SL-3):
  eth0: OT VLAN (10.100.0.0/24)
    - MQTT broker (10.100.0.10:8883)
    - Attestation service (10.100.0.20:443)
    - NTS time server (10.100.0.30:4460)
    - DEFAULT-DENY outbound except allowlisted destinations
  [No eth1 / wlan0 — physical removal or disabled via systemd-networkd]

Firewall rules (nftables):
  table inet oot_filter {
    chain input { type filter hook input priority 0; policy drop; }
    chain output { type filter hook output priority 0; policy drop;
      # Allowlist
      oif eth0 ip daddr 10.100.0.10 tcp dport 8883 accept;  # MQTT
      oif eth0 ip daddr 10.100.0.20 tcp dport 443 accept;   # attestation
      oif eth0 ip daddr 10.100.0.30 udp dport 4460 accept;  # NTS
      # Everything else rejected
    }
  }
```

**Optional: data diode (unidirectional gateway)**
- OT→IT only (sensor data, audit events egress)
- IT→OT blocked entirely (commands delivered via separate authenticated channel)
- Diode hardware: Waterfall Security WF-500 or open-source equivalent
- Use case: critical infrastructure deployments requiring NIST SP 800-82 compliance
- Trade-off: remote management complex; cloud anchor cannot push directly; firmware updates require separate physical key ceremony

**Implementation:** systemd-networkd + nftables config per deployment; ADR-022 §1 hardware_inventory.yaml declares network topology.

### 6. Physical Tamper Detection

```rust
// WHY: SL-3 assumes attacker has physical access; enclosure-opening must trigger
//      immediate security response (key zeroize + alarm before extraction window).
// WHAT: Accelerometer (MPU-6050 via I2C) detects enclosure tilt / drop / removal.
//       GPIO interrupt triggers tamper_response_handler in Rust.
// INVARIANT: tests/invariants/tamper_response.rs — simulated accelerometer trigger
//            → master key zeroized + audit entry within 100ms + cloud alarm emitted.

pub struct TamperDetector {
    accelerometer: MpuAccelerometer,
    gpio_tamper_interrupt: GpioPin,
    response_latency_ms_target: u64,  // 100ms SLO
}

impl TamperDetector {
    pub async fn handle_interrupt(&self) -> Result<()> {
        // 1. Zeroize master key (memory)
        master_key::zeroize_and_abort();
        // 2. Emit CRITICAL audit entry (before process exit)
        audit::emit_critical(AuditAction::PhysicalTamperDetected {
            detector: DetectorType::Accelerometer,
            magnitude: self.accelerometer.read_accel()?,
            timestamp: now(),
        }).await?;
        // 3. Force safe-state on all actuators
        safe_state::trip(SafeStateTrigger::TamperDetected).await?;
        // 4. Cloud alarm (MQTT publish)
        alarm::publish_critical(AlarmType::TamperDetected).await?;
        // 5. Process abort (prevents attacker from reading memory post-detection)
        std::process::abort();
    }
}
```

**Hardware requirements:**
- MPU-6050 accelerometer + gyroscope (~$3/unit)
- Mechanical enclosure design: opening triggers threshold breach
- Tamper-evident seals (physical layer — inspection-based)

**Response latency SLO:** 100ms from interrupt → key zeroized (prevents RAM extraction via cold-boot attack within window).

### 7. PTP (IEEE 1588) Sub-Microsecond Time Sync

```
NTS (ADR-018 §10) baseline accuracy: ~1-10ms (WAN-grade)
  → adequate for cert expiry, audit timestamps, TTL

PTP (IEEE 1588) sub-microsecond accuracy (~1μs LAN, ~100ns with hardware timestamping)
  → required for:
    - Safety-instrumented functions requiring tight timing correlation
      (e.g., O2 sensor reading + dosing pump response within 10ms window)
    - Multi-device event ordering without sequence ambiguity
    - SIL-2+ fault tree with time-dependent diagnostic coverage

PTP deployment:
  - Grandmaster clock: GPS-disciplined PTP server on OT VLAN
  - Edge agent PTP client via linuxptp (phc2sys + ptp4l)
  - Hardware timestamping: RPi 5 Ethernet supports; RPi 4 software-only (less accurate)
```

**Use case in aquaculture SL-3:** Tight correlation between DO sensor reading (ADR-017 §7 ST bytecode LoadTag at time T) and emergency aerator override (WriteTag at T+N). N bounded to <10ms enables fault tree claim "emergency response within SIL-2 proof test period".

**Not required unless:** SIL-2 claim formalizes timing requirement. Otherwise NTS adequate.

### 8. Formal Verification Expansion (Kani)

SL-2 baseline Kani harnesses (planda): `safe_state_reachable`, `rbac_non_bypass`, `gas_budget_saturating`.

SL-3 adds:
- **`full_safe_state_reachability.rs`:** Prove that ANY execution sequence of bytecode opcodes + runtime state transitions reaches a safe-state within bounded steps. Uses Kani bounded model checking with max depth 50.
- **`rbac_non_bypass_extended.rs`:** Prove no code path can construct `AuthorizedContext` outside `authz::verify_manifest_and_build_context` — full module graph check (extends ADR-018 §11 tier-3 test to tier-1 formal proof).
- **`gas_budget_saturating_full.rs`:** Prove `gas_remaining.saturating_sub(op.gas_cost())` terminates for any input; no overflow path; no infinite-loop via GasTick absence.
- **`secure_boot_chain_integrity.rs`:** Prove signed kernel + signed initramfs + dm-verity hash all verify before /init executes.
- **`tamper_response_latency.rs`:** Prove tamper interrupt → `master_key::zeroize_and_abort()` executes within 100ms bounded step count.

Implementation: cargo-kani in CI; dedicated `kani-proofs/` directory; nightly proof run (not every PR — too expensive).

### 9. Post-Quantum Migration Phase 2

Baseline SL-2 (ADR-021 §8 crypto agility):
- Phase 1 (2026-2027): Ed25519 active
- Phase 2 (2028): Ed25519 + ML-DSA dual-sign (PQ-transition window)
- Phase 3 (2030+): ML-DSA primary

SL-3 activation = Phase 2 accelerated to 2027:
- Rationale: SL-3 insurance + regulatory context typically requires "post-quantum ready" label
- Binary overhead: ML-DSA-65 pubkey 1952 bytes × 7 slots × 3 algorithms = ~40KB; acceptable on SL-3 hardware refresh (larger flash)
- Ceremony: ADR-021 slots 1+2+3+6+7 all ceremoniously re-keyed under ML-DSA

**WASM re-eval trigger point (per DEC-017 + ADR-017 §Alt-2):**
- At Phase 2 activation, evaluate WASM (wasmi/wasmtime) as ST runtime replacement
- Rationale: WASM + gas metering mature by 2028; PQ-signed WASM modules acceptable size
- Decision deferred to that review; if adopted, ADR-017 §Alt-2 re-eval path triggers

### 10. Sub-Minute Response SLO for Incident Containment

SL-2 baseline (ADR-021 §6): 15-min revoke propagation (audited as aspirational for offline fleet).

SL-3 upgrade:
- **Online fleet subset:** 60-second attestation-gated session invalidation
  - Compromise event → rescue_trigger published MQTT → all online devices receive within 10s (QoS 2)
  - Device refuses next attestation cycle (within 60s) → session credential invalid → no commands accepted
- **Offline fleet:** Same 7-14 day natural reconnect as SL-2 (hardware attestation on reconnect catches compromise)
- **Active-active signing:** Primary HSM + DR AWS KMS both issue revocation; redundant propagation

### 11. Hardware Requirements Summary

| SL-3 component | Hardware dependency | RPi 4 supported | RPi 5 supported | RevPi Connect 4 supported |
|----|----|----|----|----|
| Secure Boot OTP | SoC OTP fuse | Limited (32-bit) | Full (128-bit) | Full (pre-programmed) |
| dm-verity rootfs | Kernel CONFIG | Yes | Yes | Yes |
| Remote attestation TPM | TPM 2.0 hardware | External I2C TPM required | On-board (from Pi 5 w/ security chip SKU) | Full (Infineon SLB 9670 standard) |
| PTP hardware timestamp | Ethernet PHY PTP support | Software-only | Hardware | Hardware |
| Accelerometer tamper | I2C MPU-6050 | Yes (I2C-1) | Yes | Yes |
| Data diode (optional) | External hardware | N/A | N/A | N/A (external device) |

**Fleet upgrade cost:**
- RPi 4 → RPi 5 migration (or RPi 4 + external TPM retrofit): ~$80-120/device hardware + ~1 hour field ops time
- 500-device fleet: ~$40-60k hardware + ~60 engineer-days field ops
- OTP programming: one-time manufacturing line integration (~$20k setup + $5/device runtime)

---

## Alternatives Considered

### Alt-1 Mandatory SL-3 for all deployments (skip SL-2 → SL-3 direct)
Fleet refresh cost + customer lock-in; under-500-device deployments cost-inefficient. REDDEDİLDİ (opt-in tier model).

### Alt-2 Skip SL-3 entirely; stay SL-2 forever
Commercial risk: high-value customers require SL-3 (defense contractor deployments exist); regulatory landscape (NIS2 revisions 2027+) may mandate. REDDEDİLDİ (future-proofing).

### Alt-3 Partial SL-3 (secure boot only, no remote attestation)
Remote attestation is THE closure for ADR-020 §9 residual; cherry-picking individual SL-3 components without attestation leaves the key gap open. REDDEDİLDİ (integrated package).

### Alt-4 Cloud-only attestation (no local hardware TPM)
Cloud TPM services exist but require round-trip on every attestation; offline-fleet unworkable. REDDEDİLDİ (local TPM required).

---

## Consequences

### Positive
- **SL-3 adversarial closure:** ADR-020 §9 within-epoch tampering residual closed via remote attestation; full SL-3 FR1-FR7 adversarial
- **Regulatory pathway:** NIS2, NIST SP 800-82, defense contractor DFARS 252.204-7012 alignment
- **Insurance leverage:** SL-3 rated platform reduces cyber insurance premiums; enterprise tenant deal-closer
- **Future-proof:** PQ migration Phase 2 triggered; WASM re-eval window
- **Physical tamper response:** 100ms zeroize SLO closes cold-boot attack window
- **Secure boot chain:** supply-chain compromise + runtime RCE require breaking multiple independent layers (defense-in-depth SL-3)

### Negative
- **Capital expenditure:** ~$40-60k hardware + ~$20k OTP programming line + ~60 engineer-days per 500-device fleet
- **Hardware refresh cycle:** RPi 4 units EOL; deployment timeline 6-12 months fleet-wide
- **Manufacturing line integration:** OTP programming + TPM provisioning requires dedicated factory station
- **Operational complexity:** Remote attestation service (new NestJS app); PTP grandmaster deployment; network segmentation firewall rules per-site
- **Implementation timeline:** 4-6 months post-activation-decision (realistic ship date 2027 Q2 if activation 2026 Q4)
- **On-call burden:** SL-3 sub-minute response SLO requires 24/7 security operations center (SOC) integration

### Blocker relations
- **DEC-017 RESOLVED** (by this ADR)
- **ADR-017 §Alt-2 WASM re-eval** linked to Phase 2 PQ migration (2028 trigger)
- **ADR-021 PQ Phase 2** advances from 2028 to 2027 if SL-3 activated
- **ADR-022 hardware_inventory.yaml** extension — SL-3 deployments add network topology + tamper detector fields

---

## 12. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| DEC-017 | MEDIUM | This ADR as a whole | SL-3 upgrade path + WASM re-eval trigger defined |
| STL-002 (post-SL-2 baseline) | HIGH | §2-§10 | 9-component SL-3 architectural package |
| ADR-020 §9 residual (within-epoch tamper) | — | §4 remote attestation | Closes the documented SL-2 residual |
| ADR-017 §Alt-2 WASM trigger | — | §9 PQ Phase 2 | Linked activation point |

---

## 13. Implementation Plan (Plan §5 Faz 11 opsiyonel)

**Activation workflow:**

```
Trigger identified (§1) + commercial/regulatory decision
  ↓ (platform owner decision; security-lead sign-off; legal review)
Faz 11 activation plan kickoff
  ↓
Sprint 11.1 (2 weeks): Hardware procurement kickoff — RPi 5 / RevPi Connect 4 order;
  TPM co-processor procurement (if RPi 4 retrofit path)
Sprint 11.2 (4 weeks): Secure boot chain — OTP programming line setup; U-Boot signed chain;
  kernel signing in CI pipeline
Sprint 11.3 (4 weeks): dm-verity full rootfs — kernel config + hash tree generation in CI
Sprint 11.4 (6 weeks): Remote attestation — apps/attestation-service/ new NestJS app +
  TPM quote verification + platform-side cert chain
Sprint 11.5 (2 weeks): Network segmentation + firewall rules template
Sprint 11.6 (2 weeks): Physical tamper detection — MPU-6050 integration + response handler
Sprint 11.7 (4 weeks): PTP grandmaster deployment + client integration (optional per site)
Sprint 11.8 (8 weeks): Formal verification Kani harness expansion
Sprint 11.9 (ongoing): PQ Phase 2 migration (tied to ADR-021 post-rewrite)
Sprint 11.10 (2 weeks): SL-3 adversarial re-audit by external security firm
Sprint 11.11 (4 weeks): Field rollout — per-tenant staged activation

Total realistic timeline: 6-10 weeks SL-3 readiness + fleet refresh parallel 6-12 months
```

**Acceptance criteria (SL-3 Accepted per tenant):**
- All 9 components deployed + tested
- External security firm SL-3 adversarial audit pass
- Formal verification (Kani) harnesses green
- Tenant contract / regulatory requirement satisfied
- SOC integration operational
- Physical tamper drill successful (100ms zeroize verified)
- Status → per-tenant SL-3 Accepted

### Faz 11 deferral discipline
- **Tracked finding:** DEC-017 with owner + deadline 2026-09-30 internal readiness artifacts (not deployment)
- **Decision cadence:** quarterly activation review; platform-owner + security-lead
- **Partial activation:** per-tenant possible (§1 High-value tenant opt-in); not fleet-global unless all 5 triggers satisfied

---

## References

- IEC 62443-3-3 SL-3 Foundational Requirements
- TCG TPM 2.0 Library Specification + PCR Quote Protocol
- dm-verity kernel documentation (Documentation/admin-guide/device-mapper/verity.rst)
- U-Boot Verified Boot (doc/README.signature)
- IEEE 1588-2019 PTP (Precision Time Protocol)
- NIST SP 800-82 (Industrial Control Systems security)
- NIST FIPS 204 (ML-DSA post-quantum signature)
- DFARS 252.204-7012 (US defense contractor cybersecurity)
- NIS2 Directive (EU) 2022/2555
- Kani Rust Verifier: https://model-checking.github.io/kani/
- Waterfall Security WF-500 data diode (commercial reference)
- Raspberry Pi secure boot: https://www.raspberrypi.com/documentation/computers/configuration.html#secure-boot
- Revolution Pi secure boot whitepaper (KUNBUS)
- `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §Future Work / SL-3 deferral
- `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §5 Faz 11
- ADR-017 §Alt-2 WASM re-eval trigger point
- ADR-018 §11 AuthorizedContext tier-1 formal proof expansion target
- ADR-019 §4 dm-verity boot_flag (SL-2 baseline; SL-3 expands to full rootfs)
- ADR-020 §9 threat model residual (closed by §4 remote attestation)
- ADR-021 §8 crypto agility PQ migration Phase 2 trigger
- ADR-022 §1 hardware_inventory schema extension for SL-3
- `docs/security/threat-model.md` §6 IEC 62443 FR mapping (SL-2 → SL-3 transition)
