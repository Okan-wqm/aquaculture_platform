# Contract Parity Auditor: `2026-04-11-full-platform-e2e`

Scope: semantic alignment across frontend field models, payload builders, DTOs, validators, commands, entities, serializers, and read models across web and AquaMobil surfaces.

## Findings

### HIGH-001 - Impersonation session start is built against the old field model, so the backend contract rejects or misreads the request
The admin panel start form collects `tenantId`, `impersonatedUserId`, and a free-text `reason`, then posts those client field names through `impersonationApi.startSession()` without mapping them to the backend contract. The controller validates `targetTenantId` and enum `reason`, and it ignores any client-supplied admin identity because `superAdminId` is always taken from the JWT context.

Evidence:
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L94`](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L94)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L200`](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L200)
- [`/var/aqua-saas/web/modules/admin-panel/src/services/api/impersonation.ts#L50`](/var/aqua-saas/web/modules/admin-panel/src/services/api/impersonation.ts#L50)
- [`/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts#L109`](/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts#L109)
- [`/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts#L252`](/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts#L252)

Root cause:
- The frontend preserved a legacy `tenantId/adminId/reason:string` model, but the backend moved to a JWT-backed `superAdminId` plus `targetTenantId/targetUserId/reason: ImpersonationReason` contract.
- Because the UI never maps to `targetTenantId` and still sends free text for an enum field, the create path cannot preserve the intended meaning.

Classification: `write-gap`

Cross-domain dependency:
- Route to `form-write-auditor` for the broken write path.
- Route to `access-boundary-auditor` for the privileged impersonation boundary.
- Route to `workflow-state-auditor` for the session-start transition semantics.

### HIGH-002 - Grant-permission exposes `allowedActions` in the UI, but that field is dropped before persistence
The permission modal lets operators toggle `allowedActions`, but `handleGrantPermission()` never sends that state to the API. The API contract does not define `allowedActions` at all, and the persistence model only stores `allowedTenants`, `restrictedTenants`, `defaultPermissions`, and session-limit flags. As a result, the user can configure action scope in the UI without any backend representation of that choice.

Evidence:
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L101`](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L101)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L253`](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L253)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L1047`](/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx#L1047)
- [`/var/aqua-saas/web/modules/admin-panel/src/services/api/impersonation.ts#L20`](/var/aqua-saas/web/modules/admin-panel/src/services/api/impersonation.ts#L20)
- [`/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts#L52`](/var/aqua-saas/apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts#L52)
- [`/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts#L148`](/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts#L148)

Root cause:
- The UI still carries a legacy action-scope control, but the backend schema has no matching field and the request builder never translates it into `defaultPermissions` or another persisted structure.
- That makes the setting look authoritative while the persisted permission model never changes.

Classification: `access-gap`

Cross-domain dependency:
- Route to `access-boundary-auditor` because the defect changes privileged access meaning.
- Route to `tenant-isolation-auditor` because the permission surface is tenant-scoped.

### HIGH-003 - AquaMobil leave creation queues an input shape that cannot satisfy the HR GraphQL contract
`LeaveRequestPage` queues `createLeaveRequest` with only `leaveTypeId`, `startDate`, `endDate`, `isHalfDay`, and `reason`. The AquaMobil queue type mirrors that reduced model, but the HR GraphQL input and command require `employeeId`, `totalDays`, `isHalfDayStart`, `isHalfDayEnd`, and optional `halfDayPeriod/contactDuringLeave`. The mobile form therefore cannot preserve the same business meaning as the backend create contract.

Evidence:
- [`/var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L74`](/var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L74)
- [`/var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L81`](/var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx#L81)
- [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx#L95`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx#L95)
- [`/var/aqua-saas/web/apps/aquamobil/src/types/index.ts#L218`](/var/aqua-saas/web/apps/aquamobil/src/types/index.ts#L218)
- [`/var/aqua-saas/apps/hr-service/src/leave/dto/create-leave-request.input.ts#L16`](/var/aqua-saas/apps/hr-service/src/leave/dto/create-leave-request.input.ts#L16)
- [`/var/aqua-saas/apps/hr-service/src/leave/leave.resolver.ts#L246`](/var/aqua-saas/apps/hr-service/src/leave/leave.resolver.ts#L246)
- [`/var/aqua-saas/apps/hr-service/src/leave/commands/create-leave-request.command.ts#L3`](/var/aqua-saas/apps/hr-service/src/leave/commands/create-leave-request.command.ts#L3)

Root cause:
- AquaMobil keeps a reduced client-side leave model that omits required backend semantics such as employee ownership and exact day accounting.
- The offline queue then serializes that reduced model unchanged, so the eventual GraphQL mutation cannot carry the information the resolver and command require.

Classification: `write-gap`

Cross-domain dependency:
- Route to `mobile-app-auditor` for the mobile write path.
- Route to `form-write-auditor` for the persistence contract.
- Route to `workflow-state-auditor` because leave submission is lifecycle-gated.

### MEDIUM-004 - Analytics shared frontend types drift from the backend read model, so consumers rely on casts and shape guessing
The analytics package defines a flat `DashboardSummary` and array-based trend types, but the backend dashboard summary is nested and the revenue trend endpoint returns a wrapper object with `period`, `data`, and `summary`. `AnalyticsDashboardPage` compensates with `Partial<DashboardSummary>` casts and runtime shape branching instead of a single shared contract, which hides the mismatch rather than resolving it.

Evidence:
- [`/var/aqua-saas/web/modules/admin-panel/src/services/types/analytics.ts#L5`](/var/aqua-saas/web/modules/admin-panel/src/services/types/analytics.ts#L5)
- [`/var/aqua-saas/web/modules/admin-panel/src/services/api/analytics.ts#L21`](/var/aqua-saas/web/modules/admin-panel/src/services/api/analytics.ts#L21)
- [`/var/aqua-saas/web/modules/admin-panel/src/services/api/analytics.ts#L28`](/var/aqua-saas/web/modules/admin-panel/src/services/api/analytics.ts#L28)
- [`/var/aqua-saas/apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts#L130`](/var/aqua-saas/apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts#L130)
- [`/var/aqua-saas/apps/admin-api-service/src/analytics/controllers/analytics.controller.ts#L100`](/var/aqua-saas/apps/admin-api-service/src/analytics/controllers/analytics.controller.ts#L100)
- [`/var/aqua-saas/apps/admin-api-service/src/analytics/services/analytics.service.ts#L1179`](/var/aqua-saas/apps/admin-api-service/src/analytics/services/analytics.service.ts#L1179)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx#L407`](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx#L407)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx#L433`](/var/aqua-saas/web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx#L433)

Root cause:
- There are two competing frontend contract models for the same analytics endpoints: the shared API types are stale, while the page-local model has already been adapted to the real backend shape.
- The system currently works by defensive casting and shape guessing, which makes the contract fragile for any other consumer of `analyticsApi`.

Classification: `schema-gap`

Cross-domain dependency:
- Route to `data-readback-auditor` because the issue affects read-model fidelity.
- Route to `chart-widget-auditor` because the affected surface feeds dashboard charts and KPIs.

## Overall Assessment

The platform is not yet semantically aligned end to end. The highest-risk breaks are the impersonation start path and the AquaMobil leave-create path, because both lose meaning at the payload boundary before persistence can occur. The analytics drift is lower severity, but it is a clear shared-contract problem that will keep producing downstream mismatches until the frontend types are normalized to the backend read model.

No runtime test execution was performed for this audit.
