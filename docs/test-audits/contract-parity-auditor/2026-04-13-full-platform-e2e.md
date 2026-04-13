# Contract Parity Auditor: `2026-04-13-full-platform-e2e`

Scope: semantic alignment across frontend field models, payload builders, DTOs, validators, commands, entities, serializers, and read models across `web/**`, `apps/**`, `libs/**`.

Prior cycle: `2026-04-11-full-platform-e2e`. Commit `79ce984f` fixed 12 findings. This cycle re-verifies prior findings and audits additional contract boundaries.

## Findings

### HIGH-001 — Impersonation session start payload sends wrong field names and free-text reason to an enum-validated backend DTO (REPEAT)

**Status: OPEN (repeat from 2026-04-11 HIGH-001)**

The frontend `startSession` API call sends `{ tenantId, adminId, impersonatedUserId, reason }` (line 50, `impersonation.ts`). The page handler populates these from the local form model with a free-text `reason` string and `tenantId` (line 203-208, `ImpersonationPage.tsx`).

The backend `StartImpersonationDto` (line 109-149, `impersonation.controller.ts`) requires:
- `targetTenantId` (not `tenantId`) -- `@IsUUID('4')`, required
- `reason` -- `@IsEnum(ImpersonationReason)`, required enum (not free text)
- `targetUserId` (not `impersonatedUserId`) -- `@IsOptional()`, `@IsUUID('4')`

The controller ignores client-supplied `adminId` and takes `superAdminId` from the JWT (line 349). The DTO will reject the request because:
1. `targetTenantId` is missing (the UI sends `tenantId` which is not a recognized DTO field)
2. `reason` is free text but the validator requires `ImpersonationReason` enum values

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/api/impersonation.ts` line 50-51
- `/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx` lines 94-98, 200-208
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` lines 109-149, 337-358
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts` lines 17-25 (ImpersonationReason enum)

Root cause: The frontend API client was never updated when the backend migrated from legacy field names to the `target*` prefix convention and from free-text reason to enum-validated reason. The start session path is completely broken.

Classification: `write-gap`

Cross-domain: Route to `form-write-auditor` (broken write). Route to `access-boundary-auditor` (privileged impersonation boundary).

---

### HIGH-002 — Grant-permission form collects `allowedActions` but never sends it; backend has no matching field (REPEAT)

**Status: OPEN (repeat from 2026-04-11 HIGH-002)**

The permission form state includes `allowedActions: ['read'] as string[]` (line 104, `ImpersonationPage.tsx`). The `handleGrantPermission` handler (lines 253-277) intentionally omits `allowedActions` from the `grantPermission()` call. The `GrantPermissionDto` (lines 52-107, `impersonation.controller.ts`) has no `allowedActions` field. The `ImpersonationPermission` entity (lines 148-207) stores `defaultPermissions` as a typed `ImpersonationPermissions` object with fields like `canViewData`, `canModifyData`, etc. -- not a string array of action names.

The UI presents an "Allowed Actions" control that has zero backend representation. The user configures action scope believing it is persisted, but it is silently dropped.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx` lines 101-107, 253-277
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/impersonation.ts` line 15 (`allowedActions: string[]` in frontend type)
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` lines 52-107
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts` lines 27-36, 148-207

Root cause: The frontend carries a legacy action-scope model (`string[]`) that never mapped to the backend's structured `ImpersonationPermissions` interface. The `handleGrantPermission` fix intentionally skipped this field but left the UI control in place.

Classification: `access-gap`

Cross-domain: Route to `access-boundary-auditor`. Route to `tenant-isolation-auditor`.

---

### HIGH-003 — AquaMobil leave creation queues a reduced input shape that cannot satisfy the HR GraphQL contract (REPEAT)

**Status: OPEN (repeat from 2026-04-11 HIGH-003)**

`LeaveRequestPage` (lines 81-87, `LeaveRequestPage.tsx`) queues `createLeaveRequest` with:
- `leaveTypeId`, `startDate`, `endDate`, `isHalfDay`, `reason`

The AquaMobil `CreateLeaveRequestInput` type (line 218-224, `types/index.ts`) mirrors this reduced model.

The backend `CreateLeaveRequestInput` DTO (lines 16-64, `create-leave-request.input.ts`) requires:
- `employeeId` -- `@IsUUID()`, required
- `leaveTypeId` -- `@IsUUID()`, required
- `startDate`, `endDate` -- required
- `totalDays` -- `@IsNumber()`, `@Min(0.5)`, required
- `isHalfDayStart`, `isHalfDayEnd` -- boolean (not a single `isHalfDay`)
- `halfDayPeriod` -- optional enum (`AM` | `PM`)
- `contactDuringLeave` -- optional string

The mobile form omits `employeeId` (required), `totalDays` (required), and sends `isHalfDay` instead of the split `isHalfDayStart`/`isHalfDayEnd` semantics. The GraphQL mutation will fail validation on the required fields.

Evidence:
- `/var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx` lines 74-87
- `/var/aqua-saas/web/apps/aquamobil/src/types/index.ts` lines 218-224
- `/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` lines 95-104
- `/var/aqua-saas/apps/hr-service/src/leave/dto/create-leave-request.input.ts` lines 16-64
- `/var/aqua-saas/web/modules/hr-module/src/types/leave.types.ts` lines 143-154 (correct frontend type)

Root cause: AquaMobil maintains its own reduced `CreateLeaveRequestInput` interface that was never aligned to the HR service's evolved schema. The HR module's web panel (`leave.types.ts` lines 143-154) has the correct contract with `employeeId`, `totalDays`, `isHalfDayStart`, `isHalfDayEnd`.

Classification: `write-gap`

Cross-domain: Route to `form-write-auditor`. Route to `mobile-app-auditor`.

---

### HIGH-004 — Tenant status enum uses lowercase in the frontend but UPPERCASE in the backend entity, causing filter/comparison failures

The frontend `TenantStatus` enum (`tenant.ts` lines 9-15):
```
PENDING = 'pending', ACTIVE = 'active', SUSPENDED = 'suspended', DEACTIVATED = 'deactivated', ARCHIVED = 'archived'
```

The backend `TenantStatus` enum (`tenant.entity.ts` lines 11-18):
```
PENDING = 'PENDING', ACTIVE = 'ACTIVE', SUSPENDED = 'SUSPENDED', CANCELLED = 'CANCELLED', DEACTIVATED = 'DEACTIVATED', ARCHIVED = 'ARCHIVED'
```

Differences:
1. **Case mismatch**: All status values use lowercase in the frontend but UPPERCASE in the backend entity. Any direct comparison (`===`) between frontend status and database-stored status will fail.
2. **Missing member**: Backend has `CANCELLED = 'CANCELLED'` which does not exist in the frontend enum.
3. The backend entity stores `@Column({ type: 'varchar', length: 20, default: TenantStatus.PENDING })` which persists `'PENDING'` (uppercase). The frontend `ListTenantsQueryDto` validates against the backend `TenantStatus` enum, so filter queries with lowercase values will either fail validation or return empty results.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/tenant.ts` lines 9-15
- `/var/aqua-saas/apps/admin-api-service/src/tenant/entities/tenant.entity.ts` lines 11-18
- `/var/aqua-saas/apps/admin-api-service/src/tenant/dto/tenant.dto.ts` lines 384-396 (`ListTenantsQueryDto` uses `@IsEnum(TenantStatus)`)

Root cause: The frontend types were authored with a different casing convention than the backend entity enum. No shared contract exists between the two layers.

Classification: `enum-gap`

Cross-domain: Route to `data-readback-auditor` (read filters break). Route to `tenant-isolation-auditor` (status filtering is tenant-scoped).

---

### HIGH-005 — Billing PlanTier enum missing `FREE` in backend, causing subscription creation to fail for free-tier tenants

The frontend `PlanTier` enum (`billing.ts` lines 9-15):
```
FREE = 'free', STARTER = 'starter', PROFESSIONAL = 'professional', ENTERPRISE = 'enterprise', CUSTOM = 'custom'
```

The backend `PlanTier` enum (`subscription.entity.ts` lines 33-37):
```
STARTER = 'starter', PROFESSIONAL = 'professional', ENTERPRISE = 'enterprise', CUSTOM = 'custom'
```

The backend `PlanTier` enum does NOT include `FREE`. The frontend `CreateTenantPage` (line 630) works around this by mapping `'free'` to `TenantTier.STARTER`:
```ts
tier: formData.pricingTier === 'free' ? TenantTier.STARTER : formData.pricingTier as TenantTier,
```

However, any code path that passes `PlanTier.FREE` to the billing GraphQL subscription creation mutation will fail because the backend `@IsEnum(PlanTier)` validator rejects `'free'`. The `SubscriptionManagementPage` uses the frontend `PlanTier` enum for filter controls, and passing `'free'` as a filter value will be rejected.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/billing.ts` lines 9-15
- `/var/aqua-saas/apps/billing-service/src/billing/entities/subscription.entity.ts` lines 33-37
- `/var/aqua-saas/web/modules/admin-panel/src/pages/CreateTenantPage.tsx` line 630 (workaround)
- `/var/aqua-saas/web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx` lines 31-34 (filter uses frontend enum)

Root cause: The billing service was designed without a free tier (free tenants have no subscription), but the frontend enum includes `FREE` as a valid tier. The `CreateTenantPage` has a local workaround, but other consumers of the shared `PlanTier` type will fail.

Classification: `enum-gap`

Cross-domain: Route to `form-write-auditor`. Route to `billing-reconciliation-auditor`.

---

### HIGH-006 — Impersonation session status enum `revoked` in frontend does not exist in backend entity; backend uses `terminated`

The frontend `ImpersonationSession` type (`impersonation.ts` line 29):
```
status: 'active' | 'ended' | 'expired' | 'revoked'
```

The backend `ImpersonationStatus` enum (`impersonation-session.entity.ts` lines 10-15):
```
ACTIVE = 'active', ENDED = 'ended', EXPIRED = 'expired', TERMINATED = 'terminated'
```

The frontend uses `'revoked'` where the backend uses `'terminated'`. Any session with status `terminated` from the database will not match the frontend `'revoked'` literal. The frontend session list, status badges, and filter controls will misrepresent terminated sessions.

The API layer (`impersonation.ts` line 57) correctly routes to `/sessions/:id/terminate`, but the response mapping and type definition still expect `'revoked'` as the status string.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/impersonation.ts` line 29
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts` lines 10-15
- `/var/aqua-saas/web/modules/admin-panel/src/services/api/impersonation.ts` line 57

Root cause: The backend renamed `revoked` to `terminated` (semantically accurate for admin-forced session end) but the frontend type was never updated.

Classification: `enum-gap`

Cross-domain: Route to `data-readback-auditor`.

---

### MEDIUM-007 — Analytics frontend types drift from backend read model (REPEAT, partially addressed)

**Status: OPEN (repeat from 2026-04-11 MEDIUM-004, now re-assessed)**

The shared `DashboardSummary` type (`analytics.ts` lines 5-14) is a flat 8-field interface. The `AnalyticsDashboardPage` (line 18+) defines page-local `TenantMetrics`, `UserMetrics`, and `FinancialMetrics` interfaces that are structurally different and more detailed than the shared types. The page fetches from `analyticsApi` endpoints that return backend shapes, then maps them into local types with `Partial<>` casts and defensive branching.

Multiple `analyticsApi` methods throw `Error('Not implemented')` at runtime (lines 43-58 in `analytics.ts`): `getApiUsageByEndpoint`, `getEngagementMetrics`, `getFeatureUsage`, `getGeographicDistribution`. Any UI code that calls these will crash.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/analytics.ts` lines 5-14
- `/var/aqua-saas/web/modules/admin-panel/src/services/api/analytics.ts` lines 43-58
- `/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx` lines 18-50

Root cause: No single shared contract between the backend analytics service and the frontend consumers. The page has evolved independently from the shared types.

Classification: `schema-gap`

Cross-domain: Route to `data-readback-auditor`.

---

### MEDIUM-008 — Data subject request type and status enums diverge across three layers

Three different definitions of request type and status exist:

**Backend entity** (`security.entity.ts` lines 62-64):
- `DataRequestType`: `'access' | 'deletion' | 'portability' | 'rectification' | 'restriction'`
- `DataRequestStatus`: `'pending' | 'in_progress' | 'completed' | 'rejected' | 'expired'`

**Frontend shared type** (`security.ts` lines 57-69):
- `DataSubjectRequest.type`: `'access' | 'rectification' | 'erasure' | 'portability' | 'restriction'`
- `DataSubjectRequest.status`: `'pending' | 'in_progress' | 'completed' | 'rejected'`

**CompliancePage inline type** (`CompliancePage.tsx` lines 41-42):
- `DataRequestType`: `'access' | 'rectification' | 'erasure' | 'portability' | 'restriction' | 'objection'`
- `DataRequestStatus`: `'pending' | 'in_progress' | 'identity_verification' | 'processing' | 'completed' | 'rejected'`

Drift summary:
1. Backend uses `'deletion'`, frontend shared uses `'erasure'`, CompliancePage uses `'erasure'` -- the name for the same GDPR right differs.
2. CompliancePage adds `'objection'` which exists in neither the backend nor shared types.
3. CompliancePage adds `'identity_verification'` and `'processing'` statuses which the backend entity does not define.
4. Backend has `'expired'` status absent from both frontend types.

A data request created with type `'erasure'` from the frontend will not match backend's `'deletion'` in queries or filters.

Evidence:
- `/var/aqua-saas/apps/admin-api-service/src/security/entities/security.entity.ts` lines 62-64
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/security.ts` lines 57-69
- `/var/aqua-saas/web/modules/admin-panel/src/pages/security/CompliancePage.tsx` lines 41-42

Root cause: Three independent type definitions for the same domain concept with no shared contract. Each layer evolved independently.

Classification: `enum-gap`

Cross-domain: Route to `gdpr-compliance-auditor`. Route to `data-readback-auditor`.

---

### MEDIUM-009 — Frontend ImpersonationPermission type has fields absent from the backend entity read model

The frontend `ImpersonationPermission` type (`impersonation.ts` lines 5-19) includes:
- `tenantId` -- backend entity has no `tenantId` column (permissions are per-superAdmin, not per-tenant)
- `tenantName` -- not in entity
- `grantedByEmail` -- not in entity (entity has `grantedBy` UUID only)
- `allowedActions: string[]` -- not in entity (entity stores `defaultPermissions` as typed `ImpersonationPermissions`)
- `maxSessionDuration: number` -- backend field is `maxSessionDurationMinutes` (name mismatch)
- `reason: string` -- not in entity

The entity (`impersonation-session.entity.ts` lines 148-207) has fields the frontend type omits:
- `canImpersonate`, `requireReason`, `requireTicketReference`, `notifyTenantAdmin`, `maxConcurrentSessions`, `allowedTenants`, `restrictedTenants`

Any read-back of permission data will have undefined fields in the frontend, and the UI will display empty or default values for fields that don't match the entity shape.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/impersonation.ts` lines 5-19
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts` lines 148-207

Root cause: The frontend permission type was designed for a different entity schema version and was never updated.

Classification: `schema-gap`

Cross-domain: Route to `data-readback-auditor`.

---

### MEDIUM-010 — Frontend `TenantTier` enum defines `custom` but backend `TenantPlan` has `trial` instead; no `CUSTOM` in backend

The frontend `TenantTier` enum (`tenant.ts` lines 17-23):
```
FREE = 'free', STARTER = 'starter', PROFESSIONAL = 'professional', ENTERPRISE = 'enterprise', CUSTOM = 'custom'
```

The backend `TenantPlan` enum (`tenant.entity.ts` lines 20-26):
```
FREE = 'free', TRIAL = 'trial', STARTER = 'starter', PROFESSIONAL = 'professional', ENTERPRISE = 'enterprise'
```

The backend has `TRIAL` which the frontend does not define. The frontend has `CUSTOM` which the backend does not define. The `CreateTenantDto` validates `tier` with `@IsEnum(TenantPlan)`, so sending `'custom'` from the frontend will fail validation.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/tenant.ts` lines 17-23
- `/var/aqua-saas/apps/admin-api-service/src/tenant/entities/tenant.entity.ts` lines 20-26
- `/var/aqua-saas/apps/admin-api-service/src/tenant/dto/tenant.dto.ts` line 231 (`@IsEnum(TenantPlan)`)

Root cause: Two divergent enum definitions for the same domain concept (tenant pricing tier). The backend uses `TenantPlan` with a `TRIAL` state, while the frontend uses `TenantTier` with a `CUSTOM` state.

Classification: `enum-gap`

Cross-domain: Route to `form-write-auditor`. Route to `billing-reconciliation-auditor`.

---

### MEDIUM-011 — AquaMobil `FeedingInput` type does not match backend `RecordDailyFeedingInput` DTO

The AquaMobil `FeedingInput` type (`types/index.ts` lines 118-124):
```ts
{ executionId, actualKg, feedingMethod?, feederEquipmentId?, notes? }
```

The backend `RecordDailyFeedingInput` DTO (`record-daily-feeding.input.ts` lines 32-59):
```ts
{ executionId, actualKg, notes?, feederEquipmentId?, feedingMethod?: FeedingMethod (enum) }
```

The field set matches functionally, but `feedingMethod` is typed as `string | undefined` in the frontend and `FeedingMethod` enum in the backend. If the frontend sends a string value not matching the `FeedingMethod` enum (`MANUAL`, `AUTOMATIC`, etc.), the `@IsEnum(FeedingMethod)` validator will reject it. The frontend has no enum constraint.

Evidence:
- `/var/aqua-saas/web/apps/aquamobil/src/types/index.ts` lines 118-124
- `/var/aqua-saas/apps/farm-service/src/feeding/dto/record-daily-feeding.input.ts` lines 32-59

Root cause: AquaMobil types use loose string typing where the backend uses enum-validated fields.

Classification: `enum-gap`

Cross-domain: Route to `mobile-app-auditor`.

---

### LOW-012 — Frontend `ComplianceReport` shared type has different shape than CompliancePage inline type and backend entity

The shared `ComplianceReport` type (`security.ts` lines 47-55) uses:
- `type` (not `complianceType`)
- `status` with values `'compliant' | 'non_compliant' | 'partial' | 'pending_review'`
- `score` (not `overallScore`)
- `validUntil` (not in backend entity)

The CompliancePage inline `ComplianceReport` (lines 68-87) uses:
- `complianceType` (matches backend)
- `overallScore`, `totalChecks`, `passedChecks`, `failedChecks`, `warnings`
- `findings` array

The backend entity (`security.entity.ts` lines 692-779) uses:
- `complianceType`, `complianceScore`, `totalDataRequests`, `completedDataRequests`, etc.

None of the three shapes are aligned.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/security.ts` lines 47-55
- `/var/aqua-saas/web/modules/admin-panel/src/pages/security/CompliancePage.tsx` lines 68-87
- `/var/aqua-saas/apps/admin-api-service/src/security/entities/security.entity.ts` lines 692-779

Root cause: Three independent type definitions for compliance report data. The CompliancePage adapted to the real backend shape while the shared type remains stale.

Classification: `schema-gap`

Cross-domain: Route to `data-readback-auditor`.

---

### LOW-013 — Frontend ImpersonationSession type field `actionsPerformed: number` vs backend entity `actionCount: number` + `actionsPerformed: ImpersonationAction[]`

The frontend type has `actionsPerformed: number` (line 38, `impersonation.ts`) representing a count. The backend entity has both `actionCount: number` (line 129) for the count and `actionsPerformed: ImpersonationAction[]` (line 125) for the action log array. The frontend type shadows the array field with a number, so any attempt to display action history will fail.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/services/types/impersonation.ts` line 38
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts` lines 125-129

Classification: `schema-gap`

---

## Prior Finding Status

| Finding | Status | Notes |
|---------|--------|-------|
| 2026-04-11 HIGH-001 | OPEN | Re-verified as HIGH-001 above. No fix committed. |
| 2026-04-11 HIGH-002 | OPEN | Re-verified as HIGH-002 above. No fix committed. |
| 2026-04-11 HIGH-003 | OPEN | Re-verified as HIGH-003 above. No fix committed. |
| 2026-04-11 MEDIUM-004 | OPEN | Re-verified as MEDIUM-007 above. No fix committed. |

All four prior findings remain unresolved. The impersonation and AquaMobil leave contract boundaries have not been touched since the prior cycle.

## Escalation Note

The impersonation start path (HIGH-001) and AquaMobil leave path (HIGH-003) are repeated findings across two audit cycles. Per operating instructions, repeated drift in the same feature area indicates missing shared contract ownership and should be escalated. Recommend shared contract ownership assignment for:
1. Impersonation domain: admin-panel frontend types + admin-api-service DTOs
2. AquaMobil HR domain: AquaMobil types + hr-service DTOs
3. Tenant/Billing enums: admin-panel types + admin-api-service + billing-service enums
4. Compliance/Security types: admin-panel types + security entities

## Overall Assessment

The platform has 6 HIGH findings, 5 MEDIUM findings, and 2 LOW findings across the contract boundary. The highest-risk items are:
- **Impersonation** (HIGH-001, HIGH-002, HIGH-006, MEDIUM-009): The entire impersonation domain has field name drift, enum drift, and schema drift between frontend and backend. The session start path is non-functional.
- **AquaMobil leave** (HIGH-003): The mobile leave creation path omits required backend fields (`employeeId`, `totalDays`) and uses a different half-day model.
- **Enum divergence** (HIGH-004, HIGH-005, MEDIUM-008, MEDIUM-010): Tenant status, billing tier, impersonation status, and compliance request type/status enums diverge between frontend and backend with no shared contract.

No runtime test execution was performed for this audit.
