# messaging-service E2E TENANT_ISOLATION_VIOLATION — Root-Cause Investigation

**Date:** 2026-04-14
**Severity:** CRITICAL
**Finding ID:** CRITICAL-MSG-001
**Status:** RE-OPENED — middleware fix (f4df00cb) was defense-in-depth but does NOT address actual root cause
**Owner:** messaging-expert (next session) — DEADLINE 2026-04-21
**Real root cause identified 2026-04-14T12:18Z:** Entity-Table schema drift
**Surfaced by:** 2026-04-14 hardening plan V2 audit
**Pre-existing:** YES — fail mode predates the 2026-04-14 hardening work

## Symptom

Every messaging-service e2e suite fails with the same database error pattern:

```
QueryFailedError: TENANT_ISOLATION_VIOLATION: Direct write to source schema
messaging.channels blocked. Use tenant schema instead.
```

Affected suites (12 of 12 messaging-service e2e specs):
- channel-management, offline-sync, compliance, messaging-features,
  messaging-core, content-sanitization, tenant-isolation, media-upload,
  ai-chat, gdpr, rate-limiting, presence

## What's known

- The `TENANT_ISOLATION_VIOLATION` is raised by the database trigger installed
  by `SourceSchemaWriteGuardService` (libs/backend-common/src/database/source-schema-write-guard.ts:124-127).
- The trigger fires when a write hits `messaging.<table>` instead of
  `tenant_<uuid>.<table>` — a search_path resolution issue.
- Test setup (`apps/messaging-service/test/e2e-setup.ts`) creates tenant
  schemas via `setupTenantSchemas` and clones tables with `CREATE TABLE LIKE
  INCLUDING ALL` (line 270). PostgreSQL spec confirms LIKE INCLUDING ALL does
  NOT propagate triggers, so tenant-schema writes do NOT trigger the guard.
- `TenantConnectionBootstrap` (libs/backend-common/src/database/tenant-connection-bootstrap.service.ts)
  patches the pg pool to `SET search_path TO "<tenant_schema>", "messaging", public`
  on every checkout when `getRequestContext()` returns a context with
  `schemaName` set.
- `TenantSchemaMiddleware` (libs/backend-common/src/middleware/tenant-schema.middleware.ts)
  is registered in messaging app.module and runs on `*` routes.
- The same e2e suite was failing on commits BEFORE the 2026-04-14 hardening
  with a different error: `Migration AddMissingOutboxColumns1782200000000
  failed, error: functions in index predicate must be marked IMMUTABLE` (run
  24366023132). That error has either been worked around or no longer
  reproduces; the current TENANT_ISOLATION error is what surfaces today.

## Suspects (ordered by likelihood)

1. **AsyncLocalStorage context not propagating to the resolver async chain.**
   The middleware sets `ctx.schemaName` but if the GraphQL resolver runs in
   an async context that exited the `requestContextStorage.run()` callback,
   `getRequestContext()` returns `{}` (line 58 of request-context.ts) and
   `TenantConnectionBootstrap` falls into the no-tenant branch
   (tenant-connection-bootstrap.service.ts:122-137) which sets `search_path
   TO "messaging", public` — exactly the failure mode.

2. **Pool checkout interceptor chain interaction.** `RlsModule.forRoot` (added
   in 995fad0a as part of P05) registers `RlsConnectionBootstrap` which also
   patches `pool.connect`. Both bootstraps wrap the pool and chain via
   `originalConnect`. Doc claim: "either order works". Verify by tracing
   actual checkout in the messaging-service test — does search_path get
   set, or does only the RLS GUC SQL run?

3. **Test setup race condition.** `setupTenantSchemas` is called AFTER
   `createE2eTestApp()`. Between `app.init()` and the first test request,
   `SourceSchemaWriteGuardService.OnApplicationBootstrap` installs the
   trigger on `messaging.<table>`. If `setupTenantSchemas` has any latency
   in cloning tables to tenant schemas, AND a request fires before tables
   exist in tenant schema, search_path falls through to `messaging`.

4. **GraphQL middleware bypass.** Apollo Server's middleware integration may
   bypass NestJS's Express middleware chain for the `/graphql` endpoint in
   the test environment, meaning `TenantSchemaMiddleware` never runs.

## REAL ROOT CAUSE (2026-04-14T12:18Z log analysis)

`SchemaDriftValidator[messaging]` reports **15 violations** at app boot:

```
[channel_members] entity declares schema='public' but table lives in 'messaging'
[channels]        entity declares schema='public' but table lives in 'messaging'
[messages]        entity declares schema='public' but table lives in 'messaging'
[compliance_audit_log] entity declares schema='public' but table lives in 'messaging'
... (15 total tables)
```

Plus a `column "channel_lastmessageat" does not exist` error from TypeORM
queries — confirming the entity ↔ table mismatch causes query generation
to use stale/wrong identifiers.

**Mechanism:** Every `@Entity('channels')` in apps/messaging-service is
decorated WITHOUT a `schema:` option. ADR-011 (per CLAUDE.md "Schema
Ownership ZORUNLU") requires `@Entity('channels', { schema: 'messaging' })`.
TypeORM's metadata loader then introspects against `search_path =
messaging,public`, finds the table in `messaging`, and either:
  (a) caches that schema on the entity metadata at boot, OR
  (b) generates unqualified SQL relying on search_path at query time.

In either case, when the per-request middleware sets `search_path` to
`tenant_<uuid>, messaging, public`, TypeORM either:
  (a) uses its cached `messaging` qualifier (silently ignores tenant), OR
  (b) generates unqualified `INSERT INTO channels` — but the tenant
      table clone is missing some columns because `setupTenantSchemas`
      uses `CREATE TABLE LIKE INCLUDING ALL` from the source schema
      tables that TypeORM sync'd with WRONG column names (snake_case vs
      camelCase) — so search_path resolution finds the tenant table but
      the column doesn't exist there either, and TypeORM falls back to
      `messaging.channels` write attempt which the trigger blocks.

The `column "channel_lastmessageat" does not exist` error is the smoking
gun: TypeORM is generating snake_case column names for an alias join
pattern (`channel.lastMessageAt → channel_lastMessageAt → snake-case
to channel_lastmessageat`). The actual column in PG is `lastMessageAt`
(quoted camelCase from the migration). This is a **naming strategy
drift** on top of the schema drift.

## What this finding requires next session

1. **Reproduce locally.** Spin up `docker compose -f docker-compose.dev.yml
   up postgres redis nats`, then `nx test messaging-service-e2e --testFile=
   channel-management.e2e-spec.ts`. Capture full stderr.

2. **Add diagnostic logging.** Insert `console.log` in:
   - `TenantSchemaMiddleware.use()` after setting `ctx.schemaName` — confirm
     `getStore()` returns the SAME object the resolver later sees.
   - `TenantConnectionBootstrap.patchConnectionPool` callback — log
     `getRequestContext()` value at every pool checkout during a test request.
   - `RlsConnectionBootstrap.patchConnectionPool` callback — same.

3. **Confirm or refute suspect 1.** If `getRequestContext()` returns `{}`
   inside the resolver, ALS context is not propagating. Fix point: change
   how Apollo resolvers integrate with the request-scoped context.

4. **Confirm or refute suspect 2.** Temporarily remove the messaging
   `RlsModule.forRoot` registration and re-run e2e. If TENANT_ISOLATION
   disappears, the chaining is the root cause; fix RlsConnectionBootstrap.

5. **Confirm or refute suspect 3.** Add `await sleep(500)` between
   `setupTenantSchemas` and the first test query. If it passes, race
   condition; fix `setupTenantSchemas` to AWAIT all DDL completion.

6. **Architectural fix once root cause known.** No patches; close the
   identified mechanism at its source.

## Why this finding is open instead of fixed

This session's audit (2026-04-14 V-series) closes 7 architectural debts
across the 14-package hardening plan. V2 (this finding) requires:
- Local docker postgres+redis+nats stack to reproduce the test failure
- Iterative debugging with diagnostic instrumentation to identify which
  of the 4 suspects is the actual mechanism

Both are runtime tasks that exceed the current session's verification
capability. Per CLAUDE.md "ZAMAN MAZERET DEĞİLDİR" — opening this as a
TRACKED finding with explicit owner, deadline, and finding ID is the
ONLY allowed deferral pattern. NOT shipping a guess that "might fix it".

## Related files (read these first next session)

- libs/backend-common/src/database/source-schema-write-guard.ts (trigger)
- libs/backend-common/src/database/tenant-connection-bootstrap.service.ts (search_path)
- libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts (RLS GUC)
- libs/backend-common/src/middleware/tenant-schema.middleware.ts (sets schemaName)
- libs/backend-common/src/logging/request-context.ts (AsyncLocalStorage)
- apps/messaging-service/src/app.module.ts (middleware registration)
- apps/messaging-service/test/e2e-setup.ts (test bootstrap)
- apps/messaging-service/test/channel-management.e2e-spec.ts (failing test)

## Closing-Findings

When fixed, the closing commit MUST reference:
```
Closes: docs/reviews/messaging-expert/2026-04-14-tenant-isolation-violation-e2e.md#CRITICAL-MSG-001
```
