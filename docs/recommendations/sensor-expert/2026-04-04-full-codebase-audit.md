# Development Recommendations -- Sensor Expert
**Date:** 2026-04-04
**Related Review:** `docs/reviews/sensor-expert/2026-04-04-full-codebase-audit.md`

## Recommendations

---

### REC-001: Use Timing-Safe Token Comparison in `generateInstallerScript` (addresses CRITICAL-001)
**Priority:** CRITICAL
**Estimated Effort:** S
**Files to Modify:**
- `apps/sensor-service/src/edge-device/provisioning.service.ts` -- replace string equality with timing-safe comparison

**Recommended Implementation:**
```typescript
import { timingSafeEqual, createHash } from 'crypto';

// In generateInstallerScript(), replace line 224:
// OLD: if (device.provisioningToken !== provisioningToken) {
// NEW:
const receivedHash = createHash('sha256').update(provisioningToken).digest();
const storedHash = createHash('sha256').update(device.provisioningToken).digest();
if (!timingSafeEqual(receivedHash, storedHash)) {
  throw new UnauthorizedException('Invalid provisioning token');
}
```

**Acceptance Criteria:**
- [ ] `generateInstallerScript()` uses `crypto.timingSafeEqual()` with SHA-256 hashing for token comparison
- [ ] Pattern matches the existing implementation in `activateDevice()` at line 298
- [ ] Unit test added to verify that invalid tokens are rejected
- [ ] No functional change to the happy path

---

### REC-002: Replace `any` Types in MqttListenerService (addresses HIGH-001)
**Priority:** HIGH
**Estimated Effort:** S
**Files to Modify:**
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` -- replace `any` with proper types at lines 134, 1047, 1060

**Recommended Implementation:**
```typescript
// Line 134: Replace any with EdgeDevice
import { EdgeDevice } from '../edge-device/entities/edge-device.entity';

private readonly deviceCache = new Map<string, { device: EdgeDevice; expiry: number }>();

// Lines 1047/1060: Replace any with a typed interface
interface TagValueEntry {
  value: number | string | boolean;
  quality: string;
}

// Use Record<string, TagValueEntry> instead of Record<string, { value: any; quality: string }>
```

**Acceptance Criteria:**
- [ ] Zero `any` types in `mqtt-listener.service.ts`
- [ ] ESLint `no-explicit-any` rule passes
- [ ] Existing tests continue to pass

---

### REC-003: Add Tenant Verification After Sensor-by-Topic Resolution (addresses HIGH-002)
**Priority:** HIGH
**Estimated Effort:** M
**Files to Modify:**
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` -- add tenant cross-check in `handleMessage()` for sensor data path

**Recommended Implementation:**
```typescript
// In handleMessage(), after findSensorByTopic() resolves a sensor:
const sensor = await this.findSensorByTopic(topic, parsedTopic);
if (!sensor) {
  this.logger.debug(`No sensor found for topic: ${topic}`);
  return;
}

// NEW: Verify the resolved sensor's tenant matches the topic context
// For tenant-prefixed topics (tenants/{tenantId}/...), cross-check tenantId
if (parsedTopic?.tenantId && sensor.tenantId !== parsedTopic.tenantId) {
  this.logger.warn(
    `Tenant mismatch: topic tenant ${parsedTopic.tenantId} != sensor tenant ${sensor.tenantId}. ` +
    `Rejecting message on topic ${topic} to prevent cross-tenant data injection.`,
  );
  return;
}
```

**Acceptance Criteria:**
- [ ] Messages on `sensors/#` topics that resolve to a sensor belonging to a different tenant are rejected
- [ ] Tenant verification is logged as a warning for monitoring
- [ ] Legacy `sensors/#` topics without tenant context continue to work (backward compatibility)
- [ ] Test covering cross-tenant topic resolution rejection

---

### REC-004: Add tenantId Filter to VFD ChangeSet Lookups (addresses HIGH-003)
**Priority:** HIGH
**Estimated Effort:** M
**Files to Modify:**
- `apps/sensor-service/src/vfd-programming/services/vfd-change-set.service.ts` -- add tenantId parameter to `findByIdOrFail` and all calling methods
- `apps/sensor-service/src/vfd-programming/resolvers/vfd-programming.resolver.ts` -- pass tenantId to service methods

**Recommended Implementation:**
```typescript
// In vfd-change-set.service.ts:
private async findByIdOrFail(changeSetId: string, tenantId: string): Promise<VfdChangeSet> {
  const changeSet = await this.changeSetRepository.findOne({
    where: { id: changeSetId, tenantId },  // Added tenantId filter
    relations: ['items'],
  });

  if (!changeSet) {
    throw new NotFoundException(
      `Change set ${changeSetId} not found in tenant ${tenantId}`,
    );
  }

  return changeSet;
}

// Update all callers: approveChangeSet, rejectChangeSet, rollbackChangeSet
// to accept and pass tenantId.

// In vfd-programming.resolver.ts:
@Mutation(() => VfdChangeSet, { name: 'approveVfdChangeSet' })
@Roles(Role.TENANT_ADMIN)
async approveChangeSet(
  @Args('changeSetId', { type: () => ID }) changeSetId: string,
  @CurrentUser('sub') userId: string,
  @Tenant() tenantId: string,  // ADD THIS
): Promise<VfdChangeSet> {
  return this.changeSetService.approveChangeSet(changeSetId, userId, tenantId);
}
```

**Acceptance Criteria:**
- [ ] Every `findByIdOrFail` call includes `tenantId` in the WHERE clause
- [ ] `approveChangeSet`, `rejectChangeSet`, `rollbackChangeSet` mutations pass `@Tenant() tenantId`
- [ ] Test confirming cross-tenant change set access is rejected with 404
- [ ] `findById` public query also filters by tenantId

---

### REC-005: Strengthen Emergency Rollback Authorization (addresses HIGH-004)
**Priority:** HIGH
**Estimated Effort:** M
**Files to Modify:**
- `apps/sensor-service/src/vfd-programming/services/vfd-change-set.service.ts` -- add role-based gating for emergency rollback
- `apps/sensor-service/src/vfd-programming/resolvers/vfd-programming.resolver.ts` -- add separate mutation or parameter for emergency flag

**Recommended Implementation:**
```typescript
// Option A (preferred): Separate mutation with stricter role requirement
@Mutation(() => VfdChangeSet, { name: 'emergencyRollbackVfdChangeSet' })
@Roles(Role.TENANT_ADMIN)  // Only TENANT_ADMIN can trigger emergency
async emergencyRollback(
  @Args('changeSetId', { type: () => ID }) changeSetId: string,
  @Args('reason', { type: () => String }) reason: string,
  @CurrentUser('sub') userId: string,
  @Tenant() tenantId: string,
): Promise<VfdChangeSet> {
  return this.changeSetService.rollbackChangeSet(
    changeSetId,
    reason,
    userId,
    true,  // isEmergency flag
  );
}

// In vfd-change-set.service.ts:
async rollbackChangeSet(
  changeSetId: string,
  reason: string,
  performedBy: string,
  isEmergency = false,  // Explicit flag instead of string matching
): Promise<VfdChangeSet> {
  // ...
  if (isEmergency) {
    // Emergency path -- already gated by TENANT_ADMIN role at resolver level
    // Still audit the emergency override
  }
}
```

**Acceptance Criteria:**
- [ ] Emergency rollback requires TENANT_ADMIN role (not MODULE_MANAGER)
- [ ] Emergency flag is an explicit boolean parameter, not derived from reason string
- [ ] Regular rollback (`reason !== 'emergency'`) still goes through approval workflow
- [ ] Audit log records the emergency override with full context

---

### REC-006: Replace `console.warn` with Structured Logger in SetPropertyHandler (addresses HIGH-005)
**Priority:** HIGH
**Estimated Effort:** S
**Files to Modify:**
- `web/modules/sensor-module/src/engine/events/handlers/SetPropertyHandler.ts` -- replace console.warn

**Recommended Implementation:**
```typescript
// Since this is frontend code without NestJS Logger, use a module-level
// logger pattern or a SCADA runtime logger:

// Option A: Emit a structured event instead of console.warn
import type { EventHandler } from '../types';

// In createSetPropertyHandler:
if (!isPropertyPathSafe(propertyPath)) {
  // Dispatch a security event that can be captured by monitoring
  // instead of just console.warn
  store.updateWidget(event.screenId, '__system__', {
    securityEvent: {
      type: 'PROPERTY_PATH_REJECTED',
      path: propertyPath,
      timestamp: Date.now(),
    },
  });
  return;
}

// Option B (simpler): Use a tagged console.warn for structured grep-ability
if (typeof window !== 'undefined' && window.__SCADA_LOGGER__) {
  window.__SCADA_LOGGER__.warn('SECURITY_REJECTION', {
    handler: 'SetPropertyHandler',
    path: propertyPath,
  });
}
```

**Acceptance Criteria:**
- [ ] No raw `console.warn` calls in production SCADA engine code
- [ ] Security rejections are captured in a structured, auditable format

---

### REC-007: Tenant-Scope the Local In-Memory Cache in SensorTopicCacheService (addresses MEDIUM-004)
**Priority:** MEDIUM
**Estimated Effort:** S
**Files to Modify:**
- `apps/sensor-service/src/ingestion/sensor-topic-cache.service.ts` -- change local cache key to include tenantId

**Recommended Implementation:**
```typescript
// Change the local cache to use tenant-scoped keys, matching the Redis layer:

// In setLocalCache:
private setLocalCache(normalizedTopic: string, sensor: CachedSensorInfo | null): void {
  // Use tenant-scoped key for local cache to match Redis isolation
  const cacheKey = sensor
    ? `${sensor.tenantId}:${normalizedTopic}`
    : `__null__:${normalizedTopic}`;  // negative cache entries

  if (this.localCache.size >= this.LOCAL_CACHE_MAX_SIZE) {
    const firstKey = this.localCache.keys().next().value;
    if (firstKey) {
      this.localCache.delete(firstKey);
    }
  }

  this.localCache.set(cacheKey, {
    sensor,
    cachedAt: Date.now(),
  });
}

// In getFromLocalCache: Since we don't know the tenantId at lookup time,
// the simplest fix is to skip the local cache and always use Redis.
// Alternatively, maintain a topic -> tenantId index locally.
```

**Acceptance Criteria:**
- [ ] Local cache entries are tenant-scoped, preventing cross-tenant cache hits
- [ ] Cache invalidation by tenant correctly clears local cache entries
- [ ] Performance impact is minimal (local cache miss falls through to Redis, which is already fast)

---

## Summary of Priority Actions

| Priority | Count | Key Actions |
|----------|-------|-------------|
| CRITICAL | 1 | Fix timing-safe token comparison in installer script path |
| HIGH | 5 | Add tenantId to VFD change set queries; strengthen emergency rollback auth; fix `any` types; add tenant cross-check for sensor data topics |
| MEDIUM | 8 | Fix local cache tenant scoping; remove dead code; add audit decorators to VFD automation; define typed interfaces for raw DB rows |
| LOW | 5 | Remove unused injections; extract shared channel cache; remove empty stub file |
