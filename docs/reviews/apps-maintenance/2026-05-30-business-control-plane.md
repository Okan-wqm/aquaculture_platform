# Business And Control-Plane Apps Review

**Date:** 2026-05-30  
**Scope:** `apps/billing-service`, `apps/hr-service`, `apps/admin-api-service`, `apps/gateway-api`  
**Mode:** Read-only architecture review synthesized from the business/control-plane agent.

## Purpose

Validate that financial state, HR state, platform admin operations, and gateway/subgraph exposure follow enterprise ownership boundaries, authorization policy, idempotency, and tenant safety.

## Findings

### CONTROL-CRITICAL-001: Admin API violates billing/auth SSOT

`admin-api-service` declares ownership of `admin` and read-only posture for other schemas, but it directly inserts/updates `billing.*` and `auth.tenants`.

Evidence:

- `apps/admin-api-service/src/app.module.ts:96`
- `apps/admin-api-service/src/billing/billing.controller.ts:313`
- `apps/admin-api-service/src/billing/services/subscription-core.service.ts:496`
- `apps/admin-api-service/src/billing/services/subscription-core.service.ts:579`
- `apps/admin-api-service/src/billing/services/subscription-plan-change.service.ts:95`
- `apps/admin-api-service/src/billing/services/subscription-renewal.service.ts:243`

Enterprise remediation:

- Admin may orchestrate, but billing and auth must remain the only writers for their schemas.
- Move mutations behind typed billing/auth commands with audit, idempotency, and authorization context.
- Enforce admin cross-schema DB access as read-only at the credential/grant level.

### CONTROL-HIGH-001: Billing admin NATS handler bypasses billing CQRS boundary

The billing admin handler says admin writes must go through CQRS, but cancel/reactivate/extend trial execute raw SQL updates.

Evidence:

- `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:66`
- `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:203`
- `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:246`
- `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:283`

Enterprise remediation:

- Implement owner-side command handlers for admin billing operations.
- Commands must perform validation, transaction handling, audit/event emission, and optimistic locking.
- Add tests proving raw handler paths cannot bypass the domain command policy.

### CONTROL-HIGH-002: HR performance APIs have broad tenant-level IDOR risk

Several performance review, goal, KPI, and mutation operations accept arbitrary IDs without resolver-level `RolesGuard` or self/team ownership checks.

Evidence:

- `apps/hr-service/src/performance/performance.resolver.ts:116`
- `apps/hr-service/src/performance/performance.resolver.ts:137`
- `apps/hr-service/src/performance/performance.resolver.ts:178`
- `apps/hr-service/src/performance/performance.resolver.ts:224`
- `apps/hr-service/src/performance/performance.resolver.ts:359`

Enterprise remediation:

- Define HR access matrix: self, manager/team, HR admin, platform admin.
- Enforce at resolver and handler/service levels.
- Add negative tests for cross-employee and cross-team access.

### CONTROL-HIGH-003: HR employee mutation is over-permissive

`toggleFarmWorker` lets `MODULE_USER` update another employee's farm-worker status.

Evidence:

- `apps/hr-service/src/hr/hr.resolver.ts:161`

Enterprise remediation:

- Restrict to manager/admin or a dedicated HR permission.
- Validate target employee scope and tenant membership.

### CONTROL-MEDIUM-001: HR absence/attendance visibility needs tightening

`teamLeaveCalendar` has no roles guard, and `dailyAttendanceOverview` allows `MODULE_USER`.

Evidence:

- `apps/hr-service/src/leave/leave.resolver.ts:259`
- `apps/hr-service/src/attendance/attendance.resolver.ts:289`

Enterprise remediation:

- Decide privacy policy for team absence and attendance aggregates.
- Enforce the policy via roles and ownership checks.

### CONTROL-MEDIUM-002: Plan catalog and role taxonomy are drifting

Admin has `admin.plan_definitions`, billing has `billing.plans`, and billing uses local roles such as `BILLING_ADMIN`/`FINANCE_MANAGER` while gateway/admin mostly use platform roles.

Evidence:

- `apps/admin-api-service/src/billing/entities/plan-definition.entity.ts:117`
- `apps/billing-service/src/billing/entities/plan.entity.ts:26`
- `apps/billing-service/src/billing/billing.resolver.ts:40`
- `apps/gateway-api/src/guards/tenant-isolation.guard.ts:96`

Enterprise remediation:

- Define one plan catalog SSOT and one permission taxonomy.
- If admin needs plan projections, make them read models with owner-driven sync.
- Add role parity tests across gateway, admin, billing, and HR.

### CONTROL-MEDIUM-003: Renewal/payment financial correctness risks

Admin renewal processing selects due subscriptions and inserts invoices without visible row locks or idempotency keys. Billing exposes money as GraphQL `Float` and uses `number` rounding in metered billing.

Evidence:

- `apps/admin-api-service/src/billing/billing.controller.ts:414`
- `apps/admin-api-service/src/billing/services/subscription-renewal.service.ts:216`
- `apps/billing-service/src/billing/entities/plan.entity.ts:45`
- `apps/billing-service/src/modules/metering/metered-billing.service.ts:1286`

Enterprise remediation:

- Move renewals into billing-owned scheduled commands.
- Use row locks/idempotency keys for due-subscription claims.
- Use decimal-safe API/schema representation for financial values.

### CONTROL-MEDIUM-004: Admin exposure controls are uneven

Global admin throttling is removed, RLS bypass wraps every admin request, and several mutating billing/admin endpoints lack per-route throttle/idempotency.

Evidence:

- `apps/admin-api-service/src/app.module.ts:290`
- `apps/admin-api-service/src/app.module.ts:299`
- `apps/admin-api-service/src/billing/billing.controller.ts:470`
- `apps/admin-api-service/src/billing/billing.controller.ts:599`
- `apps/admin-api-service/src/billing/billing.controller.ts:725`

Enterprise remediation:

- Add explicit throttles and idempotency to mutating admin operations.
- Scope RLS bypass to audited, justified operations rather than every request when possible.
- Add audit evidence for super-admin sensitive actions.

### CONTROL-MEDIUM-005: Subgraph schema exposure depends on network controls

`ServiceIdentityGuard` allows introspection and `_service { sdl }` without service identity headers. This is safe only if direct subgraph reachability is blocked or composition uses a separate trusted path.

Evidence:

- `libs/backend-common/src/guards/service-identity.guard.ts:83`
- `libs/backend-common/src/guards/service-identity.guard.ts:179`

Enterprise remediation:

- Document and enforce subgraph network policy.
- If subgraphs are reachable outside the trusted router/composer path, require service identity or signed composition access.

## Recommended Fix Order

1. Remove admin direct writes to `billing.*` and `auth.tenants`; delegate to owner-service commands.
2. Fix HR authorization and ownership checks.
3. Harden billing correctness: CQRS commands, renewal idempotency, decimal money.
4. Normalize role/permission taxonomy.
5. Review admin/gateway exposure: throttles, idempotency, RLS bypass, subgraph reachability.
6. Resolve runtime/deploy risks such as HR schema-sync versus migration-runner ownership.
