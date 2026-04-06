# Recommendations -- Sensor Expert: S2 HIGH Findings
**Date:** 2026-04-05
**Related Review:** `docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md`

---

## REC-S2-001: Enforce Tenant Isolation on All Channel Management Operations (addresses HIGH-S2-001, HIGH-S2-002)

**Priority:** HIGH
**Estimated Effort:** M (service layer changes + resolver wire-up + tests)
**Files to Modify:**
- `apps/sensor-service/src/registration/services/channel-management.service.ts`
- `apps/sensor-service/src/registration/resolvers/channel.resolver.ts`

**Service Layer Changes:**

Add `tenantId: string` to every method operating by `channelId` or `sensorId` without an existing tenant filter.

```typescript
// updateChannel: add tenantId to signature and WHERE clause
async updateChannel(
  channelId: string,
  input: UpdateChannelInput,
  tenantId: string,                    // ADD
): Promise<SensorDataChannel> {
  const channel = await this.channelRepository.findOne({
    where: { id: channelId, tenantId }, // ADD tenantId
  });
  if (!channel) {
    throw new NotFoundException(`Channel with ID '${channelId}' not found`);
  }
  // ...existing update logic unchanged
}

// deleteChannel: add tenantId to signature and WHERE clause
async deleteChannel(channelId: string, tenantId: string): Promise<void> {
  const channel = await this.channelRepository.findOne({
    where: { id: channelId, tenantId }, // ADD tenantId
  });
  if (!channel) {
    throw new NotFoundException(`Channel with ID '${channelId}' not found`);
  }
  await this.channelRepository.remove(channel);
}

// getChannel: add tenantId to signature and WHERE clause
async getChannel(channelId: string, tenantId: string): Promise<SensorDataChannel | null> {
  return this.channelRepository.findOne({
    where: { id: channelId, tenantId }, // ADD tenantId
  });
}

// reorderChannels: add tenantId to both WHERE clauses
async reorderChannels(
  sensorId: string,
  channelIds: string[],
  tenantId: string,                    // ADD
): Promise<SensorDataChannel[]> {
  const channels = await this.channelRepository.find({
    where: { id: In(channelIds), sensorId, tenantId }, // ADD tenantId
  });
  // ...rest unchanged
}

// deleteChannelsForSensor: add tenantId to DELETE WHERE clause
async deleteChannelsForSensor(sensorId: string, tenantId: string): Promise<void> {
  await this.channelRepository.delete({ sensorId, tenantId }); // ADD tenantId
}

// getChannelsBySensor: add tenantId to WHERE clause
async getChannelsBySensor(sensorId: string, tenantId: string): Promise<SensorDataChannel[]> {
  return this.channelRepository.find({
    where: { sensorId, tenantId },     // ADD tenantId
    order: { displayOrder: 'ASC', createdAt: 'ASC' },
  });
}

// getEnabledChannels: add tenantId to WHERE clause
async getEnabledChannels(sensorId: string, tenantId: string): Promise<SensorDataChannel[]> {
  return this.channelRepository.find({
    where: { sensorId, isEnabled: true, tenantId }, // ADD tenantId
    order: { displayOrder: 'ASC', createdAt: 'ASC' },
  });
}
```

**Resolver Layer Changes:**

Replace all `_tenantId` (discarded) with `tenantId` (passed through) and add `@Tenant()` where missing.

```typescript
// dataChannel query: ADD @Tenant()
@Query(() => DataChannelType, { name: 'dataChannel', nullable: true })
async getChannel(
  @Args('channelId', { type: () => ID }) channelId: string,
  @Tenant() tenantId: string,          // ADD
): Promise<SensorDataChannel | null> {
  return this.managementService.getChannel(channelId, tenantId); // pass tenantId
}

// dataChannelsBySensor: ADD @Tenant() and pass it
@Query(() => [DataChannelType], { name: 'dataChannelsBySensor' })
async getChannelsBySensor(
  @Args('sensorId', { type: () => ID }) sensorId: string,
  @Tenant() tenantId: string,          // ADD
): Promise<SensorDataChannel[]> {
  return this.managementService.getChannelsBySensor(sensorId, tenantId);
}

// enabledChannelsBySensor: ADD @Tenant() and pass it
@Query(() => [DataChannelType], { name: 'enabledChannelsBySensor' })
async getEnabledChannels(
  @Args('sensorId', { type: () => ID }) sensorId: string,
  @Tenant() tenantId: string,          // ADD
): Promise<SensorDataChannel[]> {
  return this.managementService.getEnabledChannels(sensorId, tenantId);
}

// updateDataChannel: rename _tenantId → tenantId, pass it
@Mutation(() => DataChannelType, { name: 'updateDataChannel' })
@Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
async updateChannel(
  @Args('input') input: UpdateDataChannelInput,
  @Tenant() tenantId: string,          // RENAME from _tenantId
): Promise<SensorDataChannel> {
  return this.managementService.updateChannel(input.channelId, {...}, tenantId); // pass it
}

// deleteDataChannel: rename _tenantId → tenantId, pass it
@Mutation(() => Boolean, { name: 'deleteDataChannel' })
@Roles(Role.TENANT_ADMIN)
async deleteChannel(
  @Args('channelId', { type: () => ID }) channelId: string,
  @Tenant() tenantId: string,          // RENAME from _tenantId
): Promise<boolean> {
  await this.managementService.deleteChannel(channelId, tenantId); // pass it
  return true;
}

// reorderDataChannels: rename _tenantId → tenantId, pass it
@Mutation(() => [DataChannelType], { name: 'reorderDataChannels' })
@Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
async reorderChannels(
  @Args('input') input: ReorderChannelsInput,
  @Tenant() tenantId: string,          // RENAME from _tenantId
): Promise<SensorDataChannel[]> {
  return this.managementService.reorderChannels(input.sensorId, input.channelIds, tenantId);
}

// deleteAllChannelsForSensor: rename _tenantId → tenantId, pass it
@Mutation(() => Boolean, { name: 'deleteAllChannelsForSensor' })
@Roles(Role.TENANT_ADMIN)
async deleteAllChannels(
  @Args('sensorId', { type: () => ID }) sensorId: string,
  @Tenant() tenantId: string,          // RENAME from _tenantId
): Promise<boolean> {
  await this.managementService.deleteChannelsForSensor(sensorId, tenantId);
  return true;
}
```

**Acceptance Criteria:**
- [ ] All nine affected service methods accept and enforce `tenantId` in their WHERE clause
- [ ] All nine affected resolver operations pass `tenantId` to the service
- [ ] A test proves that `getChannel(channelId, wrongTenantId)` returns `null`
- [ ] A test proves that `deleteChannel(channelId, wrongTenantId)` throws `NotFoundException`
- [ ] A test proves that `updateChannel(channelId, input, wrongTenantId)` throws `NotFoundException`
- [ ] A test proves that `getChannelsBySensor(sensorId, wrongTenantId)` returns `[]`
- [ ] No regression in the `bulkUpdateDataChannels` flow (already correctly tenant-scoped)

---

## REC-S2-002: Add Per-Device Rate Limiting to VFD Command Mutations (addresses HIGH-S2-003)

**Priority:** HIGH
**Estimated Effort:** M (NestJS ThrottlerModule configuration + service-level cooldown map)
**Files to Modify:**
- `apps/sensor-service/src/app.module.ts`
- `apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts`
- `apps/sensor-service/src/vfd/services/vfd-command.service.ts`
- `apps/sensor-service/src/vfd/vfd.module.ts`

**Step 1: Register GraphQL-compatible ThrottlerModule**

The `SimpleRateLimitGuard` only handles REST contexts. Use `@nestjs/throttler` which supports GraphQL via a custom context extractor.

```typescript
// app.module.ts -- ADD to imports array
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

ThrottlerModule.forRoot([
  {
    name: 'vfd-command',
    ttl: 10_000,   // 10-second window
    limit: 5,      // 5 commands per 10 seconds per user
  },
]),

// app.module.ts -- ADD to providers (after RolesGuard)
// Note: do NOT replace APP_GUARD for TenantGuard/RolesGuard -- add a fourth slot
{
  provide: APP_GUARD,
  useClass: ThrottlerGuard,
},
```

Override the context extractor in the ThrottlerGuard subclass to support GQL:

```typescript
// apps/sensor-service/src/guards/gql-throttler.guard.ts
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { GqlExecutionContext } from '@nestjs/graphql';

@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  protected getRequestResponse(context: ExecutionContext) {
    const gqlCtx = GqlExecutionContext.create(context);
    const ctx = gqlCtx.getContext<{ req: Request; res: Response }>();
    return { req: ctx.req, res: ctx.res };
  }
}
```

Register `GqlThrottlerGuard` instead of `ThrottlerGuard` in `app.module.ts`.

**Step 2: Apply per-mutation throttle decorators**

```typescript
// vfd-command.resolver.ts -- Apply @Throttle() to write mutations
import { Throttle } from '@nestjs/throttler';

// Standard command mutations: 5 per 10 seconds
@Mutation(() => VfdCommandResultDto, { name: 'sendVfdCommand' })
@Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
@Throttle({ 'vfd-command': { limit: 5, ttl: 10000 } })
async sendCommand(...) { ... }

// Same decorator on startVfd, stopVfd, setVfdFrequency, setVfdSpeed, resetVfdFault

// Emergency stop: higher limit but still bounded (safety rationale preserved)
@Mutation(() => VfdCommandResultDto, { name: 'emergencyStopVfd' })
@Throttle({ 'vfd-command': { limit: 10, ttl: 60000 } }) // 10 per minute
async emergencyStop(...) { ... }
```

**Step 3: Add service-level minimum inter-command cooldown**

```typescript
// vfd-command.service.ts -- ADD cooldown map
private readonly lastCommandAt = new Map<string, number>(); // key: `${tenantId}:${deviceId}`
private static readonly MIN_COMMAND_INTERVAL_MS = 200; // 200ms minimum between commands

// At start of executeCommand():
async executeCommand(deviceId: string, tenantId: string, commandInput: VfdCommandInput) {
  const cooldownKey = `${tenantId}:${deviceId}`;
  const lastAt = this.lastCommandAt.get(cooldownKey) ?? 0;
  const elapsed = Date.now() - lastAt;
  if (elapsed < VfdCommandService.MIN_COMMAND_INTERVAL_MS) {
    throw new BadRequestException(
      `Command rate limit: wait ${VfdCommandService.MIN_COMMAND_INTERVAL_MS - elapsed}ms`
    );
  }
  this.lastCommandAt.set(cooldownKey, Date.now());

  // ...existing device lookup and command execution
}
```

**Acceptance Criteria:**
- [ ] `GqlThrottlerGuard` correctly extracts the request context from GraphQL execution context
- [ ] Sending 6 consecutive `setVfdFrequency` mutations within 10 seconds returns HTTP 429 on the 6th
- [ ] `emergencyStop` is allowed up to 10 times per minute but the 11th call is throttled
- [ ] The 200ms minimum inter-command cooldown is enforced at the service level regardless of throttle decorator
- [ ] A unit test verifies that the cooldown map rejects rapid sequential commands on the same device
- [ ] The `ThrottlerModule` configuration is externalized to `ConfigService` (ttl and limit as env vars)

---

## REC-S2-003: Add Atlas EZO Driver Type Allowlist Validation (addresses HIGH-S2-004 / MEDIUM scope)

**Priority:** MEDIUM
**Estimated Effort:** S
**Files to Modify:**
- `apps/sensor-service/src/edge-device/edge-device.service.ts`

```typescript
// Add constant near inferI2cDriverConfig method
private static readonly ATLAS_EZO_SENSOR_TYPES = new Set([
  'ph', 'do', 'orp', 'ec', 'rtd', 'co2', 'o2', 'hum', 'prs', 'flow',
]);

// Replace lines 1187-1189:
if (cfg.driverType.startsWith('atlas_ezo_')) {
  const sensorType = cfg.driverType.replace('atlas_ezo_', '').toLowerCase();
  if (!EdgeDeviceService.ATLAS_EZO_SENSOR_TYPES.has(sensorType)) {
    this.logger.warn(
      `Rejecting unknown Atlas EZO sensor type: '${sensorType}' for device ${cfg.id}`
    );
    return null; // Caller skips non-atlas I2C sensors when null is returned
  }
  return { atlas_ezo: { sensor_type: sensorType } };
}
```

**Cross-Domain Action Required:** Notify `edge-expert` to audit the Rust edge agent's handling of the `sensor_type` field from the MQTT config payload. The agent must not use `sensor_type` in any `format!()` macro or string interpolation that produces an I2C command string without sanitization.

**Acceptance Criteria:**
- [ ] `driverType = "atlas_ezo_ph"` produces `{ atlas_ezo: { sensor_type: 'ph' } }`
- [ ] `driverType = "atlas_ezo_unknown"` logs a warning and returns `null`
- [ ] `driverType = "atlas_ezo_ph\nFactory"` is rejected by the allowlist check
- [ ] Unit test covers all 10 known allowed types and 3 invalid types

---

## REC-S2-004: Fix `any` Types in MQTT Listener (addresses HIGH-S2-005 — THIRD OCCURRENCE)

**Priority:** HIGH (unfixed across 3 audit cycles — escalated per policy)
**Estimated Effort:** S (15-minute change)
**Files to Modify:**
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts`

**Root Cause Investigation Required First:** Before implementing the fix, verify whether there is a circular dependency that prevents importing `EdgeDevice` directly. If a circular dependency exists, resolve it first using one of: (a) extract `EdgeDevice` to a shared types module, (b) use `forwardRef()`, or (c) import only the entity interface (not the full module).

```typescript
// Add import at top of file (verify no circular dep first)
import { EdgeDevice } from '../edge-device/entities/edge-device.entity';

// Line 134: Replace any
private readonly deviceCache = new Map<string, { device: EdgeDevice; expiry: number }>();

// Add interface near top of file (before class declaration)
interface IoTagData {
  value: string | number | boolean | null;
  quality: 'good' | 'uncertain' | 'bad' | 'comm_failure' | 'not_initialized' | string;
}

// Lines 1047/1060: Replace any
tags as Record<string, IoTagData>,          // line 1047
tags: Record<string, IoTagData>,            // line 1060

// Line 1149: Replace return type
private async getCachedDevice(
  tenantId: string,
  deviceCode: string,
): Promise<EdgeDevice | null> {            // Replace: Promise<any | null>

// Line 1099: Add Infinity guard after isNaN check
if (isNaN(numericValue) || !isFinite(numericValue)) continue;
```

**Acceptance Criteria:**
- [ ] `eslint --rule "@typescript-eslint/no-explicit-any: error"` passes on `mqtt-listener.service.ts`
- [ ] `deviceCache` is typed as `Map<string, { device: EdgeDevice; expiry: number }>`
- [ ] `getCachedDevice` return type is `Promise<EdgeDevice | null>`
- [ ] `IoTagData.value` field is `string | number | boolean | null`
- [ ] `Infinity` and `-Infinity` values are rejected before database insert
- [ ] Build (`npm run build`) succeeds with no TypeScript errors
- [ ] If a circular dependency is discovered: document it and use the `forwardRef()` pattern rather than leaving `any` as a workaround

---

## REC-S2-005: Fix OPC UA Adapter Prototype-Safe Enum Lookup (addresses MEDIUM-S2-001)

**Priority:** MEDIUM
**Estimated Effort:** S
**Files to Modify:**
- `apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts`

```typescript
// Line 467: Replace unsafe enum index access
// OLD:
const dt = (DataType as any)[arg.dataType] || DataType.String;

// NEW:
const dt = Object.prototype.hasOwnProperty.call(DataType, arg.dataType)
  ? DataType[arg.dataType as keyof typeof DataType]
  : DataType.String;
```

For the remaining `as any` casts on the client/session objects: create a local interface file `opcua-client.interface.ts` that declares the minimum required API surface:

```typescript
interface OpcUaClientInternal {
  connect(url: string): Promise<void>;
  getEndpoints(): Promise<OpcUaEndpointDescription[]>;
  disconnect(): Promise<void>;
}
```

Cast to the interface instead of `any` so future API breaks are caught at compile time.

**Acceptance Criteria:**
- [ ] `(DataType as any)[arg.dataType]` replaced with `hasOwnProperty` safe lookup
- [ ] TypeScript build passes without `any` warnings in `opcua.adapter.ts`

---

## Systemic Recommendations

### Mandatory PR Checklist Item for All Mutations

Add to the team's PR template (`.github/pull_request_template.md`):

```markdown
## Security Checklist
- [ ] Every `@Mutation()` method that reads or modifies data passes `tenantId` from `@Tenant()` to the service layer
- [ ] No `_tenantId` (underscore-prefixed) remains in mutation signatures — if extracted, it must be used
- [ ] No new `any` types introduced in service or security-critical code paths
```

### ESLint Rule for Underscore-Prefixed `tenantId`

Add to `.eslintrc.json`:

```json
{
  "rules": {
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        "varsIgnorePattern": "^_",
        "argsIgnorePattern": "^_(?!tenantId|userId|deviceId)"
      }
    ]
  }
}
```

This configuration allows `_foo` patterns generally but flags `_tenantId`, `_userId`, `_deviceId` as errors — forcing developers to either use the value or remove the parameter entirely.
