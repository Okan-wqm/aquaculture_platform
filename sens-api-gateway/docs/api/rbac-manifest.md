# RBAC Manifest Reference

**Source of truth:** `src/authz/permission.rs` — closed, additive-only enum.
**Module design:** `src/authz/mod.rs` — exports `Permission`, `ActuatorClass`, identifier newtypes, `PolicyEngine` trait, manifest wire-format types, `verify_manifest` gate.
**Serde wire format pinned by:** `permission_golden_json_pinning` test (`src/authz/permission.rs:842-864`), `modbus_write_serde_golden_json_shape` (`src/authz/permission.rs:716-728`).
**ADR references:** ADR-018 (Edge RBAC ABAC + 5-Key Segregation + Tenant Trust Root), ADR-024 (Extended ActuatorClass + LifeSupport orthogonal flag).

## Runtime wiring status
### RC2 release posture

`agent-v2.0.0-rc2` publishes a hardened release contract and `scada-display` binary tier. It does not claim dispatcher-level RBAC enforcement; this manifest remains the vocabulary for the follow-up runtime PR.


Today the `Permission` enum, `ActuatorClass` taxonomy, identifier newtypes, `PolicyEngine` trait, `RbacManifest` wire format, and `verify_manifest` function **exist as types** (`src/main.rs:22-23` `#[allow(dead_code)] mod authz;`) but the command dispatcher does NOT consult them.

**What this means:**
- Command handlers at `src/commands.rs:399-470` currently execute without permission checks.
- Safety-critical commands emit a text-based `AUDIT:` log line (`src/commands.rs:380-397`) but no `Permission` variant is evaluated.
- `Permission::requires_two_person_integrity` (`src/authz/permission.rs:568-577`) is defined but not consulted by the dispatcher.

**Roadmap:**
- Faz 2 Sprint 6.1: wire `AuthorizedContext` sealed ctor + `PolicyEngine::authorize()` into the command dispatch path.
- Faz 2 Sprint 6.4: wire `CommandEnvelope` ed25519 verify + `jti` dedup cache + canonical-params hash.
- Behind feature flag `signed-deploy` (`Cargo.toml:355`).

This manifest is the authoritative edge vocabulary; downstream docs (`security-architecture-writer`, `operations-sla-writer`) consume from here — they do NOT redefine.

## Permission enum — 24 variants

Source: `src/authz/permission.rs:458-545`. The variants below are partitioned into 7 functional groups for readability; the underlying enum is flat.

### Read paths

| Variant | Parameters | Description |
|---|---|---|
| `ReadTag` | — | Read any tag from `ProcessImage`. Baseline — most roles include this |
| `ReadAuditLog` | — | Read append-only audit log (subset visible to non-admin per ADR-020 §10 pseudonymisation) |

### Write paths (interface-specific)

| Variant | Parameters | Description |
|---|---|---|
| `WriteTag` | `{ tag_id: TagId }` | Write to a specific tag via the `ProcessImage` write path |
| `ModbusWrite` | `{ device_id: ModbusDeviceId, register_range: ModbusRegisterRange }` | Write to a Modbus register range on a specific device. Closed interval `[start, end]` |
| `GpioWrite` | `{ pin: u8 }` | Write to a GPIO pin |
| `PwmWrite` | `{ channel: u8 }` | Write to a PWM channel |
| `SpiWrite` | `{ device_id: SpiDeviceId }` | Write to an SPI device (non-authentication use — ADR-024 §6 RFID auth ban) |
| `OpcUaWrite` | `{ tag_id: TagId }` | Write via the OPC UA server (3rd-party HMI) |

### Effect-based (ADR-024 §3)

| Variant | Parameters | Description |
|---|---|---|
| `AffectActuator` | `{ class: ActuatorClass }` | Affect an actuator by class regardless of interface. Required IN ADDITION to the interface-specific write permission — an attacker cannot sidestep via alternate interface |

### Lifecycle + admin

| Variant | Parameters | Description |
|---|---|---|
| `DeployProgram` | — | Deploy ST bytecode program (ADR-017) |
| `UpdateFirmware` | — | Update agent firmware (ADR-019) |
| `Reboot` | — | Reboot the edge agent |
| `SafeStateTrigger` | — | Trigger system-wide safe-state transition |
| `FailoverControl` | — | Manually control MQTT failover |
| `ManagePolicy` | — | Push a new RBAC manifest (ADR-018 §8 hot-reload) |
| `ManageLicense` | — | Refresh edge-license (ADR-018 §2) |

### Debug + live

| Variant | Parameters | Description |
|---|---|---|
| `WatchSubscribe` | — | Subscribe to real-time tag watch stream (ADR-017 §13 + Faz 6) |
| `DebugStep` | — | Step-through debug a running ST program (ADR-017 §13) |
| `ForceValue` | — | Force a tag to a specific value with TTL (two-person MANDATORY) |

### Emergency (binary-hardcoded narrow subset)

| Variant | Parameters | Description |
|---|---|---|
| `EmergencyActuator` | `{ class: ActuatorClass }` | Break-glass emergency actuator control. Tag allowlist is BINARY-HARDCODED (ADR-024 §3 `EMERGENCY_LIFE_SAFETY_TAGS`) — emergency policy signed by factory slot 5 can grant this but widening is impossible |

## Two-person integrity MANDATORY subset (ADR-018 §7)

`Permission::requires_two_person_integrity` (`src/authz/permission.rs:568-577`) returns `true` for exactly:

- `UpdateFirmware`
- `DeployProgram`
- `ForceValue`
- `SafeStateTrigger`
- `Reboot`

**Invariant:** manifest `two_person_required` for a `custom_role` can EXTEND this list (make more things two-person) but CANNOT narrow it — the code floor wins.

**Safety-tagged Modbus writes:** `ModbusWrite { .. }` is intentionally NOT on the code-level MANDATORY list. Safety-tagged Modbus writes are identified at runtime via `hardware_inventory.yaml` `safety_tagged: true` flag (ADR-024 §1). The authorization check in Sprint 6.1 ORs this code-level list with the inventory lookup (BATCH-002-FINDING-007).

## `is_mutating()` routing hint

`Permission::is_mutating` (`src/authz/permission.rs:586-588`) returns `false` for read-only variants:

- `ReadTag`, `ReadAuditLog`, `WatchSubscribe`

All other variants return `true`. This drives signature-enforcement routing under the `signed-deploy` feature: read-only paths are signature-exempt by design.

## ActuatorClass taxonomy

Source: `src/authz/permission.rs:391-432`. **11 variants**; three carry inner subclass tags.

| Variant | Subclass | Description |
|---|---|---|
| `Aeration` | `AerationSubClass::{Normal, LifeSupport}` | Surface agitators, air blowers, O2 injection. Life-support split per ADR-024 §1 CRITICAL-001 |
| `Chemistry` | `ChemistrySubClass::{Nutrient, PhAdjust, LifeSupportDose}` | Dosing. Life-support split per ADR-024 §1 CRITICAL-003 |
| `Filtration` | — | Drum filters, backwash solenoids, bead filters |
| `Lighting` | — | LED diurnal, photoperiod control |
| `Feeding` | — | Feeder motors, conveyor belts |
| `Thermal` | `ThermalSubClass::{Heating, Cooling}` | Heating (cold-water species) / cooling (warm-water species) |
| `Recirculation` | — | RAS main-flow pumps (core life-support in RAS) |
| `WasteRemoval` | — | Sludge pumps, drum-filter backwash drives, biosolid augers |
| `Degassing` | — | CO2 stripping, venturi blowers |
| `EmergencyContainment` | — | Spill valves, emergency drain |
| `Inventory` | — | Non-actuator (RFID asset tags — read-only; NO authentication use) |

### AerationSubClass (`src/authz/permission.rs:350-356`)

| Variant | Description |
|---|---|
| `Normal` | Non-life-support aeration (surface agitators on redundant paths). Fail-OFF acceptable when topology supports it |
| `LifeSupport` | Life-support aeration (primary oxygenation). Fail-ON mandatory |

`AerationSubClass::LifeSupport + SinglePath topology` is REJECTED at `hardware_inventory.yaml` load time (ADR-024 §4 diversity schema).

### ChemistrySubClass (`src/authz/permission.rs:368-376`)

| Variant | FailSafe rule |
|---|---|
| `Nutrient` | `FailSafe::Off` acceptable (underdose tolerable) |
| `PhAdjust` | `FailSafe::Off` acceptable |
| `LifeSupportDose` | `FailSafe::HoldLastKnownGood { max_hold_secs <= 300 }` — O2 injection, emergency chemistry |

### ThermalSubClass (`src/authz/permission.rs:383-389`)

| Variant | Description |
|---|---|
| `Heating` | For cold-water species in winter |
| `Cooling` | Chillers, heat exchangers for warm-water species |

Both default fail-OFF safe — time-scale slower than aeration/O2.

### LifeSupportRole (`src/authz/permission.rs:325-335`)

Orthogonal to `ActuatorClass`; marks life-support role on `ActuatorBinding`.

| Variant | Hazard |
|---|---|
| `OxygenSupply` | Aerators, O2 injection, air blowers |
| `TemperatureCriticalPath` | Heaters/chillers when species-dependent |
| `AmmoniaControl` | Biofilter, backwash sequencing |
| `StockDensityInterlock` | Limit-switch-style triggers |

## Identifier newtypes — sealed constructors

Source: `src/authz/permission.rs:51-305`. Every identifier uses `#[serde(transparent)]` for ergonomic JSON wire format, AND a module-private tuple position `DeviceId([u8;16])` that forbids external `literal-style` construction.

| Type | Inner | `new_from_verified` visibility | Purpose |
|---|---|---|---|
| `DeviceId` | `[u8;16]` UUID | `pub(crate)` | Edge agent identity; bound to `ProvisioningBlob` (ADR-019 §4) |
| `TenantId` | `[u8;16]` UUID | `pub(crate)` | SaaS customer identity; sealed binding (ADR-018 §3) — cross-tenant manifest pivot structurally prevented |
| `OperatorId` | `[u8;16]` UUID | `pub(crate)` | Human operator identity; minted ONLY from verified command envelope (ADR-024 §6) |
| `TagId` | `String` | `pub new()` + `From<String>` | Tag name (e.g. `pond3_aerator_primary`). Case-sensitive UTF-8 |
| `ModbusDeviceId` | `u8` | `pub` tuple | Modbus slave address; 1..=247 enforced at `hardware_inventory.yaml` load |
| `SpiDeviceId` | `u8` | `pub` tuple | Chip-select pin / SPI device-index |
| `ModbusRegisterRange` | `{start: u16, end: u16}` | `pub new(start, end)` — validates `start <= end` | Closed interval `[start, end]` — Modbus integrator convention |

**Deserialization seal:** the `#[serde(transparent)]` carve-out is closed fully in Sprint 6.1 (BATCH-002-FINDING-003-FU) via a wire-type + verifier indirection pattern.

## Manifest wire format (roadmap — Sprint 6.1)

Source: `src/authz/manifest.rs`, re-exports at `src/authz/mod.rs:98-106`.

Canonical types:
- `SignedRbacManifest` — envelope carrying `RbacManifest` + ed25519 signature from slot 4 (`program_signing_key`)
- `RbacManifest` — `tenant_id`, `version`, `valid_from` / `valid_until`, `custom_roles: Vec<CustomRole>`
- `CustomRole` — `name`, `permissions: HashSet<Permission>`, `operators: Vec<OperatorBinding>`, `two_person_required: HashSet<Permission>` (extend-only)
- `OperatorBinding` — `operator_id: OperatorId`, `pubkey: Ed25519PublicKeyBytes`

**Rejection rules enforced by `verify_manifest`:**
1. Unknown `Permission` variant in `custom_roles[].permissions` → whole-manifest REJECT (ADR-018 §6 FINDING-006 fail-closed, not silent drop).
2. `tenant_id` mismatch vs `ProvisioningBlob::verified_tenant_id()` → REJECT (ADR-018 §3 FINDING-001 cross-tenant manifest pivot prevention).
3. Signature not from slot-4 pubkey → REJECT.
4. `valid_until < now` → REJECT (epoch-bound; operator must push refreshed manifest).
5. Version downgrade (manifest version < persisted version) → REJECT (anti-rollback per ADR-019 §11).

## Default role → permission matrix (reference mapping)

The edge does not ship default roles — roles live in the cloud `custom_roles` manifest. The mapping below is the **reference shape** a cloud-side default seeder would use; it does NOT represent a hardcoded edge baseline.

| Role | Permissions |
|---|---|
| `viewer` | `ReadTag`, `ReadAuditLog`, `WatchSubscribe` |
| `operator` | viewer + `WriteTag { .. }` (per tag allowlist), `ModbusWrite { .. }`, `GpioWrite { .. }`, `PwmWrite { .. }`, `OpcUaWrite { .. }`, `AffectActuator { .. }` for non-life-support classes |
| `plc_engineer` | operator + `DeployProgram`, `DebugStep` |
| `admin` | plc_engineer + `ManagePolicy`, `ManageLicense`, `FailoverControl`, `Reboot` (two-person MANDATORY) |
| `firmware_updater` | `UpdateFirmware` (two-person MANDATORY, no other permissions) |
| `emergency_operator` | `EmergencyActuator { class }` for binary-hardcoded life-safety tag allowlist only |

**Two-person pairing** is NOT implied by role — it is enforced at the `Permission` variant level and optionally extended via `custom_roles[].two_person_required`.

## Custom role creation path (roadmap)

1. Cloud admin edits the tenant's RBAC manifest via the admin-api.
2. admin-api signs the updated `RbacManifest` with slot 4 key.
3. Signed manifest is published to `tenants/{tenant_id}/devices/{device_id}/config` (MQTT retained=true).
4. Edge subscriber receives it, runs `verify_manifest`, swaps the in-memory policy engine atomically (hot-reload per ADR-018 §8).
5. Audit event `RbacManifestUpdated` emitted (ADR-020 chain entry).

## Cross-references

- [`remote-commands.md`](./remote-commands.md) — maps each command to its roadmap `Permission` variant.
- [`event-schemas.md`](./event-schemas.md) — `AuditEvent` schema (roadmap) consumes `Permission` variant names in decision records.
- `sens-api-gateway/docs/security/threat-model.md` — STRIDE table §3.2 consumes this manifest for RBAC bypass threats.
- `sens-api-gateway/docs/compliance/iec-62443-fr2.md` — IEC 62443-3-3 FR2 Use Control evidence consumes this manifest.
