# Phase 2 — Database Hardening Rollout Guide

**Status:** Ready for staging deploy
**Branch:** `feat/rls-foundation-phase1`
**Scope:** 10 commits, 10 TypeORM migrations, 7 new libs/backend-common modules, 37 unit tests
**Owner:** Platform team
**Created:** 2026-04-07

---

## 1 — What ships in this release

This is a coordinated database-layer hardening release. It closes all
actionable CRITICAL and HIGH findings from the `database-design:postgresql`
audit, introduces tenant Row-Level Security as a defense-in-depth layer
for global-schema services, and forward-fixes a latent cast-error bug in
the existing farm-service RLS policy.

### Commit inventory

| Commit    | Topic                                                       |
| --------- | ----------------------------------------------------------- |
| `4a597b2d` | Phase 1 — tenant RLS foundation for global-schema services |
| `6e419f3d` | C-1 auth-service — `TIMESTAMP` → `TIMESTAMPTZ` (25 cols) |
| `669b3cbb` | Farm RLS migration registration fix (class-ref wiring) |
| `3f2c3612` | C-2 — `BIGSERIAL` → `IDENTITY` (farm + messaging outbox) |
| `67fbcdad` | H-5 — `LOWER(email)` case-insensitive uniqueness |
| `59fed675` | H-3 — sensor `protocol_configuration->'topic'` B-tree expr index |
| `e6dacca4` | Phase 2b admin-api — `TIMESTAMP` → `TIMESTAMPTZ` (48 cols) |
| `72457f85` | H-4 composite FK indexes + H-6 `users.accessType` CHECK |
| `069b9e78` | M-5 `(tenant_id) WHERE is_deleted = false` partial indexes |
| `efddd723` | Phase 2 regression tests (37 unit tests, 100% pass) |

### Services touched

| Service              | Runtime changes | Migrations run | Risk |
| -------------------- | --------------- | -------------- | ---- |
| **farm-service**     | RLS pool patch active | 3 new | HIGH — RLS becomes enforced |
| **auth-service**     | None            | 3 new | MEDIUM — TIMESTAMPTZ ALTERs block briefly, email pre-check may abort |
| **admin-api-service**| RLS pool patch, bypass interceptor, migration runner FIRST time | 1 new | HIGH — first migration runner ever |
| **sensor-service**   | None            | 1 new | LOW — index addition, idempotent |
| **messaging-service**| None            | 2 new | MEDIUM — iterates tenant schemas |
| **billing-service**  | RLS pool patch + startup policy install | 0 (autoApply via RlsSchemaBootstrap) | HIGH — RLS becomes enforced |
| **notification-service** | same | 0 (autoApply) | HIGH |
| **config-service**   | same | 0 (autoApply) | HIGH |

Services NOT touched by this release:
`ai-service`, `alert-engine`, `hr-service`, `hydroponics-service`,
`event-store-service`, `gateway-api`, `observability-service`.

---

## 2 — Pre-deploy checks (MANDATORY)

Run these against the target database BEFORE kicking off the deploy.
Any failure aborts the rollout and requires manual resolution.

### 2.1 — auth schema: case-insensitive email duplicates

```sql
SELECT LOWER(email) AS lowered, COUNT(*) AS count
FROM auth.users
GROUP BY LOWER(email)
HAVING COUNT(*) > 1
ORDER BY count DESC, lowered;
```

**Expected:** zero rows.

If any rows returned, `EnforceCaseInsensitiveEmailUniqueness1781300000000`
will abort the auth-service deploy with an actionable error listing the
affected addresses. Resolution is **domain-aware** — operators must decide
which of each duplicate pair to keep and which to retire. Do NOT delete
blindly: check `refresh_tokens`, `invitations`, `audit_logs` references
for each candidate before removal.

### 2.2 — auth schema: invalid accessType values

```sql
SELECT id, "accessType"
FROM auth.users
WHERE "accessType" IS NOT NULL
  AND "accessType" NOT IN ('PANEL_ONLY', 'MOBILE_ONLY', 'BOTH');
```

**Expected:** zero rows.

If any rows returned, `AddUsersAccessTypeCheck1781700000000` will abort
with the top-10 offending ids. Resolution: `UPDATE auth.users SET
"accessType" = 'BOTH' WHERE id = ...` (or set to NULL to defer the
routing decision to the application default).

### 2.3 — Session timezone sanity

```sql
SHOW TimeZone;
```

**Expected:** `UTC`.

All `TIMESTAMP → TIMESTAMPTZ` migrations use `AT TIME ZONE 'UTC'` in
their USING clause, which assumes pre-existing wall-clock values are
already-UTC. Our container fleet is UTC-pinned via the Dockerfile base
(`ENV TZ=UTC`). If any staging or production DB has been configured
with a non-UTC `TimeZone` GUC, existing timestamps will be reinterpreted
with a shift — DO NOT DEPLOY until this is investigated.

### 2.4 — Farm outbox unpublished backlog

```sql
SELECT COUNT(*)
FROM farm.farm_outbox
WHERE "publishedAt" IS NULL;
```

**Expected:** low number (ideally 0; the outbox worker polls every second
so the pending queue should be drained within a second of a healthy system).

A large backlog indicates a stuck outbox worker or NATS connectivity issue.
The `ConvertFarmOutboxToIdentity1781200000000` migration does not touch
unpublished rows, but a large backlog means operators should investigate
the outbox worker health first — the migration is not the right time
for that discovery.

### 2.5 — Farm schema RLS baseline

```sql
SELECT c.relname, pol.polname, pg_get_expr(pol.polqual, pol.polrelid) AS policy
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'farm'
ORDER BY c.relname;
```

**Expected current state:** either empty (legacy `1776000000000` migration
never deployed) OR contains `tenant_isolation_policy` with the buggy
`COALESCE(current_setting(...), '')::uuid` predicate.

After deploy, the same query should show the new `NULLIF(current_setting(...),
'')::uuid` predicate on every tenant-scoped table in the schema. This is
how you visually verify `RefreshTenantRlsPredicate1781000000000` landed.

---

## 3 — Service rollout order

Deploy order matters. Earlier services validate infrastructure changes
before higher-risk services pick them up. Between steps, wait at least
5 minutes and watch the monitoring dashboards.

### Step 1 — Publish `libs/backend-common`

The new RLS modules (`RlsModule`, `BypassRlsService`, `TenantRlsService`,
`applyTenantRlsToSchema`) live in this shared library. In the current
monorepo, this is effectively a recompile — no independent publish step,
the changes ship with each consuming service. If the release pipeline
uses incremental builds, ensure `libs/backend-common` is rebuilt before
any dependent service starts.

### Step 2 — `sensor-service`

**Why first:** lowest-risk migration (idempotent B-tree index addition),
smallest blast radius (no RLS, no TIMESTAMPTZ). Failure here should be
the cheapest to diagnose and roll back.

**Migrations that run on startup:**
- `AddSensorProtocolTopicIndex1781400000000`

**What to watch:**
- Log line: `Installing B-tree expression index on sensors.protocol_configuration->>topic`
- Per-schema log: `[tenant_xxx] installed idx_sensors_protocol_topic on (protocol_configuration->>'topic')`
- MQTT ingestion latency (should improve, not degrade)

**Rollback if needed:** `DROP INDEX "tenant_xxx".idx_sensors_protocol_topic` per schema.

### Step 3 — `auth-service`

**Why second:** highest-value C-1 target (security-sensitive columns),
but has hard abort paths via pre-checks that make runtime failures safe.

**Migrations that run on startup (via existing `migrationsRun: true`):**
1. `ConvertTimestampToTimestamptz1781100000000` — 25 cols, 12 tables
2. `EnforceCaseInsensitiveEmailUniqueness1781300000000` — pre-check + index swap
3. `AddUsersAccessTypeCheck1781700000000` — pre-check + CHECK constraint

**What to watch:**
- `Session TimeZone = UTC (USING clause pins interpretation regardless)` — confirms 2.3 check
- `Converting <table>: <cols>` for each of the 12 tables
- `Dropped legacy IDX_users_email` then `Created users_email_lower_key`
- `CHECK constraint "chk_users_access_type" installed`

**Lock window:** each table ALTER acquires `ACCESS EXCLUSIVE LOCK` for
the duration of the rewrite. Auth tables are small — expect sub-second
per table, cumulative under 10 seconds. Login requests that arrive
during the lock window will queue and complete after.

**Rollback if needed:** each migration has a documented `down()`. For
the TIMESTAMPTZ migration, down reintroduces the DST drift bug — treat
as break-glass, not standard operation.

### Step 4 — `farm-service`

**Why third:** requires the libs/backend-common RLS patch to be present,
AND runs the new `RefreshTenantRlsPredicate1781000000000` which replaces
the buggy legacy policy.

**Migrations that run on startup (via `MigrationRunnerService`):**
1. `RefreshTenantRlsPredicate1781000000000` — drops + recreates policy with NULLIF predicate
2. `ConvertFarmOutboxToIdentity1781200000000` — idempotent if already IDENTITY
3. `AddTenantActivePartialIndexes1781800000000` — dynamic table discovery, per-schema iteration

**Runtime changes:**
- `RlsModule.forRoot({ serviceName: 'farm' })` not yet wired (see
  notes below — farm-service uses the existing
  `TenantConnectionBootstrap` for schema-per-tenant isolation; RLS
  policies are installed and enforced against that existing runtime).

**What to watch:**
- `RLS armed on "farm"."<table>" (col: tenant_id)` for every tenant-scoped table
- `Existing sequence farm.farm_outbox_id_seq: last_value=N, is_called=true, next=N+1`
- `farm_outbox.id converted to IDENTITY with RESTART WITH N+1`
- `[tenant_xxx] installed idx_<table>_tenant_active`

**Critical**: after this deploy, every query against a farm tenant table
must be accompanied by a valid `app.current_tenant` GUC value (set by
`TenantConnectionBootstrap` on pool checkout from `AsyncLocalStorage`).
Any code path that bypasses the connection pool patch will return zero
rows. Watch for unexpected empty result sets in application logs.

### Step 5 — `messaging-service`

**Why fourth:** schema-per-tenant iteration cost scales with tenant
count; running this after farm-service lets us measure baseline impact
on a smaller service first.

**Migrations that run on startup:**
1. `ConvertMessagingOutboxToIdentity1781200000000` — iterates all schemas
2. `AddCompositeFkIndexesOnMessageChildren1781600000000` — iterates all schemas

**What to watch:**
- `Found N schemas with messaging_outbox` (source + each `tenant_<uuid>`)
- `[schema] messaging_outbox.id converted to IDENTITY (RESTART WITH N+1)`
- `Found N schemas with messages` (should match previous)
- `[schema] created composite index idx_<table>_message_composite on (messageId, messageCreatedAt)` for each of the 4 child tables × N schemas

**Expected total time:** for each schema, ~sub-millisecond per index.
A 100-tenant system sees ~400ms of cumulative ALTER/CREATE time. The
cron-based partition manager (`PartitionManagerService`) is unaffected
and continues its normal schedule.

### Step 6 — `admin-api-service`

**Why fifth:** FIRST time admin-api runs a TypeORM migration, which
means the migration tracking table (`admin.migrations`) may be created
automatically by TypeORM on first run. Also introduces the global
`AdminBypassRlsInterceptor` — every admin-api request now enters a
`BypassRlsService.withBypass()` frame.

**Migrations that run on startup (via newly added `migrationsRun: true`):**
1. `ConvertTimestampToTimestamptz1781500000000` — 48 cols, 19 tables

**Runtime changes:**
- `RlsModule.forRoot({ serviceName: 'admin-api', autoApply: false })`
- `APP_INTERCEPTOR: AdminBypassRlsInterceptor`

**What to watch:**
- `PostgreSQL connection pool patched for RLS GUC propagation (app.current_tenant, app.bypass_rls)`
- `RLS BYPASS GRANTED [admin-api:GET /tenants]` log lines per request
  (audit trail — 1 GRANT + 1 RELEASE per admin-api call; high
  volume during normal admin panel usage)
- Migration logs: `Converting <table>: <cols>` for each of the 19
  tables. Tables that don't exist in this environment (optional
  modules) emit `Table X not present in current schema — skipping`.

**admin-api migrations table creation:** TypeORM auto-creates the
tracking table on first run. If the schema-bootstrap service has
already created a `migrations` table with `id SERIAL` (per
`schema-bootstrap.service.ts`), TypeORM accepts the existing table
and inserts the migration record into it. No conflict.

### Step 7 — `billing-service`

**Why sixth:** First service where `RlsSchemaBootstrap` installs
policies at `OnApplicationBootstrap`. Smallest-risk global-schema
service (few tables, limited query volume).

**Runtime policy install (NOT a migration):**
- `RlsSchemaBootstrap` calls `applyTenantRlsToSchema(queryRunner,
  { serviceName: 'billing' })` on startup
- Discovers all tables in `billing` schema with `tenantId` or
  `tenant_id` column
- Installs `tenant_isolation_policy` with NULLIF predicate + bypass

**What to watch:**
- `Installing tenant RLS policies for service "billing"`
- `Tenant RLS applied to N tables in schema "billing"`
- `Tenant RLS policies installed for "billing"`
- **ALARM TRIGGER**: any log line containing `rls.bootstrap.failed` →
  the bootstrap caught a non-fatal error but the service is running
  without RLS until next restart. This is the audit hook to wire into
  PagerDuty / OpsGenie.

**Critical**: after this deploy, every query against billing tables
must carry tenant context via `TenantContextMiddleware` → `app.current_tenant`
GUC → RLS policy evaluation. Billing endpoints already use the tenant
middleware (verified during Phase 1 audit), so the runtime side is ready.

### Step 8 — `notification-service`, `config-service`

Same pattern as billing-service. Deploy one at a time with 5-minute
gaps so dashboards can distinguish between services.

---

## 4 — Monitoring signals

Wire these into your log-based alerting platform BEFORE starting Step 1.

### 4.1 — Critical alarms (PAGE)

| Signal | Meaning | Response |
| ------ | ------- | -------- |
| `rls.bootstrap.failed` | Startup policy install crashed; service running without RLS | Check logs for root cause, restart service after fix |
| `Refusing to install case-insensitive unique index` | Email dup pre-check aborted deploy | Run 2.1 check, merge duplicates manually, retry deploy |
| `Refusing to install CHECK constraint` | accessType pre-check aborted | Run 2.2 check, fix values, retry |
| `Sequence ... returned no state row` | Schema corruption — outbox sequence missing | STOP deploy, investigate before retrying |
| `Cannot patch connection pool` | pg Pool not found on DataSource driver | Check TypeORM version pinning, driver availability |
| `Failed to set RLS GUCs` | `set_config` call failed during pool checkout | Connection released broken; pool recovers. If persistent, investigate PostgreSQL extensions |

### 4.2 — Warning alarms (SLACK / EMAIL)

| Signal | Meaning | Response |
| ------ | ------- | -------- |
| `RLS BYPASS GRANTED` spikes unusually | Unexpected admin activity | Review the `operation` label; cross-reference with admin user audit |
| `Skipping invalid schema name` | Corrupted information_schema result | Investigate but don't block |
| `Table X not present in current schema — skipping` | Expected for optional modules | INFO only, document which environments skip which modules |
| `Pool checkout without tenant context` | Code path bypassing middleware | Trace the call site — usually a background job that needs `withBypass` |

### 4.3 — Normal baselines

After rollout, these patterns are **expected and not an alarm**:

- `RLS BYPASS GRANTED [admin-api:<method> <path>]` — 1 per admin-api request
- `RLS BYPASS RELEASED [admin-api:<method> <path>]` — paired with grant
- `tenant_isolation_policy` visible in `pg_policies` on every
  tenant-scoped table in `billing`, `notification`, `config`, `farm`
- `app.current_tenant` set on every non-admin query's connection
  (verify via `SELECT current_setting('app.current_tenant', true)`
  from a sampled query)

---

## 5 — Rollback plan

Each migration has a symmetric `down()`, but **rollback is not free**
and should only be invoked when forward-fix is impossible.

### 5.1 — When rollback is appropriate

- A migration abort pre-check surfaces data that cannot be resolved
  during the deploy window (e.g. 10,000+ duplicate emails requiring
  a dedicated data migration)
- Post-deploy monitoring reveals a fundamental predicate bug that
  would take longer to diagnose than the rollback itself
- A downstream consumer (analytics, reporting) breaks on the new
  column types and cannot be updated in the same deploy window

### 5.2 — When rollback is NOT appropriate

- TIMESTAMPTZ rollback reintroduces the DST drift bug — this is a
  regression, not a fix. Only roll back if there's an active incident
  requiring it.
- RLS policy rollback leaves the service without defense-in-depth.
  Forward-fix (update the predicate via a new migration) is usually
  safer than reverting to the legacy buggy state.
- BIGSERIAL rollback is possible but cosmetic — the new IDENTITY
  shape behaves identically to the application layer. Rolling back
  achieves nothing except deploying the deprecated pattern again.

### 5.3 — How to roll back a specific migration

For auth-service (has migration runner):

```bash
# On the auth-service container, with the source checked out at the
# commit BEFORE the deploy:
npx typeorm-ts-node-esm migration:revert \
  -d apps/auth-service/src/ormconfig.ts
```

Repeat `migration:revert` for each migration to roll back, in reverse
order. TypeORM runs `down()` and removes the row from the `migrations`
table.

For farm-service, messaging-service, admin-api-service: same pattern
with their respective ormconfig paths.

For billing/notification/config (RlsSchemaBootstrap):
- These do NOT use TypeORM migrations, they run `applyTenantRlsToSchema`
  at startup.
- To roll back, deploy a commit where `RlsSchemaBootstrap.onApplicationBootstrap`
  is disabled OR where the module passes `disabled: true` in the
  `RlsSchemaBootstrapOptions`. On next restart, the policies remain
  installed but nothing reinstalls them. To actively REMOVE them,
  invoke `removeTenantRlsFromSchema(queryRunner)` from a one-off
  script (libs/backend-common exports it).

---

## 6 — Edge cases and known surprises

### 6.1 — `app.migrations` table conflict on admin-api-service first run

admin-api's `schema-bootstrap.service.ts` defensively creates a
`migrations` table with `id SERIAL` (matching TypeORM's default). When
the new `migrationsRun: true` kicks in, TypeORM introspects this table
and uses it as-is. Verified compatible — no action needed.

If TypeORM encounters an incompatible pre-existing table, it errors
out with `relation "migrations" already exists` (different schema) OR
`column "timestamp" does not exist`. In that case:

```sql
-- Drop the legacy table (it has no data yet) and let TypeORM recreate
DROP TABLE IF EXISTS admin.migrations;
```

### 6.2 — Pool patch chain order for farm-service

farm-service instantiates BOTH `TenantConnectionBootstrap` (existing,
schema-per-tenant) and WILL instantiate `RlsConnectionBootstrap`
(from this release). NestJS provider initialization order is
deterministic by declaration, but both patches wrap `pool.connect()`
and chain via `originalConnect`. The chain is commutative — each
patch runs its own `SET` on the checked-out connection — so order
affects log readability, not correctness.

To verify the chain is intact after deploy:

```sql
-- From inside a farm-service connection, should show both:
SELECT current_setting('search_path'),       -- from TenantConnectionBootstrap
       current_setting('app.current_tenant'); -- from RlsConnectionBootstrap
```

### 6.3 — Tenant schemas created AFTER the deploy

`TenantSchemaSyncService` provisions new tenant schemas on demand. It
uses `CREATE TABLE ... (LIKE source.table INCLUDING ALL)` which copies
indexes present at provision time. The new partial indexes
(`AddTenantActivePartialIndexes`) and composite FK indexes
(`AddCompositeFkIndexesOnMessageChildren`) are therefore captured by
any tenant provisioned AFTER the deploy completes.

**Tenants provisioned DURING the deploy window** (between the source
schema being updated and the per-schema iteration completing) may end
up with a partial index set. The migrations are idempotent, so a
follow-up manual run will close the gap. Alternatively, pause tenant
provisioning for the deploy window.

### 6.4 — Cross-schema admin-api queries land on billing/notification/config

Once those three services have RLS enforced, `admin-api-service`
queries like `SELECT COUNT(*) FROM billing.subscriptions` will consult
the tenant_isolation_policy. The `AdminBypassRlsInterceptor` wraps
every admin-api request in `withBypass()`, which sets
`app.bypass_rls = 'on'` on the connection, so the policy grants full
visibility. Verified by test (bypass-rls.service.spec.ts).

If admin-api analytics queries return zero rows after the deploy,
the first thing to check is whether the interceptor is actually
wrapping the request:

```bash
# Should show grant + release pairs in admin-api logs:
kubectl logs -n aqua-saas deploy/admin-api-service | grep 'RLS BYPASS'
```

### 6.5 — `event-store-service` left out of Phase 2

event-store-service has NO `TenantContextMiddleware` (internal-only
service with API-key auth) and therefore cannot enforce RLS without
adding tenant middleware first. Deliberately excluded from this
release. Tracking as a Phase 2b successor task.

---

## 7 — Post-deploy verification checklist

After all 8 steps complete, run these checks:

```sql
-- 1. RLS policies installed on all expected services
SELECT n.nspname AS schema, c.relname AS table, pol.polname
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE pol.polname = 'tenant_isolation_policy'
  AND n.nspname IN ('farm', 'billing', 'notification', 'config')
ORDER BY n.nspname, c.relname;

-- 2. No TIMESTAMP WITHOUT TIME ZONE left in auth or admin schema
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema IN ('auth', 'admin')
  AND data_type = 'timestamp without time zone';
-- Expected: zero rows

-- 3. BIGSERIAL outbox converted to IDENTITY
SELECT n.nspname AS schema, c.relname AS table, a.attidentity
FROM pg_attribute a
JOIN pg_class c ON a.attrelid = c.oid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.attname = 'id'
  AND c.relname IN ('farm_outbox', 'messaging_outbox')
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY n.nspname, c.relname;
-- Expected: attidentity = 'd' (GENERATED BY DEFAULT AS IDENTITY)

-- 4. Partial indexes installed in farm schema
SELECT n.nspname AS schema, c.relname AS table, i.relname AS index_name
FROM pg_index ix
JOIN pg_class c ON c.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE i.relname LIKE 'idx_%_tenant_active'
ORDER BY n.nspname, c.relname;
-- Expected: one row per BaseEntity table per schema

-- 5. Composite FK indexes on messaging children
SELECT n.nspname, c.relname, i.relname
FROM pg_index ix
JOIN pg_class c ON c.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE i.relname LIKE 'idx_%_message_composite'
  AND n.nspname = 'messaging'
ORDER BY c.relname;
-- Expected: 4 indexes — attachments, receipts, reactions, pins

-- 6. Sensor topic index across tenant schemas
SELECT n.nspname, i.relname
FROM pg_index ix
JOIN pg_class c ON c.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE i.relname = 'idx_sensors_protocol_topic'
ORDER BY n.nspname;

-- 7. LOWER(email) unique expression index
SELECT pg_get_indexdef(ix.indexrelid)
FROM pg_index ix
JOIN pg_class c ON c.oid = ix.indrelid
WHERE c.relname = 'users'
  AND pg_get_indexdef(ix.indexrelid) LIKE '%LOWER%email%';
-- Expected: one row showing the UNIQUE (LOWER(email)) definition

-- 8. accessType CHECK constraint
SELECT pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
WHERE c.conname = 'chk_users_access_type'
  AND t.relname = 'users';
-- Expected: CHECK (("accessType" IS NULL) OR ("accessType" IN ('PANEL_ONLY', ...)))
```

All 8 queries returning their expected shapes = deploy verified.

---

## 8 — Future work referenced from this release

These items were analysed during Phase 2 but deliberately deferred:

- **H-1** `varchar(n)` → `text` + CHECK — rejected as low value
  (PostgreSQL treats them equivalently for performance)
- **H-2** `getRepository()` → `getScopedRepository()` refactor across
  169 call sites — 157 protected by schema-per-tenant or new RLS,
  12 in auth-service verified tenant-safe individually
- **M-1** snake_case naming consistency — deferred as a large refactor
  best tackled against a dedicated release
- **M-2, M-6** TimescaleDB compression + TOAST tuning — require
  EXPLAIN ANALYZE against production workloads
- **event-store-service RLS** — requires tenant middleware infrastructure
  first

See commit messages on `feat/rls-foundation-phase1` for the full
analysis trail.
