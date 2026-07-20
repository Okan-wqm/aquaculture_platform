# Cross-cutting: Entity/Migration/Schema Parity — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## Cross-cutting findings

### APA-376 [HIGH] Auth-schema RBAC + invitation DDL is owned by admin-api's migration chain (ownership inversion, deploy-order coupling)

- **Status:** PENDING
- **Symptom:** admin-api's migration 1800200000000-CreateAdminEntitySurfaceTables creates four tables in the auth schema: auth.tenant_roles, auth.tenant_role_permissions, auth.user_role_assignments, auth.tenant_invitations. auth-service's LIVE migration chain (apps/auth-service/src/migrations/*.ts) contains zero DDL for these tables (only the retired .archive chain did), yet auth-service maps them with runtime entities (tenant-role.entity.ts, tenant-role-permission.entity.ts, user-role-assignment.entity.ts) and serves the RBAC SSoT from them. admin-api's chain also adds an index on the auth table (1801100000000) and backfills auth-schema DATA (1801300000000-BackfillMessagingAiRoleCapabilities). Consequence: any environment that runs only auth-service migrations (standalone auth deploy, auth integration-test DB) has entities without tables — auth-service's boot-time SchemaDriftValidator will fail until admin-api's migrations run first. The auth entity docblock (RBAC-HIGH-011) acknowledges 'DDL was owned by admin-api migrations' and added entities for drift visibility, but the DDL ownership itself was never moved to the owning service, violating the per-service migration-ownership pattern (ADR-011/012). Known hardening gaps on these tables (missing FK tenantId->auth.tenants, no unique on (tenantId, LOWER(name)), single-default invariant app-only) are tracked as RBAC-MEDIUM-012/013 in the same docblock.
- **Evidence:**
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1800200000000-CreateAdminEntitySurfaceTables.ts:10 (CREATE TABLE auth.tenant_roles), :56 (auth.tenant_role_permissions), :69 (auth.user_role_assignments), :98 (auth.tenant_invitations)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1801100000000-AddTenantRolePermissionsRoleIdIndex.ts (admin chain indexing an auth-schema table)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1801300000000-BackfillMessagingAiRoleCapabilities.ts (admin chain mutating auth.tenant_role_permissions data)`
  - `/home/user/aquaculture_platform/apps/auth-service/src/modules/tenant/entities/tenant-role.entity.ts:10-36 (docblock: 'DDL was owned by admin-api migrations'; @Entity('tenant_roles', { schema: 'auth' }))`
  - `apps/auth-service/src/migrations/ live chain grep for 'tenant_roles' returns zero matches (verified 2026-07-19)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-377 [MEDIUM] Dead table + dead entity: auth.tenant_invitations (TenantInvitation) — created and forFeature-registered but has zero consumers; the live invitation flow uses auth.invitations

- **Status:** PENDING
- **Symptom:** TenantInvitation (@Entity('tenant_invitations', { schema: 'auth', synchronize: false })) is registered in TenantManagementModule's TypeOrmModule.forFeature but a repo-wide search (apps/ + web/) finds no service, controller, or repository injection that reads or writes it — only the entity declaration, the module registration, and the creating migration. Meanwhile auth-service owns a separate, live auth.invitations table (its migration 1800800000000-InvitationTenantIdNotNull actively evolves it). Result: admin-api ships DDL for, and registers metadata of, an invitation table in ANOTHER service's schema that nothing in the platform ever populates or queries — a ghost table that will always read empty and a second invitation store that invites split-brain if anyone wires it up later.
- **Evidence:**
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/tenant/entities/tenant.entity.ts:247 (@Entity('tenant_invitations', { schema: 'auth', synchronize: false }))`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/tenant/tenant.module.ts:83 (forFeature registration — the only reference besides the entity file)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1800200000000-CreateAdminEntitySurfaceTables.ts:98 (CREATE TABLE IF NOT EXISTS auth.tenant_invitations)`
  - `/home/user/aquaculture_platform/apps/auth-service/src/migrations/1800800000000-InvitationTenantIdNotNull.ts (the live invitation table is auth.invitations, not tenant_invitations)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-378 [MEDIUM] Dead table + dead entity: admin.plan_module_assignments (PlanModuleAssignment) — zero consumers repo-wide

- **Status:** PENDING
- **Symptom:** PlanModuleAssignment is created by the Baseline migration and registered in BillingModule's forFeature, but a repo-wide search across apps/ and web/ for 'PlanModuleAssignment' or 'plan_module_assignments' matches only the entity file, billing.module.ts, and the Baseline migration. No service, handler, or query-builder ever touches it; billing-service's plan/module logic reads admin.module_pricing and admin.plan_definitions instead. The table is registered in MODULE_SCHEMAS['admin'].tables (schema-manager.service.ts:800s block) so the drift validator protects a table nothing uses. Either wire it to the plan<->module assignment feature it was built for or retire it via the established archive-before-drop pattern (as done for global_configs/system_settings/tenant_configurations in 1801400000000).
- **Evidence:**
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/billing/entities/plan-module-assignment.entity.ts:41 (@Entity('plan_module_assignments', { schema: 'admin' }))`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/billing/billing.module.ts:44 (forFeature registration — sole non-entity reference)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:220 (CREATE TABLE admin.plan_module_assignments)`
  - `Repo-wide grep of apps/ and web/ for PlanModuleAssignment|plan_module_assignments: only the three files above (verified 2026-07-19)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-379 [MEDIUM] auth.tenants is mapped by TWO hand-written entity classes in the same DataSource — a duplication that has already caused two HIGH drift bugs

- **Status:** PENDING
- **Symptom:** admin-api carries two independent read-only mirrors of auth.tenants: Tenant (tenant/entities/tenant.entity.ts:49) and TenantReadOnly (analytics/entities/external/tenant.entity.ts:23), both @Entity('tenants', { schema: 'auth', synchronize: false }) and both registered via forFeature into the default connection. The TenantReadOnly file's own comments document that this mirror previously drifted twice with HIGH impact: DBR-HIGH-003 (UPPERCASE enum copies that never matched the lowercase column — every analytics query returned zero rows) and MT-HIGH-003 (a 4-value status subset that silently dropped tenants in missing states). The enum drift was fixed by re-exporting the event-contracts SSoT, but the structural duplication remains: the two classes still disagree today (Tenant defaults plan to TenantPlan.STARTER, TenantReadOnly to TenantPlan.TRIAL; TenantReadOnly omits 14 of Tenant's 25 columns). Any future auth.tenants change must be mirrored twice, and only column-name parity — not completeness — is checked. Consolidating to one shared read-only entity removes the recurring drift channel (tier-1 make-it-impossible).
- **Evidence:**
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/tenant/entities/tenant.entity.ts:49 (@Entity('tenants', { schema: 'auth', synchronize: false }), plan default STARTER at ~:70)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts:12-23 (drift-history comments for DBR-HIGH-003 and MT-HIGH-003; @Entity('tenants', { schema: 'auth', synchronize: false }); plan default TRIAL)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/analytics/analytics.module.ts:19,27 (TenantReadOnly forFeature-registered in the same default connection as Tenant)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-380 [LOW] Migration location and runner deviate from the platform ADR-011 pattern, and the two in-repo comments about who runs production migrations point in different directions

- **Status:** PENDING
- **Symptom:** CLAUDE.md's Migration Runners section says each service owns apps/<svc>/src/database/migrations/ and registers createMigrationRunnerService('<schema>') with migrationsRun: false. admin-api instead keeps migrations in src/migrations/ (src/database/ holds only data-source.ts), registers no createMigrationRunnerService anywhere, and runs migrations through TypeORM's built-in runner gated by DATABASE_MIGRATIONS_RUN. Internally consistent (data-source.ts and app.module.ts both reference src/migrations), but the two docblocks disagree about the production execution path: data-source.ts:12-22 says 'Application boot is the only path that runs migrations', while app.module.ts:118-119 says 'Single-writer deploy contract: aqua-db-migrate owns production migrations. Local/E2E can still opt in explicitly.' An operator following the data-source comment during an incident would expect boot-time execution that production explicitly disables. Align the comments and either adopt the shared runner factory or record the exemption where the convention is stated.
- **Evidence:**
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/database/data-source.ts:12-22 ('Application boot is the only path that runs migrations'), :35 (migrations: ['src/migrations/[0-9]*.ts'])`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/app.module.ts:117-121 (migrations glob __dirname + '/migrations/...', 'Single-writer deploy contract: aqua-db-migrate owns production migrations', migrationsRunFromEnv DATABASE_MIGRATIONS_RUN default 'false')`
  - `grep for createMigrationRunnerService under apps/admin-api-service/src returns zero matches (verified 2026-07-19); apps/admin-api-service/src/database/ contains no migrations/ directory`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-381 [LOW] CLI data-source entity glob excludes the LegalHold entity although admin-api owns the compliance.legal_holds table's DDL

- **Status:** PENDING
- **Symptom:** compliance.legal_holds is created by admin-api's migration 1787500000000-CreateComplianceLegalHolds and MODULE_SCHEMAS assigns ownership to admin-api ('Owner: admin-api-service' in the compliance registry entry), but the mapping entity lives in libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts. The runtime app picks it up via LegalHoldModule's TypeOrmModule.forFeature + autoLoadEntities, so the service works; the operator CLI DataSource, however, globs entities: ['src/**/*.entity.ts'] only, so migration:generate / schema-diff runs from the CLI see legal_holds as a table with no entity and could propose dropping or re-creating it. Add the backend-common entity path (or the class) to the CLI data-source entity list.
- **Evidence:**
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/database/data-source.ts:34 (entities: ['src/**/*.entity.ts'] — excludes libs/)`
  - `/home/user/aquaculture_platform/libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts (the only @Entity for compliance.legal_holds; column parity with the migration verified 11/11)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1787500000000-CreateComplianceLegalHolds.ts:9 (CREATE TABLE IF NOT EXISTS compliance.legal_holds)`
  - `/home/user/aquaculture_platform/libs/backend-common/src/database/schema-manager.service.ts:861-866 (compliance registry entry: 'Owner: admin-api-service ... the LegalHold entity lives there')`
  - `/home/user/aquaculture_platform/libs/backend-common/src/compliance/legal-hold/legal-hold.module.ts:47 (TypeOrmModule.forFeature([LegalHoldEntity]) — runtime path is correctly wired)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-382 [LOW] admin.audit_logs: performedByEmail filter has no supporting index (all other list filters are indexed)

- **Status:** PENDING
- **Symptom:** The audit list query supports equality filters on action, entityType, entityId, tenantId, performedBy, severity, createdAt ranges, and performedByEmail, ordered by createdAt DESC. The Baseline creates indexes for severity, createdAt, tenantId, performedBy, (entityType,entityId), and action — but none for performedByEmail (audit.service.ts:155). On a large append-only audit table, an email-filtered search degrades to a scan bounded only by the createdAt sort index. Minor today; add a performedByEmail (or (performedByEmail, createdAt)) index if operator email-search is a supported flow.
- **Evidence:**
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/audit/audit.service.ts:155 (andWhere('audit.performedByEmail = :performedByEmail'))`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:8-14 region — audit_logs indexes cover severity, createdAt, tenantId, performedBy, (entityType,entityId), action only (index list extracted 2026-07-19)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-383 [LOW] Verified-clean baseline for everything else: full entity<->migration<->registry parity across all 60 admin-schema tables

- **Status:** PENDING
- **Symptom:** Positive assurance for the rest of the audit scope, so the findings above are the complete gap list: (a) all 68 @Entity classes in admin-api declare schema explicitly (57 'admin', plus read-only externals on 'auth'/'billing' with synchronize:false) — zero missing-schema violations; (b) scripted column-name diff of every entity against the cumulative up() DDL (CREATE TABLE + ADD/DROP/RENAME COLUMN across all 18 live migrations, including the DO-block archive-before-drop retirements in 1801400000000/1801500000000) found zero mismatches, including inherited columns (AdminOutbox<-OutboxEntityBase 14/14) and the helper-generated tenant_erasure_target_proofs ledger; (c) MODULE_SCHEMAS['admin'] registers every live table (zero live-but-unregistered; entity-less raw-SQL workflow tables — tenant_provisioning_runs/steps, tenant_onboarding_acks, cleanup_runs/steps/events/evidence, retired_config_backups — are correctly declared as infrastructureTables and all have live raw-SQL consumers whose quoted column references all exist in the DDL); (d) the retired legacy config trio (global_configs/system_settings/tenant_configurations) and shared.user_permissions were dropped with count-asserted jsonb archival and their entity classes correctly un-decorated with 410-Gone write paths; (e) external read-only entities match the owning services' migration chains column-for-column (auth.tenants 25/25, auth.users, billing.subscriptions, billing.invoices, billing.usage_aggregations 18/18); (f) index coverage on hot tables (activity_logs, security_events, api_usage_logs, background_jobs, support_tickets, error_groups) matches observed filter+createdAt query patterns.
- **Evidence:**
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1800000000000-Baseline.ts (59 admin CREATE TABLEs + index set)`
  - `/home/user/aquaculture_platform/libs/backend-common/src/database/schema-manager.service.ts:723-816 (MODULE_SCHEMAS['admin'] — complete against the live migration table set)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/migrations/1801400000000-DropRetiredLegacyConfigStores.ts:37-95 and 1801500000000-DropRetiredUserPermissions.ts:47-119 (archive-before-drop retirements)`
  - `/home/user/aquaculture_platform/platform/libs/outbox/src/outbox-entity.base.ts:34-164 (14 inherited admin_outbox columns, matching 1800400000000-TenantProvisioningWorkflow.ts:10-64)`
  - `/home/user/aquaculture_platform/apps/admin-api-service/src/tenant/handlers/tenant-erasure.handler.ts:128-152 (raw-SQL columns all present in 1800900000000-CreateTenantErasureOperations.ts)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).
