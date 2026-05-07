import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateInitialSchema1780000000000
 * ============================================================================
 *
 * Restores the admin-api-service migration baseline that was lost when most
 * of the original `CREATE TABLE` migrations were squashed out of source. The
 * admin schema is provisioned by
 * `infrastructure/docker/init-scripts/00-init-schemas.sh` (CREATE SCHEMA
 * only) and this migration creates EVERY `admin.*` table that admin-api
 * entities declare — including the five tables that the original baseline
 * draft delegated to init scripts 04 and 11. Wave 5 of the bootstrap-
 * restoration plan rolls those tables into the migration so the SQL
 * baseline is the single source of truth and the init scripts can be
 * deleted in the next orchestrator step.
 *
 * Without this consolidation, the downstream chain (1781500000000+) ALTERs
 * tables that the migration runner has not seen — the converter's
 * `tableExistsInCurrentSchema` defensive check would skip them — and
 * TypeORM autoLoadEntities + the SchemaDriftValidator surface the drift on
 * every cold start.
 *
 * # Scope
 *
 * Creates 49 baseline `admin.*` tables in topologically-sorted order
 * (parents before FK children). Idempotent via `CREATE TABLE IF NOT EXISTS`,
 * `DO $$ ... EXCEPTION WHEN duplicate_object` for enum/FK blocks, and
 * `IF NOT EXISTS` on every index.
 *
 * # Tables NOT created here (owned by another step)
 *
 *   - admin.ingest_backend_policy_state (migration 1787300000000 owns the
 *                                      CREATE + seed; that migration uses
 *                                      `CREATE TABLE IF NOT EXISTS` so the
 *                                      ordering is benign either way, but
 *                                      we leave the seed responsibility with
 *                                      its dedicated owner)
 *
 * # Tables shared with init scripts (init scripts deleted post-merge)
 *
 *   - admin.module_pricing            (was init-script 04-billing-tables.sql)
 *   - admin.analytics_snapshots       (same)
 *   - admin.report_definitions        (same)
 *   - admin.report_executions         (same)
 *   - admin.audit_logs                (was init-script 11-service-audit-tables.sql)
 *
 * Migration 1787100000000-CreateAdminAuditLogsTable continues to ship as a
 * defensive idempotent re-run for legacy droplets that ran on bare
 * init-script boot — its `CREATE TABLE IF NOT EXISTS` becomes a no-op once
 * this baseline lands, but the migration row stays in the ledger so partial
 * upgrades remain replay-safe.
 *
 * Cross-schema entities the service reads from but does NOT own
 * (`{ schema: 'auth' | 'billing' | 'shared', synchronize: false }`) are
 * covered by their owning service's init or migration.
 *
 * # Idempotency
 *
 *   - `CREATE SCHEMA IF NOT EXISTS admin` (defensive, no-op when the
 *     init-script already created it).
 *   - `CREATE TABLE IF NOT EXISTS admin.<name>` for every table.
 *   - `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL END $$`
 *     for every enum CREATE TYPE and every FK ADD CONSTRAINT (Postgres
 *     has no `CREATE TYPE IF NOT EXISTS` and no `ADD CONSTRAINT IF NOT
 *     EXISTS` before pg 16).
 *   - `IF NOT EXISTS` on every CREATE INDEX.
 *
 * The migration ledger only inserts the entry once, but a partial first
 * run leaves objects in mid-state; idempotency guarantees a clean retry.
 *
 * # Topological order (parent → child)
 *
 *   No-FK platform-level + per-tenant tables (32):
 *     system_settings, email_templates, ip_access_rules, global_configs,
 *     feature_toggles, maintenance_modes, plan_definitions,
 *     plan_module_assignments, custom_plans, discount_codes,
 *     discount_redemptions, system_versions, retention_policies,
 *     tenant_configurations, tenant_activities, tenant_notes,
 *     tenant_billing_info, debug_sessions, impersonation_sessions,
 *     impersonation_permissions, onboarding_progress,
 *     feature_flag_overrides, performance_metrics,
 *     performance_snapshots, slow_query_logs, captured_queries,
 *     captured_api_calls, cache_entries_snapshot, login_attempts,
 *     api_usage_logs, user_sessions, security_events,
 *     security_incidents, threat_intelligence, data_requests,
 *     compliance_reports, activity_logs, background_jobs,
 *     job_queues, job_execution_logs, tenant_schemas,
 *     schema_migrations, schema_backups, schema_restores,
 *     database_metrics
 *
 *   FK children (created after parents above):
 *     error_groups -> error_occurrences (occurrence FKs group via fingerprint;
 *     no DDL FK declared by entity but groupId/fingerprint are correlated)
 *     error_alert_rules (no FK)
 *     message_threads -> messages (FK)
 *     announcements -> announcement_acknowledgments (FK)
 *     support_tickets -> ticket_comments (FK)
 *     plan_module_assignments depends on plan_definitions (FK created)
 *     discount_redemptions: no DB-level FK declared by entity
 *
 * # Why no FK to billing.subscriptions / auth.users
 *
 * The entities reference cross-schema IDs as plain `uuid` columns without a
 * declared FK. That's deliberate (cross-service references are validated at
 * the application layer, not the DB layer) and keeps service migrations
 * independent. We mirror the entity decorators 1:1 here.
 *
 * # Why TIMESTAMPTZ everywhere
 *
 * The downstream `ConvertTimestampToTimestamptz1781500000000` converter
 * runs on a fresh DB anyway, but starting from `timestamptz` from birth
 * matches the entity decorators (`type: 'timestamptz'` or
 * `@CreateDateColumn({ type: 'timestamp with time zone' })`) and avoids
 * an unnecessary table rewrite when the converter sees the already-
 * correct type.
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */
export class CreateInitialSchema1780000000000 implements MigrationInterface {
  name = 'CreateInitialSchema1780000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Creating baseline admin.* tables (~36) — restores the squashed-out CREATE chain',
    );

    // Defensive: schema is normally created by init-schemas.sh codegen.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS admin`);

    await this.createEnumTypes(queryRunner);

    // Settings & access (no FKs)
    await this.createSystemSettingsTable(queryRunner);
    await this.createEmailTemplatesTable(queryRunner);
    await this.createIpAccessRulesTable(queryRunner);
    await this.createGlobalConfigsTable(queryRunner);
    await this.createFeatureTogglesTable(queryRunner);
    await this.createMaintenanceModesTable(queryRunner);

    // Billing platform-level (no FKs)
    await this.createPlanDefinitionsTable(queryRunner);
    await this.createPlanModuleAssignmentsTable(queryRunner);
    await this.createCustomPlansTable(queryRunner);
    await this.createDiscountCodesTable(queryRunner);
    await this.createDiscountRedemptionsTable(queryRunner);

    // System & error
    await this.createSystemVersionsTable(queryRunner);
    await this.createErrorGroupsTable(queryRunner);
    await this.createErrorOccurrencesTable(queryRunner);
    await this.createErrorAlertRulesTable(queryRunner);
    await this.createPerformanceMetricsTable(queryRunner);
    await this.createPerformanceSnapshotsTable(queryRunner);
    await this.createSlowQueryLogsTable(queryRunner);
    await this.createBackgroundJobsTable(queryRunner);
    await this.createJobQueuesTable(queryRunner);
    await this.createJobExecutionLogsTable(queryRunner);

    // Tenant ops
    await this.createTenantConfigurationsTable(queryRunner);
    await this.createTenantActivitiesTable(queryRunner);
    await this.createTenantNotesTable(queryRunner);
    await this.createTenantBillingInfoTable(queryRunner);
    await this.createOnboardingProgressTable(queryRunner);

    // Impersonation / debug
    await this.createImpersonationSessionsTable(queryRunner);
    await this.createImpersonationPermissionsTable(queryRunner);
    await this.createDebugSessionsTable(queryRunner);
    await this.createCapturedQueriesTable(queryRunner);
    await this.createCapturedApiCallsTable(queryRunner);
    await this.createCacheEntriesSnapshotTable(queryRunner);
    await this.createFeatureFlagOverridesTable(queryRunner);

    // Security & compliance
    await this.createActivityLogsTable(queryRunner);
    await this.createSecurityEventsTable(queryRunner);
    await this.createSecurityIncidentsTable(queryRunner);
    await this.createThreatIntelligenceTable(queryRunner);
    await this.createDataRequestsTable(queryRunner);
    await this.createComplianceReportsTable(queryRunner);
    await this.createRetentionPoliciesTable(queryRunner);
    await this.createLoginAttemptsTable(queryRunner);
    await this.createApiUsageLogsTable(queryRunner);
    await this.createUserSessionsTable(queryRunner);

    // Database management
    await this.createTenantSchemasTable(queryRunner);
    await this.createSchemaMigrationsTable(queryRunner);
    await this.createSchemaBackupsTable(queryRunner);
    await this.createSchemaRestoresTable(queryRunner);
    await this.createDatabaseMetricsTable(queryRunner);

    // Forum / support — children with FKs to threads / announcements /
    // tickets created after their parents above (parent tables created
    // here before the children).
    await this.createMessageThreadsTable(queryRunner);
    await this.createMessagesTable(queryRunner);
    await this.createAnnouncementsTable(queryRunner);
    await this.createAnnouncementAcknowledgmentsTable(queryRunner);
    await this.createSupportTicketsTable(queryRunner);
    await this.createTicketCommentsTable(queryRunner);

    // Init-script-owned analytics, billing-config & admin audit
    // (folded in from 04-billing-tables.sql and 11-service-audit-tables.sql
    // — those scripts are deleted in the same PR). No FKs to other admin
    // tables, so order is independent.
    await this.createModulePricingTable(queryRunner);
    await this.createAnalyticsSnapshotsTable(queryRunner);
    await this.createReportDefinitionsTable(queryRunner);
    await this.createReportExecutionsTable(queryRunner);
    await this.createAdminAuditLogsTable(queryRunner);

    this.logger.log('Baseline admin schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting baseline admin.* tables — destructive; intended for ' +
        'ephemeral test environments only.',
    );

    // Reverse FK order — children first, then parents, then enums.
    const tablesInDropOrder = [
      // Init-script-owned analytics, billing-config & admin audit (no
      // inbound FKs from other admin tables — drop in any order).
      'audit_logs',
      'report_executions',
      'report_definitions',
      'analytics_snapshots',
      'module_pricing',
      // Forum/support children
      'ticket_comments',
      'support_tickets',
      'announcement_acknowledgments',
      'announcements',
      'messages',
      'message_threads',
      // Database management
      'database_metrics',
      'schema_restores',
      'schema_backups',
      'schema_migrations',
      'tenant_schemas',
      // Security & compliance
      'user_sessions',
      'api_usage_logs',
      'login_attempts',
      'retention_policies',
      'compliance_reports',
      'data_requests',
      'threat_intelligence',
      'security_incidents',
      'security_events',
      'activity_logs',
      // Impersonation / debug
      'feature_flag_overrides',
      'cache_entries_snapshot',
      'captured_api_calls',
      'captured_queries',
      'debug_sessions',
      'impersonation_permissions',
      'impersonation_sessions',
      // Tenant ops
      'onboarding_progress',
      'tenant_billing_info',
      'tenant_notes',
      'tenant_activities',
      'tenant_configurations',
      // System & error
      'job_execution_logs',
      'job_queues',
      'background_jobs',
      'slow_query_logs',
      'performance_snapshots',
      'performance_metrics',
      'error_alert_rules',
      'error_occurrences',
      'error_groups',
      'system_versions',
      // Billing platform
      'discount_redemptions',
      'discount_codes',
      'custom_plans',
      'plan_module_assignments',
      'plan_definitions',
      // Settings & access
      'maintenance_modes',
      'feature_toggles',
      'global_configs',
      'ip_access_rules',
      'email_templates',
      'system_settings',
    ];

    for (const table of tablesInDropOrder) {
      await queryRunner.query(`
        -- DESTRUCTIVE: rollback drops admin.${table} and all of its row data
        -- pg_dump backup taken by deploy pipeline before any migration is the recovery path
        DROP TABLE IF EXISTS admin."${table}" CASCADE
      `);
    }

    // Drop enum types last — table drops above already removed dependent
    // columns, so these should be free.
    const enumTypes = [
      'system_settings_valuetype_enum',
      'system_settings_category_enum',
      'tenant_activities_activitytype_enum',
      'plan_definitions_tier_enum',
      'plan_definitions_visibility_enum',
      'custom_plans_tier_enum',
      'custom_plans_billingcycle_enum',
      'custom_plans_status_enum',
      'discount_codes_discounttype_enum',
      'discount_codes_appliesto_enum',
      'discount_codes_duration_enum',
      // admin.audit_logs severity (folded in from 11-service-audit-tables.sql)
      'audit_logs_severity_enum',
    ];
    for (const enumType of enumTypes) {
      await queryRunner.query(
        `DROP TYPE IF EXISTS admin."${enumType}" CASCADE`,
      );
    }
  }

  /**
   * Create Postgres enum types used by entity columns declared with
   * `@Column({ type: 'enum', enum: ... })`. Entity columns declared with
   * `@Column({ type: 'varchar', length: N })` storing enum-like literals
   * (e.g. SchemaStatus, MessageStatus) get plain `varchar` columns and
   * therefore do NOT need a CREATE TYPE here.
   *
   * Names follow TypeORM's `{table}_{column}_enum` auto-generation
   * convention (lowercase, no camelCase) so SchemaDriftValidator's
   * `resolveEnumTypeName` resolves to exactly these types.
   *
   * Idempotent via `DO $$ ... EXCEPTION WHEN duplicate_object`.
   */
  private async createEnumTypes(queryRunner: QueryRunner): Promise<void> {
    const enums: ReadonlyArray<{ name: string; values: readonly string[] }> = [
      // system_setting.entity.ts
      {
        name: 'system_settings_valuetype_enum',
        values: ['string', 'number', 'boolean', 'json', 'encrypted'],
      },
      {
        name: 'system_settings_category_enum',
        values: [
          'general',
          'security',
          'email',
          'sms',
          'billing',
          'rate_limit',
          'storage',
          'integration',
          'notification',
          'feature_flag',
          'maintenance',
        ],
      },
      // tenant-activity.entity.ts
      {
        name: 'tenant_activities_activitytype_enum',
        values: [
          'created',
          'activated',
          'suspended',
          'deactivated',
          'plan_changed',
          'limits_updated',
          'module_assigned',
          'module_removed',
          'user_added',
          'user_removed',
          'settings_updated',
          'payment_received',
          'payment_failed',
          'trial_started',
          'trial_expired',
          'contact_updated',
          'domain_changed',
        ],
      },
      // plan-definition.entity.ts (PlanTier, PlanVisibility)
      {
        name: 'plan_definitions_tier_enum',
        values: ['free', 'starter', 'professional', 'enterprise', 'custom'],
      },
      {
        name: 'plan_definitions_visibility_enum',
        values: ['public', 'private', 'deprecated'],
      },
      // custom-plan.entity.ts (PlanTier, BillingCycle, CustomPlanStatus)
      {
        name: 'custom_plans_tier_enum',
        values: ['free', 'starter', 'professional', 'enterprise', 'custom'],
      },
      {
        name: 'custom_plans_billingcycle_enum',
        values: ['monthly', 'quarterly', 'semi_annual', 'annual'],
      },
      {
        name: 'custom_plans_status_enum',
        values: [
          'draft',
          'pending_approval',
          'approved',
          'active',
          'expired',
          'rejected',
        ],
      },
      // discount-code.entity.ts
      {
        name: 'discount_codes_discounttype_enum',
        values: [
          'percentage',
          'fixed_amount',
          'free_trial_extension',
          'free_months',
        ],
      },
      {
        name: 'discount_codes_appliesto_enum',
        values: [
          'all_plans',
          'specific_plans',
          'upgrades_only',
          'new_subscriptions_only',
        ],
      },
      {
        name: 'discount_codes_duration_enum',
        values: ['once', 'repeating', 'forever'],
      },
      // audit.entity.ts (admin-api SUPER_ADMIN audit trail) — admin's
      // AuditSeverity is INTENTIONALLY narrower than auth's (no 'error'
      // value) per the entity decorator. Type name follows TypeORM's
      // `{table}_{column}_enum` convention so SchemaDriftValidator's
      // resolveEnumTypeName matches it without renaming. The
      // 1787100000000-CreateAdminAuditLogsTable migration ships the same
      // enum + table CREATE as a defensive idempotent re-run for legacy
      // droplets that boot from the older init-script path.
      {
        name: 'audit_logs_severity_enum',
        values: ['info', 'warning', 'critical'],
      },
    ];

    for (const enumType of enums) {
      const literals = enumType.values.map((v) => `'${v}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE admin."${enumType.name}" AS ENUM (${literals});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }
  }

  // ============================================================================
  // Settings & Access
  // ============================================================================

  /** admin.system_settings — settings/entities/system-setting.entity.ts */
  private async createSystemSettingsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per migration-sql-lint R3
    // chunk rule (just-created-table exemption).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.system_settings (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" varchar(255) NOT NULL,
        "value" text NOT NULL,
        "valueType" admin.system_settings_valuetype_enum NOT NULL DEFAULT 'string',
        "category" admin.system_settings_category_enum NOT NULL,
        "description" text,
        "displayName" varchar(255),
        "isPublic" boolean NOT NULL DEFAULT false,
        "isReadOnly" boolean NOT NULL DEFAULT false,
        "requiresRestart" boolean NOT NULL DEFAULT false,
        "defaultValue" text,
        "validationRule" text,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedBy" varchar(255),
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "UQ_system_settings_key" UNIQUE ("key")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_system_settings_key"
        ON admin.system_settings ("key");
      CREATE INDEX IF NOT EXISTS "IDX_system_settings_category"
        ON admin.system_settings ("category");
    `);
  }

  /** admin.email_templates — settings/entities/system-setting.entity.ts */
  private async createEmailTemplatesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.email_templates (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(255) NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" varchar(255),
        "category" varchar(255) NOT NULL,
        "subject" varchar(255) NOT NULL,
        "bodyHtml" text NOT NULL,
        "bodyText" text,
        "variables" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "isActive" boolean NOT NULL DEFAULT true,
        "isSystem" boolean NOT NULL DEFAULT false,
        "tenantId" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedBy" varchar(255),
        CONSTRAINT "UQ_email_templates_code" UNIQUE ("code")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_email_templates_code"
        ON admin.email_templates ("code");
      CREATE INDEX IF NOT EXISTS "IDX_email_templates_category"
        ON admin.email_templates ("category");
    `);
  }

  /** admin.ip_access_rules — settings/entities/system-setting.entity.ts */
  private async createIpAccessRulesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.ip_access_rules (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" varchar(255),
        "ipAddress" varchar(255) NOT NULL,
        "ruleType" varchar(20) NOT NULL,
        "description" varchar(255),
        "isActive" boolean NOT NULL DEFAULT true,
        "expiresAt" timestamptz,
        "hitCount" integer NOT NULL DEFAULT 0,
        "lastHitAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" varchar(255)
      );
      CREATE INDEX IF NOT EXISTS "IDX_ip_access_rules_ipAddress"
        ON admin.ip_access_rules ("ipAddress");
      CREATE INDEX IF NOT EXISTS "IDX_ip_access_rules_tenantId"
        ON admin.ip_access_rules ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_ip_access_rules_ruleType"
        ON admin.ip_access_rules ("ruleType");
    `);
  }

  /** admin.global_configs — system-management/entities/global-config.entity.ts */
  private async createGlobalConfigsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.global_configs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" varchar(200) NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "category" varchar(50) NOT NULL DEFAULT 'system',
        "valueType" varchar(50) NOT NULL DEFAULT 'string',
        "value" jsonb NOT NULL,
        "defaultValue" jsonb,
        "validation" jsonb,
        "isSecret" boolean NOT NULL DEFAULT false,
        "isReadOnly" boolean NOT NULL DEFAULT false,
        "requiresRestart" boolean NOT NULL DEFAULT false,
        "isEnvironmentSpecific" boolean NOT NULL DEFAULT false,
        "environmentOverrides" jsonb,
        "history" jsonb,
        "maxHistoryEntries" integer NOT NULL DEFAULT 10,
        "dependsOn" jsonb,
        "affectedServices" jsonb,
        "helpText" text,
        "warningMessage" text,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "lastModifiedBy" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_global_configs_key"
        ON admin.global_configs ("key");
      CREATE INDEX IF NOT EXISTS "IDX_global_configs_category"
        ON admin.global_configs ("category");
      CREATE INDEX IF NOT EXISTS "IDX_global_configs_isSecret"
        ON admin.global_configs ("isSecret");
    `);
  }

  /** admin.feature_toggles — system-management/entities/feature-toggle.entity.ts */
  private async createFeatureTogglesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.feature_toggles (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" varchar(100) NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "scope" varchar(50) NOT NULL DEFAULT 'global',
        "status" varchar(50) NOT NULL DEFAULT 'disabled',
        "category" varchar(100),
        "conditions" jsonb,
        "rolloutPercentage" integer NOT NULL DEFAULT 0,
        "rolloutSchedule" jsonb,
        "enabledTenants" jsonb,
        "disabledTenants" jsonb,
        "metadata" jsonb,
        "defaultValue" jsonb,
        "variants" jsonb,
        "requiresRestart" boolean NOT NULL DEFAULT false,
        "isExperimental" boolean NOT NULL DEFAULT false,
        "deprecatedAt" timestamptz,
        "deprecationMessage" text,
        "createdBy" varchar(255),
        "updatedBy" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_feature_toggles_key"
        ON admin.feature_toggles ("key");
      CREATE INDEX IF NOT EXISTS "IDX_feature_toggles_scope_status"
        ON admin.feature_toggles ("scope", "status");
      CREATE INDEX IF NOT EXISTS "IDX_feature_toggles_category"
        ON admin.feature_toggles ("category");
    `);
  }

  /** admin.maintenance_modes — system-management/entities/maintenance-mode.entity.ts */
  private async createMaintenanceModesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.maintenance_modes (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title" varchar(255) NOT NULL,
        "description" text NOT NULL,
        "scope" varchar(50) NOT NULL DEFAULT 'global',
        "type" varchar(50) NOT NULL DEFAULT 'scheduled',
        "status" varchar(50) NOT NULL DEFAULT 'scheduled',
        "tenantId" uuid,
        "affectedTenants" jsonb,
        "affectedServices" jsonb,
        "affectedRegions" jsonb,
        "scheduledStart" timestamptz NOT NULL,
        "scheduledEnd" timestamptz,
        "actualStart" timestamptz,
        "actualEnd" timestamptz,
        "estimatedDurationMinutes" integer NOT NULL DEFAULT 60,
        "userMessage" text,
        "internalNotes" text,
        "notifications" jsonb,
        "allowReadOnlyAccess" boolean NOT NULL DEFAULT false,
        "bypassForSuperAdmins" boolean NOT NULL DEFAULT false,
        "whitelistedIPs" jsonb,
        "whitelistedUsers" jsonb,
        "bannerColor" text,
        "bannerIcon" text,
        "metadata" jsonb,
        "createdBy" varchar(255),
        "updatedBy" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_maintenance_modes_scope_status"
        ON admin.maintenance_modes ("scope", "status");
      CREATE INDEX IF NOT EXISTS "IDX_maintenance_modes_scheduled"
        ON admin.maintenance_modes ("scheduledStart", "scheduledEnd");
      CREATE INDEX IF NOT EXISTS "IDX_maintenance_modes_tenantId"
        ON admin.maintenance_modes ("tenantId");
    `);
  }

  // ============================================================================
  // Billing Platform-Level
  // ============================================================================

  /** admin.plan_definitions — billing/entities/plan-definition.entity.ts */
  private async createPlanDefinitionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.plan_definitions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(255) NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "shortDescription" text,
        "tier" admin.plan_definitions_tier_enum NOT NULL,
        "visibility" admin.plan_definitions_visibility_enum NOT NULL DEFAULT 'public',
        "isActive" boolean NOT NULL DEFAULT true,
        "isRecommended" boolean NOT NULL DEFAULT false,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "limits" jsonb NOT NULL,
        "pricing" jsonb NOT NULL,
        "features" jsonb NOT NULL,
        "trialDays" integer,
        "gracePeriodDays" integer,
        "upgradeMessage" text,
        "downgradeWarning" text,
        "stripeProductId" varchar(255),
        "stripePriceIds" jsonb,
        "icon" varchar(255),
        "color" varchar(255),
        "badge" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" varchar(255),
        "updatedBy" varchar(255),
        CONSTRAINT "UQ_plan_definitions_code" UNIQUE ("code")
      );
      CREATE INDEX IF NOT EXISTS "IDX_plan_definitions_tier"
        ON admin.plan_definitions ("tier");
      CREATE INDEX IF NOT EXISTS "IDX_plan_definitions_visibility"
        ON admin.plan_definitions ("visibility");
      CREATE INDEX IF NOT EXISTS "IDX_plan_definitions_isActive"
        ON admin.plan_definitions ("isActive");
    `);
  }

  /** admin.plan_module_assignments — billing/entities/plan-module-assignment.entity.ts */
  private async createPlanModuleAssignmentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // FK: plan_id -> plan_definitions(id) ON DELETE CASCADE.
    // The entity uses snake_case `@JoinColumn({ name: 'plan_id' })` while
    // exposing camelCase `planId` to the application via the @Column.
    // Mirror the entity 1:1 — the column name on the table is `plan_id`.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.plan_module_assignments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "planId" uuid NOT NULL,
        "plan_id" uuid,
        "moduleId" uuid NOT NULL,
        "moduleCode" varchar(50) NOT NULL,
        "includedQuantities" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "isRequired" boolean NOT NULL DEFAULT false,
        "allowOverage" boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_plan_module_assignments_plan_module" UNIQUE ("planId", "moduleId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_plan_module_assignments_planId"
        ON admin.plan_module_assignments ("planId");
      CREATE INDEX IF NOT EXISTS "IDX_plan_module_assignments_moduleId"
        ON admin.plan_module_assignments ("moduleId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE admin.plan_module_assignments
          ADD CONSTRAINT "FK_plan_module_assignments_plan"
          FOREIGN KEY ("plan_id") REFERENCES admin.plan_definitions("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** admin.custom_plans — billing/entities/custom-plan.entity.ts */
  private async createCustomPlansTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // basePlan FK column is named `base_plan_id` in @JoinColumn while the
    // application sees `basePlanId` via the @Column decorator.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.custom_plans (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" text,
        "basePlanId" uuid,
        "base_plan_id" uuid,
        "tier" admin.custom_plans_tier_enum NOT NULL DEFAULT 'custom',
        "billingCycle" admin.custom_plans_billingcycle_enum NOT NULL DEFAULT 'monthly',
        "modules" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "monthlySubtotal" decimal(12, 2) NOT NULL DEFAULT 0,
        "discountPercent" decimal(5, 2) NOT NULL DEFAULT 0,
        "discountAmount" decimal(12, 2) NOT NULL DEFAULT 0,
        "discountReason" varchar(100),
        "monthlyTotal" decimal(12, 2) NOT NULL,
        "currency" varchar(3) NOT NULL DEFAULT 'USD',
        "status" admin.custom_plans_status_enum NOT NULL DEFAULT 'draft',
        "validFrom" date NOT NULL,
        "validTo" date,
        "approvedBy" uuid,
        "approvedAt" timestamptz,
        "rejectionReason" text,
        "notes" text,
        "subscriptionId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid
      );
      CREATE INDEX IF NOT EXISTS "IDX_custom_plans_tenantId"
        ON admin.custom_plans ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_custom_plans_status"
        ON admin.custom_plans ("status");
      CREATE INDEX IF NOT EXISTS "IDX_custom_plans_validFrom"
        ON admin.custom_plans ("validFrom");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE admin.custom_plans
          ADD CONSTRAINT "FK_custom_plans_base_plan"
          FOREIGN KEY ("base_plan_id") REFERENCES admin.plan_definitions("id");
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** admin.discount_codes — billing/entities/discount-code.entity.ts */
  private async createDiscountCodesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.discount_codes (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(255) NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "discountType" admin.discount_codes_discounttype_enum NOT NULL,
        "discountValue" decimal(10, 2) NOT NULL,
        "appliesTo" admin.discount_codes_appliesto_enum NOT NULL DEFAULT 'all_plans',
        "applicablePlanIds" jsonb,
        "duration" admin.discount_codes_duration_enum NOT NULL DEFAULT 'once',
        "durationInMonths" integer,
        "isActive" boolean NOT NULL DEFAULT true,
        "validFrom" timestamptz,
        "validUntil" timestamptz,
        "maxRedemptions" integer,
        "currentRedemptions" integer NOT NULL DEFAULT 0,
        "maxRedemptionsPerTenant" integer,
        "minimumOrderAmount" decimal(10, 2),
        "campaignId" varchar(255),
        "campaignName" varchar(255),
        "stripePromotionCodeId" varchar(255),
        "stripeCouponId" varchar(255),
        "metadata" jsonb,
        "isReferralCode" boolean NOT NULL DEFAULT false,
        "referrerId" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" varchar(255),
        "updatedBy" varchar(255),
        CONSTRAINT "UQ_discount_codes_code" UNIQUE ("code")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_discount_codes_code"
        ON admin.discount_codes ("code");
      CREATE INDEX IF NOT EXISTS "IDX_discount_codes_isActive"
        ON admin.discount_codes ("isActive");
      CREATE INDEX IF NOT EXISTS "IDX_discount_codes_validity"
        ON admin.discount_codes ("validFrom", "validUntil");
      CREATE INDEX IF NOT EXISTS "IDX_discount_codes_campaignId"
        ON admin.discount_codes ("campaignId");
    `);
  }

  /** admin.discount_redemptions — billing/entities/discount-code.entity.ts */
  private async createDiscountRedemptionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // The entity declares no DB-level FK to discount_codes (the ID is
    // stored as plain `uuid`); we mirror the entity exactly. Application-
    // level integrity is enforced by DiscountService.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.discount_redemptions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "discountCodeId" uuid NOT NULL,
        "tenantId" varchar(255) NOT NULL,
        "subscriptionId" varchar(255),
        "invoiceId" varchar(255),
        "discountAmount" decimal(10, 2) NOT NULL,
        "currency" varchar(255) NOT NULL,
        "redeemedAt" timestamptz NOT NULL,
        "redeemedBy" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_discount_redemptions_codeId"
        ON admin.discount_redemptions ("discountCodeId");
      CREATE INDEX IF NOT EXISTS "IDX_discount_redemptions_tenantId"
        ON admin.discount_redemptions ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_discount_redemptions_redeemedAt"
        ON admin.discount_redemptions ("redeemedAt");
    `);
  }

  // ============================================================================
  // System & Error
  // ============================================================================

  /** admin.system_versions — system-management/entities/system-version.entity.ts */
  private async createSystemVersionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.system_versions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "version" varchar(50) NOT NULL,
        "majorVersion" integer NOT NULL,
        "minorVersion" integer NOT NULL,
        "patchVersion" integer NOT NULL,
        "preReleaseTag" varchar(50),
        "releaseType" varchar(50) NOT NULL DEFAULT 'patch',
        "status" varchar(50) NOT NULL DEFAULT 'draft',
        "title" varchar(255) NOT NULL,
        "summary" text,
        "changelog" jsonb,
        "migrations" jsonb,
        "breakingChanges" jsonb,
        "deprecations" jsonb,
        "newFeatures" jsonb,
        "dependencies" jsonb,
        "releaseNotes" text,
        "upgradeGuide" text,
        "deployedAt" timestamptz,
        "deployedBy" varchar(255),
        "deploymentDurationSeconds" integer,
        "deploymentEnvironments" jsonb,
        "isCurrentVersion" boolean NOT NULL DEFAULT false,
        "previousVersion" text,
        "rollbackInfo" jsonb,
        "metadata" jsonb,
        "createdBy" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_system_versions_version"
        ON admin.system_versions ("version");
      CREATE INDEX IF NOT EXISTS "IDX_system_versions_releaseType_status"
        ON admin.system_versions ("releaseType", "status");
      CREATE INDEX IF NOT EXISTS "IDX_system_versions_deployedAt"
        ON admin.system_versions ("deployedAt");
    `);
  }

  /** admin.error_groups — system-management/entities/error-tracking.entity.ts */
  private async createErrorGroupsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.error_groups (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "fingerprint" varchar(64) NOT NULL,
        "severity" varchar(50) NOT NULL DEFAULT 'error',
        "status" varchar(50) NOT NULL DEFAULT 'new',
        "message" varchar(500) NOT NULL,
        "errorType" varchar(255),
        "service" varchar(100),
        "culprit" text,
        "occurrenceCount" integer NOT NULL DEFAULT 1,
        "userCount" integer NOT NULL DEFAULT 0,
        "firstSeenAt" timestamptz NOT NULL,
        "lastSeenAt" timestamptz NOT NULL,
        "affectedTenants" jsonb,
        "affectedReleases" jsonb,
        "tags" jsonb,
        "assignedTo" uuid,
        "notes" text,
        "resolvedAt" timestamptz,
        "resolvedBy" uuid,
        "resolutionNotes" text,
        "linkedTicketUrl" text,
        "isRegression" boolean NOT NULL DEFAULT false,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_error_groups_fingerprint"
        ON admin.error_groups ("fingerprint");
      CREATE INDEX IF NOT EXISTS "IDX_error_groups_status_lastSeen"
        ON admin.error_groups ("status", "lastSeenAt");
      CREATE INDEX IF NOT EXISTS "IDX_error_groups_severity_count"
        ON admin.error_groups ("severity", "occurrenceCount");
      CREATE INDEX IF NOT EXISTS "IDX_error_groups_service"
        ON admin.error_groups ("service");
    `);
  }

  /** admin.error_occurrences — system-management/entities/error-tracking.entity.ts */
  private async createErrorOccurrencesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // Entity declares no DB-level FK to error_groups (groupId is correlated
    // via fingerprint at the application layer). Mirror the entity 1:1.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.error_occurrences (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "groupId" uuid NOT NULL,
        "fingerprint" varchar(64) NOT NULL,
        "severity" varchar(50) NOT NULL DEFAULT 'error',
        "message" varchar(500) NOT NULL,
        "errorType" varchar(255),
        "stackTrace" text,
        "stackFrames" jsonb,
        "context" jsonb,
        "service" varchar(100),
        "environment" varchar(100),
        "release" varchar(50),
        "tenantId" uuid,
        "userId" uuid,
        "ipAddress" inet,
        "userAgent" text,
        "metadata" jsonb,
        "timestamp" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_error_occurrences_fingerprint_ts"
        ON admin.error_occurrences ("fingerprint", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_error_occurrences_groupId"
        ON admin.error_occurrences ("groupId");
      CREATE INDEX IF NOT EXISTS "IDX_error_occurrences_severity_ts"
        ON admin.error_occurrences ("severity", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_error_occurrences_service_ts"
        ON admin.error_occurrences ("service", "timestamp");
    `);
  }

  /** admin.error_alert_rules — system-management/entities/error-tracking.entity.ts */
  private async createErrorAlertRulesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.error_alert_rules (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(255) NOT NULL,
        "description" text,
        "isActive" boolean NOT NULL DEFAULT true,
        "conditions" jsonb NOT NULL,
        "actions" jsonb NOT NULL,
        "cooldownMinutes" integer NOT NULL DEFAULT 15,
        "lastTriggeredAt" timestamptz,
        "triggerCount" integer NOT NULL DEFAULT 0,
        "createdBy" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_error_alert_rules_isActive"
        ON admin.error_alert_rules ("isActive");
    `);
  }

  /** admin.performance_metrics — system-management/entities/performance-metric.entity.ts */
  private async createPerformanceMetricsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.performance_metrics (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "metricType" varchar(50) NOT NULL,
        "name" varchar(200) NOT NULL,
        "value" double precision NOT NULL,
        "unit" varchar(50),
        "aggregation" varchar(20) NOT NULL DEFAULT 'avg',
        "service" varchar(100),
        "dimensions" jsonb,
        "percentiles" jsonb,
        "histogram" jsonb,
        "sampleCount" integer,
        "minValue" double precision,
        "maxValue" double precision,
        "timestamp" timestamptz NOT NULL,
        "intervalSeconds" integer NOT NULL DEFAULT 60,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_performance_metrics_type_ts"
        ON admin.performance_metrics ("metricType", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_performance_metrics_service_ts"
        ON admin.performance_metrics ("service", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_performance_metrics_timestamp"
        ON admin.performance_metrics ("timestamp");
    `);
  }

  /** admin.performance_snapshots — system-management/entities/performance-metric.entity.ts */
  private async createPerformanceSnapshotsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.performance_snapshots (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "service" varchar(100),
        "timestamp" timestamptz NOT NULL,
        "applicationMetrics" jsonb NOT NULL,
        "databaseMetrics" jsonb NOT NULL,
        "infrastructureMetrics" jsonb NOT NULL,
        "alerts" jsonb,
        "overallHealthScore" double precision,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_performance_snapshots_timestamp"
        ON admin.performance_snapshots ("timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_performance_snapshots_service"
        ON admin.performance_snapshots ("service");
    `);
  }

  /** admin.slow_query_logs — database-management/entities/database-management.entity.ts */
  private async createSlowQueryLogsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // Note: 1781500000000-ConvertTimestampToTimestamptz converts
    // recordedAt to timestamptz. We start at timestamptz so the converter
    // sees no-op work on this table.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.slow_query_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid,
        "schemaName" varchar(100),
        "query" text NOT NULL,
        "normalizedQuery" text,
        "executionTimeMs" integer NOT NULL,
        "rowsAffected" integer NOT NULL DEFAULT 0,
        "rowsExamined" integer NOT NULL DEFAULT 0,
        "usedIndex" boolean NOT NULL DEFAULT false,
        "explainPlan" jsonb,
        "sourceTable" varchar(200),
        "userId" varchar(100),
        "recordedAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_slow_query_logs_tenantId"
        ON admin.slow_query_logs ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_slow_query_logs_executionTimeMs"
        ON admin.slow_query_logs ("executionTimeMs");
      CREATE INDEX IF NOT EXISTS "IDX_slow_query_logs_recordedAt"
        ON admin.slow_query_logs ("recordedAt");
    `);
  }

  /** admin.background_jobs — system-management/entities/job-queue.entity.ts */
  private async createBackgroundJobsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.background_jobs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(255) NOT NULL,
        "queueName" varchar(100) NOT NULL,
        "jobType" varchar(50) NOT NULL DEFAULT 'immediate',
        "status" varchar(50) NOT NULL DEFAULT 'pending',
        "priority" integer NOT NULL DEFAULT 5,
        "payload" jsonb,
        "result" jsonb,
        "errorMessage" text,
        "stackTrace" text,
        "progress" jsonb,
        "tenantId" uuid,
        "userId" uuid,
        "scheduledAt" timestamptz,
        "startedAt" timestamptz,
        "completedAt" timestamptz,
        "durationMs" integer,
        "attempts" integer NOT NULL DEFAULT 0,
        "maxAttempts" integer NOT NULL DEFAULT 3,
        "retryPolicy" jsonb,
        "nextRetryAt" timestamptz,
        "cronExpression" text,
        "lastRunAt" timestamptz,
        "nextRunAt" timestamptz,
        "timeoutMs" integer NOT NULL DEFAULT 3600000,
        "dependencies" jsonb,
        "parentJobId" uuid,
        "tags" jsonb,
        "metadata" jsonb,
        "workerId" varchar(100),
        "isRecurring" boolean NOT NULL DEFAULT false,
        "isPaused" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_background_jobs_status_priority_sched"
        ON admin.background_jobs ("status", "priority", "scheduledAt");
      CREATE INDEX IF NOT EXISTS "IDX_background_jobs_queue_status"
        ON admin.background_jobs ("queueName", "status");
      CREATE INDEX IF NOT EXISTS "IDX_background_jobs_type_status"
        ON admin.background_jobs ("jobType", "status");
      CREATE INDEX IF NOT EXISTS "IDX_background_jobs_tenant_status"
        ON admin.background_jobs ("tenantId", "status");
    `);
  }

  /** admin.job_queues — system-management/entities/job-queue.entity.ts */
  private async createJobQueuesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.job_queues (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "description" text,
        "isActive" boolean NOT NULL DEFAULT true,
        "isPaused" boolean NOT NULL DEFAULT false,
        "concurrency" integer NOT NULL DEFAULT 10,
        "maxJobsPerSecond" integer NOT NULL DEFAULT 100,
        "defaultMaxRetries" integer NOT NULL DEFAULT 3,
        "defaultTimeoutMs" integer NOT NULL DEFAULT 3600000,
        "retryPolicy" jsonb,
        "pendingCount" integer NOT NULL DEFAULT 0,
        "runningCount" integer NOT NULL DEFAULT 0,
        "completedCount" integer NOT NULL DEFAULT 0,
        "failedCount" integer NOT NULL DEFAULT 0,
        "avgProcessingTimeMs" double precision,
        "lastJobAt" timestamptz,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_job_queues_name"
        ON admin.job_queues ("name");
    `);
  }

  /** admin.job_execution_logs — system-management/entities/job-queue.entity.ts */
  private async createJobExecutionLogsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // No DB-level FK to background_jobs (entity does not declare one).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.job_execution_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "jobId" uuid NOT NULL,
        "attemptNumber" integer NOT NULL,
        "status" varchar(50) NOT NULL,
        "startedAt" timestamptz NOT NULL,
        "completedAt" timestamptz,
        "durationMs" integer,
        "errorMessage" text,
        "stackTrace" text,
        "result" jsonb,
        "logs" jsonb,
        "workerId" varchar(100),
        "cpuUsage" double precision,
        "memoryUsage" double precision,
        "timestamp" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_job_execution_logs_jobId_ts"
        ON admin.job_execution_logs ("jobId", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_job_execution_logs_timestamp"
        ON admin.job_execution_logs ("timestamp");
    `);
  }

  // ============================================================================
  // Tenant Ops
  // ============================================================================

  /** admin.tenant_configurations — settings/entities/tenant-configuration.entity.ts */
  private async createTenantConfigurationsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.tenant_configurations (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" varchar(255) NOT NULL,
        "userLimits" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "storageConfig" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "apiConfig" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "dataRetention" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "domainConfig" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "brandingConfig" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "securityConfig" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "notificationConfig" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "featureFlags" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedBy" varchar(255),
        CONSTRAINT "UQ_tenant_configurations_tenantId" UNIQUE ("tenantId")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenant_configurations_tenantId"
        ON admin.tenant_configurations ("tenantId");
    `);
  }

  /** admin.tenant_activities — tenant/entities/tenant-activity.entity.ts */
  private async createTenantActivitiesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.tenant_activities (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "activityType" admin.tenant_activities_activitytype_enum NOT NULL,
        "title" varchar(255) NOT NULL,
        "description" text,
        "metadata" jsonb,
        "previousValue" jsonb,
        "newValue" jsonb,
        "performedBy" varchar(100),
        "performedByEmail" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenant_activities_tenant_created"
        ON admin.tenant_activities ("tenantId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_activities_activityType"
        ON admin.tenant_activities ("activityType");
    `);
  }

  /** admin.tenant_notes — tenant/entities/tenant-activity.entity.ts */
  private async createTenantNotesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.tenant_notes (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "content" text NOT NULL,
        "category" varchar(50) NOT NULL DEFAULT 'general',
        "isPinned" boolean NOT NULL DEFAULT false,
        "createdBy" varchar(100) NOT NULL,
        "createdByEmail" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenant_notes_tenant_created"
        ON admin.tenant_notes ("tenantId", "createdAt");
    `);
  }

  /** admin.tenant_billing_info — tenant/entities/tenant-activity.entity.ts */
  private async createTenantBillingInfoTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.tenant_billing_info (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "billingCycle" varchar(50) NOT NULL,
        "monthlyAmount" decimal(10, 2) NOT NULL DEFAULT 0,
        "currency" varchar(3) NOT NULL DEFAULT 'USD',
        "paymentStatus" varchar(50) NOT NULL DEFAULT 'pending',
        "nextBillingDate" timestamptz,
        "lastPaymentDate" timestamptz,
        "lastPaymentAmount" decimal(10, 2),
        "stripeCustomerId" varchar(255),
        "stripeSubscriptionId" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_tenant_billing_info_tenantId" UNIQUE ("tenantId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenant_billing_info_tenantId"
        ON admin.tenant_billing_info ("tenantId");
    `);
  }

  /** admin.onboarding_progress — support/entities/support.entity.ts */
  private async createOnboardingProgressTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.onboarding_progress (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "tenantName" varchar(200),
        "status" varchar(50) NOT NULL DEFAULT 'not_started',
        "completionPercent" integer NOT NULL DEFAULT 0,
        "completedSteps" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "currentStep" varchar(100),
        "welcomeEmailSent" boolean NOT NULL DEFAULT false,
        "welcomeEmailSentAt" timestamptz,
        "gettingStartedViewed" boolean NOT NULL DEFAULT false,
        "viewedTutorials" jsonb,
        "scheduledTrainings" jsonb,
        "assignedGuide" uuid,
        "assignedGuideName" varchar(200),
        "startedAt" timestamptz,
        "completedAt" timestamptz,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_onboarding_progress_tenantId" UNIQUE ("tenantId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_onboarding_progress_tenantId"
        ON admin.onboarding_progress ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_onboarding_progress_status"
        ON admin.onboarding_progress ("status");
    `);
  }

  // ============================================================================
  // Impersonation / Debug
  // ============================================================================

  /** admin.impersonation_sessions — impersonation/entities/impersonation-session.entity.ts */
  private async createImpersonationSessionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.impersonation_sessions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "superAdminId" uuid NOT NULL,
        "superAdminEmail" varchar(255),
        "targetTenantId" uuid NOT NULL,
        "targetTenantName" varchar(255),
        "targetUserId" uuid,
        "targetUserEmail" varchar(255),
        "status" varchar(50) NOT NULL DEFAULT 'active',
        "reason" varchar(50) NOT NULL,
        "reasonDetails" text,
        "ticketReference" text,
        "permissions" jsonb,
        "ipAddress" inet,
        "userAgent" text,
        "originalSessionToken" text,
        "impersonationToken" text,
        "mfaCompleted" boolean NOT NULL DEFAULT false,
        "expiresAt" timestamptz NOT NULL,
        "endedAt" timestamptz,
        "endReason" text,
        "actionsPerformed" jsonb,
        "actionCount" integer NOT NULL DEFAULT 0,
        "accessedResources" jsonb,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_impersonation_sessions_superAdmin_status"
        ON admin.impersonation_sessions ("superAdminId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_impersonation_sessions_targetTenant_status"
        ON admin.impersonation_sessions ("targetTenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_impersonation_sessions_status_expires"
        ON admin.impersonation_sessions ("status", "expiresAt");
      CREATE INDEX IF NOT EXISTS "IDX_impersonation_sessions_createdAt"
        ON admin.impersonation_sessions ("createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_impersonation_sessions_ipAddress"
        ON admin.impersonation_sessions ("ipAddress");
    `);
  }

  /** admin.impersonation_permissions — impersonation/entities/impersonation-session.entity.ts */
  private async createImpersonationPermissionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.impersonation_permissions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "superAdminId" uuid NOT NULL,
        "superAdminEmail" varchar(255),
        "canImpersonate" boolean NOT NULL DEFAULT true,
        "isActive" boolean NOT NULL DEFAULT true,
        "allowedTenants" jsonb,
        "restrictedTenants" jsonb,
        "defaultPermissions" jsonb,
        "maxSessionDurationMinutes" integer NOT NULL DEFAULT 60,
        "maxConcurrentSessions" integer NOT NULL DEFAULT 3,
        "requireReason" boolean NOT NULL DEFAULT true,
        "requireTicketReference" boolean NOT NULL DEFAULT false,
        "notifyTenantAdmin" boolean NOT NULL DEFAULT true,
        "grantedBy" uuid,
        "grantedAt" timestamptz,
        "expiresAt" timestamptz,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_impersonation_permissions_superAdmin_active"
        ON admin.impersonation_permissions ("superAdminId", "isActive");
    `);
  }

  /** admin.debug_sessions — impersonation/entities/debug-session.entity.ts */
  private async createDebugSessionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.debug_sessions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "adminId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "sessionType" varchar(50) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "configuration" jsonb,
        "filters" jsonb,
        "maxResults" integer NOT NULL DEFAULT 1000,
        "expiresAt" timestamptz,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_debug_sessions_admin_tenant"
        ON admin.debug_sessions ("adminId", "tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_debug_sessions_type_created"
        ON admin.debug_sessions ("sessionType", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_debug_sessions_isActive"
        ON admin.debug_sessions ("isActive");
    `);
  }

  /** admin.captured_queries — impersonation/entities/debug-session.entity.ts */
  private async createCapturedQueriesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.captured_queries (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "debugSessionId" uuid,
        "tenantId" uuid NOT NULL,
        "userId" uuid,
        "queryType" varchar(50) NOT NULL,
        "query" text NOT NULL,
        "parameters" jsonb,
        "normalizedQuery" text,
        "durationMs" double precision NOT NULL,
        "rowsAffected" integer,
        "rowsReturned" integer,
        "tableName" text,
        "explainPlan" jsonb,
        "isSlowQuery" boolean NOT NULL DEFAULT false,
        "hasError" boolean NOT NULL DEFAULT false,
        "errorMessage" text,
        "stackTrace" text,
        "connectionSource" inet,
        "timestamp" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_captured_queries_session_ts"
        ON admin.captured_queries ("debugSessionId", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_captured_queries_tenant_ts"
        ON admin.captured_queries ("tenantId", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_captured_queries_type_duration"
        ON admin.captured_queries ("queryType", "durationMs");
    `);
  }

  /** admin.captured_api_calls — impersonation/entities/debug-session.entity.ts */
  private async createCapturedApiCallsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.captured_api_calls (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "debugSessionId" uuid,
        "tenantId" uuid NOT NULL,
        "userId" uuid,
        "method" varchar(10) NOT NULL,
        "endpoint" varchar(500) NOT NULL,
        "fullUrl" text,
        "requestHeaders" jsonb,
        "requestBody" jsonb,
        "queryParams" jsonb,
        "responseStatus" integer NOT NULL,
        "responseHeaders" jsonb,
        "responseBody" jsonb,
        "durationMs" double precision NOT NULL,
        "clientIp" inet,
        "userAgent" text,
        "correlationId" text,
        "hasError" boolean NOT NULL DEFAULT false,
        "errorMessage" text,
        "timestamp" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_captured_api_calls_session_ts"
        ON admin.captured_api_calls ("debugSessionId", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_captured_api_calls_tenant_ts"
        ON admin.captured_api_calls ("tenantId", "timestamp");
      CREATE INDEX IF NOT EXISTS "IDX_captured_api_calls_endpoint_method"
        ON admin.captured_api_calls ("endpoint", "method");
    `);
  }

  /** admin.cache_entries_snapshot — impersonation/entities/debug-session.entity.ts */
  private async createCacheEntriesSnapshotTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.cache_entries_snapshot (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "debugSessionId" uuid,
        "tenantId" uuid,
        "key" varchar(500) NOT NULL,
        "value" jsonb,
        "sizeBytes" integer,
        "ttlSeconds" integer,
        "expiresAt" timestamptz,
        "hitCount" integer NOT NULL DEFAULT 0,
        "lastAccessedAt" timestamptz,
        "cacheStore" varchar(100),
        "tags" jsonb,
        "capturedAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_cache_entries_session_captured"
        ON admin.cache_entries_snapshot ("debugSessionId", "capturedAt");
      CREATE INDEX IF NOT EXISTS "IDX_cache_entries_tenant_key"
        ON admin.cache_entries_snapshot ("tenantId", "key");
    `);
  }

  /** admin.feature_flag_overrides — impersonation/entities/debug-session.entity.ts */
  private async createFeatureFlagOverridesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.feature_flag_overrides (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "featureKey" varchar(100) NOT NULL,
        "originalValue" jsonb NOT NULL,
        "overrideValue" jsonb NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "adminId" uuid NOT NULL,
        "reason" text,
        "expiresAt" timestamptz,
        "appliedAt" timestamptz,
        "revertedAt" timestamptz,
        "revertedBy" uuid,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_feature_flag_overrides_tenant_key"
        ON admin.feature_flag_overrides ("tenantId", "featureKey");
      CREATE INDEX IF NOT EXISTS "IDX_feature_flag_overrides_admin_active"
        ON admin.feature_flag_overrides ("adminId", "isActive");
    `);
  }

  // ============================================================================
  // Security & Compliance
  // ============================================================================

  /** admin.activity_logs — security/entities/security.entity.ts */
  private async createActivityLogsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // tags is `simple-array` -> stored as comma-separated text by TypeORM.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.activity_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" varchar(100),
        "tenantName" varchar(100),
        "userId" varchar(100),
        "userName" varchar(255),
        "userEmail" varchar(100),
        "category" varchar(50) NOT NULL,
        "severity" varchar(20) NOT NULL DEFAULT 'info',
        "action" varchar(100) NOT NULL,
        "description" text NOT NULL,
        "entityType" varchar(100),
        "entityId" varchar(100),
        "entityName" varchar(255),
        "ipAddress" varchar(45) NOT NULL,
        "geoLocation" jsonb,
        "deviceInfo" jsonb,
        "requestInfo" jsonb,
        "sessionId" varchar(255),
        "correlationId" varchar(255),
        "previousValue" jsonb,
        "newValue" jsonb,
        "changedFields" jsonb,
        "metadata" jsonb,
        "tags" text,
        "success" boolean NOT NULL DEFAULT true,
        "errorMessage" text,
        "errorCode" varchar(100),
        "duration" integer,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "isArchived" boolean NOT NULL DEFAULT false,
        "archivedAt" timestamptz
      );
      CREATE INDEX IF NOT EXISTS "IDX_activity_logs_tenant_created"
        ON admin.activity_logs ("tenantId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_activity_logs_user_created"
        ON admin.activity_logs ("userId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_activity_logs_category_created"
        ON admin.activity_logs ("category", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_activity_logs_severity_created"
        ON admin.activity_logs ("severity", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_activity_logs_ip_created"
        ON admin.activity_logs ("ipAddress", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_activity_logs_action_created"
        ON admin.activity_logs ("action", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_activity_logs_entityType"
        ON admin.activity_logs ("entityType");
      CREATE INDEX IF NOT EXISTS "IDX_activity_logs_entityId"
        ON admin.activity_logs ("entityId");
    `);
  }

  /** admin.security_events — security/entities/security.entity.ts */
  private async createSecurityEventsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // mitigationActions, indicators, relatedActivityIds, tags are `simple-array`
    // -> comma-separated text. indicators is jsonb (per @Column type:'jsonb').
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.security_events (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "eventType" varchar(50) NOT NULL,
        "threatLevel" varchar(20) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'detected',
        "title" varchar(255) NOT NULL,
        "description" text NOT NULL,
        "ipAddress" varchar(45) NOT NULL,
        "geoLocation" jsonb,
        "deviceInfo" jsonb,
        "tenantId" varchar(100),
        "userId" varchar(100),
        "userName" varchar(255),
        "targetResource" varchar(100),
        "targetEndpoint" varchar(255),
        "detectionSource" varchar(100) NOT NULL,
        "confidenceScore" double precision,
        "anomalyDetails" jsonb,
        "indicators" jsonb,
        "rawData" jsonb,
        "relatedActivityIds" text,
        "autoMitigated" boolean NOT NULL DEFAULT false,
        "mitigationActions" text,
        "investigationNotes" text,
        "assignedTo" varchar(100),
        "assignedToName" varchar(255),
        "assignedAt" timestamptz,
        "resolution" text,
        "resolvedAt" timestamptz,
        "resolvedBy" varchar(100),
        "tags" text,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_security_events_tenant_created"
        ON admin.security_events ("tenantId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_security_events_eventType_created"
        ON admin.security_events ("eventType", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_security_events_status_created"
        ON admin.security_events ("status", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_security_events_threatLevel_created"
        ON admin.security_events ("threatLevel", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_security_events_ip_created"
        ON admin.security_events ("ipAddress", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_security_events_userId"
        ON admin.security_events ("userId");
    `);
  }

  /** admin.security_incidents — security/entities/security.entity.ts */
  private async createSecurityIncidentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.security_incidents (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "incidentNumber" varchar(50) NOT NULL,
        "title" varchar(255) NOT NULL,
        "description" text NOT NULL,
        "severity" varchar(20) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'open',
        "category" varchar(100) NOT NULL,
        "attackVector" varchar(100),
        "affectedSystems" text,
        "affectedTenants" text,
        "dataBreached" boolean NOT NULL DEFAULT false,
        "affectedUsersCount" integer NOT NULL DEFAULT 0,
        "impactDescription" text,
        "businessImpact" text,
        "detectedAt" timestamptz,
        "containedAt" timestamptz,
        "eradicatedAt" timestamptz,
        "recoveredAt" timestamptz,
        "closedAt" timestamptz,
        "leadInvestigator" varchar(100),
        "leadInvestigatorName" varchar(255),
        "teamMembers" text,
        "relatedSecurityEvents" text,
        "rootCauseAnalysis" text,
        "lessonsLearned" text,
        "remediationSteps" jsonb,
        "reportedToAuthorities" boolean NOT NULL DEFAULT false,
        "reportedAt" timestamptz,
        "reportReference" varchar(255),
        "timeline" jsonb,
        "metadata" jsonb,
        "createdBy" varchar(100) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_security_incidents_status_created"
        ON admin.security_incidents ("status", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_security_incidents_severity_created"
        ON admin.security_incidents ("severity", "createdAt");
    `);
  }

  /** admin.threat_intelligence — security/entities/security.entity.ts */
  private async createThreatIntelligenceTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.threat_intelligence (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "indicatorType" varchar(50) NOT NULL,
        "value" varchar(500) NOT NULL,
        "threatLevel" varchar(20) NOT NULL,
        "source" varchar(100) NOT NULL,
        "description" varchar(255),
        "threatTypes" text,
        "tags" text,
        "confidence" double precision NOT NULL DEFAULT 0.5,
        "isActive" boolean NOT NULL DEFAULT true,
        "validFrom" timestamptz,
        "validUntil" timestamptz,
        "hitCount" integer NOT NULL DEFAULT 0,
        "lastSeenAt" timestamptz,
        "firstSeenAt" timestamptz,
        "relatedIndicators" text,
        "geoData" jsonb,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_threat_intelligence_indicatorType"
        ON admin.threat_intelligence ("indicatorType");
      CREATE INDEX IF NOT EXISTS "IDX_threat_intelligence_value"
        ON admin.threat_intelligence ("value");
      CREATE INDEX IF NOT EXISTS "IDX_threat_intelligence_threatLevel"
        ON admin.threat_intelligence ("threatLevel");
      CREATE INDEX IF NOT EXISTS "IDX_threat_intelligence_isActive"
        ON admin.threat_intelligence ("isActive");
    `);
  }

  /** admin.data_requests — security/entities/security.entity.ts */
  private async createDataRequestsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.data_requests (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "requestNumber" varchar(50) NOT NULL,
        "requestType" varchar(50) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "complianceFramework" varchar(20) NOT NULL,
        "tenantId" varchar(100) NOT NULL,
        "tenantName" varchar(255) NOT NULL,
        "requesterId" varchar(100),
        "requesterName" varchar(255) NOT NULL,
        "requesterEmail" varchar(255) NOT NULL,
        "description" text NOT NULL,
        "dataCategories" text,
        "specificData" text,
        "identityVerified" boolean NOT NULL DEFAULT false,
        "verifiedAt" timestamptz,
        "verifiedBy" varchar(100),
        "verificationMethod" varchar(100),
        "dueDate" timestamptz NOT NULL,
        "assignedTo" varchar(100),
        "assignedToName" varchar(255),
        "processingStartedAt" timestamptz,
        "completedAt" timestamptz,
        "completedBy" varchar(100),
        "completionNotes" text,
        "deliveryFormat" varchar(20),
        "downloadUrl" varchar(500),
        "downloadExpiresAt" timestamptz,
        "downloadCount" integer NOT NULL DEFAULT 0,
        "rejectionReason" text,
        "auditTrail" jsonb,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_data_requests_tenant_created"
        ON admin.data_requests ("tenantId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_data_requests_type_status"
        ON admin.data_requests ("requestType", "status");
      CREATE INDEX IF NOT EXISTS "IDX_data_requests_dueDate"
        ON admin.data_requests ("dueDate");
    `);
  }

  /** admin.compliance_reports — security/entities/security.entity.ts */
  private async createComplianceReportsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.compliance_reports (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title" varchar(255) NOT NULL,
        "complianceType" varchar(20) NOT NULL,
        "reportPeriodStart" timestamptz NOT NULL,
        "reportPeriodEnd" timestamptz NOT NULL,
        "includedTenants" text,
        "includesAllTenants" boolean NOT NULL DEFAULT true,
        "totalDataRequests" integer NOT NULL DEFAULT 0,
        "completedDataRequests" integer NOT NULL DEFAULT 0,
        "pendingDataRequests" integer NOT NULL DEFAULT 0,
        "avgResponseTimeDays" double precision,
        "securityIncidents" integer NOT NULL DEFAULT 0,
        "dataBreaches" integer NOT NULL DEFAULT 0,
        "complianceScore" double precision NOT NULL DEFAULT 100,
        "violations" jsonb,
        "recommendations" jsonb,
        "executiveSummary" text,
        "detailedFindings" jsonb,
        "pdfUrl" varchar(500),
        "csvUrl" varchar(500),
        "generatedBy" varchar(100) NOT NULL,
        "generatedByName" varchar(255) NOT NULL,
        "isAutoGenerated" boolean NOT NULL DEFAULT false,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_compliance_reports_type_created"
        ON admin.compliance_reports ("complianceType", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_compliance_reports_period"
        ON admin.compliance_reports ("reportPeriodStart", "reportPeriodEnd");
    `);
  }

  /** admin.retention_policies — security/entities/security.entity.ts */
  private async createRetentionPoliciesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.retention_policies (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "category" varchar(50) NOT NULL,
        "description" text,
        "retentionDays" integer NOT NULL,
        "archiveAfterDays" integer,
        "deleteAfterArchiveDays" integer,
        "isGlobal" boolean NOT NULL DEFAULT true,
        "specificTenants" text,
        "complianceFrameworks" text,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdBy" varchar(100) NOT NULL,
        "updatedBy" varchar(100),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_retention_policies_name" UNIQUE ("name")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_retention_policies_name"
        ON admin.retention_policies ("name");
    `);
  }

  /** admin.login_attempts — security/entities/security.entity.ts */
  private async createLoginAttemptsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.login_attempts (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email" varchar(255) NOT NULL,
        "ipAddress" varchar(45) NOT NULL,
        "success" boolean NOT NULL,
        "failureReason" varchar(100),
        "geoLocation" jsonb,
        "deviceInfo" jsonb,
        "tenantId" varchar(100),
        "userId" varchar(100),
        "sessionId" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_login_attempts_ip_created"
        ON admin.login_attempts ("ipAddress", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_login_attempts_email_created"
        ON admin.login_attempts ("email", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_login_attempts_success_created"
        ON admin.login_attempts ("success", "createdAt");
    `);
  }

  /** admin.api_usage_logs — security/entities/security.entity.ts */
  private async createApiUsageLogsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.api_usage_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" varchar(100),
        "userId" varchar(100),
        "apiKeyId" varchar(255),
        "method" varchar(10) NOT NULL,
        "endpoint" varchar(500) NOT NULL,
        "path" varchar(500) NOT NULL,
        "queryParams" jsonb,
        "requestSize" integer,
        "statusCode" integer NOT NULL,
        "responseSize" integer,
        "responseTimeMs" integer NOT NULL,
        "ipAddress" varchar(45) NOT NULL,
        "userAgent" varchar(500),
        "geoLocation" jsonb,
        "rateLimitRemaining" integer,
        "rateLimitExceeded" boolean NOT NULL DEFAULT false,
        "isError" boolean NOT NULL DEFAULT false,
        "errorCode" varchar(100),
        "errorMessage" text,
        "correlationId" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_api_usage_logs_tenant_created"
        ON admin.api_usage_logs ("tenantId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_api_usage_logs_endpoint_created"
        ON admin.api_usage_logs ("endpoint", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_api_usage_logs_status_created"
        ON admin.api_usage_logs ("statusCode", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_api_usage_logs_userId"
        ON admin.api_usage_logs ("userId");
      CREATE INDEX IF NOT EXISTS "IDX_api_usage_logs_ipAddress"
        ON admin.api_usage_logs ("ipAddress");
    `);
  }

  /** admin.user_sessions — security/entities/security.entity.ts */
  private async createUserSessionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.user_sessions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "sessionToken" varchar(255) NOT NULL,
        "userId" varchar(100) NOT NULL,
        "userName" varchar(255) NOT NULL,
        "tenantId" varchar(100),
        "tenantName" varchar(255),
        "isActive" boolean NOT NULL DEFAULT true,
        "expiresAt" timestamptz NOT NULL,
        "ipAddress" varchar(45) NOT NULL,
        "geoLocation" jsonb,
        "deviceInfo" jsonb,
        "requestCount" integer NOT NULL DEFAULT 0,
        "lastActivityAt" timestamptz NOT NULL,
        "lastActivityPath" varchar(500),
        "terminatedAt" timestamptz,
        "terminationReason" varchar(50),
        "terminatedBy" varchar(100),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_user_sessions_sessionToken" UNIQUE ("sessionToken")
      );
      CREATE INDEX IF NOT EXISTS "IDX_user_sessions_user_active"
        ON admin.user_sessions ("userId", "isActive");
      CREATE INDEX IF NOT EXISTS "IDX_user_sessions_tenant_active"
        ON admin.user_sessions ("tenantId", "isActive");
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_sessions_sessionToken"
        ON admin.user_sessions ("sessionToken");
      CREATE INDEX IF NOT EXISTS "IDX_user_sessions_lastActivityAt"
        ON admin.user_sessions ("lastActivityAt");
    `);
  }

  // ============================================================================
  // Database Management
  // ============================================================================

  /** admin.tenant_schemas — database-management/entities/database-management.entity.ts */
  private async createTenantSchemasTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.tenant_schemas (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "schemaName" varchar(100) NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'active',
        "currentVersion" varchar(20) NOT NULL DEFAULT '1.0.0',
        "sizeBytes" bigint NOT NULL DEFAULT 0,
        "tableCount" integer NOT NULL DEFAULT 0,
        "connectionCount" integer NOT NULL DEFAULT 0,
        "maxConnections" integer NOT NULL DEFAULT 10,
        "metadata" jsonb,
        "lastMigrationAt" timestamptz,
        "lastBackupAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_tenant_schemas_tenantId" UNIQUE ("tenantId")
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tenant_schemas_tenantId"
        ON admin.tenant_schemas ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_schemas_status"
        ON admin.tenant_schemas ("status");
    `);
  }

  /** admin.schema_migrations — database-management/entities/database-management.entity.ts */
  private async createSchemaMigrationsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.schema_migrations (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid,
        "schemaName" varchar(100) NOT NULL,
        "migrationName" varchar(200) NOT NULL,
        "version" varchar(20) NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'pending',
        "upScript" text,
        "downScript" text,
        "errorMessage" text,
        "executionTimeMs" integer NOT NULL DEFAULT 0,
        "isDryRun" boolean NOT NULL DEFAULT false,
        "affectedTables" jsonb,
        "executedBy" varchar(100),
        "startedAt" timestamptz,
        "completedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_schema_migrations_tenantId"
        ON admin.schema_migrations ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_schema_migrations_status"
        ON admin.schema_migrations ("status");
      CREATE INDEX IF NOT EXISTS "IDX_schema_migrations_version"
        ON admin.schema_migrations ("version");
    `);
  }

  /** admin.schema_backups — database-management/entities/database-management.entity.ts */
  private async createSchemaBackupsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.schema_backups (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid,
        "schemaName" varchar(100) NOT NULL,
        "backupType" varchar(50) NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'pending',
        "filePath" varchar(500),
        "fileName" varchar(200),
        "sizeBytes" bigint NOT NULL DEFAULT 0,
        "checksum" varchar(64),
        "isEncrypted" boolean NOT NULL DEFAULT false,
        "isCompressed" boolean NOT NULL DEFAULT false,
        "retentionDays" integer NOT NULL DEFAULT 0,
        "errorMessage" text,
        "metadata" jsonb,
        "startedAt" timestamptz,
        "completedAt" timestamptz,
        "expiresAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_schema_backups_tenantId"
        ON admin.schema_backups ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_schema_backups_status"
        ON admin.schema_backups ("status");
      CREATE INDEX IF NOT EXISTS "IDX_schema_backups_backupType"
        ON admin.schema_backups ("backupType");
    `);
  }

  /** admin.schema_restores — database-management/entities/database-management.entity.ts */
  private async createSchemaRestoresTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.schema_restores (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "backupId" uuid NOT NULL,
        "tenantId" uuid,
        "targetSchemaName" varchar(100) NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'pending',
        "isPointInTime" boolean NOT NULL DEFAULT false,
        "pointInTimeTarget" timestamptz,
        "errorMessage" text,
        "executionTimeMs" integer NOT NULL DEFAULT 0,
        "executedBy" varchar(100),
        "restoredTables" jsonb,
        "startedAt" timestamptz,
        "completedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_schema_restores_tenantId"
        ON admin.schema_restores ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_schema_restores_backupId"
        ON admin.schema_restores ("backupId");
      CREATE INDEX IF NOT EXISTS "IDX_schema_restores_status"
        ON admin.schema_restores ("status");
    `);
  }

  /** admin.database_metrics — database-management/entities/database-management.entity.ts */
  private async createDatabaseMetricsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.database_metrics (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid,
        "schemaName" varchar(100),
        "metricType" varchar(50) NOT NULL,
        "metrics" jsonb NOT NULL,
        "recordedAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_database_metrics_tenantId"
        ON admin.database_metrics ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_database_metrics_recordedAt"
        ON admin.database_metrics ("recordedAt");
      CREATE INDEX IF NOT EXISTS "IDX_database_metrics_metricType"
        ON admin.database_metrics ("metricType");
    `);
  }

  // ============================================================================
  // Forum / Support
  // ============================================================================

  /** admin.message_threads — support/entities/support.entity.ts */
  private async createMessageThreadsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.message_threads (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "subject" varchar(200) NOT NULL,
        "lastMessageId" uuid,
        "messageCount" integer NOT NULL DEFAULT 0,
        "unreadAdminCount" integer NOT NULL DEFAULT 0,
        "unreadTenantCount" integer NOT NULL DEFAULT 0,
        "isArchived" boolean NOT NULL DEFAULT false,
        "isClosed" boolean NOT NULL DEFAULT false,
        "lastMessageAt" timestamptz,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_message_threads_tenantId"
        ON admin.message_threads ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_message_threads_lastMessageAt"
        ON admin.message_threads ("lastMessageAt");
    `);
  }

  /** admin.messages — support/entities/support.entity.ts */
  private async createMessagesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.messages (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "threadId" uuid NOT NULL,
        "senderId" uuid NOT NULL,
        "senderType" varchar(50) NOT NULL,
        "senderName" varchar(200),
        "content" text NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'sent',
        "isInternal" boolean NOT NULL DEFAULT false,
        "attachments" jsonb,
        "readAt" timestamptz,
        "emailSent" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_messages_threadId"
        ON admin.messages ("threadId");
      CREATE INDEX IF NOT EXISTS "IDX_messages_senderId"
        ON admin.messages ("senderId");
      CREATE INDEX IF NOT EXISTS "IDX_messages_createdAt"
        ON admin.messages ("createdAt");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE admin.messages
          ADD CONSTRAINT "FK_messages_thread"
          FOREIGN KEY ("threadId") REFERENCES admin.message_threads("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** admin.announcements — support/entities/support.entity.ts */
  private async createAnnouncementsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.announcements (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title" varchar(200) NOT NULL,
        "content" text NOT NULL,
        "type" varchar(50) NOT NULL DEFAULT 'info',
        "status" varchar(50) NOT NULL DEFAULT 'draft',
        "isGlobal" boolean NOT NULL DEFAULT false,
        "targetCriteria" jsonb,
        "createdBy" uuid,
        "createdByName" varchar(200),
        "publishAt" timestamptz,
        "expiresAt" timestamptz,
        "requiresAcknowledgment" boolean NOT NULL DEFAULT false,
        "viewCount" integer NOT NULL DEFAULT 0,
        "acknowledgmentCount" integer NOT NULL DEFAULT 0,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_announcements_status"
        ON admin.announcements ("status");
      CREATE INDEX IF NOT EXISTS "IDX_announcements_type"
        ON admin.announcements ("type");
      CREATE INDEX IF NOT EXISTS "IDX_announcements_publishAt"
        ON admin.announcements ("publishAt");
      CREATE INDEX IF NOT EXISTS "IDX_announcements_expiresAt"
        ON admin.announcements ("expiresAt");
    `);
  }

  /** admin.announcement_acknowledgments — support/entities/support.entity.ts */
  private async createAnnouncementAcknowledgmentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.announcement_acknowledgments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "announcementId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "userName" varchar(200),
        "viewedAt" timestamptz,
        "acknowledgedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_announcement_acks_announcementId"
        ON admin.announcement_acknowledgments ("announcementId");
      CREATE INDEX IF NOT EXISTS "IDX_announcement_acks_tenantId"
        ON admin.announcement_acknowledgments ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_announcement_acks_userId"
        ON admin.announcement_acknowledgments ("userId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE admin.announcement_acknowledgments
          ADD CONSTRAINT "FK_announcement_acks_announcement"
          FOREIGN KEY ("announcementId") REFERENCES admin.announcements("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** admin.support_tickets — support/entities/support.entity.ts */
  private async createSupportTicketsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.support_tickets (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ticketNumber" varchar(20) NOT NULL,
        "tenantId" uuid NOT NULL,
        "tenantName" varchar(200),
        "createdBy" uuid NOT NULL,
        "createdByName" varchar(200),
        "createdByEmail" varchar(255),
        "subject" varchar(200) NOT NULL,
        "description" text NOT NULL,
        "category" varchar(50) NOT NULL DEFAULT 'general',
        "priority" varchar(50) NOT NULL DEFAULT 'medium',
        "status" varchar(50) NOT NULL DEFAULT 'open',
        "assignedTo" uuid,
        "assignedToName" varchar(200),
        "tags" jsonb,
        "firstResponseAt" timestamptz,
        "resolvedAt" timestamptz,
        "closedAt" timestamptz,
        "dueAt" timestamptz,
        "slaResponseMinutes" integer,
        "slaResolutionMinutes" integer,
        "slaBreached" boolean NOT NULL DEFAULT false,
        "satisfactionRating" integer NOT NULL DEFAULT 0,
        "satisfactionFeedback" text,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_support_tickets_ticketNumber" UNIQUE ("ticketNumber")
      );
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_tenantId"
        ON admin.support_tickets ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_status"
        ON admin.support_tickets ("status");
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_priority"
        ON admin.support_tickets ("priority");
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_category"
        ON admin.support_tickets ("category");
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_assignedTo"
        ON admin.support_tickets ("assignedTo");
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_dueAt"
        ON admin.support_tickets ("dueAt");
    `);
  }

  /** admin.ticket_comments — support/entities/support.entity.ts */
  private async createTicketCommentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.ticket_comments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ticketId" uuid NOT NULL,
        "authorId" uuid NOT NULL,
        "authorType" varchar(50) NOT NULL,
        "authorName" varchar(200),
        "content" text NOT NULL,
        "isInternal" boolean NOT NULL DEFAULT false,
        "attachments" jsonb,
        "emailSent" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_ticket_comments_ticketId"
        ON admin.ticket_comments ("ticketId");
      CREATE INDEX IF NOT EXISTS "IDX_ticket_comments_authorId"
        ON admin.ticket_comments ("authorId");
      CREATE INDEX IF NOT EXISTS "IDX_ticket_comments_createdAt"
        ON admin.ticket_comments ("createdAt");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE admin.ticket_comments
          ADD CONSTRAINT "FK_ticket_comments_ticket"
          FOREIGN KEY ("ticketId") REFERENCES admin.support_tickets("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  // ============================================================================
  // Init-script-owned analytics, billing-config & admin audit
  //
  // Folded in from `infrastructure/docker/init-scripts/04-billing-tables.sql`
  // and `infrastructure/docker/init-scripts/11-service-audit-tables.sql`.
  // Those init scripts are removed in the same orchestrator commit; the
  // migration is now the single source of truth for these admin.* tables
  // (matches every other admin schema table that the migration owns).
  //
  // No FKs to / from the rest of the admin schema, so order between these
  // five tables is irrelevant. Column shapes mirror the FINAL state after
  // any later ALTER (currently none target these tables — checked at
  // bootstrap-restoration time against the 1781500000000+ chain).
  // ============================================================================

  /**
   * admin.module_pricing — billing/entities/module-pricing.entity.ts
   *
   * Per-module pricing configuration with tier multipliers (free/starter/
   * professional/enterprise/custom) and effective-date windowing. Read by
   * the billing-service across schemas with `synchronize: false`; the
   * canonical writer is admin-api's ModulePricingService.
   */
  private async createModulePricingTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.module_pricing (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "moduleId" uuid NOT NULL,
        "moduleCode" varchar(50) NOT NULL,
        "pricingMetrics" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "tierMultipliers" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "currency" varchar(3) NOT NULL DEFAULT 'USD',
        "effectiveFrom" timestamptz NOT NULL DEFAULT NOW(),
        "effectiveTo" timestamptz,
        "isActive" boolean NOT NULL DEFAULT true,
        "notes" text,
        "version" integer NOT NULL DEFAULT 1,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "createdBy" uuid,
        "updatedBy" uuid,
        CONSTRAINT "UQ_module_pricing_module_effectiveFrom" UNIQUE ("moduleId", "effectiveFrom")
      );
      CREATE INDEX IF NOT EXISTS "idx_module_pricing_module_id"
        ON admin.module_pricing ("moduleId");
      CREATE INDEX IF NOT EXISTS "idx_module_pricing_is_active"
        ON admin.module_pricing ("isActive");
      CREATE INDEX IF NOT EXISTS "idx_module_pricing_effective_from"
        ON admin.module_pricing ("effectiveFrom");
    `);
  }

  /**
   * admin.analytics_snapshots — analytics/entities/analytics-snapshot.entity.ts
   *
   * Daily/weekly/monthly snapshot of platform-level metrics by category.
   * Append-only — written by the analytics aggregator cron, read by the
   * admin dashboard.
   */
  private async createAnalyticsSnapshotsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.analytics_snapshots (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "snapshotType" varchar(20) NOT NULL,
        "category" varchar(20) NOT NULL,
        "snapshotDate" date NOT NULL,
        "metrics" jsonb NOT NULL,
        "metadata" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "idx_analytics_snapshots_type_date"
        ON admin.analytics_snapshots ("snapshotType", "snapshotDate");
      CREATE INDEX IF NOT EXISTS "idx_analytics_snapshots_category_date"
        ON admin.analytics_snapshots ("category", "snapshotDate");
    `);
  }

  /**
   * admin.report_definitions — reporting/entities/report-definition.entity.ts
   *
   * Saved report templates (filters, format, schedule, recipients). The
   * `lastRunAt` and `runCount` columns are timestamp-without-tz as the
   * entity declares — the timestamptz converter (1781500000000) does NOT
   * touch report_definitions or report_executions, by design.
   */
  private async createReportDefinitionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.report_definitions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(200) NOT NULL,
        "description" text,
        "type" varchar(50) NOT NULL,
        "defaultFormat" varchar(20) NOT NULL DEFAULT 'json',
        "status" varchar(20) NOT NULL DEFAULT 'active',
        "schedule" varchar(20) NOT NULL DEFAULT 'manual',
        "defaultFilters" jsonb,
        "recipients" jsonb,
        "includeCharts" boolean NOT NULL DEFAULT false,
        "createdBy" uuid,
        "createdByEmail" varchar(255),
        "lastRunAt" timestamp,
        "runCount" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "idx_report_definitions_created_by"
        ON admin.report_definitions ("createdBy");
      CREATE INDEX IF NOT EXISTS "idx_report_definitions_status"
        ON admin.report_definitions (status);
    `);
  }

  /**
   * admin.report_executions — reporting/entities/report-execution.entity.ts
   *
   * Each report run gets a row recording filters, format, status, output
   * (download URL + size + row count) and timing. Append-only; cleaned by
   * retention sweeps. `definitionId` is a logical reference to
   * admin.report_definitions but no DB-level FK is declared (matches the
   * original init-script and the entity decorator) so retention sweeps on
   * report_definitions don't cascade-delete execution history.
   */
  private async createReportExecutionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.report_executions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "definitionId" uuid,
        "reportName" varchar(200) NOT NULL,
        "reportType" varchar(50) NOT NULL,
        "format" varchar(20) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "startDate" timestamp,
        "endDate" timestamp,
        "filters" jsonb,
        "summary" jsonb,
        "rowCount" integer,
        "fileSizeBytes" integer,
        "downloadUrl" varchar(500),
        "downloadExpiresAt" timestamp,
        "errorMessage" text,
        "durationMs" integer,
        "executedBy" uuid,
        "executedByEmail" varchar(255),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "completedAt" timestamp
      );
      CREATE INDEX IF NOT EXISTS "idx_report_executions_definition_id"
        ON admin.report_executions ("definitionId");
      CREATE INDEX IF NOT EXISTS "idx_report_executions_status"
        ON admin.report_executions (status);
      CREATE INDEX IF NOT EXISTS "idx_report_executions_created_at"
        ON admin.report_executions ("createdAt");
    `);
  }

  /**
   * admin.audit_logs — audit/audit.entity.ts
   *
   * SUPER_ADMIN cross-tenant audit trail (impersonation start/stop, tenant
   * suspension, plan changes, system setting changes) — DISTINCT from
   * `shared.audit_logs` (cross-service trail, backend-common entity shape)
   * and `auth.audit_logs` (auth-service login/MFA/token events).
   *
   * # Why three audit tables, three shapes
   *
   *   - admin.audit_logs   : extended fields (AuditAction enum, AuditSeverity,
   *                          previousValue/newValue JSONB), cross-tenant by
   *                          design — admin-api wraps every request under
   *                          BypassRlsService.withBypass()
   *   - auth.audit_logs    : login/MFA/token/permission events, narrower
   *                          shape with auth.audit_log_severity (4 values
   *                          incl. 'error')
   *   - shared.audit_logs  : canonical cross-service trail used by
   *                          backend-common's AuditLogModule.forRoot()
   *                          (different column names — resource, userId,
   *                          schemaName, correlationId, …)
   *
   * # `legalHold` column NOT created here
   *
   * Migration 1787800000000-AddAdminAuditLogsImmutability adds the
   * `legalHold` column + immutability triggers. That migration's
   * `ADD COLUMN IF NOT EXISTS` runs cleanly on top of this CREATE; we
   * keep the trigger DDL in its dedicated migration so the security
   * concern stays a single, audited unit (AUDITTRAIL-HIGH-006 cure).
   *
   * # Idempotent fallback by 1787100000000
   *
   * 1787100000000-CreateAdminAuditLogsTable continues to ship a full
   * `CREATE TABLE IF NOT EXISTS` — it is now a no-op for fresh DBs (this
   * migration runs first) but stays in the ledger for legacy droplets that
   * booted before this baseline existed.
   *
   * # `ipAddress` column type
   *
   * Birthed as `varchar(45)` to match the pre-1788000000000 shape; the
   * `ConvertAuditIpColumnsToInet1788000000000` migration converts it to
   * native `inet`. Starting from `varchar(45)` keeps the migration replay
   * idempotent (the converter does the rewrite once, on whichever shape
   * exists).
   */
  private async createAdminAuditLogsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.audit_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "action" varchar(100) NOT NULL,
        "entityType" varchar(50) NOT NULL,
        "entityId" uuid,
        "tenantId" uuid,
        "performedBy" varchar(100) NOT NULL,
        "performedByEmail" varchar(100),
        "ipAddress" varchar(45),
        "userAgent" varchar(500),
        "details" jsonb,
        "previousValue" jsonb,
        "newValue" jsonb,
        "severity" admin.audit_logs_severity_enum NOT NULL DEFAULT 'info',
        "requestId" varchar(100),
        "sessionId" varchar(100),
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_action"
        ON admin.audit_logs ("action");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_entity"
        ON admin.audit_logs ("entityType", "entityId");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_performedBy"
        ON admin.audit_logs ("performedBy");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_tenantId"
        ON admin.audit_logs ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_createdAt"
        ON admin.audit_logs ("createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_admin_audit_logs_severity"
        ON admin.audit_logs ("severity");
    `);
  }
}
