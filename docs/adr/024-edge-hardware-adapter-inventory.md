# ADR-024: Edge Hardware Adapter Inventory + Safe-State Schema v2 + Effect-Based Permissions

**Status:** **BLOCKED (post-audit; architectural safety-schema rewrite required before Proposed → Accepted)**
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + edge-expert + edge-industrial-auditor + sensor-expert + auth-security-expert
**Owner:** Okan (temp — PROC-001)
**Deadline:** 2026-05-03 — tamamlayıcı ADR-019 §2.5 (Safe-state schema v2 referansı); hardware inventory field OEM data field-ops ekibi gerektirir (Faz 0 Sprint 0.3 work)
**Related findings:** DEC-005 (PWM/SPI wire decision), ARC-004 (pwm.rs + spi.rs dead-code), STL-003 (IEC 61508 SIL-2 life-safety alignment), **DEC-022 (this ADR's rewrite tracking; opened by post-audit revision)**

---

## ⚠ BLOCKED STATUS — Post-Audit Summary (2026-04-19)

edge-industrial-auditor verdict: **NEEDS_MAJOR_REVISION**. 4 CRITICAL + 8 HIGH + 8 MEDIUM + 4 LOW/INFO bulgu. Üç tanesi ACTIVE LIFE-SAFETY BUGS:

| # | CRITICAL | Saha reality |
|---|---|---|
| AUDIT-CRITICAL-001 | §1 aerator fail-safe "on_ac_loss_to_off" vs §7 "fail-ON 90%" contradiction | Same actuator class two opposite fail-safes; integrator misread → fish kill in normal AC-loss scenario (O2 half-life minutes) |
| AUDIT-CRITICAL-002 | `hardware_inventory.yaml` lookup mutable signed-doc = class reclassification attack | Attacker modifies `(tag_id, class)` tuple → aerator reclassified as `Inventory` → AffectActuator bypass; whole-file signature doesn't prevent |
| AUDIT-CRITICAL-003 | `Chemistry` class single fail-OFF default catastrophic for O2 dosing | Template copy-paste inherits fail-OFF → pond3_o2_dosing stops on control-loss → fish die in hours |
| AUDIT-CRITICAL-004 | `backup_path: secondary` on same Modbus transport = single-point-failure | IEC 61508-2 §7.4.3.4 requires diverse redundancy; dual-Modbus = one PLC compromise takes both paths; SIL-2 claim invalid |

**Auditor saha-reality verdict:**
> "Category-error corrections sound and ready. The leap from 'category-correct wiring' to 'SIL-2-aligned life-safety platform' is not ready — rests on schema shapes that silently permit worst outcomes of each life-safety class. Current draft is carbon-steel at the category level and papier-mâché at the fail-safe-semantics level."

**Required architectural rewrite (not edit):**
1. **ActuatorClass split:** `Aeration::{Normal, LifeSupport}`, `Chemistry::{Nutrient, pH, LifeSupportDose}`, orthogonal `is_life_support: bool` flag; reject `Normal` on SinglePath topology
2. **Append-only signed class-binding log:** `(tag_id, class)` pairs individually signed with monotonic nonce; class downgrade requires 2-party signature; inventory is a Merkle-linked history, not a YAML file
3. **Explicit fail-safe enum** (not free-text): enum variants pre-validated against ActuatorSubClass; `fail_safe_on_stale/unreadable: SafeValue` mandatory for ProcessAware/InterlockWith
4. **Diverse redundancy schema:** `backup_path.diversity_class: {SameTransport | DifferentTransport | HardwiredOverride}`; LifeSupport deploy rejects SameTransport
5. **`HardwiredSafetyOverride`** as first-class OutputTag variant (GPIO→contactor bypass PLC; industrial SIL-2 pattern)
6. **Binary-const hard caps:** per-SKU `const_table!` in Rust; `effective_cap = min(yaml, binary)`; new SKU = new binary release (not YAML edit)
7. **Type-system RFID auth ban:** `OperatorId` constructor module-private; `impl From<_> for OperatorId` outside authz fails type-check; grep-lint = last line of defense, not first
8. **SIL-2 wording honesty:** "SIL-2-aligned architecture" (not certified); explicit limits document; legal review gate
9. **Engineer attestation liability ADR** (separate): employment relationship, expiry, re-attestation triggers, incident liability flow
10. **Fail-safe latency schema:** `Option<u32>`; `None` for latch_preserved; attacker-flap resistant rolling-window rate cap

**Decision to rewrite next session** — user'ın "en kaliteli + güvenli + performanslı + mimari" direktifi + life-safety bugs = honest path. DEC-022 tracks; rewrite depends on:
- Field-ops site topology survey (redundancy class per deployment)
- Process engineer attestation template + liability legal review
- Rust const_table! macro design (per-SKU binary caps)
- ActuatorClass final taxonomy after ADR-018 §5 EmergencyActuator scope coordination

**DEC-022 tracked in finding board**; rewrite deadline 2026-06-07 (4 weeks); not silent deferral.

**Aşağıdaki içerik ilk taslak — BLOCKED olarak işaretli. Category-error corrections (aerator/dosing/solenoid/LED/MAX31865/ADS1256/MFRC522) korunur; fail-safe semantics + class binding + redundancy schema rewrite scope'u.**
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-22, §5 Faz 0-1; `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.5 D-5 REVİZE MAJOR
**Supersedes:** Plan B V1 D-5 "WIRE ET" blanket PWM/SPI decision

---

## Context (WHY)

### Problem
Plan B V1 D-5 "PWM + SPI wire et" kararı field-ops ekibi audit ettiğinde **kategori hatasıyla dolu** çıktı:
- Aerator **PWM değil contactor** (on/off 3-phase motor; variable speed yok typical deployment)
- Dosing pump **PWM değil stroke-count** (peristaltic pump rpm-controlled; PWM duty cycle dosing hacmine lineer değil)
- Solenoid **PWM değil on/off** (latching solenoid zaten PWM unsuitable)
- Gerçek PWM use-case: **sadece LED diurnal** (day/night intensity cycle)
- ADS1256 24-bit ADC aquaculture için **overkill** (pH/O2/temp 16-bit yeterli)
- MFRC522 RFID **authentication için kesinlikle yasak** (ISO 14443 close-range tap; spoofable; asset-tracking OK)

`safe_state.rs` mevcut `OutputTag` enum'u sadece Modbus + GPIO varyantları taşıyor; PWM / SPI / process-aware dependency tanımları yok.

### User direktifi
*"En kaliteli + güvenli + performanslı + mimari — çelik gibi sağlam; yama yok"* → field-ops envanter ADR'da dokümante; kategori hatalarını mimariye geçirme.

### STL-003 IEC 61508 / IEC 61511 SIL alignment
Life-safety alarm path (O2, pH, temperature) SIL-2 classification hedefli:
- PFDavg (Probability of Failure on Demand, average) hedef: 10⁻³ ≤ PFD < 10⁻²
- DC (Diagnostic Coverage) hedef: ≥ %90
- Proof-test interval: 6 ay
- Fail-safe davranış per output documented (bu ADR'da)

---

## Decision (WHAT)

**1. Per-actuator hardware adapter matrix (SKU + interface + driver ownership + deployment ratio + fail-safe tanımı) — field OEM tablosu aşamalı populate edilir. 2. Safe-state schema v2 — `ProcessAware` variant + `PwmChannel` (max_duty/max_rate_of_change) + `SpiWrite` explicit forms. 3. Effect-based Permission — `AffectActuator { class }` interface-agnostic. 4. ADC self-test protocol + RFID auth lint-level prohibition. 5. PWM-use only where validated (LED diurnal); rejected-use-case table. 6. Dosage rate cap enforcement (max_rate_of_change). 7. SIL-2 alignment per life-safety output.**

### 1. Hardware Adapter Inventory — schema + field OEM population template

```yaml
# /etc/suderra/hardware_inventory.yaml (signed via ADR-019 §8 config integrity)
# INVARIANT: Every actuator/sensor at deployment site MUST have entry here.
#            Missing entry = device refuses to register actuator (tests/invariants/hw_inventory_complete.rs).

hardware_inventory:
  schema_version: 1
  inventory_generated_at: "2026-04-19T10:00:00Z"
  signed_by: "field_ops_lead_okan"  # operator signature (ADR-018 §7 per-operator key)

  actuators:
    # ==========================================================================
    # AERATORS — contactor-driven (NOT PWM)
    # ==========================================================================
    - sku: "LEESON-3PH-1.5KW-CONTACTOR-AQUAZONE"
      category: Aeration
      interface: Modbus  # via PLC → contactor; NOT direct GPIO/PWM
      driver_ownership: "sens-api-gateway/src/modbus.rs + external PLC (Yol C per CLAUDE.md)"
      reference_hardware_test_bench: "Istanbul lab; Unit SN UNIT-0042-AZ-001"
      site_deployment_ratio: "TBD — field-ops populate by 2026-05-03"
      # ^ deployment ratio from Faz 0 Sprint 0.3 field-ops survey; placeholder until data
      fail_safe_behavior: "on_ac_loss_to_off"
      fail_safe_latency_ms: 500  # contactor drop-out time (ON→OFF on control-loss)
      fail_safe_attestation:
        engineer: "Process engineer Ayşe (PE-Aquaculture)"
        signed_at: "TBD"
        # ^ engineer signature pending Faz 0 Sprint 0.3 — per user direktifi, NOT silent defer;
        #   deadline explicit + owner + finding ID — PROC-003 tracks completion

    # ==========================================================================
    # DOSING PUMPS — stroke-count (NOT PWM)
    # ==========================================================================
    - sku: "GRUNDFOS-DDA-7.5-16-AR-AQUAZONE"
      category: Chemistry
      interface: Modbus
      driver_ownership: "external PLC via Modbus register strokes_per_minute"
      reference_hardware_test_bench: "TBD"
      site_deployment_ratio: "TBD"
      fail_safe_behavior: "stroke_count_to_zero_on_loss"
      fail_safe_latency_ms: 100
      dosage_constraints:
        max_strokes_per_minute: 180     # hardware max
        platform_hard_cap: 150           # binary-embedded (not config-overridable)
        max_rate_of_change_per_min: 10   # strokes/min rate change cap; dosage overshoot safety
      fail_safe_attestation: "TBD"

    # ==========================================================================
    # SOLENOIDS — on/off (latching/non-latching)
    # ==========================================================================
    - sku: "BURKERT-6213-SOLENOID-LATCH-DN15"
      category: Filtration
      interface: GpioPin
      driver_ownership: "sens-api-gateway/src/gpio.rs"
      reference_hardware_test_bench: "TBD"
      site_deployment_ratio: "TBD"
      fail_safe_behavior: "latch_state_preserved_on_loss"  # latching solenoid; NO auto-return
      fail_safe_latency_ms: 0  # instant (latched)
      gpio_pin_constraints:
        min_pulse_width_ms: 50
        max_pulse_width_ms: 500
        platform_hard_cap_pulse_width_ms: 1000
      fail_safe_attestation: "TBD"

    # ==========================================================================
    # LED DIURNAL — PWM (ACCEPTED use-case)
    # ==========================================================================
    - sku: "MEANWELL-PLD-60-1750-LED-DRIVER"
      category: Lighting
      interface: PwmChannel
      driver_ownership: "sens-api-gateway/src/pwm.rs (WIRED — ARC-004 kapama bu ADR ile)"
      reference_hardware_test_bench: "Istanbul lab; Unit SN LED-0017"
      site_deployment_ratio: "TBD"
      fail_safe_behavior: "fade_to_zero_on_loss"
      fail_safe_latency_ms: 1000  # 1-second fade-down (sudden-off stress fish)
      pwm_constraints:
        hardware_max_duty_pct: 100
        platform_hard_cap_duty_pct: 100
        max_rate_of_change_pct_per_min: 20  # 20% duty/min — gradual diurnal transitions
        pwm_frequency_hz: 1000
      fail_safe_attestation: "TBD"

    # ==========================================================================
    # RTD TEMPERATURE SENSOR — SPI MAX31865 (ACCEPTED use-case)
    # ==========================================================================
    - sku: "ADAFRUIT-MAX31865-RTD-PT100"
      category: Sensor  # read-only; no actuator
      interface: SpiRead  # NOT SpiWrite — sensor read path
      driver_ownership: "sens-api-gateway/src/spi.rs (WIRED — ARC-004 kapama bu ADR ile)"
      reference_hardware_test_bench: "Istanbul lab; PT100 probe calibrated 0-100°C"
      site_deployment_ratio: "TBD"
      # Read-only — no fail-safe behavior on write (N/A)
      read_constraints:
        sample_rate_hz: 10
        fault_detection_enabled: true      # MAX31865 has integrated fault detection
        self_test_interval_sec: 3600       # 1-hour self-test cycle

  rejected_hardware_use_cases:
    # ==========================================================================
    # Kategori hatası düzeltmeleri — reference audit record
    # ==========================================================================
    - category_error: "Aerator PWM"
      actual_interface: "contactor (on/off) via external PLC Modbus"
      rejection_reason: "3-phase AC motor variable-speed requires VFD ($$ overkill for aquaculture);
                         typical deployment = single-speed contactor; PWM duty cycle meaningless"
      correct_design: "Modbus write to PLC register aerator_on_off; fail-safe contactor drop-out"

    - category_error: "Dosing pump direct PWM"
      actual_interface: "stroke-count via Modbus"
      rejection_reason: "Peristaltic pump dose volume = f(stroke_count), NOT linear in PWM duty;
                         PWM at 50% ≠ half dose (stroke volume constant)"
      correct_design: "Modbus register strokes_per_minute; platform cap 150 s/m"

    - category_error: "Solenoid PWM"
      actual_interface: "GPIO on/off (latching) or pulse"
      rejection_reason: "Latching solenoid holds state; non-latching requires continuous signal
                         but is NOT a PWM duty cycle (binary on/off)"
      correct_design: "GpioPin with min_pulse_width_ms / max_pulse_width_ms"

    - category_error: "ADS1256 24-bit ADC for aquaculture"
      actual_alternative: "MAX31865 (RTD) + Atlas EZO (pH/O2/EC) — these have integrated ADC
                            + protocol-level data output; no external ADC needed"
      rejection_reason: "Aquaculture sensor noise floor makes 16-bit sufficient;
                         24-bit ADS1256 complicates driver (SPI chip-select multiplex)
                         + higher cost without measurable benefit"
      correct_design: "Trust sensor-provided digital output; no external high-precision ADC"

    - category_error: "MFRC522 RFID for operator AUTHENTICATION"
      actual_permitted_use: "Asset tracking only (ISO 14443 asset-ID read)"
      rejection_reason: "ISO 14443 close-range (4cm) tap; UID easily cloned; relay attacks trivial;
                         SL-2 FR1 requires strong auth; RFID fails"
      correct_design: "Operator auth via command envelope ed25519 signature (ADR-018 §7);
                       RFID only for inventory asset tracking (no write-permission consequences)"
      lint_invariant: "tests/invariants/no_rfid_auth.rs"
```

### 2. Safe-State Schema v2 (ADR-019 §2.5 final form)

```rust
// WHY: Plan B V2 D-5 schema v2; v1 only covered Modbus + GPIO; v2 covers PWM / SPI /
//      process-aware dependencies + effect-based permission routing.
// WHAT: Enum-closed output taxonomy; every actuator MUST map to exactly one variant;
//       unknown actuator REJECTED at deploy-time (not runtime — make-it-impossible tier-1).
// INVARIANT: tests/invariants/safe_state_schema_v2_complete.rs — every entry in
//            hardware_inventory.yaml actuators[] maps to an OutputTag variant; unmapped = fail CI.

pub enum OutputTag {
    ModbusCoil {
        device: ModbusDeviceId,
        coil: u16,
        safe_value: bool,  // false = "OFF is safe"
    },
    ModbusRegister {
        device: ModbusDeviceId,
        register: u16,
        safe_value: u16,
        value_range: Range<u16>,        // platform-validated; writes outside → reject
    },
    GpioPin {
        pin: u8,
        safe_level: bool,
        min_pulse_width_ms: u16,         // for pulse-mode; continuous = u16::MAX
        max_pulse_width_ms: u16,
    },
    I2cOutput {
        bus: I2cBusId,
        address: u8,
        safe_register_writes: Vec<(u8, u8)>,  // (register, safe_value)
    },

    // v2 YENİ: PwmChannel
    PwmChannel {
        channel: u8,
        safe_duty: f32,                  // 0.0..1.0 — typically 0.0 (OFF)
        max_duty: f32,                   // platform hard cap
        max_rate_of_change_per_min: f32, // dosage overshoot prevention
        pwm_frequency_hz: u16,
        fade_duration_ms: u16,           // graceful transition on safe-state trigger
    },

    // v2 YENİ: SpiWrite
    SpiWrite {
        device: SpiDeviceId,
        safe_bytes: Vec<u8>,             // SPI command sequence for safe-state
        chip_select_pin: u8,
        transfer_speed_hz: u32,
    },

    // v2 YENİ: ProcessAware — safe-state dependent on process variables
    ProcessAware {
        base_output: Box<OutputTag>,
        dependencies: Vec<ProcessStateDependency>,
        // safe-state value = f(current process state); not constant
    },
}

pub enum ProcessStateDependency {
    // Example: "aerator safe=ON if pond_stock_density > 50 kg/m³"
    //          "aerator safe=OFF if pond_harvested AND stock_density == 0"
    TagThreshold {
        tag_id: TagId,
        threshold: f32,
        operator: ComparisonOp,  // Gt | Lt | Eq | Gte | Lte
        when_true_safe_value: SafeValue,
        when_false_safe_value: SafeValue,
    },
    ScheduleDependent {
        time_window: DailyTimeRange,
        during_safe_value: SafeValue,
        outside_safe_value: SafeValue,
    },
    InterlockWith {
        other_tag: TagId,
        must_be: TagState,  // must_be_on | must_be_off
        if_interlocked_safe: SafeValue,
        if_released_safe: SafeValue,
    },
}

pub enum SafeValue {
    Bool(bool),
    U16(u16),
    F32(f32),
    Bytes(Vec<u8>),
    InheritFromBase,  // use base_output's safe_value
}
```

### 3. Effect-Based Permission Mapping

Plan B V2 D-5 effect-based permission yaklaşımı — attacker interface'de deny olursa diğerine geçemez:

```rust
// WHY: Interface-based permission (ModbusWrite / GpioWrite / PwmWrite / SpiWrite)
//      attacker-bypass vector: deny ModbusWrite → attacker switches to GPIO path
//      for same EFFECT (e.g. turn aerator OFF via GPIO if Modbus denied).
// WHAT: AffectActuator { class } — effect-level permission; routed to interface by hardware inventory.
// INVARIANT: Permission::WriteTag{tag_id} + Permission::AffectActuator{class} BOTH required;
//            AffectActuator class resolved from hardware_inventory.yaml at deploy-time.

pub enum ActuatorClass {
    Aeration,      // aerators, blowers, oxygen injection
    Chemistry,     // pH/alkalinity/chlorine dosing pumps
    Filtration,    // filter valves, backwash solenoids
    Lighting,      // LED diurnal PWM
    Feeding,       // feeder motors, conveyor belts
    LifeSupport,   // CRITICAL subset — O2 dosing, emergency drain, aerator overrides
                   // EmergencyActuator{class: LifeSupport} narrow scope per ADR-018 §5
    Inventory,     // non-actuator (RFID asset tags, passive sensors)
}

// Permission check pipeline:
// 1. Tag lookup in hardware_inventory.yaml → resolves ActuatorClass
// 2. Permission::WriteTag{tag_id} — existing (ADR-018 §1)
// 3. AFFECT gate: AuthorizedContext.has(Permission::AffectActuator{class}) — NEW
// 4. Interface-level check (ModbusWrite/GpioWrite/PwmWrite/SpiWrite) — existing
// 5. Rate cap (hardware_inventory max_rate_of_change_per_min) — NEW

// Attack-vector closure:
// Attacker denied ModbusWrite for aerator tag "pond3_aerator" at permission manifest.
// Old design: attacker finds GPIO route "pond3_aerator_gpio" — effects aerator via GPIO → SUCCESS.
// New design: AffectActuator{Aeration} check fails regardless of interface → DENY.
```

### 4. ADC Self-Test Protocol

```rust
// WHY: Silent sensor drift → operator blind → life-safety incident.
//      IEC 61508 DC ≥ 90% requires active diagnostic coverage.
// WHAT: Hardware scanner startup + 1 Hz periodic reference voltage check; drift alarm.
// INVARIANT: tests/invariants/adc_self_test_periodic.rs — self-test frequency matches
//            hardware_inventory.yaml self_test_interval_sec; drift > 0.1% → alarm fires.

pub struct AdcSelfTest {
    pub reference_voltage_mv: i32,       // factory-calibrated reference
    pub tolerance_pct: f32,              // default 0.1%
    pub measurement_interval_sec: u64,   // hardware_inventory.yaml derived
    pub consecutive_failure_threshold: u32,  // default 3
}

impl AdcSelfTest {
    pub async fn run_cycle(&mut self) -> AdcSelfTestResult {
        let measured = read_reference_channel().await?;
        let drift = ((measured - self.reference_voltage_mv).abs() as f32 / self.reference_voltage_mv as f32) * 100.0;

        if drift > self.tolerance_pct {
            self.consecutive_failures += 1;
            if self.consecutive_failures >= self.consecutive_failure_threshold {
                // CRITICAL: ADC drifted beyond tolerance
                audit::emit(AuditAction::AdcDriftDetected {
                    reference_mv: self.reference_voltage_mv,
                    measured_mv: measured,
                    drift_pct: drift,
                });
                safe_state::trip(SafeStateTrigger::AdcDrift).await?;
                return AdcSelfTestResult::Failed { drift_pct: drift };
            }
        } else {
            self.consecutive_failures = 0;
        }
        Ok(AdcSelfTestResult::Passed)
    }
}

// Integration with MAX31865 RTD + Atlas EZO sensors (ADR-017 ST bytecode reads tags):
// Sensor drivers use MAX31865-integrated fault detection (VBIAS short-to-GND, RTD open);
// Atlas EZO calibration drift report via `Cal,?` command periodic.
// Self-test results logged as audit events (ADR-020 §7 KeystoreBackendSelected sibling).
```

### 5. RFID Auth Lint-Level Prohibition

```rust
// WHY: ISO 14443 RFID close-range tap = cloning + relay attack trivial; SL-2 FR1 fails.
//      Asset tracking OK (UID read without auth consequences); auth path FORBIDDEN.
// WHAT: Compile-time lint via cargo-deny + clippy lint + grep invariant.
// INVARIANT: tests/invariants/no_rfid_auth.rs — grep sens-api-gateway/src/
//            for patterns matching RFID-based auth (function names, imports from rfid:: into authz::);
//            any match = CI fail.

// forbidden patterns (invariant test):
// 1. use ::rfid::read_uid in src/authz/ — RFID UID must NEVER reach AuthorizedContext construction
// 2. fn authz::identify_from_rfid — function name ban (compile-time symbol grep)
// 3. Import of mfrc522 crate into crate::authz — module boundary lint
// 4. Any `impl From<RfidUid> for OperatorId` — explicit conversion ban

// PERMITTED (asset tracking):
// - src/inventory/rfid_scanner.rs — reads UID, maps to AssetId (NOT OperatorId)
// - AssetId used for inventory.yaml cross-reference — no authz consequences
```

### 6. Dosage Rate Cap Enforcement

```rust
// WHY: Dosage overshoot (chemistry pumps, PWM-driven LED) safety-critical.
//      Hardware inventory declares max_rate_of_change_per_min; enforced in write path.
// WHAT: Rate limiter per-tag; violates → reject + audit.
// INVARIANT: tests/invariants/dosage_rate_cap.rs — fuzz rapid setpoint changes;
//            exceed max_rate_of_change → writes rejected.

pub struct DosageRateCap {
    tag_id: TagId,
    max_rate_per_min: f32,          // from hardware_inventory.yaml
    last_value: f32,
    last_timestamp: Instant,         // monotonic
}

impl DosageRateCap {
    pub fn check(&mut self, new_value: f32, now: Instant) -> Result<(), RateCapViolation> {
        let delta_t_sec = (now - self.last_timestamp).as_secs_f32();
        if delta_t_sec < 1.0 {
            return Ok(()); // below measurement resolution
        }
        let rate_per_min = (new_value - self.last_value).abs() / delta_t_sec * 60.0;
        if rate_per_min > self.max_rate_per_min {
            audit::emit(AuditAction::DosageRateCapViolated {
                tag_id: self.tag_id,
                attempted_rate: rate_per_min,
                cap: self.max_rate_per_min,
            });
            return Err(RateCapViolation {
                attempted: rate_per_min,
                cap: self.max_rate_per_min,
            });
        }
        self.last_value = new_value;
        self.last_timestamp = now;
        Ok(())
    }
}
```

### 7. SIL-2 Alignment per Life-Safety Output

```yaml
# Life-safety outputs (hardware_inventory.yaml category == LifeSupport OR derived):
sil_alignment:
  target_sil: 2
  pfd_avg_target: "10^-3 ≤ PFD < 10^-2"
  diagnostic_coverage_target: "≥ 90%"
  proof_test_interval_months: 6

  life_safety_outputs:
    - tag_id: "pond3_aerator_primary"
      category: LifeSupport
      effect: Aeration
      backup_path: "pond3_aerator_secondary"  # redundant aerator; fail-over
      fail_safe: "on_at_90_percent_duty"      # fail-ON for life-support
      dc_mechanism:
        - "MAX31865 VBIAS monitor (sensor health)"
        - "Atlas EZO O2 reading cross-check"
        - "Modbus comm heartbeat 1 Hz"
      dc_computed: "TBD — FMEA post-inventory-populate"

    - tag_id: "pond3_o2_dosing"
      category: LifeSupport
      effect: Chemistry
      fail_safe: "off"  # fail-OFF for dosing (overdose worse than underdose)
      dc_mechanism:
        - "Flow-meter sensor cross-check"
        - "Stroke-count audit per minute"
      dc_computed: "TBD"

  # FMEA (Failure Modes Effects Analysis) deliverable Faz 0 Sprint 0.3 tamamlayıcı
  fmea_document_url: "docs/compliance/life-safety-fmea.md (TBD)"
```

---

## Alternatives Considered

### Alt-1 Plan B V1 "PWM + SPI wire all" (kategori körü)
Aerator/dosing/solenoid hepsini PWM kabul etmek saha gerçekliğini bozar; category error catastrophic. 3 agent audit (saha + güvenlik + mimari) REDDET. REDDEDİLDİ.

### Alt-2 Dry-run-only approach (PWM/SPI actor var ama hardware inventory Faz 1'de)
"Actor var = wire etmek hazır" varsayımı yanlış; deployment ratio + fail-safe attestation olmadan wire = operationally reckless. REDDEDİLDİ.

### Alt-3 Interface-based permission (ModbusWrite / GpioWrite / PwmWrite / SpiWrite)
Attacker bypass pathway — deny ModbusWrite → switch GpioWrite same effect. REDDEDİLDİ; effect-based AffectActuator{class} seçildi.

### Alt-4 RFID allowed for operator convenience auth
ISO 14443 cloning trivial; SL-2 FR1 fails; life-safety actuator control via cloned RFID = catastrophic. REDDEDİLDİ with lint-level enforcement.

### Alt-5 Skip SIL-2 alignment (SL-2 cyber only, not functional safety)
Aquaculture life-safety reality: O2/pH failure → fish mortality in hours. SIL alignment regulatory industry practice; skipping = operational risk + insurance issue. KABUL (SIL-2 targeted).

---

## Consequences

### Positive
- **Kategori hataları kapatılır:** aerator/dosing/solenoid correctly mapped to their actual interface; PWM only where validated (LED diurnal)
- **Effect-based permission:** attacker cannot sidestep interface deny via alternate path
- **Safe-state v2 complete:** PwmChannel / SpiWrite / ProcessAware variants final; ADR-019 §2.5 reference resolved
- **SIL-2 hazır:** life-safety outputs FMEA'ya hazır; regulatory alignment
- **ADC self-test aktif:** sensor drift → alarm + safe-state trip; IEC 61508 DC ≥ 90% path
- **RFID auth structurally blocked:** lint-level + invariant test + compile-time symbol grep
- **Dosage rate cap:** overshoot prevention; binary-embedded hard caps (manifest cannot widen)
- **Hardware inventory audit trail:** signed YAML; engineer attestation per fail-safe behavior; tamper-evident

### Negative
- **Field OEM data dependency:** inventory YAML populate Faz 0 Sprint 0.3 field-ops work; blocked sitewise until populated
- **Engineer attestation overhead:** process engineer + aquaculture engineer signature per actuator
- **Implementation kod:** `src/hardware_inventory/` + `src/safe_state/v2/` ~800-1000 satır; `src/rate_cap/` ~300 satır
- **FMEA deliverable:** docs/compliance/life-safety-fmea.md separate work; 1-2 week
- **Lint/invariant test suite:** 4+ new invariant tests

### Neutral
- **External PLC still owns aerator/dosing control path:** CLAUDE.md "Yol C" (closed PLC OPC-UA / Modbus / S7 setpoint writes) remains primary; edge agent sends setpoint, PLC enforces motor control. Edge-agent-direct-PWM only for LED.

---

## 8. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| DEC-005 | MEDIUM | §1 + §2 | Hardware inventory YAML schema + safe-state v2 complete; PWM/SPI wire decision per-actuator not blanket |
| ARC-004 | MEDIUM | §1 LED driver entry + §1 RTD entry | pwm.rs + spi.rs WIRED for ACCEPTED use cases; rejected use cases documented in rejected_hardware_use_cases |
| STL-003 | HIGH | §7 SIL alignment | SIL-2 target + DC mechanisms + FMEA deliverable tracked |
| Plan B V2 D-5 REVİZE MAJOR | — | This ADR as a whole | Category errors fixed; effect-based permission; RFID auth ban |

---

## 9. Implementation Plan (Plan §5 Faz 0-1)

**Faz 0 (Sprint 0.3 field-ops survey):**
- Field-ops team: OEM SKU + deployment ratio + fail-safe attestation populate for all actuators across 50-tenant pilot fleet
- Engineering-signed fail-safe behavior per actuator (process engineer + aquaculture engineer)
- `hardware_inventory.yaml` signed by field_ops_lead
- `docs/compliance/life-safety-fmea.md` initial draft

**Faz 1 (Sprint 7.x wiring):**
- Sprint 7.1: `src/hardware_inventory/` parser + `hardware_inventory.yaml` signed load
- Sprint 7.2: `src/safe_state/v2/` — PwmChannel + SpiWrite + ProcessAware variants
- Sprint 7.3: `src/rate_cap/` — DosageRateCap implementation + integration with command dispatch
- Sprint 7.4: `src/authz/` extension — AffectActuator{class} resolver (hardware_inventory.yaml lookup)
- Sprint 7.5: ADC self-test protocol integration (MAX31865 + Atlas EZO cross-check)
- Sprint 7.6: RFID auth lint + invariant tests (no_rfid_auth.rs, no_rfid_in_authz_module.rs)
- Sprint 7.7: Safe-state v2 migration tests (existing v1 configs → v2 schema auto-upgrade)

**Acceptance criteria:**
- `hardware_inventory.yaml` complete (zero TBD for pilot fleet) + signed
- `docs/compliance/life-safety-fmea.md` signed by process engineer + security-lead
- `tests/invariants/safe_state_schema_v2_complete.rs` green — every actuator maps to OutputTag variant
- `tests/invariants/no_rfid_auth.rs` green
- `tests/invariants/dosage_rate_cap.rs` green
- `tests/invariants/adc_self_test_periodic.rs` green
- `tests/invariants/effect_permission_bypass_impossible.rs` green — attacker denied Interface + different path same class → both denied
- 3rd-party audit: IEC 61508 SIL-2 pre-assessment pass
- Status → Accepted

---

## References

- IEC 61508 Parts 1-7 (Functional Safety of Electrical/Electronic/Programmable Systems)
- IEC 61511 (Functional Safety for Process Industry Sector)
- IEC 62443-3-3 FR1 (Identification & Authentication)
- ISO 14443 (Proximity cards)
- NFPA 79 (Industrial Machinery Electrical Safety)
- `sens-api-gateway/src/pwm.rs` (dead_code — WIRED by this ADR for LED use-case)
- `sens-api-gateway/src/spi.rs` (dead_code — WIRED by this ADR for MAX31865 RTD)
- `sens-api-gateway/src/safe_state.rs` (v1 schema extended to v2 by this ADR)
- `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.5 D-5 REVİZE MAJOR
- `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-22, §5 Faz 0-1
- ADR-017 (ST Bytecode — WriteTag opcode + RbacGatedWriter consumer of effect-based permission)
- ADR-018 (RBAC — Permission::AffectActuator{class} + Permission::EmergencyActuator{class: LifeSupport})
- ADR-019 §2.5 (Safe-state schema v2 reference)
- ADR-020 §7 (audit events AdcDriftDetected + DosageRateCapViolated)
- `docs/compliance/life-safety-fmea.md` (Faz 0 deliverable)
- `docs/security/threat-model.md` §3 (per-component STRIDE — hardware adapters)
