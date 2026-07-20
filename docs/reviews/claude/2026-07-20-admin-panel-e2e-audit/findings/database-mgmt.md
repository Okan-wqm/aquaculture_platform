# Database Management & Explorer — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## DatabaseManagementPage.tsx — `/admin/database` — verdict: **PARTIAL**

**Chain:** FE calls /api/database/* -> shell nginx rewrites /api/(.*) to /api/v1/$1 (infrastructure/nginx/droplet.conf:377-383) -> admin-api-service (default global prefix 'api/v1', libs/backend-common/src/bootstrap/create-service-app.ts:610; URI versioning VERSION_NEUTRAL keeps unversioned paths, apps/admin-api-service/src/main.ts:14-19). Every route is protected by the global PlatformAdminGuard APP_GUARD (apps/admin-api-service/src/app.module.ts:283-290) enforcing SUPER_ADMIN via RS256 JWT with issuer/audience (apps/admin-api-service/src/guards/platform-admin.guard.ts:112-177). Read chains are real: schemas list reads admin.tenant_schemas (schema-management.service.ts:83-95), migration history reads admin.schema_migrations (migration-management.service.ts:243-268), backups list reads admin.schema_backups (backup-restore.service.ts:342-367), monitoring runs live pg_stat_activity/pg_tables/pg_statio/pg_stat_user_tables queries (database-monitoring.service.ts:101-133,731-778,823-899). All tables are created by the Baseline migration in schema admin (apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:191-213) and every @Entity declares schema:'admin' (database-management.entity.ts:37,88,146,217,295,351,382). However most mutations are permanently disabled server-side by the db-migrate authority boundary (suspend/activate/refresh-stats/create-schema throw 409; migration run/rollback/batch throw 403; restore throws 400) and the FE was never updated, and Create Backup is broken at the DTO validation layer — so most action buttons on this page cannot succeed.

**Endpoints exercised:** `GET /api/v1/database/schemas`; `POST /api/v1/database/schemas/:tenantId/suspend`; `POST /api/v1/database/schemas/:tenantId/activate`; `GET /api/v1/database/schemas/:tenantId/validate`; `POST /api/v1/database/schemas/:tenantId/refresh-stats`; `GET /api/v1/database/migrations/available`; `GET /api/v1/database/migrations/history`; `POST /api/v1/database/migrations/batch/run`; `GET /api/v1/database/backups`; `GET /api/v1/database/backups/schedule`; `POST /api/v1/database/backups`; `DELETE /api/v1/database/backups/:backupId`

**DB tables:** `admin.tenant_schemas`, `admin.schema_migrations`, `admin.schema_backups`, `admin.schema_restores`, `admin.database_metrics`, `admin.slow_query_logs`, `admin.audit_logs`, `pg_stat_activity/pg_tables/pg_statio_user_tables/pg_stat_user_tables (live)`

### APA-314 [CRITICAL] Create Backup always fails with 400 — FE sends 'encrypt' field the DTO does not whitelist

- **Status:** PENDING
- **Symptom:** The Create Backup modal always includes encrypt in the POST body (page always serializes encrypt: boolean). CreateBackupDto has tenantId/backupType/compress/retentionDays/excludeTables but NO encrypt property, and the platform-wide ValidationPipe runs whitelist:true + forbidNonWhitelisted:true, so every create-backup request is rejected with 400 ('property encrypt should not exist') before reaching the service. The primary Backups-tab flow can never succeed from the UI. (Server-side, encryption is forced on anyway via resolveBackupEncryption, so the FE checkbox is doubly meaningless.)
- **Evidence:**
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:785-791 (payload includes encrypt: createForm.encrypt)`
  - `web/modules/admin-panel/src/services/api/database.ts:130-131`
  - `apps/admin-api-service/src/database-management/controllers/backup.controller.ts:47-73 (CreateBackupDto lacks encrypt)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:459-460 (whitelist:true, forbidNonWhitelisted:true)`
  - `apps/admin-api-service/src/database-management/services/backup-restore.service.ts:181-186`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-315 [HIGH] Backups can never actually complete in the deployed container — pg_dump binary, /backups volume, and BACKUP_ENCRYPTION_KEY all missing

- **Status:** PENDING
- **Symptom:** BackupRestoreService spawns pg_dump and writes AES-256-GCM-encrypted dumps to /backups/schemas. The production runtime image installs only 'curl dumb-init' (no postgresql-client), the droplet compose mounts no /backups volume for admin-api and sets no BACKUP_ENCRYPTION_KEY, so getBackupEncryptionKey() throws (or spawn ENOENT fires) and every backup — UI-triggered AND the 2AM daily / Sunday 3AM weekly crons — is marked 'failed'. The scheduled backups fail silently (error is only logged). The backup trigger therefore does NOT produce real backups in production; actual DB backups exist only via the separate pg-backup/wal-g infra containers.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/backup-restore.service.ts:61 (BACKUP_BASE_PATH '/backups/schemas'), 513-554 (spawn('pg_dump')), 556-567 (BACKUP_ENCRYPTION_KEY required), 618-667 (cron backups swallow errors)`
  - `infrastructure/docker/Dockerfile.backend:78 (runtime apk add only curl dumb-init)`
  - `docker-compose.droplet.yml:943-1009 (admin-api-service: no /backups volume, no BACKUP_ENCRYPTION_KEY env)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-316 [HIGH] Restore from backup always fails — runtime restore is disabled at the authority boundary but the FE offers it

- **Status:** PENDING
- **Symptom:** executeRestore() unconditionally marks the restore row 'failed' and throws BadRequestException('Runtime database restore is disabled. Use the audited db-migrate restore workflow instead.'). The page renders a Restore button on every completed backup and a confirm dialog warning about overwrite; the flow can never succeed and each click also inserts a failed row into admin.schema_restores.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/backup-restore.service.ts:455-471`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:811-820,955-963`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-317 [MEDIUM] Suspend/Activate schema buttons silently do nothing — backend always throws 409 and FE has no .catch

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** SchemaManagementService.updateSchemaStatus() unconditionally throws ConflictException ('Runtime admin.tenant_schemas status writes are disabled'), so suspendSchema/activateSchema can never succeed. The FE calls databaseApi.suspendSchema(...).then(refresh) with NO catch handler — the rejection is unhandled, no error UI is shown, and the row keeps its old status. Silent broken secondary flow.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/schema-management.service.ts:137-159`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:372-390 (promise without .catch)`
- **Verification:** CONFIRMED end-to-end. BE: SchemaManagementService.updateSchemaStatus() is typed `never` and unconditionally throws ConflictException ('Runtime admin.tenant_schemas status writes are disabled. Status evidence is owned by aqua-db-migrate.'); suspendSchema/activateSchema delegate to it (schema-management.service.ts:137-159), and SchemaController routes POST :tenantId/suspend|activate straight into them (schema.controller.ts:112-120) — every call is a 409. FE: apiFetch throws on 4xx with no retry (http-client.ts:309-311), and DatabaseManagementPage.tsx:373-390 chains only .then(() => schemasState.refresh()) with no .catch and no rejection handler — unhandled rejection, no error UI, row keeps old status. Reachable: the Suspend button renders for every status==='active' row. No global handler exists (adjacent buttons at lines 455-472 carry their own .catch(alert), proving per-call handling is the page's mechanism). Lint could not catch it: root no-floating-promises:'error' (eslint.config.mjs:390) excludes PROJECT_GLOBS, and admin-panel's override sets it "off" (eslint.project-overrides.mjs:2050). Severity lowered HIGH→MEDIUM: admin.tenant_schemas.status is tracking evidence only — nothing enforces tenant access from it; the real, working suspension control is PATCH /admin/tenants/:id/suspend (e2e/helpers/tenant.fixture.ts:315-342, covered by e2e/tests/integration/event-publishing.spec.ts). So impact is a dead admin control with false affordance + silent failure on a SUPER_ADMIN-only secondary flow — no security bypass, no data corruption, and the unchanged status badge gives indirect feedback after refresh. No other consumer of the schema-level suspend/activate endpoints exists (repo-wide grep), so the retired capability can be removed without breaking anything.
- **Root cause:** The 'Sites Setup SSOT remediation' retired runtime writes to admin.tenant_schemas (ownership moved to aqua-db-migrate) but applied the retirement only at the SERVICE layer — updateSchemaStatus/suspendSchema/activateSchema were tombstoned as `never`-typed throwers while the controller routes (schema.controller.ts:112-120), the FE api functions (database.ts:40-43), and the FE Suspend/Activate buttons were left standing. The drift stayed invisible because the FE call sites are fire-and-forget (.then(refresh) with no .catch) and admin-panel is exempted from the root no-floating-promises:'error' policy by its per-project ESLint override ("off", eslint.project-overrides.mjs:2050). Systemic classes: (1) capability retired mid-chain leaving live routes + FE controls pointing at tombstones (same shape as this page's createSchema/deleteSchema/refresh-stats tombstones); (2) admin-panel fire-and-forget mutations with no rejection handling, enabled by the lint-rule opt-out.
- **Fix design:** Tier 1 — make the retired capability structurally absent across the whole chain (complete the retirement instead of shimming around it): (a) delete the @Post(':tenantId/suspend') and @Post(':tenantId/activate') routes plus the already-dead UpdateSchemaStatusDto from schema.controller.ts; (b) delete the updateSchemaStatus/suspendSchema/activateSchema tombstones from schema-management.service.ts, moving the ownership statement ('admin.tenant_schemas status evidence is owned by aqua-db-migrate') to the class JSDoc; (c) delete databaseApi.suspendSchema/activateSchema from web/modules/admin-panel/src/services/api/database.ts; (d) remove the Suspend/Activate row-action buttons from DatabaseManagementPage.tsx — status stays a read-only badge, and tenant lifecycle suspension remains at its working home (PATCH /admin/tenants/:id/suspend in tenant management). TypeScript then turns any lingering reference into a compile error. Tier 3 — make the silent-failure CLASS detectable: (e) flip '@typescript-eslint/no-floating-promises' from "off" to "error" in the admin-panel block of eslint.project-overrides.mjs, aligning it with the root policy, and fix every surfaced fire-and-forget mutation (UserManagementPage.tsx, system/ImpersonationPage.tsx, remaining DatabaseManagementPage.tsx sites) by handling rejection in the UI via the page's established .catch(err => alert(...)) pattern — no eslint-disable, no allowlist; (f) update the admin-panel snapshot in tools/lint-gates/fixtures/eslintrc-flat-parity.fixture.json so the parity gate encodes the tightening intentionally; (g) add a backend surface gate spec asserting via Nest route metadata that SchemaController exposes no ':tenantId/suspend'/':tenantId/activate' routes, so the retired capability cannot silently return.
- **Files to change:**
  - `apps/admin-api-service/src/database-management/controllers/schema.controller.ts`
  - `apps/admin-api-service/src/database-management/services/schema-management.service.ts`
  - `web/modules/admin-panel/src/services/api/database.ts`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx`
  - `web/modules/admin-panel/src/pages/UserManagementPage.tsx`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `eslint.project-overrides.mjs`
  - `tools/lint-gates/fixtures/eslintrc-flat-parity.fixture.json`
  - `apps/admin-api-service/src/database-management/__tests__/schema-controller-surface.spec.ts`
- **Proof of fix:** New spec apps/admin-api-service/src/database-management/__tests__/schema-controller-surface.spec.ts: reads SchemaController route metadata and asserts no suspend/activate status-mutation routes exist and SchemaManagementService has no status-write methods. Class-level gate: `nx affected --target=lint` now enforces no-floating-promises:error over web/modules/admin-panel, so any future fire-and-forget mutation fails CI; tools/lint-gates/eslintrc-flat-parity.spec.ts stays green against the updated fixture (proves the tightening is encoded, not drift). `npm run type-check` fails on any lingering databaseApi.suspendSchema/activateSchema reference (tier-1 proof). Regression guard: existing e2e/tests/integration/event-publishing.spec.ts 'maintain schema through suspend/activate cycle' still passes — it uses the real tenant lifecycle routes (/admin/tenants/:id/suspend|activate), which are untouched.
- **Effort:** M

### APA-318 [HIGH] Slow Queries panel can never display data — backend returns a SlowQueryResult object, FE expects an array

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** GET /database/monitoring/slow-queries?grouped=true returns {source, data: [...], metadata} (SlowQueryResult). The FE types it as Array<{query,count,avgTime,...}> and the page checks slowQueries.length > 0 on the envelope-unwrapped OBJECT — undefined > 0 is false, so the panel always renders 'No slow queries detected' regardless of real slow-query volume. The actual rows sit one level down in .data and are never read.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts:298-344,353-435 (returns SlowQueryResult)`
  - `apps/admin-api-service/src/database-management/entities/database-management.entity.ts:588-592`
  - `web/modules/admin-panel/src/services/api/database.ts:172-174 (typed as flat array)`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:1167-1189,1364-1411`
- **Verification:** Confirmed end-to-end. BE: monitoring.controller.ts:77-90 returns SlowQueryResult {source, data, metadata} on every service path (slow_query_logs, pg_stat_statements, pg_stat_activity, error fallbacks). ResponseInterceptor's pagination-flatten branch requires 'total' at top level (response.interceptor.ts:47-52) but SlowQueryResult nests total inside metadata, so the whole object is wrapped {success,data:SlowQueryResult,meta:{timestamp}}. FE http-client.ts:341-349 unwraps exactly once (inner object lacks 'success', no double-unwrap), delivering the {source,data,metadata} object where database.ts:172-174 falsely asserts Array<{query,count,avgTime,...}> via the unchecked apiFetch<T> generic. DatabaseManagementPage.tsx:1188 treats the truthy object as the array; :1364 'slowQueries.length > 0' evaluates undefined > 0 = false, so the panel unconditionally renders 'No slow queries detected.' (:1406-1410) — rows in .data and the source/metadata diagnostics are never read. MonitoringTab is reachable (:1511). No alternate route; the only contract gate (contract-validation.spec.ts) checks URL/method existence, not shape, so CI cannot catch it. HIGH stands: a SUPER_ADMIN monitoring control that structurally can never display data and asserts an affirmative false negative to the operator, masking real DB performance incidents (not CRITICAL: no security/data-integrity impact). This is an instance of the systemic FE-type-drift/envelope-shape-mismatch class — every apiFetch<T> generic in services/api/* is an unverified cast.
- **Root cause:** The FE→BE type link broke at the unchecked apiFetch<T> cast. The backend endpoint evolved into the structured SlowQueryResult envelope (source/metadata added for graceful pg_stat_statements→pg_stat_activity fallback) while the hand-written inline generic in web/modules/admin-panel/src/services/api/database.ts stayed at the older flat-array shape. Nothing binds the two sides: no shared type artifact between apps/admin-api-service and the admin-panel FE, and the only CI contract gate (contract-validation.spec.ts) validates route existence, not response shape. The page's `.length > 0` truthiness guard then converted the shape mismatch into a silent false 'No slow queries detected' instead of a visible failure. Systemic class: FE hand-written response-type drift.
- **Fix design:** Tier 1 (make drift a compile error) + tier 3 gate; pattern-level plus local application. PATTERN: use the existing runtime-dependency-free FE/BE contract lib @aquaculture/shared-contracts (libs/shared-contracts, aliased in tsconfig.base.json, already consumed by web/apps/aquamobil) as the single home for this wire contract. Add libs/shared-contracts/src/admin/database-monitoring.ts exporting SlowQuerySource, per-source item interfaces (GroupedSlowQueryItem {query,count,avgTime,maxTime,minTime,lastSeen}; PgStatStatementsItem {query,count,avgTime,maxTime,minTime,totalTime,totalRows}; PgStatActivityItem {query,state,elapsedMs,username,database,applicationName,clientAddr,queryStart,waitEventType,waitEvent}; SlowQueryLogItem), SlowQueryResultMetadata, and SlowQueryResult as a discriminated union keyed on `source` whose variants fix the `data` element type — eliminating the current `Record<string, unknown>[]` erasure. Export from index.ts. BACKEND: database-management.entity.ts deletes its local SlowQuery* declarations and re-exports the shared ones; database-monitoring.service.ts return types compile against the shared union, so each source branch's mapped rows must satisfy the typed item interface and any future BE shape change breaks the build. FRONTEND: add the @aquaculture/shared-contracts alias to admin-panel's tsconfig/vite config (same mechanical entries aquamobil carries); database.ts types getSlowQueries as Promise<SlowQueryResult> (inline array generic deleted); DatabaseManagementPage.tsx deletes the local SlowQueryItem interface, uses useAsyncData<SlowQueryResult> with a typed empty initial value {source:'none', data:[], metadata:{total:0, limit:20}}, renders rows from result.data narrowed by the `source` discriminant, and surfaces `source` plus metadata.note/error in the panel header (that diagnostic metadata was designed for the operator and is currently discarded — part of the defect). After the type change, npm run type-check fails on any array-shaped consumption, making this drift structurally impossible and establishing the shared-contract home for sibling findings of the same class. Tier-3 gate: a supertest spec boots the module with the real ResponseInterceptor and asserts the wire shape (rows under .data, total inside metadata — i.e. the interceptor pagination branch must not fire), plus an FE component spec proving rows render from a realistic wire envelope (fails against current code). No defensive ?., no casts, no allowlists.
- **Files to change:**
  - `libs/shared-contracts/src/admin/database-monitoring.ts`
  - `libs/shared-contracts/src/index.ts`
  - `apps/admin-api-service/src/database-management/entities/database-management.entity.ts`
  - `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts`
  - `web/modules/admin-panel/src/services/api/database.ts`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx`
  - `web/modules/admin-panel/tsconfig.json`
  - `web/modules/admin-panel/vite.config.ts`
  - `apps/admin-api-service/src/database-management/__tests__/monitoring-slow-queries.contract.spec.ts`
  - `web/modules/admin-panel/src/pages/__tests__/DatabaseManagementPage.monitoring.spec.tsx`
- **Proof of fix:** 1) New apps/admin-api-service/src/database-management/__tests__/monitoring-slow-queries.contract.spec.ts: supertest against a test module wired with the real ResponseInterceptor and a stubbed slowQueryRepository/queryRunner returning rows; GET /database/monitoring/slow-queries?grouped=true must yield {success:true, data:{source:'slow_query_logs', data:[...rows], metadata:{total,limit,minExecutionTimeMs}}} — asserting rows live under data.data and the interceptor's pagination branch did not restructure the payload; the body is type-checked against the shared SlowQueryResult contract. 2) New web/modules/admin-panel/src/pages/__tests__/DatabaseManagementPage.monitoring.spec.tsx: render MonitoringTab with fetch mocked to the same wire envelope and assert the grouped query text and count appear in the table (this test FAILS on current code — 'No slow queries detected.' renders — proving the defect and the fix); also assert the source/metadata note surfaces for a pg_stat_activity fallback payload. 3) Compile-time invariant: npm run type-check fails if either side drifts from @aquaculture/shared-contracts SlowQueryResult (BE service return type and FE consumption both import it). Existing contract-validation.spec.ts continues to guard route existence.
- **Effort:** M

### APA-319 [HIGH] Database Health 'Slow Queries' check uses an inverted time filter — counts everything EXCEPT the last hour

- **Status:** PENDING
- **Symptom:** getDatabaseHealthStatus counts recentSlowQueries with recordedAt: LessThan(Date.now() - 3600000) — i.e. rows OLDER than one hour — while the comment and check say 'last hour'. The count grows monotonically until the 30-day cleanup, so the health score/status degrades over time based on historical rows and never reflects the actual last hour. Silent wrong data on the page's headline health widget.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts:989-1020 (LessThan with 'Last hour' comment)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-320 [HIGH] Validate Isolation always reports 'Issues found' — field name drift (isIsolated vs valid)

- **Status:** PENDING
- **Symptom:** Backend returns {isIsolated, issues}; the FE api type and the page read result.valid, which is always undefined/falsy, so the alert always takes the failure branch and prints 'Issues found: ' (empty list) even for a perfectly isolated schema. The real validation (cross-schema FK + shared-sequence queries) runs, but its verdict is never rendered correctly.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/schema-management.service.ts:197-252 (returns isIsolated)`
  - `web/modules/admin-panel/src/services/api/database.ts:46-47 (typed {valid, issues})`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:454-459`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-321 [MEDIUM] Backup Schedule card always shows 'Not configured' + suspended — response shape drift

- **Status:** PENDING
- **Symptom:** Backend GET /database/backups/schedule returns {dailyBackupEnabled, weeklyBackupEnabled, nextDailyBackup, nextWeeklyBackup, lastDailyBackup, lastWeeklyBackup}; the FE expects {enabled, schedule, lastRun, nextRun}. scheduleState.data.schedule and .enabled are undefined, so the card renders 'Not configured' with a suspended badge even though daily/weekly cron backups are registered — factually wrong operator information.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/backup-restore.service.ts:804-841`
  - `web/modules/admin-panel/src/services/api/database.ts:126-127`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:854-874`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-322 [MEDIUM] Point-in-Time Recovery modal is not wired — inputs are dead and the API is never called

- **Status:** PENDING
- **Symptom:** The PITR modal's Target Tenant ID and Recovery Point inputs are uncontrolled (no state, no onChange) and the Start Restore button only executes when selectedBackup exists (the non-PITR path). databaseApi.pointInTimeRecovery exists in the FE api layer and POST /database/backups/restore/point-in-time exists on the backend, but the page never calls it — clicking Start Restore in PITR mode is a no-op.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:1093-1111 (uncontrolled inputs),1128-1133 (only handleRestoreBackup when selectedBackup)`
  - `web/modules/admin-panel/src/services/api/database.ts:140-144 (unused pointInTimeRecovery)`
  - `apps/admin-api-service/src/database-management/controllers/backup.controller.ts:212-229`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-323 [MEDIUM] Migrations tab is vestigial — registry is permanently empty and all run/rollback/batch endpoints unconditionally 403

- **Status:** PENDING
- **Symptom:** MIGRATION_REGISTRY = [] ('Runtime admin-api does not own migration definitions'), so GET /database/migrations/available always returns [] and the Available Migrations list is permanently empty; the Batch Migration modal can never select a version. Even if forced, POST batch/run, tenant/:id/run and tenant/:id/rollback call assertRuntimeMigrationEndpointAllowed() which throws ForbiddenException before any work (the version checks after it are dead code). Only migration HISTORY (admin.schema_migrations reads) is real.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/migration-management.service.ts:37-39 (empty registry),129-157,215-224 (always reject)`
  - `apps/admin-api-service/src/database-management/controllers/migration.controller.ts:88-92,122-187 (throw-first, unreachable code after)`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:527-544,559-569`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-324 [MEDIUM] Index Recommendations render an empty SQL block — backend has no createStatement field

- **Status:** PENDING
- **Symptom:** The page renders rec.createStatement in a <code> block, but the backend IndexRecommendation contains recommendedAction/indexName/authority instead of createStatement — the recommendation is real (pg_stat_user_tables seq-scan/unused-index analysis) but the actionable SQL the UI promises is always undefined/empty.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:1443-1445`
  - `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts:852-864,882-893`
  - `apps/admin-api-service/src/database-management/entities/database-management.entity.ts:543-552`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-325 [MEDIUM] Schemas tab stats may be stale/zero — tenant_schemas sizeBytes/tableCount are ledger columns with no runtime refresh path

- **Status:** PENDING
- **Symptom:** The summary cards (Total Size, Total Tables) and per-row Size/Tables read admin.tenant_schemas.sizeBytes/tableCount, which default to 0 and can only be updated by db-migrate: updateSchemaStats/refresh-stats always throws 409, so the 'Refresh Stats' button always alerts a failure and the numbers on screen are whatever the last db-migrate ledger write left (live sizes ARE computed by getSchemaInfo, but that endpoint is not used by the page list). Also the 'Create Schema' button has no onClick handler at all (dead), and the backend createTenantSchema is disabled anyway.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/entities/database-management.entity.ts:56-63 (defaults 0)`
  - `apps/admin-api-service/src/database-management/services/schema-management.service.ts:68-74,441-447`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:304-315,329-331 (no onClick),466-473`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-326 [MEDIUM] FE api layer declares ~14 endpoints that do not exist on the backend (404 if ever used) plus hand-written type drift

- **Status:** PENDING
- **Symptom:** database.ts ships functions with no matching route: getSchemaInfo-adjacent resetSchema/optimizeSchema/analyzeSchema (schema.controller has no reset/optimize/analyze); legacy getMigration(:id), createMigration POST /migrations, runMigration(:id/run), rollbackMigration(:id/rollback), getPendingMigrations(/pending); monitoring getDatabaseStats(/stats), getTableStats(/tables), runVacuum(/vacuum), runAnalyze(/analyze); scheduleBackup POST /backups/schedule (route is GET-only); deleteSchema cannot pass the required confirmToken for hardDelete. types/database.ts also drifts from entities: TenantSchema.tenantName/rowCount never returned, status enum mismatch ('archived'/'migration_pending' vs 'creating'/'migrating'/'pending_deletion'/'deleted'); SchemaMigration.appliedToSchemas/failedSchemas/createdBy/sql do not exist (entity: migrationName/upScript/executedBy); DatabaseBackup.type/location/compressionType/encryptionKey/createdBy vs entity backupType/filePath/isCompressed/isEncrypted — the page survives only via ad-hoc inline fallback fields.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/database.ts:56-61,106-115,156-157,197-204`
  - `apps/admin-api-service/src/database-management/controllers/schema.controller.ts:72-196 (route set)`
  - `apps/admin-api-service/src/database-management/controllers/monitoring.controller.ts:49-137 (route set)`
  - `web/modules/admin-panel/src/services/types/database.ts:5-83 vs apps/admin-api-service/src/database-management/entities/database-management.entity.ts:37-211`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## DatabaseExplorerPage.tsx — `/admin/database/explorer` — verdict: **PARTIAL**

**Chain:** Read chain is fully real and defensively built: GET /api/v1/database/explorer/schemas|/schemas/:schema/tables|/tables/:table/data run on a dedicated 'explorer-readonly' DataSource with default_transaction_read_only=on at the connection level plus SET TRANSACTION READ ONLY per runner (app.module.ts:135-170, explorer.controller.ts:280-287). Schema access is allowlisted to public/auth/admin/billing, tenant_<uuid> schemas are NOT exposed, module tables are blocklisted from MODULE_SCHEMAS (the SSoT), identifiers are regex-validated, LIMIT/OFFSET are parameterized, credential-pattern columns are always masked server-side, and every read/export is fail-closed audited into admin.audit_logs (requireAuditLog blocks the response if the audit row does not persist). Row CRUD uses the write DataSource but is double-gated: ENABLE_DB_EXPLORER_WRITES must be 'true' AND NODE_ENV must not be production, so in production every insert/update/delete returns 403. Export is throttled (@ThrottleExport 5/hr) and raw SQL (POST /database/explorer/query) is flag-gated + non-prod + SELECT-only with statement/function/schema blocklists; the FE has no raw-SQL caller. Main breakages: the global ResponseInterceptor corrupts the export download, and the edit modal would write the '********' mask back into real columns if writes were enabled.

**Endpoints exercised:** `GET /api/v1/database/explorer/schemas`; `GET /api/v1/database/explorer/schemas/:schema/tables`; `GET /api/v1/database/explorer/schemas/:schema/tables/:table/data`; `POST /api/v1/database/explorer/schemas/:schema/tables/:table/rows`; `PUT /api/v1/database/explorer/schemas/:schema/tables/:table/rows/:id`; `DELETE /api/v1/database/explorer/schemas/:schema/tables/:table/rows/:id`; `GET /api/v1/database/explorer/schemas/:schema/tables/:table/export`; `POST /api/v1/database/explorer/query (backend only, no FE caller)`

**DB tables:** `information_schema.* + pg_tables/pg_index/pg_class (metadata)`, `any table in public/auth/admin/billing schemas (browse/CRUD/export)`, `admin.audit_logs (fail-closed audit of every read/export/write-intent)`

### APA-327 [HIGH] CSV/JSON export downloads a JSON envelope, not the data — global ResponseInterceptor wraps the StreamableFile

- **Status:** PENDING
- **Symptom:** exportTableData returns a StreamableFile (CSV) or a rows array (JSON) with Content-Disposition set, but the app-wide ResponseInterceptor (skip list only /health,/docs) maps EVERY body into {success,data,meta}. A StreamableFile wrapped inside a plain object is no longer detected by Nest's response handler, so the 'CSV' download serializes the envelope object instead of streaming the buffer; the JSON export delivers {success:true,data:[...],meta:...} instead of the row array. The FE only checks response.ok and saves whatever arrives — user silently gets a corrupted export file. This breaks any binary/file endpoint in admin-api, not just this one.
- **Evidence:**
  - `apps/admin-api-service/src/shared/response.interceptor.ts:23-24,44-74`
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:543-647 (StreamableFile + rows return)`
  - `web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx:96-126 (blind blob download)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-328 [HIGH] Edit Row writes the '********' mask back into real sensitive columns when writes are enabled

- **Status:** PENDING
- **Symptom:** Rows arrive with credential columns masked to '********'. RowEditorModal seeds formData with formatValue(row[col]) — i.e. the literal mask — and for sensitive columns renders NO input ('Clear to unset' is impossible: there is nothing to clear). handleSave includes every column in parsedData, so saving ANY edit on a row with masked columns sends data: {password_hash:'********', ...} and the backend updateRow blindly executes UPDATE ... SET "password_hash"='********'. With ENABLE_DB_EXPLORER_WRITES=true (dev/staging), one edit in auth.users silently destroys the real hash/token. The insert path has the same property for defaulted sensitive columns.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx:150 (MASKED_VALUE),190-203 (formData seeded with mask),222-259 (all columns serialized),307-311 (no input for sensitive columns)`
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:98,117-128 (masking),726-788 (update applies any validated column verbatim)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-329 [HIGH] Explorer read/export/raw-SQL audit rows record performedBy:'SUPER_ADMIN' literal instead of the actual operator

- **Status:** PENDING
- **Symptom:** The write-intent audits correctly capture getAuthUser(req).id/email/IP, but DATABASE_EXPLORER_READ, DATABASE_EXPLORER_EXPORT and DATABASE_EXPLORER_RAW_SQL — the highest-leak-risk actions per the code's own comments — hardcode performedBy:'SUPER_ADMIN' with no user id, email, or IP, even though the request user is available. The SOC 2 evidence chain cannot answer 'which admin exported auth.users' — silently wrong audit data.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:518-523 (READ),597-603 (EXPORT),1051-1061 (RAW_SQL) vs 331-354 (write intent uses getAuthUser)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-330 [MEDIUM] insert/update responses return the raw RETURNING * row unmasked

- **Status:** PENDING
- **Symptom:** insertRow and updateRow return result[0] from 'INSERT/UPDATE ... RETURNING *' without maskSensitiveData, so when writes are enabled the HTTP response exposes the very columns (password_hash, tokens, secrets) that the read path always masks. deleteRow similarly returns the full deleted row.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:709-715,774-784,824-834`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-331 [MEDIUM] Write UI (New Row / Edit / Delete) is always rendered but always 403 in production

- **Status:** PENDING
- **Symptom:** assertExplorerWritesEnabled requires ENABLE_DB_EXPLORER_WRITES='true' and rejects outright when NODE_ENV=production. The page renders New Row, per-row Edit and Delete unconditionally with no capability check, so in production every save/delete attempt ends in a 403 error message. The FE should not offer permanently-disabled controls.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:313-322`
  - `web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx:595-600,757-776`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-332 [MEDIUM] Raw SQL endpoint returns rows unmasked and its catalog blocklist misses unqualified references

- **Status:** PENDING
- **Symptom:** POST /database/explorer/query (no FE caller; gated to non-prod + ENABLE_RAW_SQL_EXPLORER) returns query results with NO sensitive-column masking — SELECT password_hash FROM auth.users returns real hashes, bypassing the masking layer the browse path enforces. The schema blocklist only matches 'pg_catalog.'/'information_schema.' PREFIXED references, so unqualified catalog names resolve via search_path (e.g. SELECT * FROM pg_stat_activity exposes other sessions' SQL text). Mitigations are real (read-only DataSource, SELECT/WITH-only, semicolon/multi-statement block, dangerous-function blocklist, tenant_/module-table patterns, 30s timeout, fail-closed audit), so this is a defense-in-depth gap rather than a live hole.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:919-1069 (no masking on result),1016-1029 (prefix-only schema blocklist)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-333 [MEDIUM] Personal PII is not masked — masking covers credentials only, and export pulls up to 10K rows

- **Status:** PENDING
- **Symptom:** SENSITIVE_COLUMNS matches password/token/secret/key/hash-style names only. Emails, names, phone numbers, addresses in auth.* and billing.* (cross-tenant data for ALL tenants) render fully and can be exported (limit 10,000 rows, 5 exports/hr). For a SUPER_ADMIN debug tool this may be accepted, but it contradicts the platform's mask-PII-in-logs posture and makes bulk PII exfiltration a single audited click.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:73-98 (mask list),557 (export limit 10000)`
  - `ALLOWED_SCHEMAS includes auth/billing: explorer.controller.ts:46`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-334 [LOW] Sorting on masked columns leaks relative ordering of the hidden values

- **Status:** PENDING
- **Symptom:** orderBy accepts any valid identifier including sensitive columns; the server sorts by the REAL value then masks, so an operator can binary-search relative ordering of masked data (e.g. token prefixes) via ORDER BY. Niche, but trivially closed by rejecting orderBy on sensitive columns.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:463-464,491-499 (order by real column, mask after)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## Cross-cutting findings

### APA-335 [HIGH] db-migrate authority boundary was implemented server-side but never propagated to the admin-panel FE

- **Status:** PENDING
- **Symptom:** A deliberate architectural decision moved all runtime DDL authority to aqua-db-migrate: schema create/suspend/activate/delete/refresh-stats throw 409, migration run/rollback/batch throw 403, restore throws 400, schema sync is report-only. The admin panel still renders all of these controls as if functional — six visible flows (Suspend, Activate, Refresh Stats, Batch Migration, Restore, PITR) plus Create Schema can never succeed, two of them fail silently (no .catch). This single root cause produces most of the page-level breakage above; the FE needs the same authority model (hide/disable + explain) or the endpoints should return capability metadata.
- **Evidence:**
  - `apps/admin-api-service/src/database-management/services/schema-management.service.ts:68-74,137-159,441-447,484-499`
  - `apps/admin-api-service/src/database-management/controllers/migration.controller.ts:88-92`
  - `apps/admin-api-service/src/database-management/services/backup-restore.service.ts:455-471`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx:372-390,559-569,955-963`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-336 [HIGH] Global ResponseInterceptor has no StreamableFile/binary bypass — every file-download endpoint in admin-api is corrupted

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** ResponseInterceptor wraps all bodies except /health and /docs prefixes in the {success,data,meta} envelope. Any controller returning StreamableFile (explorer CSV export today, any future report/backup download) gets its stream wrapped in a plain object, defeating Nest's StreamableFile handling and serializing garbage JSON to the client. Fix belongs in the interceptor (skip when data instanceof StreamableFile / Buffer / when Content-Disposition is set), not per-endpoint.
- **Evidence:**
  - `apps/admin-api-service/src/shared/response.interceptor.ts:44-74`
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:643 (StreamableFile return)`
- **Verification:** CONFIRMED end-to-end. ResponseInterceptor is a global APP_INTERCEPTOR (app.module.ts:291-294) whose only bypass is request-URL-prefix matching (/health, /docs*); its map() is response-type-blind. The explorer export endpoint (explorer.controller.ts:544-647) uses @Res({passthrough:true}) — the Nest-idiomatic pattern where the framework owns the reply — and returns new StreamableFile(buffer) for CSV. Nest's ExpressAdapter runs its `body instanceof StreamableFile` check on the POST-interceptor body; the envelope {success,data:StreamableFile,meta} fails it, so Express JSON-serializes the wrapper (Content-Type stays text/csv, already set via res.setHeader) — the client receives JSON garbage with HTTP 200. FE reachability confirmed: DatabaseExplorerPage.tsx:96-126 fetches this URL, blobs the 200 response, and saves table_export.csv — silent corruption, no error surfaced. The format=json branch is also broken: the downloaded artifact is the envelope, not the row array. One correction to the finding's scope: NOT every download endpoint is corrupted today — reports.controller.ts:295-305 and audit-trail.controller.ts:430-451 work because they use raw @Res() + res.send(), which skips Nest reply handling entirely; but that is precisely the per-endpoint escape-hatch accretion the interceptor forces, confirming the systemic class. HIGH is correct: a primary SUPER_ADMIN feature (the endpoint the code itself calls 'the highest-leak-risk SUPER_ADMIN action', hard-gated on audit persistence) silently delivers corrupted files in both formats, and every future idiomatic download endpoint is a trap. Not CRITICAL: functional break, no security/data-loss impact.
- **Root cause:** The response-envelope cross-cutting concern was implemented as a request-URL-prefix allowlist instead of a response-type-aware transform. Nest's contract is that adapter-level StreamableFile handling applies to the FINAL post-interceptor body (which is why Nest core's own ClassSerializerInterceptor special-cases StreamableFile); a global map() that wraps unconditionally therefore structurally defeats streaming. The interceptor was written when every admin-api endpoint returned a JSON DTO; download endpoints drifted in later under a different contract (bytes + Content-Disposition, not envelope). Two of the three (reports, audit-trail) dodged the bug by dropping to raw @Res()+res.send() — abandoning the framework reply path and hiding the defect — while the one endpoint using the idiomatic StreamableFile+passthrough pattern (explorer export) broke. No test asserts bytes-on-the-wire for any download, so the corruption was undetectable at build/test time. This is the systemic 'envelope/shape mismatch' class: the BE envelope contract has no type-level carve-out for the binary-response contract, so each new download endpoint must either break or work around.
- **Fix design:** Pattern-level fix (tier 1-2: make correct behavior automatic and wrong behavior impossible), plus local applications and a test gate. (A) Interceptor: make the bypass TYPE-driven, not URL-driven — in ResponseInterceptor.map(), return data unchanged when `data instanceof StreamableFile` (import from @nestjs/common) or `Buffer.isBuffer(data)`. This is the same structural rule Nest core applies in ClassSerializerInterceptor; it makes every current and future download endpoint correct with zero per-endpoint effort. No Content-Disposition sniffing — the type is the contract. (B) One download idiom, applied everywhere: (1) explorer.controller.ts format=json branch returns `new StreamableFile(Buffer.from(JSON.stringify(rows)))` instead of the raw rows array, so 'file download' is expressed by exactly one type and the interceptor rule is total; (2) converge reports.controller.ts downloadExecution and audit-trail.controller.ts exportAuditTrail from raw @Res()+res.send() to @Res({passthrough:true})+StreamableFile, eliminating the two escape-hatch instances so all downloads flow through the framework reply path and the global interceptor stack (incl. AdminBypassRlsInterceptor) uniformly. (C) Detectability gate (tier 3): unit spec proving StreamableFile/Buffer pass through unwrapped while DTOs and paginated shapes still wrap; supertest integration spec asserting bytes-on-the-wire for all three download routes (Content-Type, Content-Disposition, body starts with CSV header / parses as raw row array, body contains no '"success":true'); plus a static invariant failing any admin-api controller that uses @Res() without passthrough, making future escape-hatch regressions build-time detectable. No allowlist additions to SKIP_PREFIXES — that mechanism stays for the two genuinely non-enveloped infra prefixes only.
- **Files to change:**
  - `apps/admin-api-service/src/shared/response.interceptor.ts`
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`
  - `apps/admin-api-service/src/analytics/controllers/reports.controller.ts`
  - `apps/admin-api-service/src/security/controllers/audit-trail.controller.ts`
  - `apps/admin-api-service/src/shared/__tests__/response.interceptor.spec.ts`
  - `apps/admin-api-service/src/__tests__/integration/download-envelope.spec.ts`
- **Proof of fix:** New unit spec apps/admin-api-service/src/shared/__tests__/response.interceptor.spec.ts: (1) a handler emitting StreamableFile reaches the subscriber unwrapped (same instance, instanceof StreamableFile); (2) Buffer passes unwrapped; (3) plain DTO still wraps as {success:true,data,meta.timestamp}; (4) {data,total,page,limit,totalPages} still lifts pagination into meta — proving the envelope contract is unchanged for JSON bodies. New integration spec apps/admin-api-service/src/__tests__/integration/download-envelope.spec.ts (supertest against the bootstrapped app with guards overridden): GET /database/explorer/.../export?format=csv returns 200 with Content-Type text/csv, Content-Disposition attachment, body beginning with the CSV header row and NOT containing '"success":true'; format=json body JSON.parses to the raw row array (not an envelope); reports executions/:id/download and security/audit-trail/export return their declared mimeType bytes unenveloped. Same spec carries the static invariant: read all apps/admin-api-service/src/**/controllers/*.ts and fail on any @Res( not immediately followed by {passthrough: true} — locking the single download idiom. Then nx affected --target=test && nx affected --target=lint green.
- **Effort:** M

### APA-337 [HIGH] Admin-panel 'Backups' feature is a paper capability in production — runtime dependencies absent from the deploy

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The backup implementation is real code (pg_dump + AES-256-GCM + admin.schema_backups ledger + fail-closed audit) but the production deployment gives admin-api no pg_dump binary (Alpine image installs only curl/dumb-init), no persistent /backups volume, and no BACKUP_ENCRYPTION_KEY. UI-triggered and cron backups all land as status='failed'; cron failures are only logged. Either the deploy must ship pg_dump + volume + key to admin-api, or the feature should delegate to the existing pg-backup/wal-g infra containers and the panel should surface THOSE backups.
- **Evidence:**
  - `infrastructure/docker/Dockerfile.backend:78`
  - `docker-compose.droplet.yml:943-1009`
  - `apps/admin-api-service/src/database-management/services/backup-restore.service.ts:513-560,618-667`
  - `infrastructure/docker/Dockerfile.pg-backup:6-23 (real backup path lives elsewhere)`
- **Verification:** CONFIRMED, and the failure is worse than stated. (1) Production images build from infrastructure/docker/Dockerfile.backend.simple (deploy-digitalocean.yml:900, deploy-staging.yml:428) — the auditor cited Dockerfile.backend:78, but BOTH install only curl+dumb-init; no pg_dump anywhere. (2) admin-api in docker-compose.droplet.yml:1002-1007 mounts only NATS certs + JWT key — no /backups volume — and runs as non-root uid 1001, so mkdir('/backups/schemas/...') fails EACCES; that mkdir (backup-restore.service.ts:202) executes BEFORE the try block (line 210), so prod ledger rows stick at status='in_progress' (not 'failed'), the POST returns 500, and cron failures are only logged. (3) BACKUP_ENCRYPTION_KEY is set in zero compose files/env templates/k8s manifests repo-wide, and encryption is mandatory (resolveBackupEncryption forbids plaintext). (4) A fourth missing dependency the auditor missed: the admin_service DB role has grants only on admin/auth/billing/shared — no SELECT on tenant_* schemas — so pg_dump --schema=tenant_x would fail on permissions even with binary+volume+key. Crons are live (ScheduleModule.forRoot, app.module.ts:178) and write a CRITICAL-severity SCHEMA_BACKUP_CREATE_REQUESTED audit row per tenant per night before failing (self-polluting audit). Blast radius exceeds the panel: tenant-provisioning.service.ts:1014-1036 (backupTenantData) fail-closes deprovisioning on backup proof, so tenant offboarding/GDPR cleanup is structurally impossible in production. Severity stays HIGH (not CRITICAL: everything fails closed, no data loss or security bypass, and cluster-level DR genuinely exists via WAL-G + backup-production.yml; not MEDIUM: a SUPER_ADMIN DR surface misrepresents backup posture, deprovisioning is hard-blocked, and audit/ledger pollution accrues nightly).
- **Root cause:** Not FE-BE drift — FE types, api fns, controller, service, entity, and migration all align. The broken link is service-runtime vs deployment-contract: BackupRestoreService carries four implicit host dependencies (pg_dump binary in the image, a writable persistent /backups volume, BACKUP_ENCRYPTION_KEY env, and tenant-schema SELECT grants for the admin_service role) that are declared in no deployable artifact (Dockerfile package list, compose volume, compose :?-guarded env, DB grant script) and asserted by no boot-time or CI check, so the gap is invisible until a 2AM cron or a UI click. It drifted because production DR authority moved to INFRA-BACKUP-001 (WAL-G continuous archiving on the postgres container + backup-production.yml pg_dump-to-Spaces + tools/scripts/database/backup-databases.sh + the pg-backup image), and the restore half of this very service was migrated to the authority-boundary pattern (executeRestore unconditionally rejects with RUNTIME_RESTORE_AUTHORITY_ERROR, delegating to db-migrate) while the backup half kept its in-process pg_dump execution path. This is an instance of the systemic class 'runtime dependency absent from the deploy contract' (spawned binary / env key / volume / DB grant assumed but never declared or gated).
- **Fix design:** Complete the authority-boundary migration the service already established for restore — admin-api becomes the audited ledger/evidence surface; execution moves to the infrastructure that already holds the toolchain and privileges. Shipping pg_dump+volume+key into admin-api is the wrong branch: it would require granting the web-facing admin_service role SELECT on every tenant schema (tenant-isolation regression vs SEC-015) and would place the backup encryption key in a long-running internet-adjacent container instead of the production-backup GitHub environment. Local fix: (a) Remove the in-process execution path from BackupRestoreService (executeEncryptedPgDump, getBackupEncryptionKey/decode, /backups filesystem I/O, and the @Cron daily/weekly jobs which duplicate INFRA-BACKUP-001's schedule and can only produce failed rows) exactly as executeRestore was reduced; createBackup becomes validate + requireAuditLog + persist a 'requested' ledger row in admin.schema_backups. (b) Extend tools/scripts/database/backup-databases.sh (already the shared droplet/pg-backup script with pg_dump, aws-cli, gpg and privileged credentials) with a per-tenant-schema mode: consume 'requested' rows / enumerate active schemas, pg_dump --schema=<tenant> encrypted, upload to Spaces beside the WAL-G tree, then complete the ledger row (status, checksum, sizeBytes, storage URI, encryptionKeyId) via psql; backup-production.yml invokes it nightly and via workflow_dispatch for on-demand tenant backups. New admin migration adds nullable storageLocation/executedBy columns to admin.schema_backups (blue-green: nullable first). (c) tenant-provisioning backupTenantData keeps its fail-closed proof unchanged but verifies the completed ledger row written by the real executor — unblocking deprovisioning without weakening the proof. (d) FE: DatabaseManagementPage 'Create Backup' becomes 'Request Backup' with requested→completed lifecycle; the schedule panel surfaces the executor's actual cadence derived from ledger rows instead of admin-api cron fiction; extend services/types/database.ts + services/api/database.ts for the new status/storage fields. Pattern-level fix (tier 3, systemic class): new invariant spec asserting (1) every child_process spawn/execFile of an external binary under apps/**/src maps to a package installed in the image that deploys that service (parse Dockerfile.backend.simple) or lives in a designated executor image (pg-backup/db-migrate), and (2) BackupRestoreService imports no child_process at all (mirroring the restore authority boundary), plus required-env :? guard checks against docker-compose.droplet.yml — making silent paper capabilities of this class build-time detectable.
- **Files to change:**
  - `apps/admin-api-service/src/database-management/services/backup-restore.service.ts`
  - `apps/admin-api-service/src/database-management/controllers/backup.controller.ts`
  - `apps/admin-api-service/src/database-management/entities/database-management.entity.ts`
  - `apps/admin-api-service/src/migrations/1800900000000-BackupLedgerExecutorEvidence.ts`
  - `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts`
  - `tools/scripts/database/backup-databases.sh`
  - `.github/workflows/backup-production.yml`
  - `web/modules/admin-panel/src/pages/DatabaseManagementPage.tsx`
  - `web/modules/admin-panel/src/services/types/database.ts`
  - `web/modules/admin-panel/src/services/api/database.ts`
  - `e2e/tests/integration/runtime-dependency-invariants.spec.ts`
  - `apps/admin-api-service/src/database-management/__tests__/backup-restore.service.spec.ts`
  - `apps/admin-api-service/src/tenant/__tests__/tenant-provisioning.service.spec.ts`
- **Proof of fix:** New invariant spec e2e/tests/integration/runtime-dependency-invariants.spec.ts: (1) scan apps/**/src for child_process spawn/execFile of external binaries and assert each binary is installed in infrastructure/docker/Dockerfile.backend.simple's package list or the call site is in a designated executor (db-migrate CLI / pg-backup script) — fails today on backup-restore.service.ts:525 spawn('pg_dump'); (2) assert BackupRestoreService has no child_process import (authority boundary, mirroring the existing restore rejection). Extend apps/admin-api-service/src/database-management/__tests__/backup-restore.service.spec.ts: createBackup persists a 'requested' ledger row, never spawns, never reads BACKUP_ENCRYPTION_KEY; no @Cron methods remain on the service. Extend apps/admin-api-service/src/tenant/__tests__/tenant-provisioning.service.spec.ts: deprovision still rejects when the ledger row is not completed/checksummed/encrypted, and proceeds when the executor-written row is complete. Executor side: backup-production.yml workflow_dispatch dry_run exercises the per-schema mode of backup-databases.sh end-to-end (dump produced, ledger UPDATE emitted) without upload.
- **Effort:** L

### APA-338 [MEDIUM] Hand-written FE types drift systemically from backend responses (no codegen) — three of the drifts silently blank out real data

- **Status:** PENDING
- **Symptom:** services/types/database.ts and the inline api-function generics were written from an older backend. Confirmed field-level drift: SlowQueryResult object vs array (panel always empty), isIsolated vs valid (always 'Issues found'), backup schedule shape (always 'Not configured'), IndexRecommendation.createStatement missing, TenantSchema/SchemaMigration/DatabaseBackup field mismatches, plus ~14 FE functions targeting nonexistent routes. Because the envelope-unwrapping http-client returns 'unknown-shaped' data as T, none of this fails loudly — it renders wrong. A generated client (OpenAPI from the existing Swagger setup) would make this class of bug impossible.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/database.ts:5-83`
  - `web/modules/admin-panel/src/services/api/database.ts:56-61,106-115,126-127,172-174,197-204`
  - `web/modules/admin-panel/src/services/http-client.ts:341-351 (unchecked cast to T)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-339 [LOW] Security posture of the section is otherwise solid (verified, not assumed)

- **Status:** PENDING
- **Symptom:** Positive findings recorded for completeness: every /database/* route is behind the global PlatformAdminGuard (SUPER_ADMIN-only, RS256 verifyAsync with issuer/audience, access-token-type enforcement) plus ThrottlerGuard; no @Public escapes exist in the five controllers; all seven database-management entities declare schema:'admin' and match the Baseline migration column-for-column; the explorer uses a separate read-only DataSource with default_transaction_read_only=on; tenant_<uuid> schemas are structurally unreachable from the explorer (allowlist public/auth/admin/billing + MODULE_SCHEMAS-derived table blocklist + tenant_ regex in raw SQL); identifiers are regex-validated and values parameterized throughout; read/export/raw-SQL are fail-closed on audit persistence; nginx /api -> /api/v1 rewrite matches the service prefix exactly.
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:283-304`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:78-205`
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:46-67,280-322,1230-1233`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:191-213`
  - `infrastructure/nginx/droplet.conf:377-383`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).
