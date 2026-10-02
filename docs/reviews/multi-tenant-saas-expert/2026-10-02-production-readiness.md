# Tenant isolation and SaaS enforcement — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `multi-tenant-saas-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | schema-per-tenant routing, RLS, provisioning, quotas, background jobs, NATS/Redis/MinIO |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

The reviewer found no path that leaks one tenant's data to another. The blocker is different: many
background jobs bind the tenant schema but never set the tenant RLS variable
(`app.current_tenant`), so they read zero rows and silently do nothing.

## Blockers

- **B1. Per-tenant cron jobs see zero rows.**
  - Tenant schemas get FORCE RLS at provisioning (`apps/db-migrate/src/schema-registry.ts:152`).
    Outside a request the pool sets the tenant variable to ''
    (`rls-connection-bootstrap.service.ts:252-269`), so RLS returns nothing.
  - Affected: Feeding V2 tenant discovery (`feeding-cron-v2.service.ts:1399-1416`, `:1348-1361`);
    maintenance jobs (`cron-jobs.service.ts:267-274`, `:329-343`); HR leave accrual
    (`leave-accrual.service.ts:112-118`); the messaging GDPR retention sweep
    (`retention-policy.service.ts:81-92`); also tasks, recurring tasks, auto-rules, the report
    scheduler, and the HR and sensor crons.
  - Root cause: `forEachTenantSchema` sets only the search path (`for-each-tenant-schema.ts:211`).
    The gate `tests/invariants/non-http-entrypoint-tenant-context.spec.ts:77` accepts
    `listTenantSchemas` and `forEachTenantSchema` as "tenant-bound", so CI passes. The sensor
    topic-cache fix (SENSOR-HIGH-119) confirmed this blinding live in production.

## Major

- **M2. Sensor and messaging lack permission on the tenant-listing function.** EXECUTE is granted
  only to `farm_service` (`009-tenant-schema-provisioner.sql:630-631`).
  `sensor-topic-cache.service.ts:271` (MQTT topic resolution), `vfd-telemetry-poller` and
  `knowledge-extraction` will get "permission denied" under the production roles
  (`docker-compose.droplet.yml:1033,1776`). The test hides this by granting it by hand
  (`sensor-topic-cache.rls.postgres.spec.ts:110`). This is PLAT-MEDIUM-920; the reviewer would
  rate it higher.
- **M3. Plan quotas are only partly enforced.**
  - Farm, pond and sensor counts are checked (`create-site.handler.ts:58-62`), but the count can
    race under READ COMMITTED.
  - Every tenant gets the same 1000/min (`rate-limit.config.ts:42`), and limits are keyed per user
    or IP, not per tenant (`rate-limit.guard.ts:316`). There is no tenant-wide noisy-neighbour
    cap.
  - The per-plan API rate limit (`tenant-context.interceptor.ts:301`) and `maxStorageGb` are never
    enforced.

## Minor

- NATS consumers do not re-check the subject's tenant against the payload's; this is checked only
  on publish (`nats-event-bus.ts:928` vs `:1428-1462`).
- Cross-tenant MFA accepts the login-time claim instead of a fresh step-up
  (`effective-tenant.middleware.ts:225`).
- `TenantRedisService` has 0 call sites; Redis keys are built by hand.
- The tenant-swap attack E2E has no CI runner (Playwright runs only `tests/security`).

## Registry items checked

| ID | Status | Evidence |
| --- | ------ | -------- |
| INFRA-CRITICAL-029 | STALE as a blocker | admin-api read-view entities are skipped by the drift check (`schema-drift-validator.service.ts:173`, from INFRA-CRITICAL-032); hr was rebaselined and has a regression harness (`critical-infra-ssot.spec.ts:307`). Left over: 18 admin-api read-view entities on other services' schemas that nothing checks for drift, e.g. `analytics/entities/external/invoice.entity.ts:25` |
| MT-HIGH-054 | STALE | Capability checks exist at `channel.resolver.ts:188` and `agent-config.resolver.ts:153,167` |
| MT-HIGH-062 | CONFIRMED | Tenant binding is by convention (`get-farm-tanks.tool.ts:59-60`); the tenant ID is the verified one, so not exploitable today |
| MT-MEDIUM-063 | CONFIRMED | 0 uses of `assignedSiteIds` in ai-service |
| MT-HIGH-064 | CONFIRMED, dormant | `mcp-client.service.ts:81` (`MCP_ENABLED` defaults to false), `:120` (one shared token) |
| MT-MEDIUM-065 | CONFIRMED | Product decision still pending |
| Old IDs MT-CRITICAL-001/002, MT-HIGH-001/003 | STALE | `TenantScopedRepository` is complete with about 256 call sites; AI rate limit fails closed in production (`rate-limit.service.ts:34`) and budget is reserved before the call (`agent-runner.service.ts:400`); RLS bootstrap is registered in all 15 services |

## Verified sound

- Search path is reset on every connection checkout, with DB triggers blocking writes to the
  template schemas.
- App roles are NOBYPASSRLS and every pool sets the RLS variables. No pgbouncer in the stack.
- Provisioning is a leased job that drops a schema it created if it fails
  (`tenant-schema-provisioner.ts:1093-1106`).
- Erasure covers 12 services. MinIO and messaging media paths are tenant-prefixed.

## Not verified

- The live database (actual grants, RLS and drift) or real cron behaviour; B1 rests on code
  reading plus SENSOR-HIGH-119. NATS per-certificate ACLs. Full Redis key coverage.

## Registry entries

This review appended 3 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| MT-CRITICAL-071 | CRITICAL | Per-tenant cron jobs read zero rows: tenant schemas get FORCE RLS but forEachTenantSchema sets only search\_path and outside a request the RLS tenant variable is empty, while the non-http-entrypoint-tenant-context gate accepts it as tenant-bound, so feeding V2, maintenance, HR leave accrual, the messaging GDPR retention sweep and other crons silently do nothing |
| MT-HIGH-072 | HIGH | No tenant-wide noisy-neighbour or plan enforcement: every tenant gets the same 1000/min, limits key on user or IP not tenant, the per-plan API rate limit and maxStorageGb are never enforced, and farm/pond/sensor count quotas can race under READ COMMITTED |
| MT-MEDIUM-073 | MEDIUM | NATS consumers do not re-check the subject tenant against the payload tenant; the check exists only on publish |
