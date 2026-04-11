# Multi-Tenant SaaS Expert Review

**Date:** 2026-04-10  
**Scope:** Full-repo static audit for tenant isolation, tenant lifecycle, plan gating, quotas, impersonation, data portability, and cross-tenant access control.

## Deployment Decision
**BLOCK**

## Findings

### HIGH-001: Tenant provisioning marks a tenant ACTIVE before provisioning completes
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:162-179` updates `auth.tenants.status` to `ACTIVE` before schema creation, role setup, and admin creation run.
- `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts:126-203` publishes `TenantCreatedEvent`, then logs provisioning failures without reverting the tenant status or retrying the activation step.
- Impact: a partially provisioned tenant can become visible as active even when schema/bootstrap failed, which breaks tenant lifecycle integrity and can expose consumers to incomplete or inconsistent tenant state.
- Remediation: keep the tenant in `PENDING` until the full saga succeeds, or make the status transition part of the same transactional boundary with an explicit rollback to `PENDING` on any saga failure.

### HIGH-002: AI quota enforcement fails open when Redis is unavailable
- `apps/ai-service/src/app.module.ts:196-205` wires Redis as a runtime dependency for distributed quota state, but the service still boots with a localhost default instead of failing fast.
- `apps/ai-service/src/cost/rate-limit.service.ts:28-37, 82-90, 131-171` falls back to an in-memory counter and explicitly warns that multi-instance deployments multiply the configured limit.
- `apps/ai-service/src/cost/token-budget.service.ts:25-35, 96-160` uses the same in-memory fallback for monthly tenant budgets and loses counters on restart.
- Impact: tenant request limits and token budgets are no longer authoritative in production if Redis is absent or partitioned, so one tenant can exceed plan limits by scaling the service or by surviving restarts.
- Remediation: fail closed in production when Redis is unreachable, or move quota state to a shared store with explicit startup health checks and no local fallback.

### MEDIUM-003: Most plan limits are advisory only; only user count is actually enforced
- `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:149-196` exposes `maxFarms`, `maxPonds`, `maxSensors`, `maxAlertRules`, `apiRateLimit`, and `storageGb`, but `canAddFarms()` and `canAddSensors()` always return `true`, and the getter hardcodes several limits to `-1`.
- `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:252-260` enforces only `maxUsers`; there is no matching enforcement for farm, sensor, storage, or API request limits in the tenant creation path.
- `apps/admin-api-service/src/tenant/services/tenant-detail.service.ts:204-267` only reports usage percentages and does not compensate for the hardcoded unlimited values in the tenant entity.
- Impact: plan metadata and usage dashboards advertise limits that are not actually enforced, so tenants can overrun non-user quotas without a hard block.
- Remediation: move quota checks into a shared enforcement service and invoke them on every resource-creation path that changes farm, sensor, storage, or API usage.

## Cross-Domain Dependencies
- Tenant activation depends on the `auth` schema, provisioning saga, and downstream event consumers; the lifecycle bug can cascade into billing and module-assignment flows.
- Quota enforcement depends on shared infra state (`Redis`) and should be treated as a production hard dependency, not a best-effort cache.
- Plan-limit enforcement should be shared across admin, auth, farm, sensor, and AI services so the limit model is not split between dashboards and actual runtime checks.

## Verification
- Static review only. No tests were run.
