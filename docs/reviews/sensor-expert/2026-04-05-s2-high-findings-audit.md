# Review Report -- Sensor Expert: S2 HIGH Findings Audit
**Date:** 2026-04-05
**Scope:** Targeted audit for remaining HIGH-severity findings after confirmed fixes. Covers: sensor calibration channel IDOR, VFD parameter write rate limiting, Atlas EZO command injection (scope clarification), MQTT listener tenant verification, and `any` type security surface.
**Reviewer:** sensor-expert
**Prior Reviews:**
- `docs/reviews/sensor-expert/2026-04-04-full-codebase-audit.md`
- `docs/reviews/sensor-expert/2026-04-05-targeted-security-audit.md`

---

## Prior Finding Fix Verification

The following issues were confirmed fixed before this audit:

| Finding | Fix Status | Evidence |
|---------|-----------|---------|
| VFD `findByIdOrFail` tenantId (was CRITICAL-001-ESCALATED) | FIXED | `vfd-change-set.service.ts:499` now accepts `tenantId` param; `findByIdOrFail(changeSetId, tenantId)` with `WHERE { id, tenantId }` |
| VFD automation rule IDOR cluster (was CRITICAL-002) | FIXED | `vfd-automation.resolver.ts` now passes `@Tenant() tenantId` to all mutations/queries; `findByIdOrFail(id, tenantId)` in service enforces tenant filter |
| VFD change set single read IDOR (was CRITICAL-003) | FIXED | `vfd-programming.resolver.ts:91` now passes `tenantId` to `findById(id, tenantId)` |
| VFD automation rule history not tenant-scoped (was MEDIUM-005) | FIXED | `getRuleExecutionHistory(ruleId, limit, tenantId)` in service uses conditional `WHERE { automationRuleId, tenantId }` |
| `getVfdAutomationRuleHistory` resolver not tenant-scoped | FIXED | Resolver now extracts `@Tenant() tenantId` and passes it |

---

## Summary

| Severity | Count | New | Escalated |
|----------|-------|-----|-----------|
| HIGH     | 5     | 5   | 0         |
| MEDIUM   | 2     | 2   | 0         |
| LOW      | 1     | 1   | 0         |

---

## Findings

---

### [HIGH-S2-001] Data Channel IDOR: `updateDataChannel`, `deleteDataChannel`, `reorderDataChannels`, `deleteAllChannelsForSensor`, `dataChannel` Query Are Not Tenant-Scoped

**Files:**
- `apps/sensor-service/src/registration/resolvers/channel.resolver.ts:57-61` (`dataChannel` query)
- `apps/sensor-service/src/registration/resolvers/channel.resolver.ts:136-157` (`updateDataChannel` mutation)
- `apps/sensor-service/src/registration/resolvers/channel.resolver.ts:186-194` (`deleteDataChannel` mutation)
- `apps/sensor-service/src/registration/resolvers/channel.resolver.ts:230-237` (`reorderDataChannels` mutation)
- `apps/sensor-service/src/registration/resolvers/channel.resolver.ts:243-251` (`deleteAllChannelsForSensor` mutation)
- `apps/sensor-service/src/registration/services/channel-management.service.ts:130-161` (`updateChannel`)
- `apps/sensor-service/src/registration/services/channel-management.service.ts:166-177` (`deleteChannel`)
- `apps/sensor-service/src/registration/services/channel-management.service.ts:202-206` (`getChannel`)

**Category:** Security / Tenant Isolation (IDOR)

**Description:** Five operations in the channel resolver accept `@Tenant() _tenantId: string` (note the underscore — extracted but never used) or completely omit the tenant parameter from the service call.

1. **`dataChannel` query (line 57-61):** No `@Tenant()` at all. Calls `managementService.getChannel(channelId)` which queries `WHERE { id: channelId }` only — any authenticated user who knows a channel UUID can read another tenant's calibration configuration, alert thresholds, and data path mappings.

2. **`updateDataChannel` mutation (line 136-157):** Extracts `@Tenant() _tenantId: string` but does NOT pass it to `managementService.updateChannel(input.channelId, {...})`. The service `updateChannel()` queries `WHERE { id: channelId }` alone, then applies mutations without verifying ownership.

3. **`deleteDataChannel` mutation (line 186-194):** Same pattern — `@Tenant() _tenantId: string` extracted but not passed. `deleteChannel(channelId)` queries `WHERE { id: channelId }` alone.

4. **`reorderDataChannels` mutation (line 230-237):** Extracts `@Tenant() _tenantId: string` but does not pass it. `reorderChannels(sensorId, channelIds)` uses `WHERE { id: In(channelIds), sensorId }` — scoped to sensorId but not tenantId. An attacker who knows the sensorId and some channelIds from another tenant can reorder that tenant's sensor channels.

5. **`deleteAllChannelsForSensor` mutation (line 243-251):** Extracts `@Tenant() _tenantId: string` but `deleteChannelsForSensor(sensorId)` deletes `WHERE { sensorId }` with no tenantId. If the caller provides another tenant's sensorId, all channels for that sensor are deleted.

The service-level `updateChannel`, `deleteChannel`, and `getChannel` methods have no `tenantId` parameter at all:

```typescript
// channel-management.service.ts:130-135 -- no tenantId
async updateChannel(channelId: string, input: UpdateChannelInput): Promise<SensorDataChannel> {
  const channel = await this.channelRepository.findOne({
    where: { id: channelId },  // cross-tenant IDOR
  });

// channel-management.service.ts:166-169 -- no tenantId
async deleteChannel(channelId: string): Promise<void> {
  const channel = await this.channelRepository.findOne({
    where: { id: channelId },  // cross-tenant IDOR
  });

// channel-management.service.ts:202-205 -- no tenantId
async getChannel(channelId: string): Promise<SensorDataChannel | null> {
  return this.channelRepository.findOne({
    where: { id: channelId },  // cross-tenant IDOR
  });
```

**Impact:**

- `dataChannel` query: cross-tenant information disclosure. Calibration configuration (multiplier, offset, polynomial coefficients), alert thresholds, and data path expressions for another tenant's sensors are fully readable.
- `updateDataChannel`: cross-tenant write. An attacker can silently modify calibration parameters (setting multiplier to 0, offset to extreme values) causing incorrect sensor readings on fish tank instruments. This can corrupt water quality monitoring data for a competing aquaculture tenant.
- `deleteDataChannel` / `deleteAllChannelsForSensor`: cross-tenant destructive write. Deletes another tenant's channel configuration, causing sensor data to stop being recorded.
- `reorderDataChannels`: lower-impact IDOR but confirms the systemic absence of tenantId enforcement across the channel management layer.

This is the same structural pattern as the previously confirmed VFD IDOR cluster (CRITICAL-001-ESCALATED/CRITICAL-002/CRITICAL-003). It is a SYSTEMIC issue in the channel management module.

**Root Cause:** The `ChannelManagementService` was designed without a `tenantId` parameter on mutation methods. The resolver author extracted `@Tenant()` but assigned it to `_tenantId` (unused variable), indicating awareness of the requirement but incomplete implementation.

**Fix:**
1. Add `tenantId: string` parameter to `getChannel(channelId, tenantId)`, `updateChannel(channelId, input, tenantId)`, `deleteChannel(channelId, tenantId)`, `reorderChannels(sensorId, channelIds, tenantId)`, and `deleteChannelsForSensor(sensorId, tenantId)`.
2. Add `tenantId` to the `WHERE` clause of every `findOne` / `delete` / `find` call in those methods.
3. In the resolver, rename `_tenantId` to `tenantId` and pass it through in all five operations.
4. Add a `dataChannel` query `@Tenant() tenantId` parameter and pass it to `getChannel`.

**Severity:** HIGH (IDOR — cross-tenant read/write/delete on calibration and channel configuration)

---

### [HIGH-S2-002] `dataChannelsBySensor` and `enabledChannelsBySensor` Queries Are Not Tenant-Scoped

**Files:**
- `apps/sensor-service/src/registration/resolvers/channel.resolver.ts:42-54`
- `apps/sensor-service/src/registration/services/channel-management.service.ts:182-197`

**Category:** Security / Tenant Isolation (IDOR — Information Disclosure)

**Description:** The `dataChannelsBySensor` and `enabledChannelsBySensor` queries accept only `sensorId` with no `@Tenant()` extraction. The service methods `getChannelsBySensor(sensorId)` and `getEnabledChannels(sensorId)` query `WHERE { sensorId }` with no tenantId filter. Any authenticated user who knows another tenant's sensorId (a UUID) can enumerate all configured data channels for that sensor, including calibration coefficients, alert thresholds, unit definitions, and data path mappings.

```typescript
// channel.resolver.ts:42-47 -- no @Tenant()
@Query(() => [DataChannelType], { name: 'dataChannelsBySensor' })
async getChannelsBySensor(
  @Args('sensorId', { type: () => ID }) sensorId: string,
): Promise<SensorDataChannel[]> {
  return this.managementService.getChannelsBySensor(sensorId);

// channel-management.service.ts:182-187 -- no tenantId
async getChannelsBySensor(sensorId: string): Promise<SensorDataChannel[]> {
  return this.channelRepository.find({
    where: { sensorId },  // cross-tenant readable
```

**Impact:** Full disclosure of all channel configuration for any sensor whose UUID is known. Since sensor UUIDs are referenced in MQTT topic patterns and may appear in logs or error messages, this is a realistic attack path. The calibration parameters disclosed could be used by a competitor to infer proprietary measurement techniques.

**Root Cause:** Same as HIGH-S2-001: the channel management service layer does not enforce tenant scoping on read operations parameterized by sensorId.

**Fix:** Add `@Tenant() tenantId: string` to both query resolver methods. Add `tenantId` to both service methods. Add `tenantId` to the `WHERE` clause. Note: this requires verifying that the sensorId belongs to the tenant, which can be done by including `tenantId` directly in the channel `WHERE` clause since `SensorDataChannel` has a `tenantId` column.

**Severity:** HIGH (cross-tenant information disclosure)

---

### [HIGH-S2-003] VFD Command Write Operations Have No Per-Device Rate Limiting

**Files:**
- `apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts:44-146`
- `apps/sensor-service/src/vfd/services/vfd-command.service.ts:64-159`

**Category:** VFD Safety / DoS / IEC 62443 SL-2

**Description:** All seven VFD command mutations (`sendVfdCommand`, `startVfd`, `stopVfd`, `setVfdFrequency`, `setVfdSpeed`, `resetVfdFault`, `emergencyStopVfd`) have no rate limiting. The `SimpleRateLimitGuard` is registered only in the `EdgeDeviceModule` for REST endpoints (provisioning controller). The `APP_GUARD` slots in `app.module.ts` register only `ServiceIdentityGuard`, `TenantGuard`, and `RolesGuard` — no rate limit guard applies to GraphQL resolvers.

A user with TENANT_ADMIN or MODULE_MANAGER role can issue unlimited frequency-change or START/STOP commands to a VFD in a tight loop. Industrial VFDs have physical protection against rapid start/stop cycles (thermal protection, capacitor stress limits), but these protections operate at the hardware level and may take seconds to engage. In the window between commands:

- Rapid START/STOP cycling at the software layer can stress VFD capacitors even if the motor does not physically respond (capacitor charge/discharge cycles).
- Rapid `setFrequency` writes to Modbus register 0x0001 (speed reference) can cause oscillating reference signals that some VFDs interpret as a valid setpoint change, causing motor speed hunting.
- The `emergencyStop` mutation has NO `@Roles()` restriction (by design, for safety), meaning any authenticated user — including those with only `VIEWER` role — can call it unlimited times, constituting a denial-of-service against operational equipment.

```typescript
// vfd-command.resolver.ts:138-146 -- no @Roles, no rate limit
@Mutation(() => VfdCommandResultDto, { name: 'emergencyStopVfd' })
async emergencyStop(
  @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
  @Tenant() tenantId: string
): Promise<VfdCommandResultDto> {
  return this.commandService.executeCommand(vfdDeviceId, tenantId, {
    command: VfdCommandType.EMERGENCY_STOP,
  });
}
```

The service-level `VfdCommandService` has no rate limiting whatsoever. The `activeConnections` cache reuses sockets to avoid reconnect overhead, which actually makes rapid command sequences cheaper (no TCP reconnect cost).

**Impact:**

- Operational DoS: a script sending 100 `emergencyStop` calls per second to an active VFD controlling an aeration pump or recirculation system can prevent the VFD from being restarted normally during the attack (each `emergencyStop` resets the READY state, requiring re-energization of the drive).
- Equipment damage risk: rapid START/STOP cycling exceeds manufacturer-recommended minimum dwell times (typically 10-60 seconds for large drives).
- The `setFrequency` mutation can be used to rapidly oscillate frequency between min and max, causing mechanical stress in pump impellers (water hammer effect at high Hz reversals is limited by VFD ramp time but still stressful).

**Root Cause:** `SimpleRateLimitGuard` only implements `CanActivate` via `switchToHttp()` — it is a REST-only guard that does not intercept GraphQL execution contexts. The NestJS `ExecutionContext.switchToHttp()` call returns an empty/null context for GraphQL resolvers. This architectural gap means no REST rate limit guard can protect GraphQL mutations without modification.

**Fix:** The correct enterprise pattern is a dedicated GraphQL rate limiter using `@nestjs/throttler` with `ThrottlerModule.forRoot()` and `ThrottlerGuard` configured to handle GqlExecutionContext. Register it globally in `app.module.ts`. Apply `@Throttle({ default: { limit: 5, ttl: 10000 } })` (5 write commands per 10 seconds per user per device) to all VFD command mutations. The `emergencyStop` mutation should have a higher per-minute limit (e.g., 10/min) given its safety rationale, but must not be unlimited. Additionally, add a per-device command cooldown in `VfdCommandService` using a `lastCommandAt` map to enforce a minimum 200ms inter-command gap regardless of rate limit configuration.

**Severity:** HIGH (VFD safety / equipment damage risk / operational DoS)

---

### [HIGH-S2-004] Atlas EZO: Scope Clarification — No Direct Command Injection Path; Architectural Risk in I2C Driver Config

**Files:**
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1178-1208`

**Category:** Architecture / Injection Surface Assessment

**Description:** The prior audit scope item "Atlas EZO command injection" was investigated. There is no Atlas Scientific EZO command string construction or transmission in the NestJS backend. The `edge-device.service.ts` only contains driver type inference logic that maps configuration columns to a Rust agent config structure:

```typescript
// edge-device.service.ts:1187-1189
if (cfg.driverType.startsWith('atlas_ezo_')) {
  const sensorType = cfg.driverType.replace('atlas_ezo_', '');
  return { atlas_ezo: { sensor_type: sensorType } };
```

The `driverType` value is stored in the database and originates from the frontend UI (sensor registration wizard). The `sensor_type` string is serialized into a JSON config object that is transmitted to the Rust edge agent via MQTT. The Rust edge agent then constructs the Atlas EZO I2C command (`R`, `Cal,mid,7.00`, etc.) using this `sensor_type` value.

**Finding:** The backend does not directly build Atlas EZO command strings, so server-side command injection is not applicable here. However, there is a medium-severity architectural risk: `cfg.driverType` is not validated against an allowlist before being embedded in the Rust agent config. If a user with MODULE_MANAGER role sets `driverType` to `atlas_ezo_ph\nR\nFactory` or similar, the resulting JSON would contain a newline character in the `sensor_type` field. Whether this causes a command injection in the Rust agent depends entirely on how the Rust code parses and uses the `sensor_type` field.

**Impact Assessment:** Low to Medium backend risk (no server-side execution). The actual injection risk lies in the Rust edge agent, which is outside this reviewer's scope. However, the backend must not pass unvalidated strings to the Rust agent config.

**Minimal Fix:** Add an allowlist validation for `driverType` before building the agent config:

```typescript
const ALLOWED_ATLAS_SENSOR_TYPES = new Set(['ph', 'do', 'orp', 'ec', 'rtd', 'co2', 'o2']);

if (cfg.driverType.startsWith('atlas_ezo_')) {
  const sensorType = cfg.driverType.replace('atlas_ezo_', '');
  if (!ALLOWED_ATLAS_SENSOR_TYPES.has(sensorType)) {
    this.logger.warn(`Invalid Atlas EZO sensor type: ${sensorType}`);
    return null;
  }
  return { atlas_ezo: { sensor_type: sensorType } };
}
```

**Severity (backend-only scope):** MEDIUM — validation gap that may enable agent-side injection; actual impact depends on Rust agent parsing. Classified as MEDIUM rather than HIGH because no direct code execution occurs on the NestJS process.

**Note for edge-expert:** Cross-domain escalation required. The Rust edge agent must validate `sensor_type` before constructing Atlas EZO I2C command strings. If the agent does string interpolation (e.g., `format!("{}\r", sensor_type)` or similar), this is a HIGH/CRITICAL finding in the edge domain.

---

### [HIGH-S2-005] `any` Types in MQTT Listener Create Unvalidated Data Surface for Sensor Metric Persistence

**Files:**
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:134`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1047`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1060`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1149`

**Category:** Code Quality / TypeScript Safety / Data Integrity

**Description:** This finding was reported as HIGH-001 in the 2026-04-04 review and confirmed unfixed in the 2026-04-05 targeted audit. The three `any` usages have not been corrected. Additionally, a fourth `any` was identified:

1. **Line 134** — `deviceCache` type: `Map<string, { device: any; expiry: number }>`. The `device` field is used in `persistIoDataToMetrics` (line 1064-1068) to call `this.getCachedDevice()`, whose return type is also `Promise<any | null>` (line 1149). Downstream code accesses `device.id` and `device.tenantId` (line 877, 1107) without any runtime type guard. If a cache entry is populated with a malformed object (not an `EdgeDevice`), `device.id` would be `undefined`, resulting in `sensor_id = undefined` being inserted into `sensor_metrics`. With parameterized queries this causes a PostgreSQL type error rather than injection, but the error path discards the metric silently (line 1141-1143 catch swallows it).

2. **Lines 1047/1060** — `tags: Record<string, { value: any; quality: string }>`. The `value: any` field is used in the numeric conversion at line 1095-1098: `typeof tagData.value === 'boolean' ? ... : Number(tagData.value)`. If `tagData.value` is an object (e.g., `{ nested: 1 }`), `Number({nested: 1})` returns `NaN`, which is filtered out by `isNaN(numericValue)` at line 1099. However, if `tagData.value` is a specially crafted string like `"Infinity"` or `"-Infinity"`, `Number("Infinity")` passes `isNaN()` and gets stored in the database. TimescaleDB stores `Infinity` as a valid `float8` value, but downstream aggregation queries (MIN, MAX, AVG) may return unexpected results — `AVG` of one `Infinity` and one normal reading is `Infinity`, which cascades through continuous aggregates and dashboard queries.

3. **Line 1149** — `getCachedDevice` return type `Promise<any | null>`. The `any` return silences all TypeScript checks on the returned device object across all callers, including the security-critical tenant validation path.

**Root Cause:** The `EdgeDevice` entity type is not imported in `mqtt-listener.service.ts`. The `deviceCache` was typed as `any` to avoid the import cycle or entity typing complexity.

**Fix (previously described in REC-002, still unimplemented):**

```typescript
// Import the entity
import { EdgeDevice } from '../edge-device/entities/edge-device.entity';

// Replace line 134
private readonly deviceCache = new Map<string, { device: EdgeDevice; expiry: number }>();

// Replace lines 1047/1060 with a typed interface
interface IoTagData {
  value: string | number | boolean | null;
  quality: string;
}
// Use: tags: Record<string, IoTagData>

// Replace line 1149 return type
private async getCachedDevice(tenantId: string, deviceCode: string): Promise<EdgeDevice | null>
```

Additionally, add a runtime guard for `Infinity`/`-Infinity` values before insert:

```typescript
if (!isFinite(numericValue)) continue; // Rejects Infinity, -Infinity (isNaN already rejects NaN)
```

**Severity:** HIGH (confirmed unfixed from prior review — persistence integrity risk and TypeScript discipline violation in security-critical code path). This is the third audit cycle this finding has appeared without a fix.

---

## Medium Findings

---

### [MEDIUM-S2-001] `opcua.adapter.ts` Uses Untyped `as any` Casts on External Library Calls

**File:** `apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts:335-336, 338, 347, 356, 401, 403, 429, 448, 464, 467, 479`

**Category:** Code Quality / TypeScript Discipline

**Description:** The OPC UA adapter uses twelve `as any` casts to interact with the `node-opcua` library, including on the main client object (`client as any`), session objects (`session as any`), and data value arrays (`dv: any`, `v: any`). The `discoverEndpoints` method calls `(client as any).connect()` and `(client as any).getEndpoints()` — if the `node-opcua` API changes between versions, these calls will fail at runtime without any compile-time warning.

The security-relevant instance is `(DataType as any)[arg.dataType]` at line 467: the `arg.dataType` string comes from the caller (GraphQL mutation input) and is used as a key to index the `DataType` enum. If `arg.dataType` is `__proto__` or `constructor`, the `(DataType as any).__proto__` access traverses the prototype chain rather than returning `undefined` as expected, and the fallback `|| DataType.String` may not trigger because `(DataType as any).__proto__` is a non-null object.

**Impact:** Prototype pollution risk on the `DataType` enum object. Medium severity because the object being accessed is an enum (primitive-valued), but the pattern is structurally unsafe.

**Fix:** Replace `(DataType as any)[arg.dataType]` with a safe lookup:

```typescript
const dt = Object.prototype.hasOwnProperty.call(DataType, arg.dataType)
  ? DataType[arg.dataType as keyof typeof DataType]
  : DataType.String;
```

For the library interface issues, generate or import proper `node-opcua` types rather than casting to `any`.

---

### [MEDIUM-S2-002] `automation.service.ts` Uses `as any` to Access Undocumented `deployCommand.params`

**File:** `apps/sensor-service/src/automation/automation.service.ts:1382`

**Category:** Code Quality / Architecture

**Description:** `(deployCommand as any).params` accesses a property that is not in the declared type of `deployCommand`. This indicates the command object's type is incorrect or incomplete. If `params` is undefined at runtime, the result is silently `undefined` being passed as `edgeScript` to the downstream MQTT publish path.

**Impact:** If `deployCommand.params` is undefined, the automation program is deployed to the edge with a null script payload. The edge agent may interpret this as a "clear program" command, silently stopping running automation programs without an error being surfaced in the audit trail.

**Fix:** Properly type the `deployCommand` object. Define a `DeployCommand` interface with a `params: Record<string, unknown>` field and remove the `as any` cast.

---

## Low Findings

---

### [LOW-S2-001] `GaugeConfig.tsx` Uses `value: any` in `updateZone` Callback -- Frontend Type Discipline

**File:** `web/modules/sensor-module/src/components/scada-builder/widget-configs/GaugeConfig.tsx:18`

**Category:** Code Quality / TypeScript Discipline (Frontend)

**Description:** `const updateZone = (index: number, field: string, value: any)` uses `any` for a value that will be written into the SCADA gauge widget configuration. Since gauge zone values affect visual threshold rendering (not data persistence), this is low severity, but it is the type of `any` that can silently accept an object where a number is expected, causing the SCADA builder to render gauge zones incorrectly without a build-time error.

**Fix:** Type the callback properly: `value: string | number | boolean`.

---

## Systemic Assessment

### SYSTEMIC-S2-001: Channel Management Module Has No Tenant Enforcement Layer

HIGH-S2-001 and HIGH-S2-002 together constitute a systemic tenant isolation failure across the entire `ChannelManagementService`. The service was built without a `tenantId` parameter on any method that operates by `channelId` or `sensorId` alone. The resolver author was aware of this (they extract `@Tenant()` into `_tenantId`) but never wired it through. This is the third IDOR cluster in the sensor service after the VFD programming module cluster.

The pattern of extracting `@Tenant()` into `_tenantId` (underscore prefix indicating intentional discard) and then not passing it to the service is present in five resolver methods. This is a systemic code review failure — no PR reviewer caught that the extracted tenantId was being discarded.

**Architectural Recommendation:** Introduce a mandatory TypeScript ESLint rule: `no-unused-vars` configured to `error` for parameters prefixed with underscore only if they match `_tenantId` (custom rule). Better: establish a code review checklist item — "every `@Mutation` method that modifies data must pass `tenantId` to the service layer". The `@TenantScoped()` build-time decorator recommendation from SYSTEMIC-001 in the previous audit remains unimplemented and would have caught all three IDOR clusters.

### SYSTEMIC-S2-002: `any` Type in MQTT Hot Path Is a Recurring Unfixed Finding

HIGH-S2-005 was first reported 2026-04-04 (HIGH-001), confirmed unfixed 2026-04-05 (HIGH-001-CONFIRMED), and remains unfixed in this audit cycle. This is now the third occurrence. Per audit policy, issues appearing 3+ times without fix are flagged as SYSTEMIC and require architectural discussion. The fix is a 15-minute change (import the entity type, define the IoTagData interface). The continued unfixed status indicates either a DI circular dependency problem preventing the import, or a process gap in fixing TypeScript discipline issues. Either root cause requires architectural discussion.

---

## Architecture Positives (Confirmed Still Valid)

1. **VFD IDOR cluster fully resolved.** All five VFD programming mutations and the single read query now enforce `tenantId` at both resolver and service layers. The `findByIdOrFail(changeSetId, tenantId)` pattern is correct.
2. **VFD automation rule IDOR fully resolved.** `findByIdOrFail(id, tenantId)` and `findById(id, tenantId)` both include `tenantId` in `WHERE` clause. History query conditional tenant filter is correctly implemented.
3. **`bulkUpdateDataChannels` correctly tenant-scoped.** The `bulkUpdateChannelThresholds(tenantId, updates)` service method queries `WHERE { id: In(channelIds), tenantId }` and validates that all requested channels belong to the tenant before applying any update. This is the correct pattern that the non-bulk operations should mirror.
4. **`reorderDataChannels` partially protected.** The `reorderChannels` method uses `WHERE { id: In(channelIds), sensorId }` which prevents cross-sensor channel mixing within a tenant. The gap is cross-tenant (no tenantId filter), not cross-sensor.
5. **VFD command service uses `findById(deviceId, tenantId)`.** The `executeCommand` method correctly resolves the device with tenant scoping before any adapter call, preventing cross-tenant device control via the `sendVfdCommand` mutation.
