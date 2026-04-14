# Raw SQL Audit — Platform-Wide

**Date:** 2026-04-21
**Reviewer:** comprehensive-review:code-reviewer
**Scope:** `apps/`, `libs/`, `platform/` — excluding `*.spec.ts`, `__tests__/`, `/migrations/`, `/test/`, `*.e2e-*`
**Grep pattern:** `dataSource\.query | queryRunner\.query | manager\.query | createQueryBuilder.*raw | @InjectDataSource.*query`
**Workstream:** WS5 (Deploy Resilience plan, audit phase)

---

## Summary

| Metric | Count |
|--------|-------|
| Raw SQL hits (total) | **685** |
| Unique files touched | **109** |
| Bucket A (legitimate-raw, KEEP) | 49 files / ~295 hits (43%) |
| Bucket B (DRIFT-PRONE — MUST migrate) | 44 files / ~320 hits (47%) |
| Bucket C (entity-available, discretionary) | 16 files / ~70 hits (10%) |
| Audit theater instances (tests assert SQL strings) | **3 files, 24 distinct assertions** |

**Per-service hit distribution:**

| Service | Hits | Files |
|---------|------|-------|
| apps/admin-api-service | 280 | 29 |
| libs/backend-common | 112 | 18 |
| apps/farm-service | 98 | 13 |
| apps/auth-service | 66 | 8 |
| apps/messaging-service | 61 | 13 |
| apps/sensor-service | 56 | 18 |
| apps/billing-service | 13 | 2 |
| apps/hr-service | 10 | 3 |
| platform/libs | 2 | 2 |
| apps/observability-service | 2 | 2 |
| apps/event-store-service | 2 | 2 |
| apps/notification-service | 1 | 1 |

**Critical finding:** admin-api-service holds 41% of all raw SQL and is the primary drift surface. This is the same service where the messaging-ai drift pattern originated (tenant-provisioning writes unqualified `auth.*`, `billing.*` tables without entities to validate column names). Two confirmed **runtime-breaking** drift instances discovered in `admin-api-service/src/users/users.service.ts` (uses `"passwordHash"` column that does not exist on User entity).

---

## Bucket A — Legitimate raw (KEEP)

All hits in this bucket use raw SQL because no Repository-pattern equivalent exists in TypeORM, or they operate at an infrastructure layer below the entity abstraction. No migration work required.

### Schema / DDL / Catalog infrastructure (`libs/backend-common/`)

- `libs/backend-common/src/database/schema-manager.service.ts` (61 hits) — tenant schema provisioning, `CREATE SCHEMA`, `pg_advisory_lock`, TimescaleDB `create_hypertable`, continuous aggregate DDL, `pg_policies` catalog. Pure infrastructure.
- `libs/backend-common/src/database/source-schema-bootstrap.service.ts` (9 hits) — `information_schema.tables` / `pg_indexes` catalog queries + `DROP TABLE IF EXISTS ... CASCADE` for orphan cleanup. Infrastructure.
- `libs/backend-common/src/database/source-schema-write-guard.ts` (9 hits) — `CREATE TRIGGER`, `DROP TRIGGER`, `pg_trigger` catalog. Infrastructure.
- `libs/backend-common/src/database/tenant-schema-sync.service.ts` (5 hits) — `pg_attribute` introspection, `CREATE TABLE ... (LIKE ...)`, `ALTER TABLE ADD COLUMN`. Infrastructure.
- `libs/backend-common/src/database/migration-runner/migration-runner.service.ts` — TypeORM migration machinery. Infrastructure.
- `libs/backend-common/src/database/rls/tenant-rls.service.ts` (4 hits) — `set_config('app.current_tenant', …)` / `SELECT … FOR UPDATE OF` — GUC + RLS primitives.
- `libs/backend-common/src/database/rls/tenant-rls-sync.service.ts` — `pg_policies`, `pg_policy_exists`. Catalog.
- `libs/backend-common/src/database/rls/admin-bypass-rls.interceptor.ts` — `SET LOCAL app.bypass_rls`. GUC primitive.
- `libs/backend-common/src/database/schema-drift-validator.service.ts` — `information_schema.tables/columns`. Catalog.
- `libs/backend-common/src/database/watchdog/{cross-tenant-probe,schema-drift-detector,source-schema-scanner,watchdog-runner}.ts` — all catalog queries for invariant verification.
- `libs/backend-common/src/database/tenant-aware.repository.ts` — RLS context helpers wrapping `manager.query` with parameterized GUC.
- `libs/backend-common/src/database/tenant-schema.utils.ts` — `listTenantSchemas()` helper, `information_schema.schemata`. Catalog.
- `libs/backend-common/src/middleware/tenant-schema.middleware.ts` — `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`. Catalog.
- `libs/backend-common/src/health/standard-health.controller.ts` — `SELECT 1`. Liveness probe.

### Postgres-specific features (can't express via Repository)

- `apps/messaging-service/src/partition/partition-manager.service.ts` (2 hits) — `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM ... TO`. DDL / partitioning.
- `apps/admin-api-service/src/modules/tenant-management/services/schema-migration.service.ts` (4 hits) — `CREATE SCHEMA`, `DROP SCHEMA CASCADE`, `SET search_path`. Infrastructure.
- `apps/admin-api-service/src/database-management/services/{database-monitoring,migration-management,schema-management,backup-restore}.service.ts` — entirely `pg_stat_*`, `pg_catalog`, `pg_extension`, `information_schema.*` catalog queries.
- `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts` — admin DB explorer (catalog introspection).
- `apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts` — `SHOW max_connections`, `pg_stat_database`. Catalog.
- `apps/admin-api-service/src/metrics/system-metrics.service.ts` — connection metrics, `pg_stat_activity`. Catalog.
- `apps/admin-api-service/src/health/health.service.ts` — `SELECT 1`. Liveness.
- `apps/sensor-service/src/timescale/{hypertable,continuous-aggregate,retention-policy}.service.ts` — `timescaledb_information.*` catalog, `add_retention_policy()`, `add_continuous_aggregate_policy()`. TimescaleDB specific.
- `apps/sensor-service/src/sensor/services/metric-query.service.ts` (7 hits) — `time_bucket()` continuous-aggregate queries on `metrics_1min` / `metrics_1hour` / `metrics_1day` (materialized views with no TypeORM entity). TimescaleDB.
- `apps/sensor-service/src/sensor/services/sensor-query.service.ts` (5 hits) — `time_bucket($1::interval, timestamp)` aggregation. TimescaleDB.
- `apps/sensor-service/src/aggregation/time-bucket.service.ts` (2 hits) — `time_bucket()` downsample. TimescaleDB.
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` — bulk-insert into `sensor_metrics` hypertable with `VALUES (...),(...)` multi-row pattern; performance-justified (per-message throughput target). **Borderline — see Bucket C.**
- `apps/sensor-service/src/registration/services/sensor-registration.service.ts` / `batch-processor.service.ts` / `data-ingestion.service.ts` — bulk COPY-equivalent INSERT patterns on hypertables.
- `apps/sensor-service/src/health/health.controller.ts` — `SELECT 1`.
- `apps/sensor-service/src/common/transaction.ts` — `SET LOCAL statement_timeout` GUC.
- `apps/sensor-service/src/automation/automation.service.ts` — `pg_notify()` LISTEN/NOTIFY channel publish.
- `apps/event-store-service/src/event-store/services/event-store.service.ts` — `SELECT nextval('stored_events_global_position_seq')` for atomic global position. Sequence primitive.
- `apps/event-store-service/src/health/health.service.ts` — `SELECT 1`.
- `apps/observability-service/src/health/health.service.ts` — `SELECT 1`.
- `apps/observability-service/src/metrics/metrics-aggregator.service.ts` — parameterized query wrapper passing through to instrumented DataSource.
- `apps/auth-service/src/database/schema-bootstrap.service.ts` (3 hits) — `DO $$ ... IF NOT EXISTS ... ALTER TABLE ADD COLUMN` bootstrap. **ADR-011 violation: DDL should live in migration runner, not bootstrap. See "Out of scope".**
- `apps/billing-service/src/billing/billing-scheduler.service.ts` (4 hits) — `pg_try_advisory_lock($1)` / `pg_advisory_unlock($1)` for distributed cron lock. Postgres primitive.
- `platform/libs/outbox/src/outbox-worker.service.ts` — `SELECT ... FOR UPDATE SKIP LOCKED`. Table name derived from entity metadata (`this.repo.metadata.tableName`), so drift-safe.
- `platform/libs/outbox/src/outbox-publisher.service.ts` — runtime transaction-active check on queryRunner; no SQL issued.

### Cross-tenant introspection (Bucket A-with-caveats)

- `apps/sensor-service/src/ingestion/sensor-topic-cache.service.ts` (7 hits) — cross-tenant discovery via `information_schema.schemata LIKE 'tenant_%'` + per-schema `SELECT … FROM ${quoteIdentifier(schema)}.sensors`. Legitimate cross-tenant scan; entity exists but Repository has no cross-schema discovery primitive.
- `apps/sensor-service/src/edge-device/{mqtt-auth,provisioning}.service.ts` — same cross-tenant scan pattern for `edge_devices`.
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`, `apps/farm-service/src/scheduler/cron-jobs.service.ts`, `apps/farm-service/src/weather/services/weather-cron.service.ts`, `apps/farm-service/src/feeding/services/feeding-cron.service.ts` — all do `for (schema of tenantSchemas) { SET search_path … }` discovery scans. The `SET search_path` is Bucket A (GUC). But the embedded `SELECT DISTINCT "tenantId" FROM "batches_v2"` body is **Bucket B** — hardcoded table name, with a comment explicitly warning that the table was previously renamed from `batches` to `batches_v2` and the query broke. Precisely the ai-privacy failure mode, one fix already landed.

---

## Bucket B — Drift-prone (MUST migrate)

### SEVERITY-CRITICAL — Confirmed runtime drift (deploy-breaking)

#### 1. `apps/admin-api-service/src/users/users.service.ts:412,526`
- **SQL (line 412):** `INSERT INTO auth.users (email, "firstName", "lastName", "passwordHash", role, "tenantId", "isActive") VALUES ($1,$2,$3,$4,$5,$6,true)`
- **SQL (line 526):** `UPDATE auth.users SET "passwordHash" = $1, "updatedAt" = NOW() WHERE id = $2`
- **Entity:** `apps/auth-service/src/modules/authentication/entities/user.entity.ts` → `@Entity('users')` with `@Column({ type: 'varchar', length: 255, nullable: true }) password?: string`. No `passwordHash` column exists.
- **Drift detected:**
  - Column: SQL says `"passwordHash"`, entity field (and physical column) is `password`.
  - Schema: `@Entity('users')` has NO `{ schema: 'auth' }` decoration — ADR-011 violation (entity relies on search_path convention).
- **Audit theater:** Not directly — this service has test file but no `stringContaining('passwordHash')` assertion found. Likely never exercised in unit tests.
- **Runtime impact:** Every admin-api `createUser` and `resetPassword` call will crash with `column "passwordHash" does not exist`. Ship-blocker.
- **Contradictory reference:** `apps/admin-api-service/src/auth/password-reset.controller.ts:251` uses `SET password = $1` (correct). So admin-api has TWO inconsistent code paths writing the same field, proving this is drift, not an intentional column rename.
- **Recommended fix:** Inject `Repository<User>`, use `repo.create({ email, firstName, lastName, password: hashedPassword, role, tenantId, isActive: true })` + `repo.save()`. Delete raw SQL. Same for resetPassword → `repo.update(id, { password: hashedPassword })`.

#### 2. `apps/admin-api-service/src/modules/modules.service.ts` (22 hits)
- **SQL (line 117):** `COALESCE(m.is_core, false) = $${paramIndex++}`
- **SQL (line 140):** `COALESCE(m.is_core, false) as "isCore"`
- **SQL (line 198):** `SELECT COUNT(*) as count FROM auth.modules WHERE COALESCE(is_core, false) = true`
- **Entity:** `apps/auth-service/src/modules/system-module/entities/module.entity.ts` → `@Entity('modules')` (no schema) with `@Column({ name: 'is_core', ... }) isCore?: boolean`.
- **Drift detected:**
  - Mixed casing: query mixes snake-case `is_core` (unquoted, relying on Postgres fold-to-lowercase) with camelCase `"isActive"`, `"defaultRoute"`, `"sortOrder"` (double-quoted, case-sensitive). Any column-rename on the entity that doesn't preserve both forms will break half the statements.
  - Schema: query hardcodes `auth.modules`; entity is `@Entity('modules')` unqualified. ADR-011 violation at entity level.
- **Audit theater:** **YES** — see `apps/admin-api-service/src/modules/__tests__/modules.service.spec.ts` asserts `stringContaining('INSERT INTO auth.modules')`, `stringContaining('is_core')`, `stringContaining('ILIKE')`, etc. Tests pin the SQL strings, so entity-level column renames would not fail CI.
- **Recommended fix:** Inject `Repository<Module>` + `Repository<TenantModule>`. All 22 hits map to stock TypeORM:
  - `listModules` → `repo.findAndCount({ where: ..., take, skip })`
  - `getModuleStats` → QueryBuilder `.select('COUNT(*)').addSelect(...).groupBy(...)`
  - `createModule/updateModule/deleteModule` → `repo.save()` / `repo.update()` / `repo.delete()`
  - `assignModuleToTenant` UPSERT → `tenantModuleRepo.upsert(payload, { conflictPaths: ['tenantId', 'moduleId'] })`
  - `checkExtendedColumns()` information_schema probe can be deleted — entity metadata already answers.

#### 3. `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts` (21 hits)
- **SQL (line 168):** `UPDATE auth.tenants SET status = 'PROVISIONING', "updatedAt" = NOW() WHERE id = $1 AND status = $2`
- **SQL (line 333):** `DELETE FROM auth.users WHERE "tenantId" = $1 AND role = 'TENANT_ADMIN'`
- **SQL (line 554):** `SELECT m.code FROM auth.tenant_modules tm JOIN auth.modules m ON m.id = tm."moduleId" WHERE tm."tenantId" = $1 AND tm."isEnabled" = true`
- **SQL (line 675):** `INSERT INTO auth.tenant_roles (id, "tenantId", code, name, description, permissions, is_default, is_editable, display_order, created_at, updated_at) VALUES (...)`
- **SQL (line 720):** `CREATE TABLE IF NOT EXISTS auth.tenant_roles (...)` ← **runtime DDL**
- **Entity:** `Tenant`, `TenantModule`, `Module` exist in auth-service. **NO entity for `tenant_roles`** — it's managed entirely via raw SQL DDL + CRUD.
- **Drift detected:**
  - Cross-service writes: admin-api writes auth-service tables. Architectural boundary violation (ADR says each service owns its schema; admin-api should NOT write `auth.*` directly).
  - `tenant_roles` has no entity class — zero compile-time schema validation. Any column rename in a future migration silently breaks this code.
  - `CREATE TABLE IF NOT EXISTS` at runtime violates ADR-011/ADR-012 (migration runner must own DDL). Bootstrap racing across replicas; the `tenantRolesTableEnsured` guard is per-process only.
  - `created_at`, `updated_at`, `is_default`, `is_editable`, `display_order` (snake) mixed with `"tenantId"` (camel-quoted). Mixed-casing drift same as #2.
- **Audit theater:** No spec assertions on these SQL strings found, but architectural review has flagged this file before — TODO(NATS-MIGRATION) comments on lines 114-120 explicitly acknowledge the service is writing to tables it doesn't own.
- **Recommended fix (phased):**
  - Phase 1 (WS5 scope): Create `TenantRoleEntity` in auth-service; inject `Repository<TenantRole>` into admin-api-service via cross-service entity import; delete the runtime DDL.
  - Phase 2 (out of scope): Replace cross-service DB writes with NATS request-reply commands per the existing TODO(NATS-MIGRATION) annotations. Track as HIGH architectural finding.

#### 4. `apps/admin-api-service/src/users/services/user-provisioning.service.ts` (11 hits)
- **SQL:** `INSERT INTO auth.users (…)`, `INSERT INTO auth.invitations (…)`, `INSERT INTO auth.user_module_assignments (…)`, `UPDATE auth.tenants SET user_count = user_count + 1`.
- **Entities exist:** User, Invitation, UserModuleAssignment, Tenant — all in auth-service, unqualified `@Entity('…')`.
- **Drift detected:** Same cross-service-write pattern as #3. Very likely has the same `password`/`passwordHash` drift — line 107 visible in grep output INSERTs into `auth.users`. Needs inspection but high-risk duplicate of finding #1.
- **Recommended fix:** Repository injection; delete runtime `UPDATE auth.tenants SET user_count = user_count + 1` (entity has `userCount` camelCase? — verify column mapping); replace with NATS command in Phase 2.

### SEVERITY-HIGH — Definite drift, not yet proven to crash

#### 5. `apps/admin-api-service/src/billing/services/subscription-core.service.ts` (13 hits)
- **SQL:** Mixed-casing `billing.subscriptions s` queries with `s.tenant_id` (snake) + `s."createdAt"` (camel-quoted) on the same row. `LEFT JOIN auth.tenants t ON t.id::text = s.tenant_id` — UUID-to-text cast suggests the column types don't match between `auth.tenants.id` (UUID) and `billing.subscriptions.tenant_id` (text/varchar?).
- **Entity:** `apps/billing-service/src/billing/entities/subscription.entity.ts` → `@Entity('subscriptions')` **without schema decoration** (ADR-011 violation on source entity).
- **Drift detected:** Type-cast `::text` is runtime-fragile and invisible to the type system. If `billing.subscriptions.tenant_id` is ever migrated to UUID, this JOIN still works but loses index usability. If kept as varchar, breaks as soon as an entity-consumer assumes UUID.
- **Recommended fix:**
  1. Add `{ schema: 'billing' }` to billing-service entities (out-of-scope architectural task — see below).
  2. Inject read-only `Repository<Subscription>` into admin-api via cross-service entity import (synchronize: false).
  3. Replace all 13 queries with `.createQueryBuilder()`. The cross-service JOIN should happen via NATS query to auth-service, not SQL JOIN.

#### 6. `apps/admin-api-service/src/billing/services/subscription-analytics.service.ts` (20 hits) + `subscription-renewal.service.ts` (9 hits) + `payment-management.service.ts` (9 hits) + `invoice-management.service.ts` (12 hits)
- **SQL:** 50+ hardcoded `billing.subscriptions`, `billing.invoices`, `billing.payments` references.
- **Entities:** Exist in billing-service without schema decoration.
- **Drift detected:** Same pattern as #5. `payment-management.service.ts:200` does `INSERT INTO billing.payments ( ... )` with literal column list — column rename on Payment entity would break silently.
- **Recommended fix:** Single cross-service entity import + Repository pattern. These analytics queries are read-only and aggregation-heavy — can be `.createQueryBuilder()` with `.getRawMany<T>()`.

#### 7. `apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts` (11 hits)
- **SQL:** `INSERT INTO auth.tenant_modules (...) ON CONFLICT (...) DO UPDATE SET ...`, `UPDATE auth.tenant_modules SET "isEnabled" = ...`, `SELECT id, name, plan FROM auth.tenants WHERE id = $1`, `SELECT * FROM auth.modules`.
- **Entity:** TenantModule, Tenant, Module all exist.
- **Drift detected:** Cross-service writes (same pattern as #3). UPSERT is the classic `repo.upsert()` case.
- **Audit theater:** **YES** — `modules.service.spec.ts:598` asserts `stringContaining('INSERT INTO auth.tenant_modules')`.
- **Recommended fix:** `tenantModuleRepo.upsert(payload, { conflictPaths: ['tenantId', 'moduleId'] })`.

#### 8. `apps/admin-api-service/src/analytics/services/analytics.service.ts` (9 hits)
- **SQL:** `FROM auth.tenants`, `FROM auth.users`, `FROM shared.audit_logs`, `FROM billing.invoices`, `FROM admin.analytics_snapshots`.
- **Entities:** All exist cross-service.
- **Drift:** Cross-service reads of four schemas. Hardcoded `shared.audit_logs` at least matches canonical placement (ADR-011 shared-table list), but relies on the column set of foreign entities.
- **Recommended fix:** Cross-service `Repository<Tenant>`, `Repository<User>`, `Repository<AuditLogEntity>` with read-only `synchronize: false`. QueryBuilder for the aggregation joins.

#### 9. `apps/messaging-service/src/gdpr/gdpr.service.ts` (17 hits)
- **SQL:** `SELECT "channelId", role, "joinedAt", "leftAt" FROM channel_members WHERE "userId" = $1`, `DELETE FROM message_receipts`, `DELETE FROM message_reactions`, `UPDATE channel_members SET "leftAt" = NOW()`, `INSERT INTO compliance_audit_log`, `UPDATE agent_conversations SET messages = $1::jsonb, …`.
- **Entities:** ChannelMember, MessageReceipt, MessageReaction, ComplianceAuditLog, Message all exist in `messaging` schema. `agent_conversations` is owned by ai-service (`@Entity('agent_conversations')`, no schema decoration).
- **Drift detected:**
  - Hardcoded table names without schema qualification in a service that DOES decorate its entities `{ schema: 'messaging' }`. Relies on per-request `search_path`.
  - `agent_conversations` is a **cross-service write from messaging-service into ai-service tables** — wrapped in `try/catch { logger.warn() }` with fallback to a GDPR event. Architecturally questionable (messaging-service should not have a code path that writes directly to ai-service tables even "best effort").
  - `UPDATE compliance_audit_log ("tenantId", "userId", action, "resourceType", "resourceId", details, "createdAt")` — the column list hardcodes 7 column names. A rename breaks silently.
- **Recommended fix:**
  - Inject `Repository<ChannelMember>`, `Repository<MessageReceipt>`, etc.
  - `.delete({ userId, …, messageId: In(messageIds) })` with IN (uuid[]) via Repository.
  - Remove `UPDATE agent_conversations` block entirely — the `GdprAnonymizeRequested` NATS event already handles the ai-service cascade; "best-effort direct write" is defense-in-depth that creates drift.
  - For ComplianceAuditLog INSERT → `auditRepo.save(auditRepo.create({...}))`.

#### 10. `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts` (11 hits)
- **SQL:** `SELECT EXISTS(SELECT 1 FROM messages WHERE "senderId" = $1 LIMIT 1)`, `DELETE FROM message_entity_references WHERE "messageId" = ANY($1::uuid[])`, `UPDATE messages SET "senderId" = $1, content = '[message deleted by user]', embedding = NULL WHERE "senderId" = $2 AND "channelId" = $3`, etc.
- **Entities:** Message, MessageEntityReference, MessageAnalysis, MessageReaction, MessageReceipt, ChannelMember — all exist.
- **Drift:** Same as #9. `embedding = NULL` explicitly sets a `vector` column, which Repository supports via `@Column('vector')` if the entity decorates it. Verify entity mapping.
- **Recommended fix:** Repository; same pattern as #9.

#### 11. `apps/messaging-service/src/ai/services/knowledge-extraction.service.ts` (5 hits)
- **SQL:** `SELECT m."id", m."channelId", m."senderId", m."content", m."createdAt" FROM "messages" m LEFT JOIN "message_entity_references" mer ON …` (complex join), `SET search_path TO "${tenantSchema}", messaging, public` (legitimate A), `SELECT schema_name FROM information_schema.schemata` (catalog A).
- **Entities exist.**
- **Drift:** The 5-column SELECT from `messages` is hand-rolled when a QueryBuilder would derive columns from entity metadata. Table names still hardcoded.
- **Recommended fix:** `queryRunner.manager.createQueryBuilder(Message, 'm').leftJoin(MessageEntityReference, 'mer', 'mer.messageId = m.id').where('mer.id IS NULL').getMany()`.

#### 12. `apps/messaging-service/src/ai/services/embedding.service.ts` (3 hits)
- **SQL:** `SELECT m."id", m."channelId", m."senderId", m."content", m."createdAt", m."tenantId" FROM "messages" m WHERE m."embedding" IS NULL AND m."isDeleted" = false AND m."content" IS NOT NULL AND m."content" != '' ORDER BY m."createdAt" ASC LIMIT $1 FOR UPDATE OF m SKIP LOCKED` + `UPDATE "messages" SET "embedding" = $1::vector WHERE "id" = $2 AND "createdAt" = $3`.
- **Entity:** Message with `@Column('vector') embedding`.
- **Drift:** Column-list hardcoded. The `::vector` cast is the ONLY raw-SQL-only artifact; `FOR UPDATE … SKIP LOCKED` is supported by TypeORM `.setLock('pessimistic_write', undefined, 'skip locked')` in v0.3+.
- **Recommended fix:** `repo.createQueryBuilder('m').where('m.embedding IS NULL').setLock('pessimistic_write_skip_locked').getMany()`. For `UPDATE … SET embedding = $1::vector`, keep a **narrow** raw-SQL helper that accepts (id, createdAt, vector) — the pgvector dimension cast is the only part that genuinely requires raw SQL. Document with a `// SECURITY:`-style comment.

#### 13. `apps/messaging-service/src/ai/queries/search-similar-messages.handler.ts` (3 hits)
- **SQL:** `ORDER BY m."embedding" <=> $1::vector LIMIT $4` — pgvector cosine-distance operator.
- **Drift:** pgvector operators (`<=>`, `<#>`, `<->`) have no QueryBuilder support. **Genuine Bucket A** for the vector ordering clause.
- But the SELECT body hardcodes column names and table name. Membership lookup (`SELECT "channelId" FROM "channel_members"`) is pure drift-prone — move to Repository.

#### 14. `apps/messaging-service/src/ai/queries/get-sentiment-trends.handler.ts` (1 hit)
- **SQL:** Complex aggregation with `date_trunc('week', ma."analyzedAt")`, `GROUP BY m."channelId", c."name", …`.
- **Recommended fix:** `.createQueryBuilder('ma').select("date_trunc('week', ma.analyzedAt)", 'weekStart').addSelect("AVG(CAST(ma.result->>'score' AS DOUBLE PRECISION))", 'avgScore').innerJoin(Message, 'm', ...).getRawMany()`. QueryBuilder permits arbitrary SELECT expressions.

#### 15. `apps/messaging-service/src/ai/services/sentiment-analysis.service.ts` (1 hit)
- **SQL:** `SELECT (ma."result"->>'score')::text as score FROM "message_analysis" ma INNER JOIN "messages" m ON ma."messageId" = m."id" AND ma."messageCreatedAt" = m."createdAt"` — composite-key join on `(messageId, messageCreatedAt)`.
- **Recommended fix:** QueryBuilder with composite join `ON ma.messageId = m.id AND ma.messageCreatedAt = m.createdAt`.

#### 16. `apps/messaging-service/src/compliance/services/data-export.service.ts` (1 hit)
- **SQL:** `SELECT "channelId" FROM "legal_holds" WHERE "tenantId" = $1 AND "isActive" = true AND "channelId" IS NOT NULL` wrapped in `.catch(() => [])`.
- **Drift:** `.catch(() => [])` is the ai-privacy anti-pattern — swallows all errors. LegalHold entity exists.
- **Recommended fix:** `legalHoldRepo.find({ where: { tenantId, isActive: true, channelId: Not(IsNull()) }, select: ['channelId'] })`. Drop the blanket catch; let failures propagate.

#### 17. `apps/messaging-service/src/guards/channel-authorization.guard.ts` (1 hit)
- **SQL:** Cross-table join `SELECT cm."id" FROM "channel_members" cm INNER JOIN "channels" c ON c."id" = cm."channelId" WHERE cm."channelId" = $1 AND cm."userId" = $2 AND c."tenantId" = $3 AND cm."leftAt" IS NULL LIMIT 1`.
- **Recommended fix:** `memberRepo.createQueryBuilder('cm').innerJoin('cm.channel', 'c').where('cm.channelId = :cid AND cm.userId = :uid AND c.tenantId = :tid AND cm.leftAt IS NULL', {...}).getCount() > 0`.

#### 18. `apps/messaging-service/src/message/queries/search-messages.handler.ts` (1 hit)
- **SQL:** `SET LOCAL statement_timeout = '${SearchMessagesHandler.SEARCH_TIMEOUT_MS}'` — Bucket A GUC. Body uses QueryBuilder already. ✓ Actually correct — only the GUC SET is raw, and that's legitimate. Misclassified by grep; remove from Bucket B.

#### 19. `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts` (27 hits)
- **SQL:** `SELECT ... FROM "${schemaName}"."tenant_roles" r LEFT JOIN "${schemaName}"."tenant_role_permissions" p ON r.id = p.role_id LEFT JOIN (SELECT role_id, COUNT(*)::int ... FROM "${schemaName}"."user_role_assignments" WHERE is_active = true GROUP BY role_id) uc ON r.id = uc.role_id ORDER BY r.level DESC, r.name ASC`, `INSERT INTO "${schemaName}"."tenant_roles" (…)`, `INSERT INTO "${schemaName}"."tenant_role_permissions" (…)`, `UPDATE "${schemaName}"."tenant_roles" SET is_default = false WHERE is_default = true`, `SELECT id FROM "${schemaName}"."tenant_roles" WHERE LOWER(name) = LOWER($1) FOR UPDATE`.
- **Entities:** **NONE EXIST** for `tenant_roles`, `tenant_role_permissions`, `user_role_assignments`. These are created via raw `CREATE TABLE IF NOT EXISTS` in `admin-api-service/src/tenant/services/tenant-provisioning.service.ts:720` (finding #3).
- **Drift detected:** No compile-time schema. Entire tenant-role subsystem is raw-SQL-only. Adding a column requires updating both the admin-api DDL (hand-maintained SQL), every SELECT that lists column names, and every INSERT. Ground zero for drift.
- **Audit theater:** **YES** — `apps/auth-service/src/modules/tenant/__tests__/tenant-role.service.spec.ts` asserts `stringContaining('WHERE r.id = $1')`, `stringContaining('FOR UPDATE')`, `stringContaining('SET is_default = false')`, `stringContaining('LOWER(name) = LOWER($1)')`, `stringContaining(schemaA)`, etc. Ten distinct SQL-string assertions.
- **Architectural severity: HIGH** — this is not just "migrate to Repository". It's "create proper `@Entity()` classes in a schema-owned module, generate migration, then switch to Repository". Pre-work blocks the migration.
- **Recommended fix:** Treat as Phase 1 of Week 2 migration — create `TenantRole`, `TenantRolePermission`, `UserRoleAssignment` entities; generate baseline migration; THEN migrate all 27 hits + all 16 hits in `admin-api-service/src/users/services/tenant-role.service.ts` (different service, same tables) in one atomic PR.

#### 20. `apps/admin-api-service/src/users/services/tenant-role.service.ts` (16 hits)
- **Same tenant_roles/tenant_role_permissions tables as #19, accessed from admin-api.** Cross-service + no entity.
- **Recommended fix:** Block on #19. Once entities exist, cross-service repository injection.

#### 21. `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts` (13 hits)
- **SQL:** Mix of tenant-scoped schema interpolation + `UPDATE "${schemaName}"."..." SET is_active = false`, `DELETE FROM "${schemaName}"."..."`.
- **Audit theater:** **YES** — spec asserts `stringContaining('is_active = false')`, `stringContaining('DELETE')`, `stringContaining(otherSchema)`. Three assertions.
- **Recommended fix:** Requires entities for tenant-scoped user assignment tables. Same pre-work as #19.

#### 22. `apps/auth-service/src/modules/tenant/services/tenant.service.ts` (10 hits)
- **SQL:** Mix of `SELECT ... FROM auth.tenants` + tenant-schema interpolation.
- **Recommended fix:** `Repository<Tenant>` for auth.tenants; sub-query blocking on #19.

#### 23. `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts` (7 hits)
- **SQL:** Similar pattern.
- **Recommended fix:** Same as #22.

#### 24. `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts` (2 hits)
- **SQL:** Small scope, same pattern.

#### 25. `apps/auth-service/src/modules/authentication/services/token.service.ts` (3 hits)
- **SQL:** `SELECT code, name, "defaultRoute" FROM auth.modules WHERE "isActive" = true ORDER BY "sortOrder" ASC, name ASC`, `SELECT m.code, m.name, m."defaultRoute" FROM auth.tenant_modules tm JOIN auth.modules m ON ...`, tenant-schema-interpolated role_permission lookup.
- **Entities exist.**
- **Drift:** The tenant-schema query is the only genuinely novel part; the two `auth.modules` queries are drop-in Repository replacements.
- **Recommended fix:** `moduleRepo.find({ where: { isActive: true }, order: { sortOrder: 'ASC', name: 'ASC' } })`; `tenantModuleRepo.find({ where: { tenantId, isEnabled: true }, relations: ['module'] })`.

#### 26. `apps/auth-service/src/modules/authentication/services/authentication.service.ts` (1 hit)
- Minor, single query.

#### 27. `apps/hr-service/src/hr/query-handlers/get-hr-dashboard-stats.handler.ts` (4 hits)
- **SQL:** `FROM employees`, `FROM attendance_records`, `FROM leave_requests`, `FROM departments_hr` — all unqualified.
- **Entities exist** in hr-service BUT lack schema decoration (ADR-011 violation — see "Out of scope").
- **Drift:** No schema qualification anywhere. Relies on search_path.
- **Audit theater:** No spec assertions.
- **Recommended fix:** QueryBuilder `.select('COUNT(*) FILTER (WHERE isDeleted = false)', 'totalEmployees').addSelect(...)` pattern with `.getRawOne()`. All four queries are aggregations expressible in QueryBuilder.

#### 28. `apps/hr-service/src/attendance/query-handlers/get-daily-attendance-overview.handler.ts` (2 hits)
- Same pattern as #27.

#### 29. `apps/hr-service/src/leave/leave-accrual.service.ts` (4 hits)
- **SQL:** Tenant-schema interpolation. Cross-tenant batch job.
- **Recommended fix:** Use `queryRunner.manager.find(LeaveBalance, ...)` after search_path is set — Repository methods respect the connection-level search_path.

#### 30. `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts` (9 hits)
- **SQL:** `CREATE TABLE IF NOT EXISTS billing.subscription_provisioning_retries (...)` + `CREATE INDEX IF NOT EXISTS` + `INSERT INTO billing.subscription_provisioning_retries ... ON CONFLICT DO NOTHING` + `UPDATE ... SET status = 'processing' ... RETURNING id, tenant_id, event_payload, retry_count` + `DELETE FROM billing.subscription_provisioning_retries WHERE id = $1`.
- **Entity:** **NONE EXISTS** — entire retry-queue subsystem is raw-SQL-only.
- **Additional:** `SELECT id, code, name FROM modules WHERE id = ANY($1)` — unqualified `modules` from a service whose search_path does NOT guarantee `auth`. If billing-service connection pool doesn't include `auth` in search_path, this query crashes.
- **Drift detected:** Runtime DDL (ADR-011/012 violation); no compile-time schema; cross-service read of `auth.modules` without schema qualification.
- **Recommended fix:**
  - Create `SubscriptionProvisioningRetry` entity + baseline migration in billing-service → delete runtime DDL.
  - Use `Repository<SubscriptionProvisioningRetry>` for the retry-queue CRUD.
  - Cross-service `auth.modules` lookup → NATS request-reply command to auth-service.

#### 31. `apps/notification-service/src/notification/services/notification-dispatcher.service.ts` (1 hit)
- **SQL:** `UPDATE notification_logs SET status = $1, retry_count = retry_count + 1 WHERE tenant_id = $2 AND status = $3 AND retry_count < $4 AND (next_retry_at IS NULL OR next_retry_at <= $5) ORDER BY created_at ASC LIMIT 100 RETURNING *`.
- **Entity:** `NotificationLog` exists `@Entity('notification_logs', { schema: 'notification' })`. SQL uses unqualified table.
- **Drift:** Column casing: SQL uses `tenant_id` (snake) but entity uses `tenantId` (camel mapped via `name: 'tenant_id'`? — needs verification). The hand-written row mapper at lines 680-698 hardcodes 13 column names.
- **Recommended fix:** QueryBuilder `.update(NotificationLog).set({...}).where(...).returning('*').execute()`. Result maps through entity metadata automatically — delete the hand-written mapper.

#### 32. `apps/farm-service/src/database/services/farm-seed.service.ts` (37 hits)
- **SQL:** Heavy INSERT … SELECT id FROM … patterns for seed data. Operates via `BypassRlsService` in production path for ref-data; dev/staging path (`NODE_ENV !== 'production'`) writes test tenants + sites + departments.
- **Entities exist for most target tables.**
- **Drift:** `INSERT INTO tenants (...)`, `INSERT INTO modules WHERE code = 'farm' OR 'FARM'` — cross-service writes from farm-seed to auth tables.
- **Severity:** LOWER — dev-only path for most inserts; reference-data inserts run in prod but are INSIDE `bypassRls.withBypass()` and target entities in the farm schema.
- **Recommended fix:** Migrate to Repository where entities exist; for `INSERT INTO tenants` (auth schema), the correct fix is to stop writing auth tables from farm-seed and use NATS `CreateTenantCommand` instead. Alternatively, since this is dev-only, defensively accept raw SQL but document with a `// DEV-ONLY:` marker and gate with `if (process.env.NODE_ENV !== 'production') throw`.

#### 33. `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` (18 hits)
- **SQL:** `SET search_path` (A) + `SELECT DISTINCT "tenantId" AS "tenantId" FROM "batches_v2" WHERE "isActive" = true LIMIT 100` (B — hardcoded table name, comment warns about prior drift).
- **Entity:** Batch exists `@Entity('batches_v2')`. Previous incident: the query used to say `FROM "batches"` after a rename to `batches_v2`, and broke.
- **Recommended fix:** `queryRunner.manager.createQueryBuilder(Batch, 'b').select('DISTINCT b.tenantId', 'tenantId').where('b.isActive = true').limit(100).getRawMany()`.

#### 34. `apps/farm-service/src/scheduler/cron-jobs.service.ts` (14 hits)
- Same pattern as #33.

#### 35. `apps/farm-service/src/weather/services/weather-cron.service.ts` (6 hits)
- Cross-tenant scan; weather-reading entities should exist. Same Repository migration pattern.

#### 36. `apps/farm-service/src/task/services/{task,recurring-task,auto-rule-trigger}.service.ts` (4+4+4 hits) & `batch/query-handlers/list-available-tanks.handler.ts` (4 hits) & `equipment/handlers/list-equipment.handler.ts` (1 hit) & `feeding/services/{daily-feeding-execution,feeding-cron}.service.ts` (1+3) & `worker/handlers/create-worker.handler.ts` (1) & `database/services/code-generator.service.ts` (1)
- Smaller scope per file; all have corresponding entities. Straightforward Repository migrations.

#### 37. `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (9 hits)
- **SQL:** Mix of (A) `SET search_path`, (B) `SELECT program_id FROM "deployment_logs" WHERE command_id = $1`, (B) `INSERT INTO sensor_metrics (...)` bulk.
- **Entity:** DeploymentLog exists; `sensor_metrics` is hypertable.
- **Drift:** `deployment_logs` Repository usage would be trivial; hypertable bulk insert justified (Bucket A/C borderline).
- **Recommended fix:** Single lookup → Repository; bulk insert → keep raw (performance).

#### 38. `apps/sensor-service/src/edge-device/edge-device.service.ts` (4 hits)
- **SQL:** `SELECT * FROM "${tenantSchema}".edge_devices WHERE "${column}" = $1 LIMIT 1` with `column` switching between `id` and `device_code` at runtime.
- **Entity:** EdgeDevice exists.
- **Drift:** Table name correct; column name selection via template string defeats type-checking.
- **Recommended fix:** `repo.findOne({ where: isUuid ? { id } : { deviceCode } })`.

#### 39. `apps/sensor-service/src/infrastructure/audit/audit.subscriber.ts` (3 hits)
- **SQL:** `INSERT INTO sensor_audit_logs (id, tenant_id, entity_type, entity_id, action, previous_value, new_value, changed_fields, changed_by, changed_at) VALUES (...)`.
- **Entity:** SensorAuditLog `@Entity('sensor_audit_logs')` — no schema decoration. Column-list mapping hardcoded.
- **Recommended fix:** `event.queryRunner.manager.insert(SensorAuditLog, { tenantId, entityType, ... })`.

#### 40. `apps/admin-api-service/src/users/services/user-role-assignment.service.ts` (5 hits)
- **SQL:** Tenant-schema interpolation writes to `user_role_assignments` — same tables as #19, #20.
- **Recommended fix:** Block on #19 entity creation.

#### 41. `apps/admin-api-service/src/users/services/role-template.service.ts` (2 hits)
- **SQL:** Tenant-schema interpolation, small scope.
- **Recommended fix:** Same as #40.

#### 42. `apps/admin-api-service/src/tenant/services/tenant-detail.service.ts` (7 hits)
- **SQL:** `FROM auth.tenants`, `FROM auth.users`, etc.
- **Recommended fix:** Cross-service Repository pattern like #8.

#### 43. `apps/admin-api-service/src/tenant/query-handlers/tenant-query.handlers.ts` (1 hit) & `apps/admin-api-service/src/billing/services/{module-pricing,subscription-plan-change}.service.ts` (2+4 hits)
- Small-scope drift-prone. Straightforward Repository migrations.

#### 44. `apps/admin-api-service/src/analytics/services/reports.service.ts` (4 hits)
- **SQL:** Analytics aggregations. Cross-service reads.
- **Recommended fix:** QueryBuilder with cross-service entity imports.

#### 45. `libs/backend-common/src/security/gdpr/gdpr.service.ts` (7 hits)
- **SQL:** `SELECT id, email, "firstName", "lastName", "createdAt", "updatedAt" FROM users WHERE id = $1`, `UPDATE users SET email = $2, "firstName" = 'Deleted', ...`, `DELETE FROM users WHERE id = $1`, `SELECT * FROM shared.audit_logs WHERE "userId" = $1`, `SELECT id, "createdAt", "ipAddress", "userAgent" FROM refresh_tokens WHERE "userId" = $1`, `DELETE FROM refresh_tokens WHERE "userId" = $1`, plus anonymize UPDATE.
- **Entities:** User (in auth-service), RefreshToken (in auth-service), AuditLogEntity (in backend-common `{ schema: 'shared' }`). **This is backend-common library code writing auth-service's tables directly.**
- **Drift detected:**
  - Cross-service write from a SHARED library into auth-service tables. Architectural anti-pattern.
  - Table `users` unqualified → relies on each consuming service's search_path including `auth`, which is not guaranteed.
  - `.catch(() => { return {} })` swallows errors — ai-privacy anti-pattern, hides drift.
- **Recommended fix (architectural):** backend-common should NOT know about concrete entity tables. Refactor: each service registers its GDPR data-collectors with their own injected Repository; backend-common's GdprService becomes a pure coordinator. This is HIGH architectural work — escalate to architectural-arbiter.

---

## Bucket C — Entity-available, discretionary

These are cases where raw SQL is currently used for readability or marginal performance, but a Repository/QueryBuilder would work. Migrate if scope permits; acceptable to defer.

- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` — bulk `sensor_metrics` INSERT (9 hits). Performance justified; Repository `.insert([{...}, {...}])` has minor per-row overhead. Keep raw.
- `apps/sensor-service/src/ingestion/{batch-processor,data-ingestion}.service.ts` — same.
- `apps/sensor-service/src/sensor/services/metric-query.service.ts` — the `SELECT name FROM sensors WHERE id = $1 AND tenant_id = $2` at line 382 wrapped in a `try { } catch {}` is pure Bucket B; everything else is TimescaleDB. Migrate just this one line.
- `apps/farm-service/src/database/services/farm-seed.service.ts` — dev-only seed data; migrate opportunistically, not required for prod safety.
- `apps/messaging-service/src/ai/queries/search-similar-messages.handler.ts` — pgvector order-by clause is Bucket A; surrounding WHERE can be QueryBuilder but would complicate the ORDER BY embedding — leave as-is with clear separation.

---

## Audit theater hit list

Tests that pin SQL strings and must be rewritten (mock-level) during the migration phase. Rewriting these tests to use spy mocks on Repository calls is part of the migration PR, not the audit.

| File | Line | Assertion | Findings it protects |
|------|------|-----------|---------------------|
| `apps/admin-api-service/src/modules/__tests__/modules.service.spec.ts` | 87 | `stringContaining('m."isActive" = $')` | #2 |
| | 102 | `stringContaining('is_core')` | #2 |
| | 117 | `stringContaining('ILIKE')` | #2 |
| | 161 | `stringContaining('WHERE')` | #2 |
| | 231 | `stringContaining('WHERE m.id = $1')` | #2 |
| | 264 | `stringContaining('WHERE m.code = $1')` | #2 |
| | 301 | `stringContaining('INSERT INTO auth.modules')` | #2 |
| | 372 | `stringContaining('UPDATE auth.modules')` | #2 |
| | 396 | `stringContaining('name = $')` | #2 |
| | 449 | `stringContaining('DELETE FROM auth.modules')` | #2 |
| | 546 | `stringContaining('tm."tenantId" = $')` | #7 |
| | 561 | `stringContaining('tm."moduleId" = $')` | #7 |
| | 574 | `stringContaining('tm."tenantId" = $')` | #7 |
| | 598 | `stringContaining('INSERT INTO auth.tenant_modules')` | #7 |
| | 633 | `stringContaining('ON CONFLICT')` | #7 |
| | 653 | `stringContaining('DELETE FROM auth.tenant_modules')` | #7 |
| `apps/auth-service/src/modules/tenant/__tests__/tenant-role.service.spec.ts` | 173 | `stringContaining('WHERE r.id = $1')` | #19 |
| | 293 | `stringContaining('FOR UPDATE')` | #19 |
| | 357 | `stringContaining('LOWER(name) = LOWER($1)')` | #19 |
| | 362 | `stringContaining('FOR UPDATE')` | #19 |
| | 385 | `stringContaining('SET is_default = false')` | #19 |
| | 696 | `stringContaining('FOR UPDATE')` | #19 |
| | 808 | `stringContaining(schemaA)` | #19 |
| `apps/auth-service/src/modules/tenant/__tests__/tenant-user-management.service.spec.ts` | 439 | `stringContaining('is_active = false')` | #21 |
| | 455 | `stringContaining('DELETE')` | #21 |
| | 664 | `stringContaining(otherSchema)` | #21 |

**Total:** 26 distinct assertions across 3 files. **Every one is a unit test that would not catch an entity-column rename** — by construction. This is the same anti-pattern that kept ai-privacy (MSG-CRITICAL-006) green in CI for an unknown duration while runtime was permanently broken.

---

## Migration ordering (recommended for Week 2)

Ordered by runtime-risk severity + blocking dependencies:

### PR 1 (ship immediately — production blocker)

**`admin-api: users.service.ts passwordHash→password drift (CRITICAL-001)`**

Scope: Fix finding #1 only. ~50 lines changed. Unblocks admin user creation and password reset.

### PR 2

**`admin-api,auth: tenant_roles entity + Repository migration (HIGH-001)`**

Scope: Findings #3, #19, #20, #21, #22, #23, #24, #40, #41.

1. Create `TenantRole`, `TenantRolePermission`, `UserRoleAssignment` entities in auth-service with `{ schema: 'auth' }` (or the tenant-schema equivalent — verify ADR-011 placement).
2. Generate baseline migration.
3. Delete runtime `CREATE TABLE IF NOT EXISTS` from `tenant-provisioning.service.ts`.
4. Migrate all 27+16+13+10+7+5+2 = 80 SQL hits across 9 files to Repository.
5. Rewrite the 10 audit-theater assertions in `tenant-role.service.spec.ts` and 3 in `tenant-user-management.service.spec.ts`.

Largest single PR of the workstream. Must land as one atomic change because all 9 files share the same 3 tables.

### PR 3

**`admin-api: modules.service + module-assignment Repository migration`**

Scope: Findings #2, #7. ~38 SQL hits.

Rewrite the 16 audit-theater assertions in `modules.service.spec.ts`. Delete `checkExtendedColumns()` — the column question is now answered by entity metadata.

### PR 4

**`admin-api,auth: user-provisioning cross-service + token.service auth.modules Repository migration`**

Scope: Findings #4, #25, #26. ~15 SQL hits. Includes likely-duplicate password drift in user-provisioning.service.ts that must be verified line-by-line.

### PR 5

**`messaging: GDPR + NATS handler + AI service Repository migration`**

Scope: Findings #9, #10, #11, #12, #13, #14, #15, #16, #17. ~40 SQL hits.

Keep narrow pgvector raw SQL helpers for `::vector` cast and `<=>` distance operator only.

### PR 6

**`admin-api,billing: billing.* cross-service Repository migration`**

Scope: Findings #5, #6, #42, #43, #44. ~60 SQL hits.

Pre-requisite: Add `{ schema: 'billing' }` decoration to billing-service entities (this is **architecturally part of the billing-service ADR-011 remediation**, see "Out of scope" below — should be done FIRST in its own PR).

### PR 7

**`billing: subscription_provisioning_retries entity + retry-queue Repository migration`**

Scope: Finding #30. New entity, baseline migration, refactor retry-queue subsystem.

### PR 8

**`hr,notification: unqualified-table-name Repository migration`**

Scope: Findings #27, #28, #29, #31. ~7 SQL hits.

Pre-requisite: Add schema decoration to hr-service entities (same ADR-011 remediation track).

### PR 9

**`farm,sensor: scheduler + edge-device cross-tenant scan Repository migration`**

Scope: Findings #33, #34, #35, #36, #38, #39. ~50 SQL hits.

Keep the `SET search_path` GUCs (Bucket A); only the `SELECT … FROM "batches_v2"` / `FROM "edge_devices"` bodies migrate.

### PR 10 (architectural — out of workstream)

**`backend-common: GDPR service decoupling (ARCH-HIGH-001)`**

Finding #45 — requires architectural-arbiter sign-off.

---

## Out of scope for Week 2 migration

### ARCH-HIGH-001 — billing-service entities lack schema decoration

**Severity:** HIGH (tracked finding)
**Owner:** billing-service owner (TBD)
**Deadline:** Before PR 6 of migration

`apps/billing-service/src/billing/entities/{invoice,payment,subscription,plan,scheduled-plan-change,subscription-module-item,tenant-usage-metrics}.entity.ts` are all `@Entity('tablename')` without `{ schema: 'billing' }`. This violates ADR-011 and means billing-service relies entirely on connection-level `search_path` to place tables in `billing` schema. Any consumer that imports these entities into a different DataSource (as admin-api-service does via readonly entity imports) will either create tables in `public` or fail depending on schema configuration.

**Fix:** Add schema decoration to all 7 entities; write baseline migration that verifies (does not recreate) tables in `billing` schema; update `MODULE_SCHEMAS` in `schema-manager.service.ts` accordingly.

### ARCH-HIGH-002 — hr-service entities lack schema decoration

**Severity:** HIGH
**Owner:** hr-service owner
**Deadline:** Before PR 8

All 20 hr-service entities are `@Entity('tablename')` unqualified. Same remediation pattern as ARCH-HIGH-001 with `{ schema: 'hr' }`.

### ARCH-HIGH-003 — auth-service User/RefreshToken/Tenant/Module entities lack schema decoration

**Severity:** HIGH
**Owner:** auth-service owner
**Deadline:** Before PR 4

`@Entity('users')`, `@Entity('refresh_tokens')`, `@Entity('tenants')`, `@Entity('modules')`, `@Entity('tenant_modules')` all unqualified. Same remediation pattern.

### ARCH-HIGH-004 — notification-service NotificationLog + AI service agent_conversations schema

**Severity:** MEDIUM
**Owner:** notification-service, ai-service owners
**Deadline:** Before PR 5, 8

`notification-service/src/notification/entities/notification-log.entity.ts` correctly has `{ schema: 'notification' }`. Good. `ai-service/src/conversation/conversation.entity.ts` has `@Entity('agent_conversations')` unqualified — needs `{ schema: 'ai' }`.

### ARCH-HIGH-005 — admin-api cross-service DB writes (NATS-MIGRATION)

**Severity:** HIGH (architectural)
**Owner:** admin-api-service owner + platform-arbiter
**Deadline:** Post-migration (Q3)

Multiple admin-api services write directly to `auth.*`, `billing.*` tables. The code is already annotated with `TODO(NATS-MIGRATION)` comments. Per-PR repository migrations partially remediate (typed column access) but do not fix the architectural boundary violation. Full remediation requires NATS request-reply commands (`CreateTenantCommand`, `AssignTenantModulesCommand`, etc.).

### ARCH-HIGH-006 — backend-common GdprService reads auth-service tables

**Severity:** HIGH (architectural)
**Owner:** platform-arbiter
**Deadline:** Q3

Finding #45. Library code should never know about concrete service tables. Requires refactor to data-collector-registration pattern.

### ARCH-MEDIUM-001 — runtime DDL violations of ADR-011/012

**Severity:** MEDIUM (each instance)
**Owners:** per service
**Deadline:** Opportunistic during migration PRs

Runtime `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` statements exist in:
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:720` (tenant_roles)
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts:484` (subscription_provisioning_retries)
- `apps/auth-service/src/database/schema-bootstrap.service.ts:41,60,82` (accessType column, mobile_user_settings backfill, TypeORM migrations table)

Each should be replaced with a proper migration file under the service's `src/database/migrations/` directory and removed from the service startup path.

---

## Appendix — methodology notes

1. **Grep filter** excludes `__tests__/`, `*.spec.ts`, `/migrations/`, `/test/`, `*.e2e-*`. 18 hits fell into these categories and were excluded; 685 remained.
2. **Bucket classification** is based on: (a) presence of corresponding `@Entity()`, (b) whether the SQL uses Postgres-specific features without Repository equivalent (pgvector, TimescaleDB time_bucket, LISTEN/NOTIFY, advisory locks, `FOR UPDATE SKIP LOCKED`, partitioning DDL, information_schema catalog), (c) whether table/column names are hardcoded in strings vs. derived from entity metadata.
3. **Audit-theater detection** used `grep` for `stringContaining` or `stringMatching` inside `.spec.ts` files with SQL keyword substrings. Three files matched, with 26 distinct assertions.
4. **Cross-service-write detection** is done by comparing the schema prefix in raw SQL (`auth.modules`, `billing.subscriptions`) against the service that contains the file. Any mismatch is a boundary violation.
5. **Entity-availability verification** relies on `grep -rn "@Entity.*tablename"` — if the entity exists, the raw SQL is migratable to Repository unless (b) above applies.

**Files reviewed in detail:** 33 of 109 (every file with Bucket B candidate classification). Remaining 76 files classified by pattern from grep results.

**Total audit time:** ~90 minutes.

---

## Traceability

This audit produces no code changes. It produces the findings catalog that Week 2 migration PRs must cite via `Closes: docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md#FINDING-N` in their commit messages, per CLAUDE.md §Review Finding Traceability.

Finding ID anchors (for `Closes:` references):

- `CRITICAL-001` → finding #1 (admin-api users.service.ts passwordHash drift)
- `HIGH-001` through `HIGH-044` → findings #2 through #45 in Bucket B
- `ARCH-HIGH-001` through `ARCH-HIGH-006` → architectural out-of-scope findings
- `ARCH-MEDIUM-001` → runtime DDL cleanup
