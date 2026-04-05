# Review Report -- Farm Expert
**Date:** 2026-04-04
**Scope:** Full codebase audit of apps/farm-service/ and web/modules/farm-module/ (focus areas: batch lifecycle, tank capacity, CQRS compliance, tenant isolation, Sentinel Hub security, feeding scheduler, frontend components)
**Reviewer:** farm-expert

## Summary
| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| HIGH | 6 |
| MEDIUM | 7 |
| LOW | 4 |

## Impact Analysis

### Files Changed
Full codebase audit -- no diff, reviewing current state.

### Downstream Consumers Affected
- All downstream consumers of BatchTransferred, BatchAllocatedToTank, and BatchClosed NATS events are affected: these events are never published.
- Frontend `TransferModal.tsx` hardcodes `skipCapacityCheck: true`, bypassing server-side safety.

### Breaking Changes
- NONE (this is a state audit, not a change review)

### Cross-Domain Dependencies
- NONE detected

### Tenant Isolation Check
- CRITICAL concern in `FeedingSchedulerService`: three public methods (`executeFeedingSchedule`, `updateFeedingStatus`, `calculateFeedAmount`) query by entity ID without tenantId filter.

### Farm Domain Integrity Check
- Batch Lifecycle: VIOLATION -- state machine diverges from documented spec; missing ACTIVE->CLOSED direct path; extra states (GROWING, PRE_HARVEST, HARVESTED, TRANSFERRED, FAILED) not in documented spec.
- FCR/Growth Calculations: PASSED -- formula is correct: `totalFeedConsumed / weightGain`.
- Tank Capacity Management: VIOLATION -- `AllocateToTankHandler` logs a warning but never blocks over-capacity allocations; frontend hardcodes `skipCapacityCheck: true`.
- Event Contract Compliance: VIOLATION -- 5 of 13 batch command handlers do not publish NATS events; 2 handlers swallow event publish errors without logging.
- Sentinel Hub Security: PASSED -- SEC-C14 compliance verified.

### Risk Level
- HIGH -- Multiple tenant isolation gaps, missing event publications, and capacity check bypasses affect data integrity and cross-service consistency.

---

## Findings

### [CRITICAL-001] Tenant Isolation Missing in FeedingSchedulerService Public Methods
- **File:** `apps/farm-service/src/scheduler/feeding-scheduler.service.ts:416-434`
- **Category:** Security
- **Description:** Three public methods query entities by ID only, without `tenantId` in the WHERE clause:
  1. `executeFeedingSchedule()` (line 426): `findOne({ where: { id: scheduleId } })` -- no tenantId
  2. `updateFeedingStatus()` (line 544): `findOne({ where: { id } })` -- no tenantId
  3. `calculateFeedAmount()` (line 613): `findOne({ where: { id: batchId } })` -- no tenantId

  If any of these methods are callable via a resolver or API endpoint where the caller can supply arbitrary IDs, a malicious tenant could operate on another tenant's feeding schedules, feeding records, or batches.
- **Impact:** IDOR vulnerability. Tenant A could execute feeding schedules, modify feeding records, or read batch biomass data belonging to Tenant B if UUIDs are guessable or leaked.
- **Recommendation:** See REC-001 in recommendations file.

### [CRITICAL-002] RecordCullHandler Has TOCTOU Race Condition (Reads Outside Transaction)
- **File:** `apps/farm-service/src/batch/handlers/record-cull.handler.ts:37-68`
- **Category:** Security / Data Integrity
- **Description:** Unlike `RecordMortalityHandler` (which was fixed), `RecordCullHandler` reads the batch (line 38), tank (line 47), and TankBatch (line 67) OUTSIDE the transaction without pessimistic locks. The transaction only starts at line 79. This creates a TOCTOU (time-of-check-time-of-use) race condition where:
  1. Two concurrent cull requests read `batch.currentQuantity = 100`
  2. Both validate `50 <= 100` passes
  3. Both execute inside separate transactions, resulting in `currentQuantity = 0` and `cullCount = 100` -- double the intended cull.
  
  Additionally, `Math.max(0, ...)` guards are missing at lines 105, 114-115, 127-128, meaning `currentQuantity`, `totalQuantity`, `totalBiomassKg`, and `currentBiomass` can go negative.
- **Impact:** Concurrent cull operations can corrupt batch and tank biomass data, resulting in negative fish counts and incorrect production metrics.
- **Recommendation:** See REC-002 in recommendations file.

### [CRITICAL-003] Frontend TransferModal Hardcodes skipCapacityCheck: true
- **File:** `web/modules/farm-module/src/pages/production/components/TransferModal.tsx:150`
- **Category:** Domain Logic / Data Integrity
- **Description:** The `TransferModal` component hardcodes `skipCapacityCheck: true` on line 150 of the `handleSubmit` function:
  ```
  skipCapacityCheck: true, // Always allow transfers even if destination is over capacity
  ```
  This completely bypasses server-side tank density validation for every single transfer operation initiated from the production UI. While the UI shows a capacity warning (non-blocking), the backend capacity check is unconditionally skipped.
  
  The `AllocateToTankHandler` (line 99-104) also never blocks on capacity -- it only logs a warning. Combined, this means there is NO enforced capacity limit anywhere in the system for tank allocations or transfers.
- **Impact:** Tanks can be loaded to arbitrary density levels without any system enforcement. In aquaculture, exceeding density limits causes oxygen depletion, stress mortality, and regulatory violations. No audit trail captures that capacity checks were overridden.
- **Recommendation:** See REC-003 in recommendations file.

---

### [HIGH-001] CloseBatchHandler Missing Transaction, Event Publishing, and Logger
- **File:** `apps/farm-service/src/batch/handlers/close-batch.handler.ts`
- **Category:** Architecture / CQRS Compliance
- **Description:** The `CloseBatchHandler` has three architectural violations:
  1. **No transaction**: Line 86 does a direct `batchRepository.save()` without a QueryRunner transaction. If the save partially fails (e.g., optimistic lock exception from `@VersionColumn()`), the in-memory batch object will have been mutated but not persisted, leaving inconsistent state.
  2. **No NATS event published**: `BatchClosed` is listed as a published event in the event contracts, but this handler does not inject `EVENT_BUS` or publish any event. Downstream consumers (notification service, analytics) will never know a batch was closed.
  3. **No Logger**: Unlike all other batch handlers, this one has no `Logger` instance and produces no observability output.
- **Impact:** Batch closure is invisible to the event-driven architecture. Downstream services that depend on `BatchClosed` events will have stale data. No operational visibility into batch closures.
- **Recommendation:** See REC-004 in recommendations file.

### [HIGH-002] TransferBatchHandler Injects EVENT_BUS But Never Publishes Events
- **File:** `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts:55-56`
- **Category:** Architecture / CQRS Compliance
- **Description:** The handler correctly injects `@Optional() @Inject('EVENT_BUS')` at line 55, but never calls `this.eventBus.publish()` anywhere in the `execute()` method. The `BatchTransferred` event type is defined in event contracts but is never emitted during transfer operations.
- **Impact:** Downstream consumers expecting `BatchTransferred` events (e.g., for tank density alerts, production dashboards, audit trail) receive nothing. The event bus injection is dead code.
- **Recommendation:** See REC-005 in recommendations file.

### [HIGH-003] AllocateToTankHandler Missing NATS Event Publication
- **File:** `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts`
- **Category:** Architecture / CQRS Compliance
- **Description:** The handler does not inject `EVENT_BUS` and does not publish `BatchAllocatedToTank` events. This event type is defined in the event contracts but is never emitted.
- **Impact:** External systems have no visibility into tank allocation changes. This breaks the CQRS event-driven architecture for a critical production operation.
- **Recommendation:** See REC-006 in recommendations file.

### [HIGH-004] UpdateBatchStatusHandler Publishes Event Before Transaction Guarantee
- **File:** `apps/farm-service/src/batch/handlers/update-batch-status.handler.ts:77-97`
- **Category:** Architecture / CQRS Compliance
- **Description:** Two violations:
  1. **No transaction**: The handler uses a direct `batchRepository.save()` (line 77) without a QueryRunner transaction. While this is a single-entity save, the lack of explicit transaction means the event could be published even if the save encounters a retry due to optimistic locking.
  2. **Silent error swallow**: The event publish error handler at line 94-96 has an empty catch block -- the error is neither logged nor tracked:
     ```
     } catch (eventError) {
       // Log but don't fail for event publishing errors
     }
     ```
     The comment says "Log" but there is no `this.logger` call.
- **Impact:** Event publish failures are completely invisible. If NATS is down, there is no way to detect missed `BatchStatusChanged` events.
- **Recommendation:** See REC-007 in recommendations file.

### [HIGH-005] RecordMortalityHandler Event Publish Error Silently Swallowed
- **File:** `apps/farm-service/src/batch/handlers/record-mortality.handler.ts:223-225`
- **Category:** Observability
- **Description:** Same pattern as HIGH-004 -- the catch block at line 223-225 swallows the event publish error without logging:
  ```
  } catch (eventError) {
    // Log but don't fail for event publishing errors
  }
  ```
  The comment is misleading -- it says "Log" but there is no logging statement.
- **Impact:** Failed `MortalityRecorded` event publications are invisible to operations. Mortality alerts to downstream services will silently fail.
- **Recommendation:** See REC-007 in recommendations file.

### [HIGH-006] BatchResolver N+1 Query Pattern on Document Field Resolvers
- **File:** `apps/farm-service/src/batch/resolvers/batch.resolver.ts:918-951`
- **Category:** Performance
- **Description:** Three `@ResolveField()` methods execute individual database queries per parent batch:
  1. `getDocuments()` (line 919): queries `documentRepository.find({ where: { batchId: batch.id } })`
  2. `getHealthCertificates()` (line 928): queries with additional `documentType` filter
  3. `getImportDocuments()` (line 941): queries with additional `documentType` filter

  When the `batches` list query returns N batches, each batch triggers up to 3 additional database queries, resulting in 1 + 3N total queries. For a page of 20 batches, this produces 61 database queries.
- **Impact:** Significant database load on list pages. With 100 batches per page, this would be 301 queries per request.
- **Recommendation:** See REC-008 in recommendations file.

---

### [MEDIUM-001] Batch State Machine Diverges From Documented Specification
- **File:** `apps/farm-service/src/batch/entities/batch.entity.ts:602-628`
- **Category:** Domain Logic
- **Description:** The documented batch lifecycle states are `QUARANTINE -> ACTIVE -> HARVESTING -> CLOSED` with a direct close path `QUARANTINE -> ACTIVE -> CLOSED`. However, the actual `canTransitionTo()` implementation defines 9 states with a much more complex graph:
  - `QUARANTINE -> ACTIVE, FAILED`
  - `ACTIVE -> GROWING, TRANSFERRED, FAILED`
  - `GROWING -> PRE_HARVEST, TRANSFERRED, FAILED`
  - `PRE_HARVEST -> HARVESTING, GROWING, FAILED`
  - `HARVESTING -> HARVESTED, FAILED`
  - `HARVESTED -> CLOSED`
  - `TRANSFERRED -> CLOSED`
  - `FAILED -> CLOSED`
  
  The documented direct path `ACTIVE -> CLOSED` is NOT in the state machine. There is no transition from `ACTIVE` directly to `HARVESTING` either -- it must go through `GROWING` and `PRE_HARVEST` first. Additionally, the `CloseBatchHandler` has its own parallel validation via `allowedPreviousStatuses` (line 41-47) that allows closing from ANY status via `BatchCloseReason.OTHER`, bypassing the state machine entirely.
- **Impact:** The documentation does not match the implementation. Developers relying on the documented lifecycle will write incorrect code. The `OTHER` close reason bypass could be abused.
- **Recommendation:** Update documentation to match implementation, or simplify the state machine. Restrict `BatchCloseReason.OTHER` to admin roles only.

### [MEDIUM-002] FeedingSchedulerService File Size: 1749 Lines
- **File:** `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`
- **Category:** Code Quality
- **Description:** At 1749 lines, this file exceeds the 500-line limit by 3.5x. It contains: tenant config management, feeding schedule CRUD, feed amount calculation with bilinear interpolation, daily cron jobs (plan generation, reminders, summaries), FCR analysis, stock checks, and utility methods. These are at least 5 distinct responsibilities.
- **Impact:** Difficult to test, review, and maintain. Changes to cron job logic risk breaking feed calculation logic and vice versa.
- **Recommendation:** Extract into separate services: `FeedAmountCalculatorService`, `FeedingCronService`, `FeedingScheduleCrudService`, `TenantFeedingConfigService`.

### [MEDIUM-003] CronJobsService File Size: 759 Lines
- **File:** `apps/farm-service/src/scheduler/cron-jobs.service.ts`
- **Category:** Code Quality
- **Description:** At 759 lines, this file exceeds the 500-line limit by 1.5x. Contains maintenance scheduling, spare part alerts, work order generation, and tenant config management.
- **Impact:** Single-responsibility violation; moderately difficult to maintain.
- **Recommendation:** Extract tenant config management and each cron job category into separate files.

### [MEDIUM-004] FeedInventoryTab.tsx Uses `any` Type Extensively
- **File:** `web/modules/farm-module/src/pages/feeding/components/FeedInventoryTab.tsx:35,86,117,145,161,392-399,455`
- **Category:** Code Quality
- **Description:** Multiple `any` type usages violate the TypeScript discipline:
  - Line 35: `sites: any[]` in `FeedInventoryTabProps`
  - Line 86: `feeds?.items?.forEach((f: any) => ...)`
  - Line 92: `sites.forEach((s: any) => ...)`
  - Lines 117, 145, 161: `handleAddSubmit(data: any)`, `handleConsumeSubmit(data: any)`, `handleAdjustSubmit(data: any)`
  - Line 392-399: `AddInventoryModalProps` has `feeds: any[]`, `sites: any[]`, `onSubmit: (data: any) => void`
- **Impact:** Loss of type safety. Refactoring or API changes could introduce runtime errors that TypeScript would normally catch.
- **Recommendation:** Define proper interfaces for `Site`, `Feed` list items, and form data types.

### [MEDIUM-005] FeedInventoryTab.tsx Uses console.error Instead of Structured Logging
- **File:** `web/modules/farm-module/src/pages/feeding/components/FeedInventoryTab.tsx:142,153,175`
- **Category:** Observability
- **Description:** Three `console.error()` calls in submit handlers that should use the application's error reporting/toast system.
- **Impact:** Errors are only visible in browser console; users get no feedback on failures unless the mutation hook surfaces the error.
- **Recommendation:** Replace with toast notifications and error boundary patterns.

### [MEDIUM-006] TransferModal.tsx Duplicate Error Display
- **File:** `web/modules/farm-module/src/pages/production/components/TransferModal.tsx:463-484`
- **Category:** Code Quality
- **Description:** The validation errors are displayed twice:
  1. Lines 464-472: First error block (conditionally shown when `quantity > 0 || destinationTankId`)
  2. Lines 474-484: Second error block (always shown when `errors.length > 0`)
  
  When both conditions are true, the user sees the same errors duplicated.
- **Impact:** Confusing user experience with redundant error messages.
- **Recommendation:** Remove one of the duplicate error display blocks.

### [MEDIUM-007] SentinelHubSettings Entity: clientId/clientSecret Have No @HideField
- **File:** `apps/farm-service/src/sentinel-hub/entities/sentinel-hub-settings.entity.ts:29-33`
- **Category:** Security (Defense in Depth)
- **Description:** While `clientId` and `clientSecret` on the `SentinelHubSettings` entity do NOT have `@Field()` decorators (so they are correctly excluded from GraphQL), they also lack explicit `@HideField()` decorators. This is a defense-in-depth concern: if someone accidentally adds `@Field()` during refactoring, the credentials would be exposed. The `SentinelHubToken` and `SentinelHubWmtsConfig` types correctly use `@HideField()` on their `accessToken` fields (lines 109, 129), but the settings entity does not follow the same pattern.
- **Impact:** Low risk currently (fields are not exposed), but a refactoring mistake could expose encrypted credentials via GraphQL.
- **Recommendation:** Add `@HideField()` to `clientId`, `clientSecret`, and `instanceId` columns as defense-in-depth.

---

### [LOW-001] Batch Entity File Size: 657 Lines
- **File:** `apps/farm-service/src/batch/entities/batch.entity.ts`
- **Category:** Code Quality
- **Description:** At 657 lines, the entity file exceeds the 500-line limit. The business methods (`getCurrentBiomass`, `calculateFCR`, `calculateSGR`, `canTransitionTo`, etc.) could be extracted into a domain service.
- **Impact:** Moderate maintainability concern. Entity classes should primarily define schema, not business logic.
- **Recommendation:** Extract business methods into a `BatchDomainService` or value objects.

### [LOW-002] BatchResolver File Size: 952 Lines
- **File:** `apps/farm-service/src/batch/resolvers/batch.resolver.ts`
- **Category:** Code Quality
- **Description:** At 952 lines, this file exceeds the 500-line limit by nearly 2x. It contains input types, response types, enum registrations, and the resolver class all in one file. The input types and response types should be in separate files.
- **Impact:** Difficult to navigate and maintain. Finding a specific mutation or query requires scrolling through 600+ lines of type definitions.
- **Recommendation:** Move input types to `batch/dto/`, response types to `batch/types/`, and enum registrations to a dedicated file.

### [LOW-003] Test Coverage: 16 Test Files for 814 Source Files (~2%)
- **File:** `apps/farm-service/src/` (entire service)
- **Category:** Quality
- **Description:** Only 16 test files exist for 814 source files. Critical paths that lack ANY test coverage include:
  - `AllocateToTankHandler` -- complex allocation logic with capacity checks
  - `TransferBatchHandler` -- multi-entity transaction with dual tank updates
  - `CloseBatchHandler` -- final metrics calculation
  - `RecordCullHandler` -- the handler with the TOCTOU race condition (CRITICAL-002)
  - All 36 GraphQL resolvers
  - All feeding scheduler cron jobs
  - All storage/inventory handlers
  - All weather/sentinel-hub services
- **Impact:** Regressions are undetectable. The TOCTOU bug in CRITICAL-002 would have been caught by a concurrent test.
- **Recommendation:** Prioritize tests for handlers identified in CRITICAL-002, HIGH-001 through HIGH-005.

### [LOW-004] TransferModal.tsx Uses console.error in DEV Mode Only
- **File:** `web/modules/farm-module/src/pages/production/components/TransferModal.tsx:157`
- **Category:** Observability
- **Description:** Line 157: `if (import.meta.env.DEV) console.error(...)` -- error logging is only active in development mode. In production, transfer failures are silent beyond the toast message.
- **Impact:** Production debugging of transfer failures requires reproduction in dev mode.
- **Recommendation:** Use a structured error logger that works in all environments, or at minimum, log the error object (not just hide it).

---

## Positive Observations

The following areas demonstrate strong engineering practices:

1. **CreateBatchHandler** (`create-batch.handler.ts`): Exemplary CQRS compliance -- transaction with QueryRunner, event published AFTER commit, `@Optional() @Inject('EVENT_BUS')` pattern, error logging on event failure, proper biomass formula `(qty * avgWeightG) / 1000`.

2. **RecordMortalityHandler** (`record-mortality.handler.ts`): Correctly uses pessimistic locking, `Math.max(0, ...)` guards, transaction isolation, and post-commit event publishing. (The only issue is the silent error swallow on event publish.)

3. **TransferBatchHandler** (`transfer-batch.handler.ts`): Excellent use of `pessimistic_write` locks on both source and destination entities, `Math.max(0, ...)` guards on biomass/count, and proper pre/post operation state tracking.

4. **Sentinel Hub Security** (`sentinel-hub/`): SEC-C14 compliance is thorough -- `@HideField()` on tokens, backend proxy controller with JWT auth, path traversal prevention via regex, AES-256-CBC encryption of credentials with no hardcoded fallback keys, and masked credential display.

5. **Tenant Isolation in Standard Handlers**: The query handlers (e.g., `GetConsumableHandler`, `CreateParameterConfigHandler`) consistently include `tenantId` in their WHERE clauses. The vulnerability in CRITICAL-001 is isolated to the `FeedingSchedulerService`.

6. **Memory Leak Prevention**: The `FeedingSchedulerService` and `CronJobsService` both implement TTL-based cleanup of tenant configs with `OnModuleDestroy` cleanup, proper interval management, and stale config eviction.
