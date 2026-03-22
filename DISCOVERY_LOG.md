# Event Consistency Discovery Log

## Date: 2026-03-22
## Agent: Event Consistency Architect (Agent 3)

---

## FIXED (CRIT/HIGH)

### CRIT-01: auth-service suspend/activate/cancel missing ALL event publishing
- **File**: `apps/auth-service/src/modules/tenant/services/tenant.service.ts`
- **Methods**: `suspend()`, `activate()`, `cancel()`
- **Issue**: State changes (DB save) without any event publishing
- **Fix**: Added `TenantSuspendedEvent` + `TenantStatusChangedEvent` for suspend, `TenantActivatedEvent` + `TenantStatusChangedEvent` for activate, `TenantStatusChangedEvent` for cancel

### CRIT-02: auth-service assignModules() missing TenantModulesAssignedEvent
- **File**: `apps/auth-service/src/modules/tenant/services/tenant.service.ts`
- **Method**: `assignModules()`
- **Issue**: Modules assigned to tenant without event notification to billing/other services
- **Fix**: Added `TenantModulesAssignedEvent` publishing after transaction commit

### HIGH-01: admin-api-service handlers missing TenantStatusChangedEvent
- **File**: `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts`
- **Handlers**: `SuspendTenantHandler`, `ActivateTenantHandler`, `ArchiveTenantHandler`
- **Issue**: Published specific events (TenantSuspended, TenantActivated, TenantArchived) but NOT the generic `TenantStatusChangedEvent`. Consumers listening for general status changes would miss these transitions.
- **Fix**: Added `TenantStatusChangedEvent` publishing alongside specific events in all three handlers

### HIGH-02: admin-api-service handlers using untyped event objects
- **File**: `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts`
- **Issue**: All event publishes used inline object literals (`{ eventId: ..., eventType: 'TenantSuspended', ... }`) without type checking against event contracts
- **Fix**: Added explicit type annotations using imported event contract interfaces (`TenantSuspendedEvent`, `TenantActivatedEvent`, `TenantArchivedEvent`, `TenantStatusChangedEvent`)

### HIGH-03: DeactivateTenantHandler used string literal 'deactivated' instead of enum
- **File**: `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts`
- **Issue**: `newStatus: 'deactivated'` hardcoded string instead of `TenantStatus.DEACTIVATED`
- **Fix**: Changed to `TenantStatus.DEACTIVATED` for consistency

### HIGH-04: updateTenantSettings() missing TenantUpdatedEvent
- **File**: `apps/auth-service/src/modules/tenant/services/tenant.service.ts`
- **Method**: `updateTenantSettings()`
- **Issue**: Active method called from resolver for non-SUPER_ADMIN users. Updates tenant fields but never publishes TenantUpdatedEvent. Consumers miss settings-level changes.
- **Fix**: Added `TenantUpdatedEvent` publishing

---

## DISCOVERED (MED/LOW - Not Fixed)

### MED-01: TenantSubscriptionChangedEvent has no publisher anywhere
- **Contract**: `libs/event-contracts/src/tenant-events.ts` line 82
- **Issue**: Defined contract with `previousPlan`, `newPlan`, `effectiveDate` fields but no service publishes it
- **Impact**: Dead contract. If plan changes happen, no event is emitted. Billing service cannot react to plan upgrades/downgrades.
- **Recommendation**: Publish from `update()` method when `input.plan` differs from `tenant.plan`

### MED-02: TenantProvisioningFailedEvent published as untyped object
- **File**: `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts` line 185
- **Issue**: Published as `{ eventType: 'TenantProvisioningFailed', ... }` without importing or typing against the contract interface
- **Impact**: No compile-time verification that payload matches contract

### MED-03: ModuleRemovedFromTenantEvent published as untyped object
- **File**: `apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts` line 314
- **Issue**: Published as inline object without typing against `ModuleRemovedFromTenantEvent` contract
- **Impact**: No compile-time verification

### MED-04: TenantModulesAssignedEvent published as untyped in admin-api module-assignment
- **File**: `apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts` line 543
- **Issue**: `publishModulesAssignedEvent()` uses untyped object literal
- **Impact**: No compile-time verification

### LOW-01: Dual event publishing path for same operations
- **auth-service**: `suspend()`, `activate()` via GraphQL mutations
- **admin-api-service**: `SuspendTenantCommand`, `ActivateTenantCommand` via REST API
- **Issue**: Same logical operation has two publishing paths. If contract changes, both must be updated.
- **Recommendation**: Consider consolidating to a single canonical path or extracting shared event-building utility

### LOW-02: auth-service TenantStatus enum missing DEACTIVATED/ARCHIVED
- **File**: `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts`
- **Issue**: Only has ACTIVE, SUSPENDED, PENDING, CANCELLED. admin-api-service has DEACTIVATED and ARCHIVED (aliased to CANCELLED)
- **Impact**: auth-service cannot represent full lifecycle. Not blocking since cancel() covers the CANCELLED state.
