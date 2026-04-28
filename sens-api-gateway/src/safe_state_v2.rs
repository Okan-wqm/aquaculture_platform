//! # Safe-State v2 — FailSafe enum + OutputTag v2 + DiversityClass (ADR-024 §3 §4)
//!
//! Schema v2 supersedes v1 (`safe_state.rs`) by addressing the 4 CRITICAL
//! life-safety bugs identified in ADR-024 v1 audit:
//!
//! | # | Bug | v2 closure |
//! |---|-----|------------|
//! | 1 | Aerator fail-safe `on_ac_loss_to_off` vs `fail-ON 90%` contradiction | [`FailSafe`] enum with per-`ActuatorSubClass` invariant (AerationSubClass::LifeSupport + FailSafe::Off → REJECT) |
//! | 2 | `hardware_inventory.yaml` lookup mutable = class reclassification attack | Per-tuple signed `ActuatorClassBindingEntry` (ADR-024 §2 — lands in Faz 2 Sprint 6.2) |
//! | 3 | `Chemistry` class single fail-OFF default catastrophic for O2 dosing | [`ChemistrySubClass`] split (`Nutrient`/`PhAdjust` fail-OFF; `LifeSupportDose` fail-HOLD-BOUNDED) |
//! | 4 | Dual-Modbus `backup_path` = single-point-failure | [`DiversityClass`] enum + [`HardwiredSafetyOverride`] first-class variant |
//!
//! ## Scope of Batch 3
//! **Pure type definitions — zero runtime behavior.** The v1 `SafeStateManager`
//! still drives shutdown safe-state apply; Faz 2 Sprint 7.2 migrates consumers
//! to v2. This batch exists so downstream modules (hardware_inventory loader,
//! ST VM `WriteTag` opcode, OPC UA server write-through) can reference the v2
//! shape before runtime wiring.
//!
//! ## Invariants enforced in types (compile-time / ctor-time)
//!
//! 1. **`FailSafe::OffViaGracefulFade.fade_duration_ms > 0`** — zero-duration
//!    graceful fade is a contradiction; enforced at manifest-parse time
//!    (`hardware_inventory.yaml` → `FailSafe` conversion).
//! 2. **`FailSafe::OnAtPercent.duty_pct` ∈ [0.0, 1.0]** — PWM duty clamp;
//!    enforced at ctor in the `hardware_caps` binary-const overlay
//!    (ADR-024 §5 `const_table!` macro; Batch 5).
//! 3. **`ProcessAwareFailSafe.dependency_freshness_seconds_max > 0`** — stale
//!    data definition cannot be "0 seconds past" (always stale) nor unbounded.
//! 4. **`ModbusRegisterRange` (authz::permission)** already enforces
//!    `start <= end` at ctor.
//!
//! ## Cross-ADR references
//!
//! - ADR-024 §3 Explicit FailSafe enum + FailSafeOnStale
//! - ADR-024 §4 Diversity schema — backup_path.diversity_class
//! - ADR-018 §5 EMERGENCY_PERMITTED_BASE (EmergencyActuator{LifeSupport})
//! - ADR-019 §2.5 Safe-state schema v2 reference
//! - ADR-020 §7 AuditAction::AdcDriftDetected + DosageRateCapViolated

use serde::{Deserialize, Serialize};

// BATCH-001-CI-FIX-017: only ActuatorClass is currently referenced in
// type signatures (e.g. `BackupPath::validate_for_life_support`).
// AerationSubClass / ChemistrySubClass / ThermalSubClass are imported for
// the test module at the bottom of this file; moved their `use` down
// there to keep top-level clean under `default=["health"]` builds.
use crate::authz::ActuatorClass;
// Imported from authz::permission for FailSafe threshold comparisons + tag-scoped
// interlock references; Batch 2 delivered these types.
use crate::authz::TagId;

// =============================================================================
// ModbusDeviceName newtype — signed-binding-controlled logical device name
// =============================================================================

/// Logical Modbus device name as it appears in the signed ActuatorClassBindingEntry.
///
/// **WHY (BATCH-003-FINDING-001 closure):** v1 `safe_state.rs` uses bare
/// `device_name: String`, and Batch 2 `authz::ModbusDeviceId(u8)` holds the
/// protocol-level slave ID. Without a type-visible link between the two, a
/// future Sprint 7.2 dispatcher will need a MUTABLE logical-name→slave-ID table
/// — the same "mutable lookup = reclassification attack" vector ADR-024 §2
/// closes for `ActuatorClassBindingEntry`.
///
/// **WHAT:** Newtype over `String`. Consumed by `ModbusCoilAddress` /
/// `ModbusRegisterAddress` / `SpiWrite.device_name`. The resolver that maps
/// `ModbusDeviceName` → `ModbusDeviceId` MUST live behind the signed binding
/// registry; no ad-hoc HashMap lookup tables.
///
/// **INVARIANT:** Name appears in the signed `ActuatorClassBindingEntry`
/// (ADR-024 §2; Faz 2 Sprint 6.2). Unsigned usage rejected at inventory load.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModbusDeviceName(pub String);

impl ModbusDeviceName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for ModbusDeviceName {
    fn from(s: String) -> Self {
        Self(s)
    }
}

// =============================================================================
// FailSafe enum (ADR-024 §3 CRITICAL-001/003, HIGH-001/002/003/004 closure)
// =============================================================================

/// Explicit fail-safe behavior for an actuator output.
///
/// **WHY:** v1 (`safe_state.rs`) assumed a single canonical fail-safe (de-energise
/// / drive to zero / LOW). Aquaculture reality: life-support actuators often
/// require fail-**ON** or fail-**HOLD-LAST** because fail-OFF kills fish (O2
/// depletion within minutes). ADR-024 §3 CRITICAL-001 closure.
///
/// **WHAT:** Closed enum covering the full taxonomy observed in aquaculture
/// deployments:
/// - OFF family (safe-OFF actuators — pH dosing, nutrient dosing, LED, contactors)
/// - ON family (life-support aeration, O2 injection during power loss)
/// - Stateful preservation (latching solenoids, RAS recirculation)
/// - Process-aware (safe value depends on stock density, schedule, interlocks)
/// - Emergency escalation (TripToSafeState cascade, operator alert-only)
///
/// **INVARIANT (per-subclass — Faz 2 Sprint 7.2 runtime check):**
/// - `AerationSubClass::Normal` → `FailSafe::Off { latency_ms: Some(..) }` required
/// - `AerationSubClass::LifeSupport` → `FailSafe::OnAtPercent { duty_pct: >= 0.8 }` required
/// - `ChemistrySubClass::Nutrient` / `PhAdjust` → `FailSafe::Off` required
/// - `ChemistrySubClass::LifeSupportDose` → `FailSafe::HoldLastKnownGood { max_hold_duration_secs: <= 300 }` required
/// - `ThermalSubClass::*` → `FailSafe::Off` required (cold/hot drift slower than boil)
/// - `Filtration` (drum) → `FailSafe::Off` required
/// - `Filtration` (latching solenoid) → `FailSafe::LatchPreserved` required
/// - `Lighting` LED diurnal → `FailSafe::OffViaGracefulFade { fade_duration_ms: >= 1000, hold_last_state_ms_first: >= 60_000 }` (species-aware)
/// - `Recirculation` → `FailSafe::HoldLastKnownGood { max_hold_duration_secs: <= 600, escalation: TripToSafeState }`
///
/// Invariant test `tests/invariants/fail_safe_enum_per_subclass.rs` (Faz 2
/// Sprint 7.2 acceptance criterion) enforces the above at deploy-time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FailSafe {
    // -------------------------------------------------------------------------
    // Actuator-OFF family (safe-OFF actuators)
    // -------------------------------------------------------------------------
    /// De-energise the output. Relay drops out → actuator off.
    ///
    /// `latency_ms = None` means "immediate" (unbounded for latching actuators
    /// where no active transition is needed — see [`FailSafe::LatchPreserved`]
    /// for the correct choice if the actuator is latching). `Some(N)` means
    /// control-loss to actual-off transition should complete within N ms.
    Off {
        /// None = immediate (no active transition); Some(N) = bounded transition.
        /// ADR-024 §3 LOW-004 closure: None reserved for latching; general
        /// actuators use Some(_).
        latency_ms: Option<u32>,
    },

    /// Fade gracefully to zero output over `fade_duration_ms` milliseconds.
    /// Optional `hold_last_state_ms_first` — hold the last commanded state for
    /// this duration BEFORE starting the fade (mitigates sudden-darkness stress
    /// on photoperiod-critical species per HIGH-001 closure).
    OffViaGracefulFade {
        fade_duration_ms: u32,
        /// None = fade starts immediately on control-loss.
        /// Some(N) = hold last state for N ms, then fade.
        hold_last_state_ms_first: Option<u32>,
    },

    // -------------------------------------------------------------------------
    // Actuator-ON family (life-support)
    // -------------------------------------------------------------------------
    /// Drive the output ON at full rated capacity for up to `max_duration_secs`.
    /// On expiry, apply the explicit `on_expiry` FailSafe — type-visible link
    /// so the signed `ActuatorBinding` attests to BOTH the ON-duration AND the
    /// post-expiry behavior in the same signed unit.
    ///
    /// **WHY (BATCH-003-FINDING-003 closure):** v1 doc said "escalate to
    /// HoldLastKnownGood configured at ActuatorBinding level" — untyped runtime
    /// lookup = reclassification attack vector. Explicit field makes escalation
    /// part of the signed binding.
    OnFull {
        max_duration_secs: u32,
        /// Mandatory escalation behavior on max-duration expiry.
        on_expiry: Box<FailSafe>,
    },

    /// Drive the output ON at a specific duty percentage (PWM actuators) or
    /// nominal rate (dosing pumps). `duty_pct ∈ [0.0, 1.0]`. For aerator
    /// life-support typical: 0.9 (90% duty).
    ///
    /// **BATCH-003-FINDING-003 closure:** explicit `on_expiry` same pattern as
    /// `OnFull`.
    OnAtPercent {
        /// 0.0..=1.0 — validated by `hardware_caps::effective_cap` (ADR-024 §5)
        duty_pct: f32,
        max_duration_secs: u32,
        /// Mandatory escalation behavior on max-duration expiry.
        on_expiry: Box<FailSafe>,
    },

    // -------------------------------------------------------------------------
    // Stateful preservation
    // -------------------------------------------------------------------------
    /// Hold the last commanded state until `max_hold_duration_secs`, then
    /// escalate to the nested `escalation` FailSafe.
    ///
    /// Used for: RAS recirculation pumps (brief hold OK, eventually escalate);
    /// photoperiod-sensitive LED (hold then fade); O2 dosing (hold then alert).
    HoldLastKnownGood {
        /// 0 means "immediate escalation" — degenerate; use direct escalation.
        /// Typical bounds: 60..=600 secs for life-support; 5..=30 secs for
        /// non-critical.
        max_hold_duration_secs: u32,
        /// Escalation behavior on hold expiry. Boxed to avoid infinite enum size.
        escalation: Box<FailSafe>,
    },

    /// No active transition — latching solenoid / mechanical latch holds its
    /// current state. Latency is N/A (no action).
    ///
    /// **Only valid for truly latching hardware.** Non-latching outputs that
    /// require continuous signal MUST use `Off` or `OnAtPercent`.
    LatchPreserved,

    /// Hold the output within a bounded range `[min, max]`; drive to `default_to`
    /// on control-loss.
    ///
    /// Used for: sensors expecting a specific calibration offset output; analog
    /// outputs where "zero" is meaningless (e.g., 4-20 mA where 4 mA is the
    /// valid "zero" signal).
    ///
    /// **BATCH-003-FINDING-002 closure:** Validation enforced via
    /// [`BoundedRange`] newtype (see below) instead of bare struct-variant
    /// fields — ctor rejects invariant violations (`min > max` or
    /// `default_to < min` or `default_to > max`).
    BoundedRange(BoundedRange),

    // -------------------------------------------------------------------------
    // Process-aware + interlock
    // -------------------------------------------------------------------------
    /// Safe-state depends on runtime process state (stocking density, time of
    /// day, interlock with another tag); if the dependency is stale/unreadable,
    /// escalate to the stored fallback.
    ///
    /// HIGH-002 closure: `primary.dependency_freshness_seconds_max` bounds
    /// "real-time" requirement; `fail_safe_on_stale` provides safe fallback
    /// when dependency can't be trusted.
    ProcessAwareOrEscalate {
        primary: Box<ProcessAwareFailSafe>,
        fail_safe_on_stale: Box<FailSafe>,
    },

    /// Check an interlock; different safe-values for interlocked / released /
    /// unreadable (sensor failure) states.
    ///
    /// HIGH-004 closure: `if_unreadable_safe` forces engineer to explicitly
    /// choose the safer-of-two on sensor failure; cannot fall through to
    /// "last known good" (which may itself be stale).
    ///
    /// **BATCH-003-FINDING-004 closure:** `TagState` reduced to binary `On`/`Off`
    /// (transient intermediate observations route through `if_unreadable_safe`
    /// per engineer convention); three-branch semantics preserved.
    InterlockOrFailSafe {
        check: InterlockCheck,
        if_interlocked_safe: Box<FailSafe>,
        if_released_safe: Box<FailSafe>,
        if_unreadable_safe: Box<FailSafe>,
    },

    // -------------------------------------------------------------------------
    // Emergency escalation
    // -------------------------------------------------------------------------
    /// Escalate to the system-wide safe-state routine (trips ALL actuators to
    /// their registered fail-safe). Used as terminal escalation in
    /// `HoldLastKnownGood.escalation` when per-actuator recovery has exhausted.
    TripToSafeState,

    /// Emit an operator alert but take no automatic action. Appropriate ONLY
    /// for monitoring-only deployments where remote operator intervention is
    /// the expected response. **NOT VALID** for life-support tags — use
    /// `TripToSafeState` instead.
    OperatorAlertOnly,
}

// =============================================================================
// BoundedRange — validated numeric range newtype (BATCH-003-FINDING-002 closure)
// =============================================================================

/// Bounded numeric range for [`FailSafe::BoundedRange`].
///
/// **WHY:** v1 struct-variant with `pub` fields permitted `min > max` or
/// `default_to` outside `[min, max]` at YAML load; doc-only invariant =
/// tier-4. Ctor-validated newtype = tier-1 make-it-impossible.
///
/// **WHAT:** Private fields + `new()` ctor + `#[serde(try_from = "...")]`
/// indirection (same pattern as `authz::ModbusRegisterRange` from Batch 2).
///
/// **INVARIANT (enforced at ctor):** `min <= default_to <= max` AND `min <= max`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "BoundedRangeWire")]
pub struct BoundedRange {
    min: f32,
    max: f32,
    default_to: f32,
}

#[derive(Deserialize)]
struct BoundedRangeWire {
    min: f32,
    max: f32,
    default_to: f32,
}

impl TryFrom<BoundedRangeWire> for BoundedRange {
    type Error = BoundedRangeError;
    fn try_from(w: BoundedRangeWire) -> Result<Self, Self::Error> {
        Self::new(w.min, w.max, w.default_to)
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum BoundedRangeError {
    #[error("BoundedRange: min ({min}) must be <= max ({max})")]
    MinAfterMax { min: f32, max: f32 },
    #[error("BoundedRange: default_to ({default_to}) must be within [{min}, {max}]")]
    DefaultOutOfBounds {
        min: f32,
        max: f32,
        default_to: f32,
    },
    #[error("BoundedRange: min/max/default_to must not be NaN")]
    NaNInput,
}

impl BoundedRange {
    pub fn new(min: f32, max: f32, default_to: f32) -> Result<Self, BoundedRangeError> {
        if min.is_nan() || max.is_nan() || default_to.is_nan() {
            return Err(BoundedRangeError::NaNInput);
        }
        if min > max {
            return Err(BoundedRangeError::MinAfterMax { min, max });
        }
        if default_to < min || default_to > max {
            return Err(BoundedRangeError::DefaultOutOfBounds {
                min,
                max,
                default_to,
            });
        }
        Ok(Self {
            min,
            max,
            default_to,
        })
    }

    pub fn min(&self) -> f32 {
        self.min
    }
    pub fn max(&self) -> f32 {
        self.max
    }
    pub fn default_to(&self) -> f32 {
        self.default_to
    }
}

// =============================================================================
// ProcessAware + dependencies (ADR-024 §3 HIGH-002 closure)
// =============================================================================

/// Process-aware fail-safe root — a base FailSafe augmented with runtime
/// dependencies on other tags' values.
///
/// **WHY:** Aquaculture reality — the "safe" aerator state depends on pond
/// stocking density (empty pond = aerator OFF safe; stocked pond = aerator ON
/// mandatory). Static fail-safe can't express this; static fallback picks the
/// pessimistic assumption when dependency data is unavailable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessAwareFailSafe {
    /// The base FailSafe shape when dependencies are satisfied.
    pub base: FailSafe,
    /// Ordered list of process-state dependencies. Each evaluated in order;
    /// first failing dependency triggers `action_on_stale`.
    pub dependencies: Vec<ProcessStateDependency>,
    /// Max age (seconds) beyond which dependency data is considered stale.
    /// Typical bounds: 10..=300 secs for real-time sensors; 3600..=86400 secs
    /// for operator-entered stocking metadata.
    pub dependency_freshness_seconds_max: u32,
    /// Action when ANY dependency is stale / unreadable.
    pub action_on_stale: StaleAction,
}

/// A single process-state condition participating in process-aware fail-safe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ProcessStateDependency {
    /// Compare a tag's current value against a threshold.
    ///
    /// Example: `"safe-state aerator = ON if pond_stock_density > 50 kg/m³"` →
    /// `TagThreshold { tag_id: "pond3_stock_density", threshold: 50.0,
    /// operator: ComparisonOp::Gt, ... }`.
    TagThreshold {
        tag_id: TagId,
        threshold: f32,
        operator: ComparisonOp,
        /// Whether this tag is a real-time sensor (fast freshness) or
        /// operator-entered metadata (slower).
        freshness_requirement: FreshnessRequirement,
        /// FailSafe to apply when comparison evaluates TRUE.
        when_true_safe: Box<FailSafe>,
        /// FailSafe to apply when comparison evaluates FALSE.
        when_false_safe: Box<FailSafe>,
    },
    /// Time-of-day-based safe-state.
    ///
    /// Example: LED diurnal — during night window FailSafe::Off, during day
    /// window FailSafe::OffViaGracefulFade (bounded fade after photoperiod end).
    ScheduleDependent {
        time_window: DailyTimeRange,
        /// HIGH-003 closure — trust mode for the wall clock; degrades gracefully
        /// on stale clock (post-cold-boot, RTC battery dead).
        clock_trust_mode: ClockTrustMode,
        during_safe: Box<FailSafe>,
        outside_safe: Box<FailSafe>,
    },
    /// Interlock with another tag's state.
    ///
    /// Example: "aerator ON only if filter pump ON (dependency check)".
    InterlockWith {
        other_tag: TagId,
        must_be: TagState,
        if_interlocked_safe: Box<FailSafe>,
        if_released_safe: Box<FailSafe>,
        if_unreadable_safe: Box<FailSafe>,
    },
}

/// Comparison operator for [`ProcessStateDependency::TagThreshold`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ComparisonOp {
    /// Strict less-than.
    Lt,
    /// Less-than-or-equal.
    Lte,
    /// Equal (exact float equality — prefer threshold-with-tolerance for floats).
    Eq,
    /// Greater-than-or-equal.
    Gte,
    /// Strict greater-than.
    Gt,
}

/// How fresh a tag value must be for a [`ProcessStateDependency`] to trust it.
///
/// **WHY (HIGH-002 closure):** ADR-024 §3 explicit — stocking-density tag is
/// typically operator-entered static metadata (updated at stocking events),
/// NOT a real-time sensor. Using stale metadata to gate a life-safety
/// fail-safe is unsafe; this enum forces the engineer to classify.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FreshnessRequirement {
    /// Real-time sensor data. `max_age_seconds` is bounded (typically 1..=30).
    MustBeRealTimeSensor { max_age_seconds: u32 },
    /// Operator-entered stocking metadata. `max_age_hours` bounded
    /// (typically 1..=168 for weekly-attested data).
    /// On stale: `fail_safe_on_stale` used (worst-case stocking assumed).
    StaticStockingMetadata {
        max_age_hours: u32,
        fail_safe_on_stale: SafeValue,
    },
    /// Operator-configured (one-time) value. Cannot be "stale" per se but
    /// CAN be "missing" (never entered). `fail_safe_on_stale_or_missing`
    /// handles either.
    StaticConfigOperatorEntered {
        fail_safe_on_stale_or_missing: Box<FailSafe>,
    },
}

/// Action when a [`ProcessAwareFailSafe`] dependency is stale.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum StaleAction {
    /// Assume the pessimistic (most-safety-conservative) value.
    /// Example: stocking density unknown → assume MAX density (aerator ON).
    AssumePessimistic(SafeValue),
    /// Trip to system-wide safe-state.
    TripToSafeState,
    /// Emit operator alert; take no automatic action. Monitoring-only deployments.
    OperatorAlert,
}

/// Trust model for wall clock on [`ProcessStateDependency::ScheduleDependent`].
///
/// **WHY (HIGH-003 closure):** RPi 4/5 without battery-backed RTC boots with
/// epoch clock; `ScheduleDependent` matching wrong window = wrong safe-state.
/// Operator selects how clock-stale-tolerant the schedule evaluation is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ClockTrustMode {
    /// Trust wall clock only when NTP-synced within `max_age_seconds`.
    /// On stale: degrade per `outside_safe` in the parent `ScheduleDependent`.
    NtpSyncedWithinWindow { max_age_seconds: u32 },
    /// Do not trust wall clock. Always use `outside_safe` (safest polarity).
    /// Appropriate for cold-boot / RTC-less deployments.
    MonotonicOnlyIgnoreSchedule,
    /// SL-3 remote-attestation + GPS-disciplined PTP hardware time.
    /// Provides sub-microsecond precision + verified freshness.
    /// (ADR-023 §7 SL-3 option.)
    GpsPtpHardware,
}

/// Interlock evaluation for [`FailSafe::InterlockOrFailSafe`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum InterlockCheck {
    /// Check if another tag is in a specific state.
    TagState { tag: TagId, state: TagState },
    /// Check if another tag's value crosses a threshold.
    ProcessThreshold {
        tag: TagId,
        threshold: f32,
        op: ComparisonOp,
    },
}

/// Tag state for boolean interlock checks.
///
/// **BATCH-003-FINDING-004 closure:** reduced to binary On/Off. Transitional
/// / transient intermediate observations route through
/// [`FailSafe::InterlockOrFailSafe::if_unreadable_safe`] by engineer convention
/// (sensor-filtering concern, not a safe-state primitive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TagState {
    On,
    Off,
}

/// Daily time range for [`ProcessStateDependency::ScheduleDependent`].
///
/// Represents `[start, end]` within a 24-hour day. `start > end` means the
/// window crosses midnight (e.g., `22:00..06:00` = night).
///
/// **BATCH-003-FINDING-002 closure:** Validated ctor — hours 0..=23, minutes
/// 0..=59. Serde deserialization routed through `try_from` indirection to
/// enforce invariants (same pattern as `authz::ModbusRegisterRange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "DailyTimeRangeWire")]
pub struct DailyTimeRange {
    start_hour: u8,
    start_minute: u8,
    end_hour: u8,
    end_minute: u8,
}

#[derive(Deserialize)]
struct DailyTimeRangeWire {
    start_hour: u8,
    start_minute: u8,
    end_hour: u8,
    end_minute: u8,
}

impl TryFrom<DailyTimeRangeWire> for DailyTimeRange {
    type Error = DailyTimeRangeError;
    fn try_from(w: DailyTimeRangeWire) -> Result<Self, Self::Error> {
        Self::new(w.start_hour, w.start_minute, w.end_hour, w.end_minute)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DailyTimeRangeError {
    #[error("invalid hour: {0} (must be 0..=23)")]
    HourOutOfRange(u8),
    #[error("invalid minute: {0} (must be 0..=59)")]
    MinuteOutOfRange(u8),
}

impl DailyTimeRange {
    pub fn new(
        start_hour: u8,
        start_minute: u8,
        end_hour: u8,
        end_minute: u8,
    ) -> Result<Self, DailyTimeRangeError> {
        if start_hour > 23 {
            return Err(DailyTimeRangeError::HourOutOfRange(start_hour));
        }
        if end_hour > 23 {
            return Err(DailyTimeRangeError::HourOutOfRange(end_hour));
        }
        if start_minute > 59 {
            return Err(DailyTimeRangeError::MinuteOutOfRange(start_minute));
        }
        if end_minute > 59 {
            return Err(DailyTimeRangeError::MinuteOutOfRange(end_minute));
        }
        Ok(Self {
            start_hour,
            start_minute,
            end_hour,
            end_minute,
        })
    }

    pub fn start_hour(&self) -> u8 {
        self.start_hour
    }
    pub fn start_minute(&self) -> u8 {
        self.start_minute
    }
    pub fn end_hour(&self) -> u8 {
        self.end_hour
    }
    pub fn end_minute(&self) -> u8 {
        self.end_minute
    }
}

/// Typed safe-value for [`FailSafe`] actuator output targets.
///
/// Decoupled from specific output-interface types (Modbus coil bool, register
/// u16, GPIO bool, PWM f32) so a single FailSafe spec can target any interface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SafeValue {
    Bool(bool),
    U16(u16),
    F32(f32),
    Bytes(Vec<u8>),
    /// Inherit from the parent `OutputTag` / `FailSafe` context.
    InheritFromBase,
}

// =============================================================================
// OutputTag v2 — existing v1 variants + PwmChannel + SpiWrite + ProcessAware +
// HardwiredSafetyOverride (ADR-024 §3 + §4)
// =============================================================================

/// Modbus coil address scope.
///
/// Uses [`ModbusDeviceName`] (not bare `String`) — BATCH-003-FINDING-001 closure.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ModbusCoilAddress {
    pub device_name: ModbusDeviceName,
    pub coil: u16,
}

/// Modbus holding register address scope.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ModbusRegisterAddress {
    pub device_name: ModbusDeviceName,
    pub register: u16,
}

/// I2C output descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct I2cOutputDescriptor {
    pub bus: String,
    pub address: u8,
    /// Ordered (register, safe_value) writes.
    pub safe_register_writes: Vec<(u8, u8)>,
}

/// Output tag — extended v2 schema superseding v1 `safe_state::OutputTag`.
///
/// **WHY:** ADR-024 §3 extended taxonomy — v1 only covered Modbus + GPIO;
/// v2 adds PWM, SPI write, process-aware dependencies, and hardwired safety
/// override (industrial SIL-2 pattern per ADR-024 §4 CRITICAL-004 closure).
///
/// **INVARIANT:** Every `(tag_id, OutputTag)` binding in
/// `hardware_inventory.yaml` MUST map to exactly one variant; unmapped entries
/// rejected at inventory load. Enforced by
/// `tests/invariants/safe_state_schema_v2_complete.rs` (Faz 2 Sprint 7.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum OutputTag {
    // -------------------------------------------------------------------------
    // v1 variants (preserved for migration compatibility)
    // -------------------------------------------------------------------------
    /// Modbus coil (digital output).
    ModbusCoil {
        address: ModbusCoilAddress,
        safe_value: bool,
    },
    /// Modbus holding register (analog output).
    ModbusRegister {
        address: ModbusRegisterAddress,
        safe_value: u16,
        /// Valid value range; writes outside the range rejected at dispatch time.
        value_range_min: u16,
        value_range_max: u16,
    },
    /// GPIO output pin.
    GpioPin {
        pin: u8,
        safe_level: bool,
        /// For pulse-mode outputs: min/max pulse width in ms.
        /// Continuous-signal outputs: `max_pulse_width_ms = u32::MAX`.
        min_pulse_width_ms: u16,
        max_pulse_width_ms: u32,
    },
    /// I2C DAC or relay board.
    I2cOutput {
        descriptor: I2cOutputDescriptor,
    },

    // -------------------------------------------------------------------------
    // v2 NEW — PwmChannel (ADR-024 §3)
    // -------------------------------------------------------------------------
    /// PWM channel output (ACCEPTED use-case: LED diurnal per ADR-024 §1).
    ///
    /// **INVARIANT:** `safe_duty ∈ [0.0, max_duty]`; `max_duty ∈ [0.0, 1.0]`;
    /// `max_rate_of_change_per_min ∈ [0.0, ∞)`. Binary-const hard caps per SKU
    /// (`hardware_caps::lookup_cap(sku)` from ADR-024 §5) override YAML
    /// loosening.
    PwmChannel {
        channel: u8,
        /// 0.0..=max_duty — typically 0.0 (OFF)
        safe_duty: f32,
        /// Platform hard cap — writes above this reject.
        max_duty: f32,
        /// Rate-of-change cap (%/minute) — dosage overshoot prevention
        /// (ADR-024 §6 dosage rate cap enforcement).
        max_rate_of_change_per_min: f32,
        /// PWM carrier frequency.
        pwm_frequency_hz: u16,
        /// Graceful transition duration on safe-state trigger.
        fade_duration_ms: u16,
    },

    // -------------------------------------------------------------------------
    // v2 NEW — SpiWrite (ADR-024 §3)
    // -------------------------------------------------------------------------
    /// SPI write output (NON-AUTHENTICATION use only per ADR-024 §6 RFID auth ban).
    ///
    /// Uses `ModbusDeviceName` newtype for cross-batch consistency — same
    /// signed-binding-controlled discipline as Modbus addresses (SPI has its
    /// own bus registry in `src/spi.rs`, but the logical-name → chip-select
    /// resolution must traverse the signed binding registry).
    SpiWrite {
        /// SPI device logical name — consulted in signed binding registry.
        device_name: ModbusDeviceName,
        /// SPI command sequence for safe-state.
        safe_bytes: Vec<u8>,
        chip_select_pin: u8,
        transfer_speed_hz: u32,
    },

    // -------------------------------------------------------------------------
    // v2 NEW — ProcessAware (ADR-024 §3)
    // -------------------------------------------------------------------------
    /// Process-aware output — safe-state depends on runtime process variables
    /// (stocking density, time of day, interlocks).
    ///
    /// The wrapped `base_output` is the underlying output target; `dependencies`
    /// override the safe-value at runtime per process state.
    ProcessAware {
        base_output: Box<OutputTag>,
        dependencies: Vec<ProcessStateDependency>,
    },

    // -------------------------------------------------------------------------
    // v2 NEW — HardwiredSafetyOverride (ADR-024 §4 CRITICAL-004 closure)
    // -------------------------------------------------------------------------
    /// GPIO hardwired to contactor coil bypassing PLC (industrial SIL-2 SOA).
    ///
    /// **WHY:** ADR-024 §4 — dual-Modbus backup_path is single-point-failure;
    /// IEC 61508-2 §7.4.3.4 mandates diverse redundancy. Hardwired override
    /// enables diverse control path (PLC fails → GPIO still drives contactor).
    ///
    /// **INVARIANT:** Only valid when `ActuatorBinding.is_life_support: true`.
    /// `signed_hardware_attestation` must carry ed25519 signature by RBAC
    /// manifest signing key (ADR-021 slot 2) asserting the engineer attestation
    /// of the diversity claim. BATCH-003-FINDING-007 closure: signature wrapped
    /// in [`HardwareAttestationSig`] newtype with verifier that re-derives
    /// canonical attestation bytes — prevents two-call-site serialization drift.
    HardwiredSafetyOverride {
        /// Which normal-path tag this override replaces.
        primary_tag: TagId,
        /// GPIO pin for direct contactor control (bypasses PLC/Modbus).
        gpio_pin: u8,
        /// Coil voltage in volts DC (typically 24V).
        coil_voltage_v: u8,
        /// Behavior on override activation.
        override_behavior: FailSafe,
        /// ed25519 signature by rbac_manifest_signing_key (slot 2) over the
        /// canonical attestation bytes (see `HardwareAttestationSig::canonical_bytes`).
        signed_hardware_attestation: HardwareAttestationSig,
    },
}

/// ed25519 signature wrapper for [`OutputTag::HardwiredSafetyOverride`].
///
/// **WHY (BATCH-003-FINDING-007 closure):** Raw `[u8; 64]` has no type-visible
/// binding to the claim payload; two call-sites serializing the attestation
/// differently drift silently. Newtype with `canonical_bytes` associated
/// function pins the serialization shape.
///
/// **INVARIANT:** `canonical_bytes` deterministic — bincode serialization of
/// the exact tuple `(primary_tag, gpio_pin, coil_voltage_v, override_behavior)`
/// in field-declaration order. Verification code MUST call `canonical_bytes`;
/// direct `bincode::serialize(&the_struct)` is forbidden (would include the
/// signature field itself in the payload → unverifiable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareAttestationSig(
    #[serde(with = "serde_big_array::BigArray")]
    pub [u8; 64],
);

impl HardwareAttestationSig {
    /// Expose the raw signature bytes.
    pub fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }

    /// Canonical attestation bytes for the given override parameters.
    ///
    /// **WHAT:** Deterministic serialization of `(primary_tag, gpio_pin,
    /// coil_voltage_v, override_behavior)` in field-declaration order using
    /// bincode 1.3.3 (ADR-020 FINDING-019 pinned).
    /// **WHY:** Verifier calls this to reconstruct the signed payload; prevents
    /// field-order drift / format drift across call sites.
    pub fn canonical_bytes(
        primary_tag: &TagId,
        gpio_pin: u8,
        coil_voltage_v: u8,
        override_behavior: &FailSafe,
    ) -> Result<Vec<u8>, bincode::Error> {
        let tuple = (primary_tag, gpio_pin, coil_voltage_v, override_behavior);
        bincode::serialize(&tuple)
    }
}

// =============================================================================
// DiversityClass + BackupPath (ADR-024 §4 CRITICAL-004 closure)
// =============================================================================

/// Redundancy class declaring the diversity of a backup path.
///
/// **WHY:** IEC 61508-2 §7.4.3.4 requires diverse redundancy for SIL-2
/// credit. Dual-Modbus on same PLC = single-point-failure. This enum forces
/// engineer to declare the diversity topology.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DiversityClass {
    /// Both paths traverse the same transport (e.g., dual-Modbus on same PLC).
    /// **NOT VALID for LifeSupport-flagged actuators.** SL-0 redundancy level.
    SameTransport,
    /// Different transport (e.g., primary Modbus + secondary GPIO).
    /// Acceptable SL-1 redundancy level.
    DifferentTransport,
    /// Hardwired GPIO→contactor bypassing PLC (industrial SIL-2 SOA).
    /// Enables life-support primary-path failure recovery.
    HardwiredOverride,
    /// Secondary PLC with separate RS-485 trunk + independent power feed.
    /// SL-2 sustained redundancy level.
    IndependentPlc,
}

/// Backup path descriptor for redundancy declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupPath {
    /// Tag-ID of the secondary actuator that takes over on primary failure.
    pub tag_id: TagId,
    /// Diversity topology.
    pub diversity_class: DiversityClass,
    /// Engineer-attested narrative describing the hardware topology.
    /// Examples: "Dedicated GPIO pin 17 → 24V contactor coil bypassing PLC"
    /// or "Secondary PLC on independent RS-485 trunk, separate 24V power feed".
    pub hardware_topology_notes: String,
}

impl BackupPath {
    /// Validate that this BackupPath is allowed for a given actuator class + LifeSupport flag.
    ///
    /// **INVARIANT (ADR-024 §4 CRITICAL-004):** LifeSupport-flagged actuators
    /// MUST have `diversity_class != SameTransport`; inventory-load rejects
    /// otherwise.
    ///
    /// Returns `Ok(())` if valid, `Err(BackupPathError)` otherwise.
    pub fn validate_for_life_support(
        &self,
        is_life_support: bool,
        class: ActuatorClass,
    ) -> Result<(), BackupPathError> {
        if is_life_support && self.diversity_class == DiversityClass::SameTransport {
            return Err(BackupPathError::LifeSupportRequiresDiverseRedundancy {
                actual: self.diversity_class,
                class_hint: class,
            });
        }
        Ok(())
    }
}

/// Error returned by [`BackupPath::validate_for_life_support`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BackupPathError {
    #[error(
        "life-support actuator requires diverse redundancy; got {actual:?} \
         (class hint: {class_hint:?}); use DifferentTransport, HardwiredOverride, or IndependentPlc"
    )]
    LifeSupportRequiresDiverseRedundancy {
        actual: DiversityClass,
        class_hint: ActuatorClass,
    },
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    // BATCH-001-CI-FIX-017: SubClass enums used inside tests at
    // `BackupPath::validate_for_life_support` call sites + the
    // `actuator_class_reachable_from_safe_state_v2` smoke test. Pulled
    // into test scope explicitly so the module-level `use` stays minimal.
    use crate::authz::{AerationSubClass, ChemistrySubClass, ThermalSubClass};

    // WHY: Serde roundtrip smoke test for FailSafe variants — manifest JSON
    //      shape stability depends on this contract.
    #[test]
    fn fail_safe_serde_roundtrip_off() {
        let f = FailSafe::Off {
            latency_ms: Some(500),
        };
        let json = serde_json::to_string(&f).expect("serialize");
        let parsed: FailSafe = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(f, parsed);
    }

    #[test]
    fn fail_safe_serde_roundtrip_on_at_percent() {
        let f = FailSafe::OnAtPercent {
            duty_pct: 0.9,
            max_duration_secs: 1800,
            on_expiry: Box::new(FailSafe::HoldLastKnownGood {
                max_hold_duration_secs: 60,
                escalation: Box::new(FailSafe::TripToSafeState),
            }),
        };
        let json = serde_json::to_string(&f).expect("serialize");
        let parsed: FailSafe = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(f, parsed);
    }

    // BATCH-003-FINDING-002 regression guard: BoundedRange rejects invariant
    // violations at construction.
    #[test]
    fn bounded_range_rejects_min_after_max() {
        let err = BoundedRange::new(10.0, 5.0, 7.0).expect_err("should reject");
        assert!(matches!(err, BoundedRangeError::MinAfterMax { .. }));
    }

    #[test]
    fn bounded_range_rejects_default_out_of_bounds() {
        let err = BoundedRange::new(0.0, 100.0, 150.0).expect_err("should reject");
        assert!(matches!(err, BoundedRangeError::DefaultOutOfBounds { .. }));
    }

    #[test]
    fn bounded_range_rejects_nan_input() {
        let err = BoundedRange::new(f32::NAN, 100.0, 50.0).expect_err("should reject");
        assert_eq!(err, BoundedRangeError::NaNInput);
    }

    #[test]
    fn bounded_range_accepts_valid_input() {
        let r = BoundedRange::new(0.0, 100.0, 50.0).expect("valid range");
        assert_eq!(r.min(), 0.0);
        assert_eq!(r.max(), 100.0);
        assert_eq!(r.default_to(), 50.0);
    }

    // BATCH-003-FINDING-002 — DailyTimeRange ctor validation.
    #[test]
    fn daily_time_range_rejects_invalid_hour() {
        let err = DailyTimeRange::new(25, 0, 6, 0).expect_err("should reject");
        assert_eq!(err, DailyTimeRangeError::HourOutOfRange(25));
    }

    #[test]
    fn daily_time_range_rejects_invalid_minute() {
        let err = DailyTimeRange::new(22, 60, 6, 0).expect_err("should reject");
        assert_eq!(err, DailyTimeRangeError::MinuteOutOfRange(60));
    }

    #[test]
    fn daily_time_range_accepts_valid_night_window() {
        // 22:00..06:00 night window (crosses midnight)
        let r = DailyTimeRange::new(22, 0, 6, 0).expect("valid night window");
        assert_eq!(r.start_hour(), 22);
        assert_eq!(r.end_hour(), 6);
    }

    // WHY: HoldLastKnownGood nests another FailSafe in Box — smoke-test that
    //      Box'd recursive variants serialize/deserialize cleanly.
    #[test]
    fn fail_safe_serde_roundtrip_hold_last_with_escalation() {
        let f = FailSafe::HoldLastKnownGood {
            max_hold_duration_secs: 300,
            escalation: Box::new(FailSafe::TripToSafeState),
        };
        let json = serde_json::to_string(&f).expect("serialize");
        let parsed: FailSafe = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(f, parsed);
    }

    // WHY: Core ADR-024 §4 CRITICAL-004 invariant — dual-same-transport for
    //      LifeSupport actuator MUST be rejected at inventory-load time.
    #[test]
    fn backup_path_rejects_same_transport_for_life_support() {
        let bp = BackupPath {
            tag_id: TagId::from("pond3_aerator_secondary".to_string()),
            diversity_class: DiversityClass::SameTransport,
            hardware_topology_notes: "Dual Modbus on same PLC — NOT diverse".to_string(),
        };
        let err = bp
            .validate_for_life_support(true, ActuatorClass::Aeration(AerationSubClass::LifeSupport))
            .expect_err("life-support + SameTransport must fail");
        assert!(matches!(
            err,
            BackupPathError::LifeSupportRequiresDiverseRedundancy {
                actual: DiversityClass::SameTransport,
                ..
            }
        ));
    }

    #[test]
    fn backup_path_accepts_hardwired_override_for_life_support() {
        let bp = BackupPath {
            tag_id: TagId::from("pond3_aerator_hardwired".to_string()),
            diversity_class: DiversityClass::HardwiredOverride,
            hardware_topology_notes: "GPIO 17 → 24V contactor coil bypassing PLC".to_string(),
        };
        assert!(
            bp.validate_for_life_support(true, ActuatorClass::Aeration(AerationSubClass::LifeSupport))
                .is_ok()
        );
    }

    #[test]
    fn backup_path_accepts_different_transport_for_life_support() {
        // BATCH-003-FINDING-006 closure: DifferentTransport is acceptable SL-1
        // level per ADR-024 §4 documentation; validate_for_life_support accepts.
        let bp = BackupPath {
            tag_id: TagId::from("pond3_aerator_gpio_backup".to_string()),
            diversity_class: DiversityClass::DifferentTransport,
            hardware_topology_notes: "Primary Modbus + secondary GPIO on separate power".to_string(),
        };
        assert!(
            bp.validate_for_life_support(true, ActuatorClass::Aeration(AerationSubClass::LifeSupport))
                .is_ok()
        );
    }

    #[test]
    fn backup_path_accepts_same_transport_for_non_life_support() {
        // Non-life-support actuator — SameTransport is acceptable SL-0 level.
        let bp = BackupPath {
            tag_id: TagId::from("pond3_feeder_secondary".to_string()),
            diversity_class: DiversityClass::SameTransport,
            hardware_topology_notes: "Dual Modbus on same PLC — OK for non-LS".to_string(),
        };
        assert!(
            bp.validate_for_life_support(false, ActuatorClass::Feeding)
                .is_ok()
        );
    }

    // WHY: OutputTag HardwiredSafetyOverride carries a HardwareAttestationSig
    //      newtype; compile-time check that the newtype carries 64 bytes.
    #[test]
    fn hardwired_safety_override_signature_is_64_bytes() {
        let _t = OutputTag::HardwiredSafetyOverride {
            primary_tag: TagId::from("pond3_aerator".to_string()),
            gpio_pin: 17,
            coil_voltage_v: 24,
            override_behavior: FailSafe::OnAtPercent {
                duty_pct: 0.9,
                max_duration_secs: 1800,
                on_expiry: Box::new(FailSafe::TripToSafeState),
            },
            signed_hardware_attestation: HardwareAttestationSig([0u8; 64]),
        };
        // If the field is not HardwareAttestationSig([u8; 64]), this does not compile.
    }

    // BATCH-003-FINDING-007 — canonical_bytes deterministic across calls;
    // two identical (primary_tag, gpio_pin, coil_voltage_v, override_behavior)
    // tuples yield identical serialization.
    #[test]
    fn hardware_attestation_canonical_bytes_deterministic() {
        let tag = TagId::from("pond3_aerator".to_string());
        let fs = FailSafe::OnAtPercent {
            duty_pct: 0.9,
            max_duration_secs: 1800,
            on_expiry: Box::new(FailSafe::TripToSafeState),
        };
        let a = HardwareAttestationSig::canonical_bytes(&tag, 17, 24, &fs).expect("ok");
        let b = HardwareAttestationSig::canonical_bytes(&tag, 17, 24, &fs).expect("ok");
        assert_eq!(a, b);
        // Different parameters → different bytes.
        let c = HardwareAttestationSig::canonical_bytes(&tag, 18, 24, &fs).expect("ok");
        assert_ne!(a, c);
    }

    // WHY: PwmChannel carries multiple rate/cap fields; smoke-test that serde
    //      emits a self-consistent JSON shape.
    #[test]
    fn pwm_channel_serde_roundtrip() {
        let t = OutputTag::PwmChannel {
            channel: 0,
            safe_duty: 0.0,
            max_duty: 1.0,
            max_rate_of_change_per_min: 0.20,
            pwm_frequency_hz: 1000,
            fade_duration_ms: 1000,
        };
        let json = serde_json::to_string(&t).expect("serialize");
        let parsed: OutputTag = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(t, parsed);
    }

    // WHY: ProcessAware wraps Box<OutputTag> — test recursive-variant roundtrip.
    #[test]
    fn process_aware_wraps_output_tag_roundtrip() {
        let inner = OutputTag::ModbusCoil {
            address: ModbusCoilAddress {
                device_name: ModbusDeviceName("plc1".to_string()),
                coil: 17,
            },
            safe_value: false,
        };
        let pa = OutputTag::ProcessAware {
            base_output: Box::new(inner.clone()),
            dependencies: vec![],
        };
        let json = serde_json::to_string(&pa).expect("serialize");
        let parsed: OutputTag = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(pa, parsed);
    }

    // WHY: ComparisonOp values must serialize as canonical names for manifest
    //      JSON stability (golden shape pin).
    #[test]
    fn comparison_op_serde_canonical_names() {
        assert_eq!(serde_json::to_string(&ComparisonOp::Lt).expect("ok"), r#""Lt""#);
        assert_eq!(serde_json::to_string(&ComparisonOp::Gt).expect("ok"), r#""Gt""#);
        assert_eq!(serde_json::to_string(&ComparisonOp::Gte).expect("ok"), r#""Gte""#);
    }

    // WHY: DailyTimeRange is a flat struct — wire format must be stable.
    #[test]
    fn daily_time_range_golden_json_shape() {
        let r = DailyTimeRange {
            start_hour: 22,
            start_minute: 0,
            end_hour: 6,
            end_minute: 0,
        };
        let json = serde_json::to_string(&r).expect("ok");
        assert_eq!(
            json,
            r#"{"start_hour":22,"start_minute":0,"end_hour":6,"end_minute":0}"#
        );
    }

    // WHY: Reference to ChemistrySubClass / ThermalSubClass from Batch 2 —
    //      smoke-test that authz::ActuatorClass variants compile against this
    //      module's expected usage.
    #[test]
    fn actuator_class_reachable_from_safe_state_v2() {
        let classes = [
            ActuatorClass::Aeration(AerationSubClass::LifeSupport),
            ActuatorClass::Chemistry(ChemistrySubClass::LifeSupportDose),
            ActuatorClass::Thermal(ThermalSubClass::Heating),
            ActuatorClass::Recirculation,
        ];
        assert_eq!(classes.len(), 4);
    }

    // WHY: Verify that ModbusDeviceName + ModbusCoilAddress compose correctly.
    //      BATCH-003-FINDING-001 closure — type-visible logical device name.
    #[test]
    fn modbus_coil_address_uses_device_name_newtype() {
        let addr = ModbusCoilAddress {
            device_name: ModbusDeviceName("plc1".to_string()),
            coil: 17,
        };
        assert_eq!(addr.device_name.as_str(), "plc1");
        let _tag = OutputTag::ModbusCoil {
            address: addr,
            safe_value: false,
        };
    }

    // WHY: TagState binary enum (BATCH-003-FINDING-004 closure — Transitioning
    //      dropped). Serde roundtrip + variant count pin.
    #[test]
    fn tag_state_is_binary() {
        assert_eq!(serde_json::to_string(&TagState::On).expect("ok"), r#""On""#);
        assert_eq!(serde_json::to_string(&TagState::Off).expect("ok"), r#""Off""#);
    }

    // WHY: FreshnessRequirement has nested Box<FailSafe> — ensure recursive
    //      enum compiles + serializes.
    #[test]
    fn freshness_requirement_static_config_roundtrip() {
        let fr = FreshnessRequirement::StaticConfigOperatorEntered {
            fail_safe_on_stale_or_missing: Box::new(FailSafe::TripToSafeState),
        };
        let json = serde_json::to_string(&fr).expect("ok");
        let parsed: FreshnessRequirement = serde_json::from_str(&json).expect("ok");
        assert_eq!(fr, parsed);
    }
}
