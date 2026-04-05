# Review Report -- Sensor Expert
**Date:** 2026-04-04
**Scope:** Full codebase audit of sensor domain (backend: sensor-service, frontend: sensor-module engine)
**Reviewer:** sensor-expert

## Summary
| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 5 |
| MEDIUM | 8 |
| LOW | 5 |

---

## Findings

### [CRITICAL-001] Provisioning Token Comparison Uses Non-Constant-Time String Equality Before Timing-Safe Check
- **File:** `apps/sensor-service/src/edge-device/provisioning.service.ts:224`
- **Category:** Security
- **Description:** In `generateInstallerScript()`, the provisioning token comparison at line 224 uses a direct string equality check (`device.provisioningToken !== provisioningToken`) instead of a timing-safe comparison. This allows timing attacks that could reveal the token character-by-character. While `activateDevice()` at line 298 correctly uses `crypto.timingSafeEqual()` with SHA-256 hashing, the installer script retrieval path does not have this protection.
- **Impact:** An attacker with network access to the provisioning endpoint could use timing analysis to brute-force the provisioning token character-by-character. The token is 64 hex characters (32 bytes of entropy), but a timing attack reduces the search space from `16^64` to `16*64 = 1024` attempts.
- **Current Code:**
  ```typescript
  // Line 224
  if (device.provisioningToken !== provisioningToken) {
    throw new UnauthorizedException('Invalid provisioning token');
  }
  ```
- **Recommendation:** See recommendation file REC-001.

---

### [HIGH-001] `any` Type Usage in MqttListenerService Device Cache
- **File:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:134`
- **Category:** Code Quality / TypeScript Discipline
- **Description:** The `deviceCache` field uses `any` for the device type: `Map<string, { device: any; expiry: number }>`. The project enforces `@typescript-eslint/no-explicit-any: error`. Two additional `any` usages appear at lines 1047 and 1060 for the `tags` parameter type.
- **Impact:** Bypasses TypeScript type safety, allowing runtime errors from incorrect property access. Violates project ESLint rules.
- **Recommendation:** See recommendation file REC-002.

---

### [HIGH-002] Legacy `sensors/#` Wildcard Subscription Lacks Tenant Enforcement
- **File:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:271-273`
- **Category:** MQTT Security / Tenant Isolation
- **Description:** The MQTT listener subscribes to `sensors/#` and `aquaculture/+/sensors/#` wildcard topics. Messages arriving on `sensors/{anything}` are routed to `findSensorByTopic()` which does a cross-schema database lookup without verifying that the MQTT publisher is authorized for the resolved sensor's tenant. While the ACL controller restricts device publishing to their own topics, the sensor data path lacks an additional server-side tenant verification after topic resolution.
- **Impact:** If a device manages to publish to a `sensors/` topic (bypassing ACL or via a legacy subscription), the data could be written to a sensor belonging to a different tenant. The cross-schema lookup returns the first match across ALL tenants.
- **Current Code:**
  ```typescript
  // Line 271-273
  'sensors/#',                    // All sensor data
  'aquaculture/+/sensors/#',      // Tenant-specific sensors
  '+/+/+/temperature-array',      // Array sensor pattern
  ```
- **Recommendation:** See recommendation file REC-003.

---

### [HIGH-003] `findByIdOrFail` in VfdChangeSetService Does Not Filter by tenantId
- **File:** `apps/sensor-service/src/vfd-programming/services/vfd-change-set.service.ts:496-508`
- **Category:** Security / Tenant Isolation (IDOR)
- **Description:** The `findByIdOrFail()` helper queries change sets by ID alone without filtering by `tenantId`. This means any authenticated user who knows a change set UUID from another tenant could approve, reject, or rollback it. The `approveChangeSet`, `rejectChangeSet`, and `rollbackChangeSet` mutations in the resolver do not pass `tenantId` to the service.
- **Impact:** Cross-tenant IDOR vulnerability. A user in Tenant A could approve VFD parameter changes belonging to Tenant B by guessing/obtaining the change set UUID.
- **Current Code:**
  ```typescript
  private async findByIdOrFail(changeSetId: string): Promise<VfdChangeSet> {
    const changeSet = await this.changeSetRepository.findOne({
      where: { id: changeSetId },  // No tenantId filter
      relations: ['items'],
    });
  ```
- **Recommendation:** See recommendation file REC-004.

---

### [HIGH-004] Emergency Rollback Allows Self-Approval (Maker-Checker Bypass)
- **File:** `apps/sensor-service/src/vfd-programming/services/vfd-change-set.service.ts:398-404`
- **Category:** VFD Safety / IEC 62443 Compliance
- **Description:** Emergency rollback (`reason === 'emergency'`) auto-approves the rollback change set with `savedRollback.approvedBy = performedBy`, where `performedBy` is also the `createdBy` of the rollback change set (line 372). This intentionally bypasses Maker-Checker, which is documented but the bypass condition is a simple string comparison (`reason === 'emergency'`). Any user with MODULE_MANAGER role can trigger an emergency rollback by passing `reason: 'emergency'` as a string.
- **Impact:** The Maker-Checker 4-eye principle can be bypassed by any user with rollback permissions simply by setting the reason to `'emergency'`. There is no secondary authorization (e.g., requiring TENANT_ADMIN role for emergency operations, or requiring a confirmation token).
- **Current Code:**
  ```typescript
  const isEmergency = reason === 'emergency';
  if (isEmergency) {
    savedRollback.status = VfdChangeSetStatus.APPROVED;
    savedRollback.approvedBy = performedBy;  // self-approval
  ```
- **Recommendation:** See recommendation file REC-005.

---

### [HIGH-005] `console.warn` Usage in SetPropertyHandler Instead of Logger
- **File:** `web/modules/sensor-module/src/engine/events/handlers/SetPropertyHandler.ts:80`
- **Category:** Code Quality
- **Description:** Uses `console.warn()` instead of a structured logger. While this is frontend code where `console.warn` is more common, the project mandates structured logging patterns. More critically for SCADA runtime, security rejection events should be captured in a structured way for audit purposes.
- **Impact:** Security-relevant events (rejected property paths) are not captured in a structured, auditable format. In production, `console.warn` may be stripped or ignored.
- **Current Code:**
  ```typescript
  console.warn(
    `[SetPropertyHandler] Rejected unsafe property path: "${propertyPath}"`,
  );
  ```
- **Recommendation:** See recommendation file REC-006.

---

### [MEDIUM-001] Token First-4-Characters Logged in Provisioning Debug Output
- **File:** `apps/sensor-service/src/edge-device/provisioning.service.ts:296`
- **Category:** Security / Information Disclosure
- **Description:** Debug logging at line 296 outputs the first 4 characters of both the received and stored provisioning tokens: `received_first4=${token.substring(0, 4)}****, stored_first4=${(device.provisioningToken || '').substring(0, 4)}****`. While marked as debug-level, if debug logging is enabled in a production-like environment, this leaks partial token data to logs.
- **Impact:** Reduces the entropy of the provisioning token from 256 bits to 240 bits per log entry exposure. An attacker with log access could reconstruct tokens over time.
- **Recommendation:** Remove the `received_first4` and `stored_first4` log fields. The hash prefixes already provide sufficient diagnostic information.

---

### [MEDIUM-002] `error: any` Type in Provisioning Service Catch Block
- **File:** `apps/sensor-service/src/edge-device/provisioning.service.ts:140`
- **Category:** Code Quality / TypeScript Discipline
- **Description:** The catch block at line 140 uses `catch (error: any)` which violates the `no-explicit-any` rule. Should use `catch (error: unknown)` with type narrowing.
- **Impact:** TypeScript discipline violation. Minor runtime safety concern.
- **Recommendation:** Change to `catch (error: unknown)` and use `(error as Error).code` or proper type narrowing with `instanceof`.

---

### [MEDIUM-003] `installer-script.service.ts` Uses `any` for Config Object
- **File:** `apps/sensor-service/src/edge-device/installer-script.service.ts:83`
- **Category:** Code Quality / TypeScript Discipline
- **Description:** Line 83 declares `let config: any;` which violates the `no-explicit-any` rule.
- **Impact:** TypeScript discipline violation.
- **Recommendation:** Define a proper `ProvisioningConfig` interface.

---

### [MEDIUM-004] SensorTopicCacheService Local Cache is Not Tenant-Scoped
- **File:** `apps/sensor-service/src/ingestion/sensor-topic-cache.service.ts:458-469`
- **Category:** Tenant Isolation
- **Description:** While the Redis cache correctly uses tenant-scoped keys (SEC-M16), the local in-memory cache at line 459 uses `normalizedTopic` as the key without tenant scoping. If two tenants have sensors with the same MQTT topic pattern, the local cache could return the wrong tenant's sensor. The `getFromLocalCache()` method returns the first cached entry for a topic regardless of tenant.
- **Impact:** Potential cross-tenant data routing if two tenants configure sensors with identical MQTT topic strings. The Redis cache is correctly tenant-scoped, so this only affects the 1-minute local cache window.
- **Recommendation:** See recommendation file REC-007.

---

### [MEDIUM-005] `formatUUID` and `formatProtocol` Methods Are Dead Code
- **File:** `apps/sensor-service/src/ingestion/data-ingestion.service.ts:418-435`
- **Category:** Code Quality
- **Description:** The methods `formatUUID()` (line 418) and `formatProtocol()` (line 430) exist from a previous string-interpolation SQL implementation but are no longer used after the migration to parameterized queries. They are dead code.
- **Impact:** Code maintainability -- dead code creates confusion about which SQL security pattern is actually in use.
- **Recommendation:** Remove both methods.

---

### [MEDIUM-006] VFD Parameter Writer Does Not Verify tenantId Before Applying ChangeSet
- **File:** `apps/sensor-service/src/vfd-programming/services/vfd-parameter-writer.service.ts:42-48`
- **Category:** Security / Tenant Isolation
- **Description:** The `applyChangeSet()` method loads the VFD device using `findById(changeSet.vfdDeviceId, changeSet.tenantId)`, which is correct. However, it receives the change set from the caller without re-verifying that the change set's `tenantId` matches the calling user's tenant context. Combined with HIGH-003 (missing tenantId filter in findByIdOrFail), a cross-tenant change set could be applied.
- **Impact:** Cascading effect of HIGH-003 -- if an attacker can retrieve a cross-tenant change set, they could trigger its application.
- **Recommendation:** Fix HIGH-003 first; this issue resolves as a consequence.

---

### [MEDIUM-007] VFD Automation Resolver Missing From Audit Scope
- **File:** `apps/sensor-service/src/vfd-programming/resolvers/vfd-automation.resolver.ts`
- **Category:** Observability / Audit
- **Description:** The VFD automation resolver exists but was not reviewed for `@AuditLog()` decorator usage on mutation endpoints. Automation rules that trigger VFD parameter changes should have audit logging for IEC 62443 compliance.
- **Impact:** Potential compliance gap -- automated VFD parameter changes may not be fully audited.
- **Recommendation:** Verify all mutations in `vfd-automation.resolver.ts` have `@AuditLog()` decorators.

---

### [MEDIUM-008] TimeBucketService Interpolates Tier Name Into SQL
- **File:** `apps/sensor-service/src/aggregation/time-bucket.service.ts:162`
- **Category:** Security / SQL Safety
- **Description:** The `queryAggregate()` method interpolates the `tier` variable directly into the SQL query: `FROM ${tier}`. While the tier is validated against the enum values at line 96 (`validTiers.includes(tier)`), this is a defensive pattern that relies on the enum remaining correct. If a new tier value were added without updating the validation, SQL injection would be possible.
- **Impact:** Currently mitigated by the enum validation. Fragile against future changes.
- **Recommendation:** Use a whitelist Map instead of string interpolation:
  ```typescript
  const TIER_TABLES = new Map([
    [TimeBucketGranularity.MIN_1, 'metrics_1min'],
    // ...
  ]);
  ```

---

### [LOW-001] Provisioning Token Non-Constant-Time Log Comparison
- **File:** `apps/sensor-service/src/edge-device/provisioning.service.ts:298-300`
- **Category:** Security
- **Description:** The warning log at line 299-300 includes hash prefixes of both received and stored tokens. While SHA-256 hash prefixes do not directly leak the token, the log statement is only reached after the timing-safe comparison fails, so this is informational only.
- **Impact:** Minimal -- the timing-safe comparison has already completed.
- **Recommendation:** Consider removing stored hash prefix from rejection logs to follow the principle of least disclosure.

---

### [LOW-002] rollup.service.ts is an Empty Stub
- **File:** `apps/sensor-service/src/aggregation/rollup.service.ts`
- **Category:** Code Quality
- **Description:** The file contains only whitespace (1 empty line). It is imported but provides no implementation.
- **Impact:** Dead code. No functional impact.
- **Recommendation:** Either implement the service or remove the file.

---

### [LOW-003] Data Processor Service Has Injected But Unused Repository
- **File:** `apps/sensor-service/src/ingestion/data-processor.service.ts:46`
- **Category:** Code Quality
- **Description:** `SensorReading` repository is injected via constructor at line 46 but is never used in any method of the service.
- **Impact:** Unnecessary dependency injection. Minor startup overhead.
- **Recommendation:** Remove the unused `readingRepository` injection.

---

### [LOW-004] `mapRowToEdgeDevice` Uses `Record<string, any>` Parameter Type
- **File:** `apps/sensor-service/src/edge-device/mqtt-auth.service.ts:383`
- **File:** `apps/sensor-service/src/edge-device/provisioning.service.ts:775`
- **Category:** Code Quality / TypeScript Discipline
- **Description:** Both `mapRowToEdgeDevice` methods accept `row: Record<string, any>`. Should use a typed raw row interface.
- **Impact:** TypeScript discipline violation.
- **Recommendation:** Define a `RawEdgeDeviceRow` interface with proper snake_case field types.

---

### [LOW-005] Duplicate Channel Cache Logic in DataIngestionService and MqttListenerService
- **File:** `apps/sensor-service/src/ingestion/data-ingestion.service.ts:365-381`
- **File:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:130-131`
- **Category:** Code Quality / DRY
- **Description:** Both services maintain independent channel caches with identical TTL (60 seconds) and identical lookup logic. This duplicated caching creates inconsistency risk if one cache is updated but not the other.
- **Impact:** Maintenance burden and potential for divergent cache behavior.
- **Recommendation:** Extract channel caching into a shared `ChannelCacheService`.

---

## Architecture Assessment

### What Was Done Well

1. **MQTT Circuit Breaker & Exponential Backoff:** The `MqttClientService` implements a robust circuit breaker pattern with jitter-based exponential backoff. The 5-minute circuit reset and max 20 reconnect attempts are well-calibrated for production.

2. **SCADA Script Sandbox:** The `ScriptExecutor` and `workerScript.ts` implement an exemplary Web Worker sandbox with defense-in-depth: dangerous globals deleted, `Function` constructor locked after setup, prototype pollution prevention on both worker and main thread, URL validation, rate limiting for tag writes, timeout enforcement, and code size limits. The `BUILTIN_FUNCTIONS` registry is properly frozen with `Object.freeze(new Map(...))`.

3. **Expression Evaluator Security:** The `evaluator.ts` correctly uses `Object.prototype.hasOwnProperty.call()` for tag resolution (preventing prototype chain traversal), a frozen function registry, and exhaustive AST node type checking.

4. **Batch INSERT Security:** Both `BatchProcessorService` and `DataIngestionService.batchInsertMetrics()` use parameterized queries with proper UUID validation, `Number.isFinite()` checks, protocol string sanitization, and PostgreSQL parameter limit awareness (65535 params, 1000-row chunk size).

5. **VFD Maker-Checker Workflow:** The `VfdChangeSetService` correctly implements the 4-eye principle with `createdBy !== approvedBy` enforcement, risk evaluation integration, concurrent change set guards, and a proper state machine (DRAFT -> PENDING_APPROVAL -> APPROVED -> APPLYING -> APPLIED -> VERIFIED).

6. **MQTT ACL with Timing-Safe Tenant Comparison:** `MqttAuthService.checkTopicAccess()` uses SHA-256 hashing plus `timingSafeEqual()` for tenant ID comparison, preventing timing attacks on cross-tenant ACL enforcement.

7. **Edge Device Lifecycle Enforcement:** `verifyDeviceCredentials()` correctly rejects `revoked` and `decommissioned` devices at the MQTT auth layer.

8. **Credential Vault:** Uses AES-256-GCM with proper IV randomization, authentication tags, and a hard production requirement for the encryption key. The dev-only fallback key is clearly marked and would fail in production.

9. **PBKDF2-SHA512 with OWASP-Recommended Iterations:** HTTP mode uses 600,000 iterations per OWASP guidance. File mode correctly uses 101 iterations for Mosquitto compatibility.

10. **TimescaleDB Query Routing:** `TimeBucketService` automatically selects the correct continuous aggregate tier based on time range, preventing accidental raw table scans for historical queries. All queries include mandatory `tenant_id` and `time` filters.
