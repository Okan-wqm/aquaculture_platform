//! # Permission enum + ActuatorClass taxonomy (ADR-018 §1 + ADR-024 §1)
//!
//! Fixed edge-vocabulary permission enum — the **authoritative list of capabilities**
//! the edge agent understands. Platform RBAC manifest evolution happens at the
//! `custom_roles[].permissions: Vec<Permission>` level; this enum itself is stable
//! within a binary release.
//!
//! ## Design decisions
//!
//! 1. **Closed enum, additive-only** — per ADR-018 §1 INVARIANT; variants may be
//!    added in new binary releases but NEVER removed (would break forward compat
//!    for manifests targeting the removed variant). Removal requires ADR amendment
//!    + `min_edge_version` floor bump (ADR-018 §6).
//!
//! 2. **Effect-based `AffectActuator`** — per ADR-024 §3 Effect-Based Permission
//!    Mapping. Attacker denied `ModbusWrite` for aerator cannot simply switch to
//!    `GpioWrite` for same effect; `AffectActuator { class }` check catches all
//!    interface variants once resolved from `hardware_inventory.yaml`.
//!
//! 3. **`EmergencyActuator` narrowly scoped** — per ADR-018 §5 break-glass subset.
//!    Binary-hardcoded allowlist (ADR-024 §3) — manifest cannot widen.
//!
//! 4. **Newtype identifiers** — `TagId`, `DeviceId`, `OperatorId`, `TenantId`,
//!    `SpiDeviceId` are newtypes wrapping primitive types. Purpose: prevent
//!    accidental cross-type assignment (e.g., passing a `DeviceId` where a
//!    `TagId` is expected) at the type system level.
//!
//! ## Serialization contract
//!
//! All enums + newtypes derive `Serialize`+`Deserialize` (serde) for:
//! - RBAC manifest JSON parsing (ADR-018 §6)
//! - Audit event emission (ADR-020 §7)
//! - Bytecode header serialization (ADR-017 §6; see allowed_write_tags)
//!
//! Deserialization rejects unknown variant names via Rust enum exhaustiveness
//! (serde default behavior for untagged variant names). Per ADR-018 §6
//! FINDING-006: unknown permissions in a manifest → whole-manifest REJECT
//! (fail-closed), not silent drop. That check lives in `authz::verify_manifest`
//! (Faz 2 Sprint 7.1).
//!
//! Future struct-variant parameters (e.g., potential future `ExtendedWriteTag`
//! with optional fields) should carry `#[serde(deny_unknown_fields)]` on the
//! associated inner struct. No such variants exist in Batch 2 — enum-level
//! annotation does NOT cascade to struct variants; per-struct annotation
//! required when such variants are added. BATCH-002-FINDING-004 closure.

use serde::{Deserialize, Serialize};

// =============================================================================
// Identifier newtypes
// =============================================================================

/// Opaque identifier for a device (edge agent instance).
///
/// **WHY:** Every signed artifact carries a `device_id` binding (ADR-019 §4
/// `ProvisioningBlob.device_id`). Using a newtype prevents accidental type
/// confusion with other UUIDs like `TenantId` at the call-site.
///
/// **WHAT:** Wraps `[u8; 16]` — UUID byte representation in network order.
/// Display format is the canonical UUID hyphenated hex per
/// `uuid::Uuid::from_bytes(inner)`.
///
/// **INVARIANT:** Inner field is module-private (no `pub` on tuple position).
/// Constructed by `new_from_verified` (pub(crate)) only; downstream code cannot
/// forge via `DeviceId([0u8;16])` literal. BATCH-002-FINDING-003 partial closure.
/// Full seal (sealing `Deserialize` behind a wire-type + verifier) lands with
/// `AuthorizedContext` in Faz 2 Sprint 6.1 — tracked as BATCH-002-FINDING-003-FU.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DeviceId([u8; 16]);

impl DeviceId {
    /// Mint a `DeviceId` from raw bytes — restricted to the verified provisioning path.
    ///
    /// **WHY:** ADR-019 §4 sealed provisioning binding. Only the provisioning-blob
    /// verifier (Faz 2 Sprint 6.2) should originate `DeviceId` values.
    /// **WHAT:** pub(crate) constructor; crate-internal callers only.
    pub(crate) fn new_from_verified(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Borrow the underlying UUID bytes.
    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// Opaque identifier for a tenant (SaaS customer).
///
/// **WHY:** Sealed tenant binding per ADR-018 §3 + ADR-019 §4 is the primary
/// isolation boundary. Cross-tenant manifest pivot (ADR-018 FINDING-001) is
/// structurally prevented by `TenantId` equality check at manifest verify.
///
/// **WHAT:** Wraps `[u8; 16]` — UUID bytes in network order, same convention as
/// `DeviceId`. Inner field module-private.
///
/// **INVARIANT:** `expected_tenant_id` used in `authz::verify_manifest` MUST
/// originate from `ProvisioningBlob::verified_tenant_id()` (ADR-019 §4), NEVER
/// from `config.yaml::tenant_id` (ADR-018 §3 FINDING-001 closure). Enforced by
/// `tests/invariants/tenant_binding_sealed.rs` (Faz 2 Sprint 6.2).
/// Tuple-field sealing: BATCH-002-FINDING-003 partial closure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TenantId([u8; 16]);

impl TenantId {
    /// Mint from the sealed provisioning source only.
    pub(crate) fn new_from_verified(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Borrow the underlying UUID bytes.
    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// Opaque identifier for an operator (human user authorized to issue commands).
///
/// **WHY:** Per-operator ed25519 signing key per ADR-018 §7 — each operator
/// signs commands with their own key, enrolled in the RBAC manifest
/// `custom_roles[].operators[].pubkey`. `OperatorId` is the stable reference
/// that binds an audit trail row to a specific human.
///
/// **WHAT:** Wraps `[u8; 16]` UUID bytes. Inner field module-private.
///
/// **INVARIANT (critical):** `OperatorId` constructor lives in
/// `authz::context::verify::mint_from_verified_envelope` ONLY (ADR-024 §6
/// type-system RFID auth ban closure). In Batch 2, a `pub(crate)
/// new_from_verified` helper is exposed for the forthcoming verifier. Full
/// deserialization seal (wire-type indirection) lands with `AuthorizedContext`
/// in Faz 2 Sprint 6.1 — tracked as BATCH-002-FINDING-003-FU.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OperatorId([u8; 16]);

impl OperatorId {
    /// Mint from a verified command envelope only.
    pub(crate) fn new_from_verified(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    /// Borrow the underlying UUID bytes.
    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// Human-readable tag identifier (e.g., `"pond3_aerator_primary"`).
///
/// **WHY:** Existing code uses `tag_name: String` (see `process_image.rs:122`);
/// newtype wrapping keeps ergonomic compatibility (`Into<&str>` via `as_str()`)
/// while introducing type-safety for permission checks — a function taking
/// `TagId` cannot be called with a `DeviceId` or arbitrary `String` without
/// explicit conversion.
///
/// **WHAT:** Wraps `String`. UTF-8, case-sensitive, no length limit (bounded by
/// `hardware_inventory.yaml` schema validation per ADR-024).
///
/// **INVARIANT:** Future refactor may switch to `Arc<str>` for cheaper cloning
/// in hot paths (ST VM scan cycle). That migration is tracked as a Faz 3
/// performance finding; Batch 2 stays on `String` to preserve HC-1 ergonomics.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TagId(String);

impl TagId {
    /// Construct a `TagId` from an owned string. Used at manifest parse
    /// boundaries and in tests. Wire-format parsing goes through
    /// `serde(transparent)` which reaches the private field via
    /// `Deserialize` — that's the sole serde-layer carve-out and is the
    /// intended path for JSON/YAML manifest ingestion.
    ///
    /// **Seal consistency (EDGE-LOW-003 closure):** inner field is private
    /// to match the `DeviceId` / `TenantId` / `OperatorId` sealed-newtype
    /// pattern established in Batch 2. External tuple-ctor invocation
    /// `TagId("raw".to_string())` is now a compile error; callers use
    /// `TagId::from(s)` or `TagId::new(s)` — both names accepted.
    pub fn new(s: String) -> Self {
        Self(s)
    }

    /// Returns the tag identifier as a string slice.
    ///
    /// **WHY:** Enables ergonomic interop with existing `tag_name: &str` APIs
    /// (`process_image.rs` etc.) without forcing cloning.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for TagId {
    /// Converts an owned `String` into a `TagId`.
    ///
    /// **WHAT:** Zero-copy wrap. Used primarily at manifest parse boundaries.
    fn from(s: String) -> Self {
        TagId(s)
    }
}

/// Identifier for a Modbus device on the network.
///
/// **WHY:** `Permission::ModbusWrite` is parameterized by device + register
/// range per ADR-018 §1; `DeviceId` is the Modbus slave address context
/// (distinct from the edge agent's own `DeviceId` above — Modbus naming is
/// protocol-scoped).
///
/// **WHAT:** Wraps `u8` — Modbus slave ID range 1..247 per protocol spec.
///
/// **INVARIANT:** Validation of `0..=247` range happens at `hardware_inventory.yaml`
/// parse time; this type does NOT validate at construction to preserve const-fn
/// usability. Violations caught at deploy-time inventory load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModbusDeviceId(pub u8);

/// Inclusive Modbus register range `[start, end]`.
///
/// **WHY:** ADR-018 §1 `Permission::ModbusWrite` parameterized by register
/// range. `std::ops::Range<u16>` does NOT implement `Hash` (BATCH-002-FINDING-001),
/// breaking `#[derive(Hash)]` on `Permission`. Also Rust's `Range` is half-open
/// `[start, end)` whereas Modbus integrators universally expect closed intervals
/// `[start, end]` (BATCH-002-FINDING-002). Explicit newtype removes both issues.
///
/// **WHAT:** Two `u16` fields with `start <= end` constructor check. `Copy`,
/// `Hash`, `Eq` derived — usable in `HashSet<Permission>` per ADR-018 §6
/// `required_permissions`. Serde emits `{"start": N, "end": M}` — stable wire
/// format for manifest JSON.
///
/// **INVARIANT:** `new(start, end)` constructor validates `start <= end`;
/// deserialization goes through validation via `try_from`. `start` and `end`
/// are 0..=65535 per Modbus protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "ModbusRegisterRangeWire")]
pub struct ModbusRegisterRange {
    start: u16,
    end: u16,
}

// Internal wire type used purely for serde deserialize + validation indirection.
// Keeps the field-level invariant (`start <= end`) behind `try_from`.
#[derive(Deserialize)]
struct ModbusRegisterRangeWire {
    start: u16,
    end: u16,
}

impl TryFrom<ModbusRegisterRangeWire> for ModbusRegisterRange {
    type Error = ModbusRegisterRangeError;

    fn try_from(wire: ModbusRegisterRangeWire) -> Result<Self, Self::Error> {
        Self::new(wire.start, wire.end)
    }
}

/// Error returned by `ModbusRegisterRange::new` / `TryFrom` when `start > end`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ModbusRegisterRangeError {
    #[error("invalid register range: start ({start}) must be <= end ({end})")]
    StartAfterEnd { start: u16, end: u16 },
}

impl ModbusRegisterRange {
    /// Construct a validated register range.
    ///
    /// **WHY:** Enforces `start <= end` at type-construction time, preventing
    /// malformed permission records from flowing through the system.
    /// **WHAT:** Validated ctor; returns `Err(StartAfterEnd)` on violation.
    pub fn new(start: u16, end: u16) -> Result<Self, ModbusRegisterRangeError> {
        if start > end {
            return Err(ModbusRegisterRangeError::StartAfterEnd { start, end });
        }
        Ok(Self { start, end })
    }

    /// Inclusive start register (0..=65535).
    pub fn start(&self) -> u16 {
        self.start
    }

    /// Inclusive end register (0..=65535).
    pub fn end(&self) -> u16 {
        self.end
    }

    /// Returns `true` if the given register is in the closed interval `[start, end]`.
    pub fn contains(&self, reg: u16) -> bool {
        reg >= self.start && reg <= self.end
    }
}

/// Identifier for an SPI device on the edge bus.
///
/// **WHY:** `Permission::SpiWrite` parameterized by device per ADR-018 §1.
/// ADR-024 §1 accepted SKUs include MAX31865 RTD (read-only) — but architectural
/// scope reserves SpiWrite for future SKUs (SPI DAC, PWM via SPI, etc.).
///
/// **WHAT:** Wraps `u8` — chip-select pin number or device-index in the SPI
/// bus registry (`sens-api-gateway/src/spi.rs` manages mapping).
///
/// **INVARIANT:** SPI writes are ADR-024 §1 rejected for authentication (MFRC522
/// RFID) — feature-gated via hardware_inventory allowlist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SpiDeviceId(pub u8);

// =============================================================================
// ActuatorClass taxonomy (ADR-024 §1)
// =============================================================================

/// Life-support subclassification for actuators whose failure threatens fish
/// survival (aerators, O2 dosing, emergency drain, etc.).
///
/// **WHY:** ADR-024 §1 — separates roles within `is_life_support: true` entries
/// so the permission check at audit time can correlate with the specific
/// hazard (e.g., an "OxygenSupply"-role actuator triggers different incident
/// response than a "TemperatureCriticalPath"-role actuator).
///
/// **WHAT:** Enum, additive-only per ADR-018 §1 INVARIANT. Variants map to
/// life-support roles identified in aquaculture HAZOP / FMEA per ADR-024 §7
/// SIL alignment.
///
/// **INVARIANT:** Serialization via serde-default (variant-name tag);
/// manifest schema accepts role names as strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LifeSupportRole {
    /// Oxygen supply path (aerators, O2 injection, air blowers).
    OxygenSupply,
    /// Temperature critical path (heaters/chillers when species-dependent).
    TemperatureCriticalPath,
    /// Ammonia + nitrogen-cycle control (biofilter, backwash sequencing).
    AmmoniaControl,
    /// Stocking-density interlocks (limit-switch-style triggers).
    StockDensityInterlock,
}

/// Aeration-class sub-classification (ADR-024 §1 CRITICAL-001 closure).
///
/// **WHY:** v1 ADR-024 conflated "aeration" with "life-support aeration" →
/// integrator misread → fish kill on AC-loss. Split into `Normal` (safe-OFF OK
/// when redundancy topology supports it) vs `LifeSupport` (mandatory fail-ON).
///
/// **WHAT:** Enum with `Normal` / `LifeSupport` variants. `FailSafe` enum
/// invariant (to land in Safe-State v2 batch) enforces:
/// - `AerationSubClass::Normal` requires `FailSafe::Off` (latency_ms = Some(_))
/// - `AerationSubClass::LifeSupport` requires `FailSafe::OnAtPercent` (duty >= 0.8)
///
/// **INVARIANT:** `hardware_inventory.yaml` load REJECTS
/// `Aeration(LifeSupport) + SinglePath topology` (ADR-024 §4 diversity schema).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AerationSubClass {
    /// Non-life-support aeration (surface agitators on redundant paths).
    Normal,
    /// Life-support aeration (primary oxygenation; fail-ON mandatory).
    LifeSupport,
}

/// Chemistry-class sub-classification (ADR-024 §1 CRITICAL-003 closure).
///
/// **WHY:** v1 ADR-024 single `Chemistry` default fail-OFF → O2 dosing pump
/// stopping on control-loss = fish die. Split by dose-chemistry criticality:
/// - `Nutrient` / `PhAdjust` → fail-OFF safe (underdose tolerable)
/// - `LifeSupportDose` → fail-HOLD-LAST-BOUNDED (O2, emergency chemistry)
///
/// **WHAT:** Enum. `FailSafe` invariant (Safe-State v2 batch):
/// - `LifeSupportDose` → `FailSafe::HoldLastKnownGood { max_hold_secs <= 300 }`
/// - Other variants → `FailSafe::Off` acceptable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ChemistrySubClass {
    /// Nutrient dosing (nitrogen, phosphorus supplements).
    Nutrient,
    /// pH / alkalinity buffer dosing.
    PhAdjust,
    /// Life-support dosing (O2 injection, emergency chemistry).
    LifeSupportDose,
}

/// Thermal-class sub-classification (ADR-024 §1 MEDIUM-001 closure).
///
/// **WHY:** v1 ADR-024 missed heating / cooling as distinct class. Heater
/// runaway → fish boil; chiller stuck-on → cold-shock. Both failure modes are
/// time-scale slower than aeration/O2, so fail-OFF safe for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThermalSubClass {
    /// Heating (for cold-water species in winter).
    Heating,
    /// Cooling (chillers, heat exchangers for warm-water species in summer).
    Cooling,
}

/// Actuator class — the top-level category every actuator tag maps into.
///
/// **WHY:** ADR-018 §1 `AffectActuator { class }` effect-based permission
/// routes through this enum. ADR-024 §1 extended taxonomy: added
/// `Recirculation`, `WasteRemoval`, `Degassing`, `EmergencyContainment` beyond
/// v1 core classes.
///
/// **WHAT:** Tagged union per actuator family. Variants that are inherently
/// life-support-capable (Aeration, Chemistry, Thermal) carry subclass markers;
/// others are single-level.
///
/// **INVARIANT:** Every tag in `hardware_inventory.yaml` MUST map to exactly
/// one `ActuatorClass` variant; unmapped tags are rejected at inventory load.
/// The separate `is_life_support: bool` flag on `ActuatorBinding` is
/// **orthogonal** to this enum — a `Thermal::Heating` tag can be
/// life-support-flagged for a species that depends on precise temperature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ActuatorClass {
    /// Aeration actuators (surface agitators, air blowers, O2 injection).
    Aeration(AerationSubClass),
    /// Chemistry dosing (nutrients, pH, O2, emergency chemistry).
    Chemistry(ChemistrySubClass),
    /// Filtration (drum filters, backwash solenoids, bead filters).
    Filtration,
    /// Lighting (LED diurnal, photoperiod control).
    Lighting,
    /// Feeding (feeder motors, conveyor belts).
    Feeding,
    /// Thermal (heating / cooling per sub-class).
    Thermal(ThermalSubClass),
    /// Recirculation (RAS main flow pumps — core life-support in RAS systems).
    Recirculation,
    /// Waste removal (sludge pumps, drum-filter backwash drives, biosolid augers).
    WasteRemoval,
    /// Degassing (CO2 stripping, venturi blowers).
    Degassing,
    /// Emergency containment (spill valves, emergency drain).
    EmergencyContainment,
    /// Non-actuator inventory (RFID asset tags — read-only; NO authentication use
    /// per ADR-024 §6 type-system RFID auth ban).
    Inventory,
}

// =============================================================================
// Permission enum (ADR-018 §1 — fixed edge vocabulary)
// =============================================================================

/// Edge-vocabulary capability — what a principal (operator or system) may do.
///
/// **WHY:** Per ADR-018 §1, this is the **Tier-1 make-it-impossible** boundary
/// against RBAC bypass. A closed Rust enum bounds the set of capabilities that
/// downstream code (command handlers, ST VM `WriteTag` opcode, audit emitters)
/// can check. Unknown permissions at manifest-parse time → fail-closed reject
/// (ADR-018 §6 `required_permissions: HashSet<PermissionName>` INVARIANT).
///
/// **WHAT:** Tagged union. Variants with parameters (e.g., `WriteTag { tag_id }`,
/// `ModbusWrite { device_id, register_range }`) enable fine-grained per-resource
/// authorization; variants without parameters (e.g., `ReadAuditLog`) are coarse.
///
/// **INVARIANT (additive-only):** Variants may be added in new releases; **never
/// removed** (removal breaks manifests targeting the removed permission).
/// Renaming a variant requires `min_edge_version` floor bump per ADR-018 §6.
///
/// **Serde representation:** Default serde tag (variant name). Manifest JSON
/// uses variant names as string discriminators; parameters serialize as nested
/// objects (e.g., `{"WriteTag": {"tag_id": "pond3_aerator"}}`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Permission {
    // -------------------------------------------------------------------------
    // Read paths
    // -------------------------------------------------------------------------
    /// Read any tag value from `ProcessImage`. Non-sensitive by default;
    /// most roles include this baseline.
    ReadTag,
    /// Read the append-only audit log (subset visible to non-admin per ADR-020 §10
    /// pseudonymization — operator-level audit view scrubbed of other-operator PII).
    ReadAuditLog,

    // -------------------------------------------------------------------------
    // Write paths (interface-specific — attacker cannot sidestep via alternate interface)
    // -------------------------------------------------------------------------
    /// Write to a specific `TagId` via the generic `ProcessImage` write path.
    /// Routed through `RbacGatedWriter` per ADR-017 §4 (Tier-1 module-boundary).
    WriteTag { tag_id: TagId },
    /// Write to a Modbus register range on a specific device.
    ///
    /// **WHY:** v1 used `Range<u16>` which does NOT implement `Hash` — breaks
    /// `#[derive(Hash)]` on the enum + `HashSet<Permission>` use cases cited
    /// in ADR-018 §6 `required_permissions: HashSet<PermissionName>`.
    /// BATCH-002-FINDING-001 closure via `ModbusRegisterRange` newtype below.
    ///
    /// **WHAT:** Closed interval `[start, end]` (Modbus register-range convention —
    /// most integrators expect inclusive bounds). Validated `start <= end` at
    /// construction (see `ModbusRegisterRange::new`).
    ModbusWrite {
        device_id: ModbusDeviceId,
        register_range: ModbusRegisterRange,
    },
    /// Write to a GPIO pin (digital output).
    GpioWrite { pin: u8 },
    /// Write to a PWM channel (duty-cycle control).
    PwmWrite { channel: u8 },
    /// Write to an SPI device (non-authentication use per ADR-024 §6).
    SpiWrite { device_id: SpiDeviceId },
    /// Write to a tag via OPC UA server (ADR-018 §3 — 3rd-party HMI).
    OpcUaWrite { tag_id: TagId },

    // -------------------------------------------------------------------------
    // Effect-based permission (ADR-024 §3 — attacker cannot bypass via alternate interface)
    // -------------------------------------------------------------------------
    /// Affect an actuator by class regardless of interface.
    /// `ModbusWrite` for an aerator + `AffectActuator { class: Aeration(..) }`
    /// are BOTH required per ADR-024 §3 — interface-level deny alone does NOT
    /// stop an attacker who finds an alternate write path.
    AffectActuator { class: ActuatorClass },

    // -------------------------------------------------------------------------
    // Lifecycle + admin
    // -------------------------------------------------------------------------
    /// Deploy an ST bytecode program (ADR-017).
    DeployProgram,
    /// Update firmware (ADR-019).
    UpdateFirmware,
    /// Reboot the edge agent.
    Reboot,
    /// Trigger the system-wide safe-state transition.
    SafeStateTrigger,
    /// Manually control MQTT failover.
    FailoverControl,
    /// Push a new RBAC manifest (ADR-018 §8 hot-reload).
    ManagePolicy,
    /// Refresh edge-license (ADR-018 §2 license tier).
    ManageLicense,

    // -------------------------------------------------------------------------
    // Debug + live operations
    // -------------------------------------------------------------------------
    /// Subscribe to a real-time tag watch stream (ADR-017 §13 + Faz 6).
    WatchSubscribe,
    /// Step-through debug a running ST program (ADR-017 §13 breakpoint).
    DebugStep,
    /// Force a tag to a specific value with TTL (ADR-018 §7 two-person MANDATORY).
    ForceValue,

    // -------------------------------------------------------------------------
    // Emergency (ADR-018 §5 break-glass — binary-hardcoded narrow subset)
    // -------------------------------------------------------------------------
    /// Emergency actuator control narrowly scoped to life-support class
    /// (binary-hardcoded tag allowlist per ADR-024 §3 EMERGENCY_LIFE_SAFETY_TAGS).
    ///
    /// **WHY:** Emergency policy (signed by factory slot 5) can grant this but
    /// widening impossible — `authz::emergency` verifier checks against
    /// binary-embedded allowlist before accepting.
    EmergencyActuator { class: ActuatorClass },
}

impl Permission {
    /// Returns `true` if this permission variant requires two-person integrity
    /// per ADR-018 §7.
    ///
    /// **WHY:** Command dispatch pipeline checks this before accepting a
    /// single-signed envelope. Code-level MANDATORY subset: UpdateFirmware,
    /// DeployProgram, ForceValue, SafeStateTrigger, Reboot.
    ///
    /// **WHAT:** Match on variant; returns bool.
    ///
    /// **INVARIANT:** This list is code-level; `two_person_required` in a
    /// custom_roles manifest entry can EXTEND this list (make MORE things
    /// two-person) but CANNOT NARROW it (code floor wins).
    ///
    /// **NOTE (ADR-018 §7 safety_tagged ModbusWrite):** `ModbusWrite { .. }` is
    /// intentionally NOT in this code-level list. Safety-tagged Modbus writes
    /// are identified at runtime by consulting `hardware_inventory.yaml`
    /// `safety_tagged: true` flag (ADR-024 §1 extended schema). The runtime
    /// authorization check in Faz 2 Sprint 6.1 (`authz::verify_command`) ORs
    /// this method's result with the inventory lookup to produce the final
    /// decision. BATCH-002-FINDING-007 closure.
    pub fn requires_two_person_integrity(&self) -> bool {
        matches!(
            self,
            Self::UpdateFirmware
                | Self::DeployProgram
                | Self::ForceValue
                | Self::SafeStateTrigger
                | Self::Reboot
        )
    }

    /// Returns `true` if this permission is a write (mutating) operation.
    ///
    /// **WHY:** Signature verification pipeline (ADR-018 SignatureMode::Enforcing
    /// per Faz 2) requires ed25519 signatures on all mutating commands;
    /// read-only operations are signature-exempt by design.
    ///
    /// **WHAT:** Match — returns bool for routing at the command dispatch layer.
    pub fn is_mutating(&self) -> bool {
        !matches!(self, Self::ReadTag | Self::ReadAuditLog | Self::WatchSubscribe)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // WHY: Smoke test that serde round-trips correctly for every variant shape.
    //      Manifest JSON schema stability depends on this contract.
    // WHAT: Serialize → Deserialize → PartialEq check.
    #[test]
    fn permission_serde_roundtrip_read_tag() {
        let p = Permission::ReadTag;
        let json = serde_json::to_string(&p).expect("serialize");
        let parsed: Permission = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(p, parsed);
    }

    #[test]
    fn permission_serde_roundtrip_write_tag_with_param() {
        let p = Permission::WriteTag {
            tag_id: TagId::from("pond3_aerator".to_string()),
        };
        let json = serde_json::to_string(&p).expect("serialize");
        let parsed: Permission = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(p, parsed);
    }

    #[test]
    fn permission_serde_roundtrip_affect_actuator_life_support() {
        let p = Permission::AffectActuator {
            class: ActuatorClass::Aeration(AerationSubClass::LifeSupport),
        };
        let json = serde_json::to_string(&p).expect("serialize");
        let parsed: Permission = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(p, parsed);
    }

    // WHY: Two-person-integrity set is the ADR-018 §7 MANDATORY subset; any
    //      regression here (accidental removal of a variant from the match arm)
    //      silently reduces security. This test locks the list.
    // WHAT: Explicit enumeration of the MANDATORY set; assert each is true,
    //       assert a sampling of non-MANDATORY is false.
    #[test]
    fn two_person_mandatory_subset_matches_adr_018_section_7() {
        // Mandatory subset per ADR-018 §7:
        assert!(Permission::UpdateFirmware.requires_two_person_integrity());
        assert!(Permission::DeployProgram.requires_two_person_integrity());
        assert!(Permission::ForceValue.requires_two_person_integrity());
        assert!(Permission::SafeStateTrigger.requires_two_person_integrity());
        assert!(Permission::Reboot.requires_two_person_integrity());

        // Spot-check non-mandatory:
        assert!(!Permission::ReadTag.requires_two_person_integrity());
        assert!(!Permission::WatchSubscribe.requires_two_person_integrity());
        assert!(
            !Permission::WriteTag {
                tag_id: TagId::from("x".to_string())
            }
            .requires_two_person_integrity()
        );
    }

    // WHY: is_mutating drives signature-enforcement routing; same regression
    //      class as above.
    #[test]
    fn is_mutating_distinguishes_read_from_write() {
        assert!(!Permission::ReadTag.is_mutating());
        assert!(!Permission::ReadAuditLog.is_mutating());
        assert!(!Permission::WatchSubscribe.is_mutating());

        assert!(
            Permission::WriteTag {
                tag_id: TagId::from("x".to_string())
            }
            .is_mutating()
        );
        assert!(Permission::DeployProgram.is_mutating());
        assert!(Permission::UpdateFirmware.is_mutating());
        assert!(Permission::ForceValue.is_mutating());
    }

    #[test]
    fn actuator_class_life_support_aeration_distinct_from_normal() {
        let a = ActuatorClass::Aeration(AerationSubClass::Normal);
        let b = ActuatorClass::Aeration(AerationSubClass::LifeSupport);
        assert_ne!(a, b);
    }

    #[test]
    fn tag_id_as_str_matches_construction() {
        let t = TagId::from("pond3_aerator".to_string());
        assert_eq!(t.as_str(), "pond3_aerator");
    }

    #[test]
    fn chemistry_sub_class_variants_distinct() {
        let nut = ChemistrySubClass::Nutrient;
        let ph = ChemistrySubClass::PhAdjust;
        let life = ChemistrySubClass::LifeSupportDose;
        assert_ne!(nut, ph);
        assert_ne!(nut, life);
        assert_ne!(ph, life);
    }

    // WHY: BATCH-002-FINDING-001 regression guard — `Permission` MUST implement
    //      `Hash` so that `HashSet<Permission>` (ADR-018 §6 required_permissions)
    //      compiles. If any variant adds a non-Hash field, this fails.
    // WHAT: Trait-bound smoke test; compiles iff Permission: Hash.
    #[test]
    fn permission_is_hashable_for_required_permissions_set() {
        fn assert_hash<T: std::hash::Hash>() {}
        assert_hash::<Permission>();
        // HashSet<Permission> is the concrete use in ADR-018 §6.
        let mut set: std::collections::HashSet<Permission> = std::collections::HashSet::new();
        set.insert(Permission::ReadTag);
        set.insert(Permission::DeployProgram);
        assert_eq!(set.len(), 2);
    }

    // WHY: Serde wire format for ModbusWrite is manifest-facing; regressions
    //      break manifest authors silently. Pin the JSON shape.
    // WHAT: Golden-JSON assertion for one representative struct variant.
    #[test]
    fn modbus_write_serde_golden_json_shape() {
        let p = Permission::ModbusWrite {
            device_id: ModbusDeviceId(10),
            register_range: ModbusRegisterRange::new(100, 200).expect("valid range"),
        };
        let json = serde_json::to_string(&p).expect("serialize");
        assert_eq!(
            json,
            r#"{"ModbusWrite":{"device_id":10,"register_range":{"start":100,"end":200}}}"#
        );
        let parsed: Permission = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(p, parsed);
    }

    // WHY: ModbusRegisterRange::new MUST reject start > end at type-construction
    //      time; silent accept would allow nonsense ranges through the system.
    #[test]
    fn modbus_register_range_rejects_start_after_end() {
        let err = ModbusRegisterRange::new(500, 100).expect_err("should reject");
        assert_eq!(
            err,
            ModbusRegisterRangeError::StartAfterEnd {
                start: 500,
                end: 100
            }
        );
    }

    // WHY: `contains` is the hot-path check at command-dispatch time for
    //      "is the requested write register within the authorized range?";
    //      inclusive interval must match ADR-018 §1 closed-interval semantics.
    #[test]
    fn modbus_register_range_contains_is_inclusive() {
        let range = ModbusRegisterRange::new(100, 200).expect("valid range");
        assert!(range.contains(100)); // start boundary
        assert!(range.contains(150)); // middle
        assert!(range.contains(200)); // end boundary (inclusive)
        assert!(!range.contains(99)); // before start
        assert!(!range.contains(201)); // after end
    }

    // WHY: Deserialization via `try_from` MUST reject wire `{"start": x,"end": y}`
    //      when x > y — otherwise malformed manifests slip through.
    #[test]
    fn modbus_register_range_deserialize_rejects_invalid() {
        let bad_json = r#"{"start":500,"end":100}"#;
        let err = serde_json::from_str::<ModbusRegisterRange>(bad_json).unwrap_err();
        // We don't pin the exact error message (serde_json wraps try_from errors),
        // but the call MUST fail — not produce a nonsense range.
        assert!(err.to_string().contains("start") || err.to_string().contains("100"));
    }

    // WHY: BATCH-002-FINDING-006 — pin is_mutating() result for every variant
    //      class. Accidental "simplification" moving DebugStep/ForceValue/etc.
    //      to read-side would silently reduce signature enforcement.
    // WHAT: Explicit enumeration of mutating variants; assert each.
    #[test]
    fn is_mutating_exhaustive_per_variant_class() {
        // Read-side (not mutating):
        assert!(!Permission::ReadTag.is_mutating());
        assert!(!Permission::ReadAuditLog.is_mutating());
        assert!(!Permission::WatchSubscribe.is_mutating());

        // Write-side — interface-specific:
        assert!(
            Permission::WriteTag {
                tag_id: TagId::from("x".to_string())
            }
            .is_mutating()
        );
        assert!(
            Permission::ModbusWrite {
                device_id: ModbusDeviceId(1),
                register_range: ModbusRegisterRange::new(0, 0).expect("valid")
            }
            .is_mutating()
        );
        assert!(Permission::GpioWrite { pin: 17 }.is_mutating());
        assert!(Permission::PwmWrite { channel: 0 }.is_mutating());
        assert!(
            Permission::SpiWrite {
                device_id: SpiDeviceId(0)
            }
            .is_mutating()
        );
        assert!(
            Permission::OpcUaWrite {
                tag_id: TagId::from("x".to_string())
            }
            .is_mutating()
        );

        // Effect-based:
        assert!(
            Permission::AffectActuator {
                class: ActuatorClass::Aeration(AerationSubClass::Normal)
            }
            .is_mutating()
        );

        // Lifecycle + admin:
        assert!(Permission::DeployProgram.is_mutating());
        assert!(Permission::UpdateFirmware.is_mutating());
        assert!(Permission::Reboot.is_mutating());
        assert!(Permission::SafeStateTrigger.is_mutating());
        assert!(Permission::FailoverControl.is_mutating());
        assert!(Permission::ManagePolicy.is_mutating());
        assert!(Permission::ManageLicense.is_mutating());

        // Debug + live:
        // DebugStep changes scan-cycle timing → treated as mutating for signature
        // enforcement per BATCH-002-FINDING-006 pinning.
        assert!(Permission::DebugStep.is_mutating());
        assert!(Permission::ForceValue.is_mutating());

        // Emergency:
        assert!(
            Permission::EmergencyActuator {
                class: ActuatorClass::Aeration(AerationSubClass::LifeSupport)
            }
            .is_mutating()
        );
    }

    // WHY: Golden-JSON pins for most-referenced manifest shapes (BATCH-002-FINDING-008).
    #[test]
    fn permission_golden_json_pinning() {
        // Unit variant:
        let p = Permission::ReadTag;
        assert_eq!(serde_json::to_string(&p).expect("ok"), r#""ReadTag""#);

        // Struct variant with TagId:
        let p = Permission::WriteTag {
            tag_id: TagId::from("pond3_aerator".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&p).expect("ok"),
            r#"{"WriteTag":{"tag_id":"pond3_aerator"}}"#
        );

        // Nested enum within struct variant (ActuatorClass::Aeration(LifeSupport)):
        let p = Permission::AffectActuator {
            class: ActuatorClass::Aeration(AerationSubClass::LifeSupport),
        };
        assert_eq!(
            serde_json::to_string(&p).expect("ok"),
            r#"{"AffectActuator":{"class":{"Aeration":"LifeSupport"}}}"#
        );
    }
}
