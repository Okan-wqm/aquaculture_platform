# ADR-024: Edge Hardware Adapter Inventory + Safe-State Schema v2 + Append-Only Signed Class Binding + Effect-Based Permissions

**Status:** Proposed (opened 2026-04-19; rewritten post-audit 2026-04-19 — 4 CRITICAL + 8 HIGH + 8 MEDIUM closed in §13 closure table; target Accepted 2026-06-07 post-implementation deps)
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + edge-expert + edge-industrial-auditor + sensor-expert + auth-security-expert + legal counsel
**Owner:** Okan (temp — PROC-001)
**Deadline:** 2026-06-07 (internal architecture + test harnesses; inventory populate + legal review parallel ops work)
**Related findings:** DEC-005, ARC-004, STL-003, DEC-022 (this ADR's rewrite remediation)
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §5 Faz 0-1; `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.5 D-5 REVİZE MAJOR

---

## Context (WHY)

### Problem
ADR-024 v1 (written 2026-04-19 earlier) audited NEEDS_MAJOR_REVISION by edge-industrial-auditor. 4 active LIFE-SAFETY bugs:
1. Aerator fail-safe §1 "on_ac_loss_to_off" vs §7 "fail-ON 90%" contradiction (integrator misread → fish kill)
2. `hardware_inventory.yaml` lookup mutable (attacker reclassifies tag → AffectActuator bypass)
3. `Chemistry` class single fail-OFF default (O2 dosing catastrophic)
4. `backup_path` dual-Modbus = single-point-failure (SIL-2 FR3 fails; IEC 61508-2 §7.4.3.4 requires diverse redundancy)

Architectural decision pending external inputs (field-ops topology survey, legal review) **does NOT block architectural decision** — user direktifi "sonraya bırakma yok + arkadan dolanma yok" gereği. Schema + invariant definition verilir; YAML populate implementation-phase ops work.

### Post-audit rewrite — Option architecture
**User direktifi:** yama değil schema redesign. Bu rewrite:
1. ActuatorClass enum expansion + `::Normal` / `::LifeSupport` variant split
2. `is_life_support: bool` flag orthogonal
3. Append-only signed class-binding log (per-tuple ed25519 signature, NOT whole-YAML)
4. Explicit FailSafe enum (schema-bound, not string)
5. Diversity_class enum per backup_path (SameTransport banned for LifeSupport)
6. `HardwiredSafetyOverride` first-class OutputTag variant
7. Binary-const per-SKU caps via `const_table!` macro
8. Type-system RFID auth ban (OperatorId constructor module-private)
9. "SIL-2-informed design" wording (not certified)
10. Engineer attestation structured schema
11. `fail_safe_latency: Option<u32>` (None for latch-preserve)
12. FailSafeOnStale semantics for ProcessAware + InterlockWith
13. ScheduleDependent clock_trust_mode
14. Atlas EZO calibration_policy explicit

---

## Decision (WHAT)

### 1. ActuatorClass extended enum + LifeSupport orthogonal flag

```rust
// WHY: v1 single "Chemistry" class catastrophic for O2 dosing; missing classes
//      (Thermal, Recirculation, WasteRemoval) force mis-classification. Extended
//      enum + orthogonal life_support flag solves both.
// INVARIANT: tests/invariants/actuator_class_enum_closed.rs — enum additions
//            require ADR amendment (closed-set discipline ADR-017 pattern).

pub enum ActuatorClass {
    Aeration(AerationSubClass),
    Chemistry(ChemistrySubClass),
    Filtration,
    Lighting,
    Feeding,
    Thermal(ThermalSubClass),            // NEW (MEDIUM-001)
    Recirculation,                       // NEW — RAS main flow, core life-support
    WasteRemoval,                        // NEW — sludge pumps, drum filter backwash
    Degassing,                           // NEW — CO2 stripping, blowers
    EmergencyContainment,                // NEW — drain/spill-containment valves
    Inventory,                           // non-actuator (RFID asset tags, passive)
}

pub enum AerationSubClass {
    Normal,       // fail-OFF acceptable when DualPath redundancy exists
    LifeSupport,  // fail-ON mandatory (stocking density > threshold OR DO sensor below setpoint)
}

pub enum ChemistrySubClass {
    Nutrient,           // fail-OFF safe (underdose)
    PhAdjust,           // fail-OFF safe
    LifeSupportDose,    // fail-HOLD-LAST-BOUNDED (O2 dosing, emergency chemistry)
}

pub enum ThermalSubClass {
    Heating,   // fail-OFF safe (cold-shock slower than boil)
    Cooling,   // fail-OFF safe (warm-drift slower than chill-shock)
}

// Orthogonal LifeSupport flag (CRITICAL-002 partial closure — doesn't force class split)
pub struct ActuatorBinding {
    pub tag_id: TagId,
    pub primary_class: ActuatorClass,
    pub is_life_support: bool,                // orthogonal to class
    pub life_support_role: Option<LifeSupportRole>,
}

pub enum LifeSupportRole {
    OxygenSupply,
    TemperatureCriticalPath,
    AmmoniaControl,
    StockDensityInterlock,
}

// Permission check pipeline update:
// - AffectActuator{primary_class} required ALWAYS
// - if is_life_support: EmergencyActuator{LifeSupport} ADDITIONAL per ADR-018 §5
// - Binary-hardcoded life-support tag allowlist per ADR-018 §5 EMERGENCY_LIFE_SAFETY_TAGS
```

### 2. Append-only signed class-binding log (CRITICAL-002 kapama)

```rust
// WHY: v1 hardware_inventory.yaml whole-file signature = attacker with write access
//      + re-signed signature → class reclassification attack → AffectActuator bypass.
//      Fix: each (tag_id, class) binding individually signed + Merkle-linked chain.
// INVARIANT: tests/invariants/class_binding_tamper.rs — mutate any (tag_id, class)
//            at runtime → safe-state trips before any command dispatches.

#[derive(Serialize, Deserialize)]
pub struct ActuatorClassBindingEntry {
    pub entry_id: u64,                  // monotonic per-device
    pub tag_id: TagId,
    pub primary_class: ActuatorClass,
    pub is_life_support: bool,
    pub life_support_role: Option<LifeSupportRole>,
    pub binding_nonce: [u8; 16],        // freshness; dedup
    pub effective_at_unix_ms: i64,
    pub prev_binding_hash: [u8; 32],    // chain-link to previous binding for this tag_id
    pub binding_signature: [u8; 64],    // ed25519 by rbac_manifest_signing_key (ADR-021 slot 2)
}

// Chain semantics:
// - Each (tag_id, class) pair has its own chain (indexed by tag_id)
// - First binding: prev_binding_hash = all-zero
// - Reclassification: MUST include prev_binding_hash of current active binding
//                     + monotonic entry_id increment
//                     + NEW signature (platform 4-eye signed)
// - Downgrade (LifeSupport → Normal): requires TWO-party signature
//   (ADR-018 §7 two-person integrity on ReclassifyBinding command)
// - Upgrade (Normal → LifeSupport): one-way once pond stocked with
//   density > threshold (locked by interlock sensor reading)

// Edge verification on receive:
// 1. ed25519 verify with slot 2 rbac_manifest_signing_key
// 2. prev_binding_hash matches locally-stored current binding hash for this tag_id
// 3. entry_id > locally-stored highest_entry_id for this tag_id (replay prevention)
// 4. binding_nonce dedup (persist 30 days)
// 5. effective_at within grace window (clock skew tolerance)
// 6. If reclassification: check downgrade vs upgrade semantics
// 7. Atomic binding update + chain persist

// tests/invariants/class_binding_tamper.rs:
// - Fuzz: replace binding in inventory with forged (re-signed with stolen slot 2 key)
// - Expect: chain continuity check fails (prev_binding_hash mismatch) → REJECT
// - Fuzz: replay old binding (old entry_id)
// - Expect: entry_id monotonic check fails → REJECT
```

### 3. Explicit FailSafe enum + FailSafeOnStale (CRITICAL-001/003, HIGH-001/002/003/004 kapama)

```rust
// WHY: v1 fail_safe_behavior: String → operator-error-prone (category-error-copy);
//      contradiction between §1 aerator "on_ac_loss_to_off" and §7 "fail-ON 90%".
//      Enum + per-subclass invariant closes.

pub enum FailSafe {
    // ==========================================================================
    // Actuator-OFF family (safe-OFF actuators)
    // ==========================================================================
    Off {
        latency_ms: Option<u32>,         // None = latch-preserve (no active transition)
    },
    OffViaGracefulFade {
        fade_duration_ms: u32,
        hold_last_state_ms_first: Option<u32>,  // HIGH-001 LED night-stress — hold THEN fade
    },

    // ==========================================================================
    // Actuator-ON family (life-support: aerator, O2 dose, heater winter)
    // ==========================================================================
    OnFull {
        max_duration_secs: u32,           // bounded run; after expiry, revert to HoldLastKnownGood
    },
    OnAtPercent {
        duty_pct: f32,                    // 0.0..1.0 (e.g. 90% for aerator life-support)
        max_duration_secs: u32,
    },

    // ==========================================================================
    // Stateful preservation
    // ==========================================================================
    HoldLastKnownGood {
        max_hold_duration_secs: u32,      // bounded (e.g., 15 min) — then escalate
        escalation: Box<FailSafe>,         // nested escalation (typically OffViaGracefulFade)
    },
    LatchPreserved,                       // no action; for latching solenoids
    BoundedRange {
        min: f32,
        max: f32,
        default_to: f32,                  // target value within bounds
    },

    // ==========================================================================
    // Process-aware + interlock
    // ==========================================================================
    ProcessAwareOrEscalate {
        primary: Box<ProcessAwareFailSafe>,
        fail_safe_on_stale: Box<FailSafe>,  // HIGH-002 closure — if ProcessAware dependency stale
    },
    InterlockOrFailSafe {
        check: InterlockCheck,
        if_released_safe: Box<FailSafe>,
        if_interlocked_safe: Box<FailSafe>,
        if_unreadable_safe: Box<FailSafe>,  // HIGH-004 closure — sensor failure = safer of the two
    },

    // ==========================================================================
    // Emergency escalation
    // ==========================================================================
    TripToSafeState,                      // invoke ADR-019 §2.5 safe-state
    OperatorAlertOnly,                    // non-automated — for monitoring-only deployments
}

pub struct ProcessAwareFailSafe {
    pub base: FailSafe,
    pub dependencies: Vec<ProcessStateDependency>,
    pub dependency_freshness_seconds_max: u32,  // HIGH-002 — beyond this, "stale" state
    pub action_on_stale: StaleAction,
}

pub enum StaleAction {
    AssumePessimistic(SafeValue),    // worst-case stocking density assumed
    TripToSafeState,
    OperatorAlert,
}

pub enum ProcessStateDependency {
    TagThreshold {
        tag_id: TagId,
        threshold: f32,
        operator: ComparisonOp,
        freshness_requirement: FreshnessRequirement,  // HIGH-002
        when_true_safe: Box<FailSafe>,
        when_false_safe: Box<FailSafe>,
    },
    ScheduleDependent {
        time_window: DailyTimeRange,
        clock_trust_mode: ClockTrustMode,  // HIGH-003 — wrong-clock recovery
        during_safe: Box<FailSafe>,
        outside_safe: Box<FailSafe>,
    },
    InterlockWith {
        other_tag: TagId,
        must_be: TagState,
        if_interlocked_safe: Box<FailSafe>,
        if_released_safe: Box<FailSafe>,
        if_unreadable_safe: Box<FailSafe>,  // HIGH-004
    },
}

pub enum FreshnessRequirement {
    MustBeRealTimeSensor { max_age_seconds: u32 },
    StaticStockingMetadata { max_age_hours: u32, fail_safe_on_stale: SafeValue },
    StaticConfigOperatorEntered { fail_safe_on_stale_or_missing: Box<FailSafe> },
}

pub enum ClockTrustMode {
    NtpSyncedWithinWindow { max_age_seconds: u32 },
    MonotonicOnlyIgnoreSchedule,  // degraded mode on stale clock
    GpsPtpHardware,                // SL-3 per ADR-023 §7
}

pub enum InterlockCheck {
    TagState { tag: TagId, state: TagState },
    ProcessThreshold { tag: TagId, threshold: f32, op: ComparisonOp },
}

// Invariants:
// tests/invariants/fail_safe_enum_per_subclass.rs
//   - AerationSubClass::Normal: FailSafe::Off (latency_ms Some) required
//   - AerationSubClass::LifeSupport: FailSafe::OnAtPercent (duty_pct >= 0.8) required
//   - ChemistrySubClass::Nutrient: FailSafe::Off required
//   - ChemistrySubClass::LifeSupportDose: FailSafe::HoldLastKnownGood (max_hold <= 300s) required
//   - ThermalSubClass::Heating/Cooling: FailSafe::Off required
//   - Filtration Drum: FailSafe::Off required
//   - Filtration Solenoid Latching: FailSafe::LatchPreserved required
//   - Lighting LED diurnal: FailSafe::OffViaGracefulFade {fade_duration >= 1000ms}
//     + hold_last_state_ms_first >= 60_000 for photoperiod-critical species (species-aware)
//   - Recirculation: FailSafe::HoldLastKnownGood (bounded <= 600s escalate to TripToSafeState)

// Schema-rejected combinations:
//   - AerationSubClass::LifeSupport + FailSafe::Off → REJECT (prevents CRITICAL-001)
//   - ChemistrySubClass::LifeSupportDose + FailSafe::Off → REJECT (prevents CRITICAL-003)
```

### 4. Diversity schema — backup_path diversity_class (CRITICAL-004 kapama)

```rust
// WHY: IEC 61508-2 §7.4.3.4 requires diverse redundancy; dual-Modbus = SPoF.
// WHAT: Schema enforces diversity_class; LifeSupport deploy rejects SameTransport.

pub struct BackupPath {
    pub tag_id: TagId,
    pub diversity_class: DiversityClass,
    pub hardware_topology_notes: String,      // attested by engineer
}

pub enum DiversityClass {
    SameTransport,            // both paths via same Modbus/PLC; SL-0 equivalent
    DifferentTransport,       // e.g., primary Modbus + secondary GPIO; acceptable SL-1
    HardwiredOverride,        // SIL-2 SOA: dedicated GPIO→contactor bypassing PLC
    IndependentPlc,           // secondary PLC with separate RS-485 trunk; SL-2 sustained
}

// HardwiredSafetyOverride first-class OutputTag variant (new)
pub enum OutputTag {
    // ... (v1 variants preserved: ModbusCoil, ModbusRegister, GpioPin, I2cOutput, PwmChannel, SpiWrite, ProcessAware)

    // ==========================================================================
    // SIL-2 industrial pattern — GPIO hardwired to contactor coil
    // ==========================================================================
    HardwiredSafetyOverride {
        primary_tag: TagId,                  // which normal-path tag this overrides
        gpio_pin: u8,                         // direct hardware coil control
        coil_voltage_v: u8,                   // e.g., 24V DC
        override_behavior: FailSafe,
        signed_hardware_attestation: [u8; 64], // ed25519 by slot 2; attests diversity
    },
}

// Inventory deploy-time validation:
// - ActuatorBinding.is_life_support: true
// - ActuatorBinding.primary_class in {Aeration::LifeSupport, Chemistry::LifeSupportDose,
//                                      Recirculation, Thermal::Heating (winter)}
// → MUST have backup_path.diversity_class in {HardwiredOverride, IndependentPlc, DifferentTransport}
// → SameTransport → REJECTED at deploy-time (compile-error-equivalent for hardware)

// tests/invariants/life_support_diversity_required.rs
//   Fuzz inventory with LifeSupport + SameTransport → load rejects
```

### 5. Binary-const per-SKU hard caps (HIGH-005 kapama)

```rust
// WHY: v1 platform_hard_cap was YAML field = attacker signed-config tampering
//      could raise. Fix: per-SKU binary-const table; YAML can only be MORE restrictive,
//      never wider.
// WHAT: const_table! macro generates compile-time table; effective_cap = min(yaml, binary).

// sens-api-gateway/src/hardware_caps/mod.rs
macro_rules! const_table {
    ($($sku:literal => $cap:expr),* $(,)?) => {
        pub const SKU_CAPS: &[(&str, HardwareCap)] = &[$(($sku, $cap)),*];

        pub fn lookup_cap(sku: &str) -> Option<HardwareCap> {
            SKU_CAPS.iter().find(|(k, _)| *k == sku).map(|(_, v)| *v)
        }
    };
}

#[derive(Copy, Clone)]
pub struct HardwareCap {
    pub max_strokes_per_minute: Option<u16>,
    pub max_pwm_duty_pct: Option<f32>,
    pub max_pulse_width_ms: Option<u16>,
    pub max_rate_of_change_per_min: Option<f32>,
    // ... per-SKU capabilities
}

const_table! {
    "LEESON-3PH-1.5KW-CONTACTOR-AQUAZONE" => HardwareCap {
        max_strokes_per_minute: None,
        max_pwm_duty_pct: None,
        max_pulse_width_ms: None,
        max_rate_of_change_per_min: None,
    },
    "GRUNDFOS-DDA-7.5-16-AR-AQUAZONE" => HardwareCap {
        max_strokes_per_minute: Some(150),   // binary floor; YAML cannot exceed
        max_pwm_duty_pct: None,
        max_pulse_width_ms: None,
        max_rate_of_change_per_min: Some(10.0),
    },
    "GRUNDFOS-DDA-12-10-AR" => HardwareCap {
        max_strokes_per_minute: Some(200),
        max_pwm_duty_pct: None,
        max_pulse_width_ms: None,
        max_rate_of_change_per_min: Some(15.0),
    },
    "MEANWELL-PLD-60-1750-LED-DRIVER" => HardwareCap {
        max_strokes_per_minute: None,
        max_pwm_duty_pct: Some(1.0),
        max_pulse_width_ms: None,
        max_rate_of_change_per_min: Some(0.20),
    },
    "BURKERT-6213-SOLENOID-LATCH-DN15" => HardwareCap {
        max_strokes_per_minute: None,
        max_pwm_duty_pct: None,
        max_pulse_width_ms: Some(1000),
        max_rate_of_change_per_min: None,
    },
    // ... new SKU = new binary release (not YAML edit)
}

// Runtime:
pub fn effective_cap(sku: &str, yaml_cap: HardwareCap) -> HardwareCap {
    let binary_cap = lookup_cap(sku).unwrap_or(HardwareCap::MOST_RESTRICTIVE_DEFAULT);
    HardwareCap {
        max_strokes_per_minute: min_option(binary_cap.max_strokes_per_minute, yaml_cap.max_strokes_per_minute),
        // ... (min per-field)
    }
}

// INVARIANT: tests/invariants/per_sku_binary_caps.rs
//   Assert every SKU in loaded inventory has matching binary entry; unknown SKU → MOST_RESTRICTIVE_DEFAULT
//   (zero writes until binary release adds the SKU entry)
```

### 6. Type-system RFID auth ban (HIGH-006 kapama)

```rust
// WHY: v1 grep-lint = last line of defense; bypasses via transmute, serde, HashMap exist.
//      Fix: type-system OperatorId constructor module-private; ANY cross-module conversion fails type-check.

// sens-api-gateway/src/authz/operator_id.rs
pub struct OperatorId {
    // Private field; no pub constructor exported outside this module
    _raw: [u8; 16],
    // Type-level marker: cannot be constructed via transmute due to seal trait
    _seal: private_seal::OpIdSeal,
}

mod private_seal {
    // Sealed trait pattern — only this module can implement
    pub struct OpIdSeal(pub(super) ());
}

impl OperatorId {
    // Only constructor — inside this module + authz::verify_manifest caller path
    pub(crate) fn mint_from_verified_envelope(
        envelope: &VerifiedCommandEnvelope,
    ) -> Result<Self, AuthzError> {
        // ... full verification path before minting
        Ok(OperatorId {
            _raw: envelope.actor_raw_bytes(),
            _seal: private_seal::OpIdSeal(()),
        })
    }
}

// Negative-impl trait block (requires stable Rust trait-bound approach):
// Any attempt to `impl From<X> for OperatorId` in external module fails because
// OperatorId's private field + sealed trait makes external struct-literal construction impossible.

// unsafe transmute bypass: prevented by module-level forbid
// sens-api-gateway/src/authz/mod.rs
#![forbid(unsafe_code)]  // stronger than #![deny]; not just on-request, always on

// String-indirect bypass via serde:
// OperatorId doesn't derive Serialize/Deserialize from outside; authz module-private
// deserializer only; external JSON parse → OperatorId fails type-check (no impl)

// HashMap<RfidUid, OperatorId> bypass:
// Valid Rust but unusable — nothing can populate the HashMap with real OperatorId
// instances (constructor not exported); map effectively empty

// cargo-deny entry:
// [bans]
// deny = [
//   { name = "mfrc522", wrappers = ["sens-api-gateway-authz"] },  # MFRC522 imports into authz crate banned
// ]

// INVARIANT: tests/invariants/rfid_auth_impossible_at_compile_time.rs
//   - Attempt compile: external crate tries to construct OperatorId from RfidUid
//   - Expected: compile error (no pub constructor; sealed type)
//   - Fuzz: try all 5 bypass paths from audit (transmute, serde, HashMap, From impl,
//     re-export chain) — all fail compile or runtime-empty
```

### 7. Engineer attestation structured schema (HIGH-008 kapama)

```yaml
# Per-actuator attestation — part of signed class-binding entry (§2)
attestation:
  engineer:
    credential_id: "PE-TR-AQUA-00042"     # Turkish PE license
    credential_expiry: "2028-12-31"        # re-attest if < 90d
    employer_relationship: "platform_staff_employed"   # OR "contractor" / "tenant_employed"
    indemnification_coverage: "platform-provided_PE_insurance_bonded"
    personal_ed25519_pubkey: "base64..."   # cross-signs attestation

  attestation_scope:
    tag_id: "pond3_aerator_primary"
    fail_safe_behavior: FailSafe::OnAtPercent { duty_pct: 0.9, max_duration_secs: 1800 }
    diversity_class: DiversityClass::HardwiredOverride
    hardware_sku: "LEESON-3PH-1.5KW-CONTACTOR-AQUAZONE"
    site_code: "aquafarm-izmir-01"

  attestation_valid_until: "2027-04-19"
  re_attestation_triggers:
    - hardware_sku_change
    - species_change                    # tilapia → salmon = different DO curves
    - deployment_topology_change        # SinglePath → DualPath
    - signing_engineer_departure        # new PE required
    - annual_heartbeat                  # 365-day cadence minimum

  signatures:
    engineer_signature: "base64 ed25519 by engineer personal key"
    security_lead_countersignature: "base64 ed25519 by security_lead personal key"
    legal_counsel_witness: "base64 ed25519 by legal counsel key"  # liability acknowledgment

  liability:
    incident_flow: "see docs/compliance/engineer-attestation-liability.md"
    jurisdiction: "TR"
    insurance_claim_process: "contact legal@aquaculture.com within 24h of incident"
```

```rust
// INVARIANT: tests/invariants/attestation_freshness.rs
//   Every ActuatorBinding with category: LifeSupport MUST have:
//     - attestation_valid_until > now()
//     - engineer.credential_expiry > now() + 90 days (warning window)
//     - all 3 signatures present
//   Expired → tag auto-degraded to READ-ONLY + alarm
```

### 8. Hardware inventory — signed schema + deployment ratio runtime gate (MEDIUM-007 kapama)

```yaml
# /etc/suderra/hardware_inventory.yaml (signed via signed-config per ADR-019 §8;
#  individual ActuatorClassBindingEntry entries signed per §2 per-tuple scheme)

hardware_inventory:
  schema_version: 2
  inventory_generated_at: "2026-04-19T10:00:00Z"
  signed_by_field_ops_lead: "operator_id_uuid"
  inventory_bundle_signature: "base64 ed25519 by rbac_manifest_signing_key"

  actuators:
    - sku: "LEESON-3PH-1.5KW-CONTACTOR-AQUAZONE"
      tag_id: "pond3_aerator_primary"
      primary_class: Aeration::LifeSupport
      is_life_support: true
      life_support_role: OxygenSupply
      fail_safe: OnAtPercent { duty_pct: 0.9, max_duration_secs: 1800 }
      fail_safe_latency: Some(500)
      power_loss_behavior: PowerLossFailSafe::FailToContactorOn  # explicit (distinct from control-loss)
      interface: Modbus { device_id: 10, register_range: 0..16 }
      backup_path:
        tag_id: "pond3_aerator_hardwired_override"
        diversity_class: HardwiredOverride
        hardware_topology_notes: "Dedicated GPIO pin 17 → 24V contactor coil bypassing PLC"
      attestation: (see §7)

    - sku: "GRUNDFOS-DDA-7.5-16-AR-AQUAZONE"
      tag_id: "pond3_o2_dosing"
      primary_class: Chemistry::LifeSupportDose
      is_life_support: true
      life_support_role: OxygenSupply
      fail_safe: HoldLastKnownGood { max_hold_duration_secs: 300, escalation: TripToSafeState }
      fail_safe_latency: Some(100)
      interface: Modbus { device_id: 12, register_range: 16..32 }
      backup_path:
        tag_id: "pond3_o2_emergency_dosing"
        diversity_class: IndependentPlc
        hardware_topology_notes: "Secondary PLC on independent RS-485 trunk"
      attestation: (see §7)

    # ... (full inventory at deployment)

  site_deployment_ratio:
    # MEDIUM-007 runtime gate — if unpopulated, edge agent READS OK but REJECTS writes
    pond3_aerator_primary: "32 tanks active; 4 LifeSupport classified"
    # ...

  # Staged population policy:
  # Phase A (schema merged): inventory skeleton + category-error corrections committed;
  #   edge-agent refuses WRITE to any actuator with TBD in required fields; READS OK
  # Phase B (pilot fleet populated): field-ops survey complete per-tenant; writes enabled
  #   per-tenant as field data lands; tracked per-tenant readiness
```

### 9. ADC self-test + Atlas EZO calibration (MEDIUM-003/004/005 kapama)

```rust
// MEDIUM-003 closure: external traceable reference for SIL-2 DC claims
pub struct AdcSelfTestConfig {
    pub reference_source: ReferenceSource,
    pub reference_voltage_mv: i32,
    pub tolerance_pct: f32,
    pub measurement_interval_sec: u64,
}

pub enum ReferenceSource {
    RpiInternalUnstable,                  // SL-0 (development only)
    ExternalTraceableREF3030 { part_number: String, traceability_cert_url: String },
    ExternalTraceableREF5025 { part_number: String, traceability_cert_url: String },
    NistTraceable { cert_number: String },  // SL-2 production
}

// INVARIANT: SL-2 deployments require ReferenceSource != RpiInternalUnstable

// MEDIUM-004 closure: explicit fault_detection_profile (no redundancy with chip integrated)
pub struct SensorFaultDetectionProfile {
    pub chip_integrated: IntegratedFaultDetection,
    pub external_self_test: Option<ExternalSelfTestProcedure>,
}

pub enum IntegratedFaultDetection {
    None,
    ContinuousPerSpec { spec_name: String, covered_faults: Vec<FaultType> },
}

pub enum ExternalSelfTestProcedure {
    InjectKnownCurrent { current_ua: f32, expected_reading: f32 },
    ReferenceChannelCrossCheck { reference_source: ReferenceSource },
}

// For MAX31865: chip_integrated = ContinuousPerSpec; external_self_test = None (redundant)
// For raw ADC like ADS1256: external_self_test = required

// MEDIUM-005 closure: Atlas EZO explicit calibration_policy
pub struct CalibrationPolicy {
    pub scheduled_interval_days: u16,    // e.g., 30 days
    pub drift_threshold_pct_forcing_recal: f32,  // e.g., 5% drift
    pub out_of_service_if_overdue_days: u16,    // e.g., 45 days — beyond this, tag READ-ONLY
}

// INVARIANT: Atlas EZO entries without calibration_policy → inventory-load REJECT
```

### 10. RFID feature gating (MEDIUM-006 kapama)

```toml
# Cargo.toml
[features]
default = ["gpio"]
rfid-asset-tracking = ["dep:mfrc522"]   # OFF by default; explicit opt-in
# ... other features
```

If asset tracking not in current product scope → feature NEVER enabled in production builds; mfrc522 crate NOT compiled in; attack surface eliminated.

If retained:
- `src/inventory/rfid_scanner.rs` reads UID, maps to AssetId (NOT OperatorId, structurally per §6)
- Compile-time feature gate double-checks against type-system OperatorId ban

### 11. SIL-2 honest wording (HIGH-007 kapama)

**Throughout this ADR:** "SIL-2-informed design" (NOT "SIL-2 certified", NOT "SIL-2 aligned", NOT "SIL-2 compliant").

**Explicit disclaimer section:**

```markdown
## SIL-2 Compliance Position (for tenants, insurers, regulators)

This ADR documents a **SIL-2-informed architecture** — design practices consistent
with IEC 61508 functional-safety principles applied to software and deployment
patterns. **No formal SIL-2 certification is claimed for the edge agent** at the
platform level.

- Software process alignment: IEC 61508-3 partial adherence documented
- Hardware fault tree + PFDavg + CCF analysis: deployment-specific (integrator
  responsibility per SIL-2 end-user functional-safety responsibility model)
- Deployment-specific SIL-2 certification pathway: each integrator produces
  site-specific FTA + attestation per local jurisdiction
- Pre-assessment deliverable (Faz 0 Sprint 0.3): identifies gap list, not pass/fail
- Insurance claims: see `docs/compliance/engineer-attestation-liability.md`
```

### 12. Schema versioning + migration (LOW-003 kapama)

```rust
// INVARIANT: Edge rejects inventory_bundle with schema_version > supported
// Upgrade path: agent release adds new schema_version support; cloud pushes new schema
//               only after fleet-wide agent update complete
// NO DOWNGRADE: edge refuses to load schema_version < current supported

const SUPPORTED_SCHEMA_VERSIONS: &[u16] = &[1, 2];  // v1 + v2 during transition
const CURRENT_SCHEMA_VERSION: u16 = 2;

pub fn load_inventory(bytes: &[u8]) -> Result<HardwareInventory, Error> {
    let bundle = parse_bundle(bytes)?;
    if !SUPPORTED_SCHEMA_VERSIONS.contains(&bundle.schema_version) {
        return Err(Error::SchemaVersionUnsupported(bundle.schema_version));
    }
    // ... upcaster v1 → v2 applied if needed
}
```

---

## Alternatives Considered (updated post-audit)

### Alt-1 v1 unified single ActuatorClass enum (no subclass split)
REDDEDİLDİ (CRITICAL-001/003 life-safety consequences).

### Alt-2 Whole-YAML signature (v1 original)
REDDEDİLDİ (CRITICAL-002 class reclassification attack).

### Alt-3 Same-transport dual backup (v1 original)
REDDEDİLDİ (CRITICAL-004 SPoF; IEC 61508-2 §7.4.3.4 requires diversity).

### Alt-4 YAML-only caps (v1 original)
REDDEDİLDİ (HIGH-005 attacker signed-config tampering; binary-const required).

### Alt-5 Grep-lint RFID auth ban (v1 original)
REDDEDİLDİ (HIGH-006 5 bypass paths; type-system ban required).

### Alt-6 "SIL-2 aligned/certified" wording
REDDEDİLDİ (HIGH-007 commercial+legal exposure; "informed" honest).

### Alt-7 Drop RFID entirely (no asset tracking)
Considered; currently KABUL as feature-gated OFF-by-default; asset-tracking product need re-evaluated at Faz 10.

---

## Consequences

### Positive
- **Life-safety bugs closed:** aerator fail-safe contradiction (CRITICAL-001), Chemistry fail-OFF (CRITICAL-003), backup dual-Modbus SPoF (CRITICAL-004) all ARCHITECTURALLY resolved by schema
- **Class-binding attack closed:** append-only signed log per §2 (CRITICAL-002); invariant test class_binding_tamper.rs
- **Type-system RFID ban:** OperatorId constructor module-private; all 5 bypass paths ruled out at compile-time
- **Binary-const caps:** attacker signed-config cannot widen caps; new SKU = new binary release discipline
- **SIL-2-informed honest:** no misleading certification claims; integrator responsibility model documented
- **Engineer attestation liability:** structured schema + re-attestation triggers + expiry gate + signature chain
- **Extended class enum:** Thermal/Recirculation/WasteRemoval/Degassing/EmergencyContainment added
- **FailSafe explicit enum:** per-subclass invariant tests prevent category-error copy-paste
- **Process-aware fail-safe-on-stale:** HIGH-002/003/004 closed via FreshnessRequirement + ClockTrustMode + if_unreadable_safe
- **Atlas EZO + ADC self-test:** explicit fault_detection_profile + reference_source SIL-2-bound

### Negative
- **Implementation kod:** `src/hardware_inventory/` ~1000 satır; `src/safe_state/v2/` ~800 satır; `src/hardware_caps/` ~500 satır; `src/authz/operator_id.rs` sealed refactor; 7+ invariant tests
- **Inventory population ops work:** Phase A (schema committed) vs Phase B (field-ops survey) staged rollout
- **Engineer attestation logistics:** per-actuator PE signature + liability bonding per deployment; 3-6 weeks per-site initial
- **SIL-2 pre-assessment deliverable:** ~$15k external security firm; gap-list identification
- **const_table! macro maintenance:** new SKU = binary release; accepted as security gain over YAML override
- **Inventory transition period:** schema v1 → v2 migration; old inventory upcasted; 1-release deprecation window

### Neutral
- **Site-specific SIL-2 certification:** integrator/tenant responsibility per end-user model; platform provides architecture tooling

---

## 13. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| AUDIT-CRITICAL-001 (aerator fail-safe contradiction) | CRITICAL | §3 FailSafe enum + invariant fail_safe_enum_per_subclass.rs | AerationSubClass::LifeSupport + FailSafe::Off → compile/runtime REJECT |
| AUDIT-CRITICAL-002 (class-binding mutable) | CRITICAL | §2 append-only signed per-tuple | Per-tuple ed25519 + prev_binding_hash chain; tamper → REJECT |
| AUDIT-CRITICAL-003 (Chemistry fail-OFF O2) | CRITICAL | §1 ChemistrySubClass + §3 FailSafe | LifeSupportDose variant mandates HoldLastKnownGood; Nutrient/PhAdjust fail-OFF separate |
| AUDIT-CRITICAL-004 (dual-Modbus SPoF) | CRITICAL | §4 diversity_class | LifeSupport + SameTransport → inventory-load REJECT; HardwiredOverride first-class |
| AUDIT-HIGH-001 (LED fade-to-zero night) | HIGH | §3 OffViaGracefulFade hold_last_state_ms_first | Species-aware hold window; photoperiod-critical protection |
| AUDIT-HIGH-002 (ProcessAware stock density real-time) | HIGH | §3 FreshnessRequirement + StaleAction | Static metadata requires max_age + pessimistic stale action |
| AUDIT-HIGH-003 (ScheduleDependent wrong clock) | HIGH | §3 ClockTrustMode | MonotonicOnlyIgnoreSchedule fallback on stale clock |
| AUDIT-HIGH-004 (InterlockWith sensor failure) | HIGH | §3 if_unreadable_safe | Explicit safer-of-the-two on unreadable |
| AUDIT-HIGH-005 (platform_hard_cap YAML) | HIGH | §5 const_table! | Binary-const per-SKU; YAML cannot widen |
| AUDIT-HIGH-006 (RFID lint bypass) | HIGH | §6 type-system OperatorId sealed | 5 bypass paths ruled out compile-time |
| AUDIT-HIGH-007 (SIL-2 wording) | HIGH | §11 | "SIL-2-informed design" (not certified) |
| AUDIT-HIGH-008 (attestation liability) | HIGH | §7 | Structured schema + expiry + re-attestation + liability ADR link |
| AUDIT-MEDIUM-001 (ActuatorClass completeness) | MEDIUM | §1 extended enum | Thermal/Recirculation/WasteRemoval/Degassing/EmergencyContainment added |
| AUDIT-MEDIUM-002 (LifeSupport overlap) | MEDIUM | §1 is_life_support orthogonal flag | Class + flag combined dual-permission check |
| AUDIT-MEDIUM-003 (ADC ref voltage) | MEDIUM | §9 ReferenceSource enum | External traceable required for SL-2 |
| AUDIT-MEDIUM-004 (MAX31865 redundancy) | MEDIUM | §9 IntegratedFaultDetection + ExternalSelfTestProcedure Option | No redundancy; explicit choice |
| AUDIT-MEDIUM-005 (Atlas EZO calibration) | MEDIUM | §9 CalibrationPolicy | scheduled_interval_days + drift_threshold + out_of_service_overdue required |
| AUDIT-MEDIUM-006 (RFID feature gate) | MEDIUM | §10 + Cargo.toml feature | OFF by default; opt-in only |
| AUDIT-MEDIUM-007 (TBD deployment ratio) | MEDIUM | §8 Phase A/B | Schema merged; writes gated per-tenant readiness |
| AUDIT-MEDIUM-008 (ADR-018 §5 ref verification) | MEDIUM | §1 cross-ref | ADR-018 §5 EMERGENCY_PERMITTED_BASE currently defined; verified |
| AUDIT-LOW-001 (platform_hard_cap derivation) | LOW | §5 per-SKU commented | Chemistry safety-factor documented per entry |
| AUDIT-LOW-002 (DosageRateCap delta<1s) | LOW | FailSafe rolling-window pattern | Stateful average vs instant delta |
| AUDIT-LOW-003 (schema migration) | LOW | §12 | Edge reject higher version; no downgrade; upcaster v1→v2 |
| AUDIT-LOW-004 (fail_safe_latency=0 latch) | LOW | §3 Option<u32> | None variant for LatchPreserved |
| AUDIT-INFO-001 (ADR citation) | INFO | References | Cross-ADR section numbers verified mechanically pre-merge |

---

## 14. Implementation Plan (Plan §5 Faz 0-1)

**Phase A (schema + code; Faz 0 Sprint 0.3-1.7, 4-6 weeks):**
- Sprint 0.3: Hardware inventory schema v2 + ActuatorClass extended enum + FailSafe enum
- Sprint 0.4: Signed class-binding log (§2) + per-tuple ed25519 signature path (uses ADR-021 slot 2)
- Sprint 0.5: const_table! macro + per-SKU binary caps + HardwareCap struct
- Sprint 0.6: OperatorId sealed refactor (§6) + authz module-boundary enforcement
- Sprint 0.7: Engineer attestation schema + docs/compliance/engineer-attestation-liability.md draft
- Sprint 1.1: HardwiredSafetyOverride OutputTag variant + safe_state/v2 integration
- Sprint 1.2: ProcessAware FailSafe + FreshnessRequirement + ClockTrustMode
- Sprint 1.3: ADC self-test + Atlas EZO calibration policy
- Sprint 1.4: Invariant tests (10+) + fuzz harnesses for bypass attempts
- Sprint 1.5: RFID feature gating + cargo-deny entry
- Sprint 1.6: SIL-2-informed documentation + compliance template
- Sprint 1.7: Pre-assessment external security firm engagement ($15k; gap-list delivery)

**Phase B (field-ops population + per-tenant rollout; operational work, 8-12 weeks):**
- Field-ops OEM SKU survey per pilot tenant (50-tenant fleet)
- Engineer attestation ceremony per actuator (PE + security-lead + legal counsel signatures)
- `docs/compliance/life-safety-fmea.md` per-tenant
- Inventory YAML populate + signed class-binding log publish
- Per-tenant staged rollout (writes enabled as readiness lands)

**Acceptance criteria:**
- All 10+ invariant tests green (§3/§4/§5/§6/§7/§8/§9 coverage)
- `tests/invariants/class_binding_tamper.rs` green
- `tests/invariants/rfid_auth_impossible_at_compile_time.rs` green (compile-fail on bypass attempts)
- `tests/invariants/fail_safe_enum_per_subclass.rs` green
- `tests/invariants/life_support_diversity_required.rs` green
- SIL-2 pre-assessment external audit gap-list delivered (not pass/fail)
- Pilot tenant (1+) Phase B signed inventory + engineer attestation complete
- IEC 61508 functional-safety design-input documentation published
- DEC-022 → RESOLVED
- Status → Accepted

---

## References

- IEC 61508 Parts 1-7 (Functional Safety)
- IEC 61511 (Functional Safety for Process Industry)
- IEC 62443-3-3 FR1 (Identification & Authentication)
- ISO 14443 (Proximity cards)
- NFPA 79 (Industrial Machinery Electrical Safety)
- `sens-api-gateway/src/pwm.rs` (dead_code; wired by this ADR for LED only)
- `sens-api-gateway/src/spi.rs` (dead_code; wired by this ADR for MAX31865 only)
- `sens-api-gateway/src/safe_state.rs` (v1 extended to v2 via this ADR + ADR-019 §2.5)
- `docs/compliance/engineer-attestation-liability.md` (Faz 0 Sprint 0.7 deliverable)
- `docs/compliance/life-safety-fmea.md` (Phase B per-tenant deliverable)
- `docs/security/threat-model.md` §3 (per-component STRIDE — hardware adapters)
- ADR-017 (ST Bytecode — WriteTag + RbacGatedWriter consumer of effect-based permission)
- ADR-018 §5 EMERGENCY_PERMITTED_BASE + §7 two-person integrity
- ADR-019 §2.5 Safe-state v2 reference + §8 config integrity
- ADR-020 §7 audit events AdcDriftDetected + DosageRateCapViolated
- ADR-021 §1 slot 2 rbac_manifest_signing_key for per-tuple binding signatures
- `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.5 D-5
- `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-22, §5 Faz 0-1
