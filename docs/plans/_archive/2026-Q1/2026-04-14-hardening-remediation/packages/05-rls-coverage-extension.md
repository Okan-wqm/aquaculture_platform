# Package 05: rls-coverage-extension (merged 05a + 05b)

## Metadata
Status: DONE (commit TBD)
Estimated Tokens: 6K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: no (single atomic module registration sweep)
Prerequisites: none
Closing-Findings: [HIGH-004]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md (2026-04-14 gap scan #7)

## Context
The hardening report's initial claim — "no PostgreSQL RLS policies" — was **outdated**. Live repo state at 2026-04-14:

- Infrastructure COMPLETE: `applyTenantRlsToSchema`, `RlsConnectionBootstrap`, `BypassRlsService`, `TenantRlsSyncService`, and the one-line `RlsModule.forRoot({ serviceName, autoApply?, syncTenantSchemas? })` DI wiring.
- Coverage INCOMPLETE: only farm-service, billing-service, admin-api-service, hr-service, notification-service, config-service registered `RlsModule`. Seven other services were unprotected.

This package closes the coverage gap by registering `RlsModule` in every remaining backend service. `autoApply: true` for global-schema services (auth, alert, event-store) lets the helper install policies at `OnApplicationBootstrap`; `syncTenantSchemas: true` for schema-per-tenant services (sensor, messaging, hydroponics, ai, alert) iterates every `tenant_<uuid>` schema and installs the canonical policy (CREATE TABLE LIKE INCLUDING ALL does NOT copy RLS — sync is required).

Package 05a (session GUC wiring) and 05b (policy enable) merged into one commit since they're a single behavior change per service: importing `RlsModule`.

## Findings
**HIGH-004** (2026-04-14 gap scan #7): No PostgreSQL RLS policies; app-layer tenant isolation only.

Corrected by investigation: RLS infrastructure was already present; what remained was wiring it into every service that has tenant-scoped tables.

## Affected Files
- /var/aqua-saas/apps/auth-service/src/app.module.ts (autoApply)
- /var/aqua-saas/apps/sensor-service/src/app.module.ts (syncTenantSchemas)
- /var/aqua-saas/apps/messaging-service/src/app.module.ts (syncTenantSchemas)
- /var/aqua-saas/apps/hydroponics-service/src/app.module.ts (syncTenantSchemas)
- /var/aqua-saas/apps/alert-engine/src/app.module.ts (syncTenantSchemas)
- /var/aqua-saas/apps/event-store-service/src/app.module.ts (autoApply)
- /var/aqua-saas/apps/ai-service/src/app.module.ts (syncTenantSchemas)

## Atomic Commit Plan

```
security(db): extend tenant RLS coverage to 7 remaining services

RlsModule infrastructure already existed (applyTenantRlsToSchema helper
+ RlsConnectionBootstrap GUC injector + RlsSchemaBootstrap auto-installer
+ TenantRlsSyncService per-tenant schema sweeper). Coverage was
incomplete — only 6 services registered the module.

This commit registers RlsModule in the remaining services that handle
tenant-scoped data:

  Global-schema (autoApply installs policies on source schema):
    - auth-service      (User, Tenant, Invitation, ActionToken tables)
    - event-store-service (projection tables with tenant_id)

  Schema-per-tenant (syncTenantSchemas sweeps every tenant_<uuid> schema):
    - sensor-service    (sensor readings, device configs)
    - messaging-service (channels, messages with PII)
    - hydroponics-service
    - alert-engine
    - ai-service        (conversations, tool executions)

Each registration excludes the outbox / audit-log tables that are
intentionally cross-tenant. RlsConnectionBootstrap is installed in every
service regardless of whether policies are present, so the GUC propagation
path is uniform.

Runtime effect: a query issued in any of these services against a
tenant-scoped table will consult app.current_tenant (set from
AsyncLocalStorage by the request-context middleware). If the GUC is
unset (background jobs without withTenantContext wrapper), the policy's
NULLIF guard makes the predicate UNKNOWN and no rows are returned —
deny by default.

Closes: docs/security/2026-04-12-hardening-gap-report.md#HIGH-004
```

## Test Plan
- Each service boots cleanly with RlsModule registered (existing tests cover this path)
- applyTenantRlsToSchema is idempotent — repeated bootstraps install the same canonical policy

## Verification Command
Per-service build + startup smoke test

## Rollback Plan
`git revert {commit_hash} --no-edit`
Removes the RlsModule registrations. Pool GUCs stop being injected; services fall back to app-layer tenant checks. No data corruption, just weaker isolation.

## Failure Notes
_(empty)_
