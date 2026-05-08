import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateInitialSchema1700000000000
 * ============================================================================
 *
 * Restores the auth-service migration baseline that was lost when several
 * earlier `CREATE TABLE` migrations were squashed out of source. On a
 * fresh-volume bootstrap (no init scripts mounted, or init scripts only
 * supplying the legacy partial set: `users`, `tenants`, `invitations`,
 * `tenant_modules`, `tenant_roles`), the remaining migration chain
 * (1711700000000+) assumes baseline tables/columns that no longer have a
 * creation step. Concrete failure on a fresh DB:
 * `1781100000000-ConvertTimestampToTimestamptz` ALTERs `users.mfaLockedUntil`
 * which was never created.
 *
 * # Scope
 *
 *   1. Create 12 missing `auth.*` tables idempotently:
 *        refresh_tokens, webauthn_credentials, user_module_assignments,
 *        mobile_user_settings, modules, announcements,
 *        announcement_acknowledgments, message_threads, messages,
 *        support_tickets, ticket_comments, audit_logs.
 *   2. Add 5 missing columns to `auth.users` idempotently:
 *        accessType, mfaRecoveryCodes, mfaFailedAttempts, mfaLockedUntil,
 *        notificationPreferences.
 *
 * Tables already created by `infrastructure/docker/init-scripts/01-init-databases.sql`
 * (users, tenants, invitations, tenant_modules, tenant_roles) are NOT
 * re-created here — that boundary is owned by the init script. This
 * migration only fills the gap between the init-script snapshot and the
 * current entity surface.
 *
 * # Idempotency
 *
 * Every DDL statement uses `IF NOT EXISTS` (tables, columns, indexes) and
 * `DO $$ ... EXCEPTION ...` blocks for enum types and FK constraints.
 * A second run is a no-op. This is required because:
 *
 *   - The migration ledger (`auth.migrations`) only inserts the entry
 *     once, but a partial first-run failure (e.g. transient network) may
 *     leave some objects already created when the migration is retried.
 *   - The init script may already have established a subset of these
 *     objects on legacy environments.
 *
 * # Order
 *
 * Tables are created in topological order (parents before FK children):
 *   modules / mobile_user_settings (no auth.* FKs)
 *     -> user_module_assignments (FK to users + modules)
 *     -> refresh_tokens, webauthn_credentials (FK to users)
 *     -> announcements (FK to tenants), announcement_acknowledgments (FK to announcements)
 *     -> message_threads (FK to tenants) -> messages (FK to message_threads)
 *     -> support_tickets (FK to tenants) -> ticket_comments (FK to support_tickets)
 *     -> audit_logs (no FKs; standalone)
 *
 * # Why TIMESTAMPTZ for every date column
 *
 * The codebase standardises on TIMESTAMPTZ across the auth schema; the
 * later `ConvertTimestampToTimestamptz1781100000000` migration converts
 * any plain `TIMESTAMP` survivors and uses `information_schema` to skip
 * tables/columns it cannot find — so creating the new tables with
 * `TIMESTAMPTZ` from birth is consistent with both the entity decorators
 * (`type: 'timestamptz'`) and the timestamptz-only invariant.
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */
export class CreateInitialSchema1700000000000 implements MigrationInterface {
  name = 'CreateInitialSchema1700000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Creating baseline auth.* tables (17) — full ownership of every auth.* template',
    );

    // The auth schema itself is created by infrastructure/docker/init-scripts.
    // Defensive guard for direct CLI runs against a bare database — this is a
    // no-op when the schema already exists.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS auth`);

    await this.createEnumTypes(queryRunner);

    // 5 init-script-owned tables now folded into the baseline (Wave 4-A.2
    // landed when 01-init-databases.sql was stripped to extensions-only).
    // These create the canonical auth identity surface that every other
    // table FKs against (users → tenants, invitations → tenants, etc.).
    await this.createTenantsTable(queryRunner);
    await this.createUsersTable(queryRunner);
    await this.createInvitationsTable(queryRunner);
    await this.createTenantModulesTable(queryRunner);
    await this.createTenantRolesTable(queryRunner);

    // ALTER block kept for legacy droplets where the older init-script
    // shape lives in the DB; on fresh DB the columns are already in
    // createUsersTable so every ADD COLUMN IF NOT EXISTS is a no-op.
    await this.alterAuthUsersAddMissingColumns(queryRunner);

    await this.createModulesTable(queryRunner);
    await this.createMobileUserSettingsTable(queryRunner);
    await this.createUserModuleAssignmentsTable(queryRunner);
    await this.createRefreshTokensTable(queryRunner);
    await this.createWebauthnCredentialsTable(queryRunner);
    await this.createAnnouncementsTable(queryRunner);
    await this.createAnnouncementAcknowledgmentsTable(queryRunner);
    await this.createMessageThreadsTable(queryRunner);
    await this.createMessagesTable(queryRunner);
    await this.createSupportTicketsTable(queryRunner);
    await this.createTicketCommentsTable(queryRunner);
    await this.createAuditLogsTable(queryRunner);

    this.logger.log('Baseline auth schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse FK order — children first, then parents, then the
    // auth.users column additions, then the enum types.
    this.logger.warn(
      'Reverting baseline auth.* tables and auth.users column additions. ' +
        'This is destructive and is intended for ephemeral test environments only.',
    );

    const tablesInDropOrder = [
      'audit_logs',
      'ticket_comments',
      'support_tickets',
      'messages',
      'message_threads',
      'announcement_acknowledgments',
      'announcements',
      'webauthn_credentials',
      'refresh_tokens',
      'user_module_assignments',
      'mobile_user_settings',
      'modules',
      // 5 init-script-owned tables folded into Wave 1 baseline by Wave 4-A.2.
      // Drop order: tenant_roles + tenant_modules first (FK to tenants), then
      // invitations, users, then tenants last.
      'tenant_roles',
      'tenant_modules',
      'invitations',
      'users',
      'tenants',
    ];

    for (const table of tablesInDropOrder) {
      await queryRunner.query(`DROP TABLE IF EXISTS auth."${table}" CASCADE`);
    }

    // Drop the 5 columns added to auth.users. Order is irrelevant.
    const userColumnsToRemove = [
      'accessType',
      'mfaRecoveryCodes',
      'mfaFailedAttempts',
      'mfaLockedUntil',
      'notificationPreferences',
    ];
    for (const col of userColumnsToRemove) {
      await queryRunner.query(
        `ALTER TABLE auth.users DROP COLUMN IF EXISTS "${col}"`,
      );
    }

    // Drop enum types last — table drops above already removed dependent
    // columns, so these should be free.
    const enumTypes = [
      'announcements_type_enum',
      'announcements_status_enum',
      'announcements_scope_enum',
      'message_threads_status_enum',
      'messages_sendertype_enum',
      'messages_status_enum',
      'support_tickets_category_enum',
      'support_tickets_priority_enum',
      'support_tickets_status_enum',
      'ticket_comments_authortype_enum',
      'audit_logs_severity_enum',
    ];
    for (const enumType of enumTypes) {
      await queryRunner.query(
        `DROP TYPE IF EXISTS auth."${enumType}" CASCADE`,
      );
    }
  }

  /**
   * auth.tenants — canonical tenant identity. FK target for users,
   * invitations, tenant_modules, tenant_roles, and every per-tenant
   * scope across the platform. Folded into Wave 1 baseline when
   * Wave 4-A.2 stripped 01-init-databases.sql to extensions-only.
   */
  private async createTenantsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.tenants (
        id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name                VARCHAR(255) NOT NULL,
        slug                VARCHAR(100) NOT NULL,
        description         TEXT,
        "logoUrl"           VARCHAR(500),
        "contactEmail"      VARCHAR(255),
        "contactPhone"      VARCHAR(50),
        address             TEXT,
        "taxId"             VARCHAR(100),
        status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        plan                VARCHAR(20) NOT NULL DEFAULT 'starter',
        "maxUsers"          INTEGER NOT NULL DEFAULT 5,
        max_storage         INTEGER NOT NULL DEFAULT -1,
        is_trial_active     BOOLEAN NOT NULL DEFAULT false,
        user_count          INTEGER NOT NULL DEFAULT 0,
        farm_count          INTEGER NOT NULL DEFAULT 0,
        sensor_count        INTEGER NOT NULL DEFAULT 0,
        "trialEndsAt"       TIMESTAMP,
        "subscriptionEndsAt" TIMESTAMP,
        "customDomain"      VARCHAR(255),
        settings            JSONB,
        "createdBy"         UUID,
        "createdAt"         TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt"         TIMESTAMP NOT NULL DEFAULT NOW(),
        version             INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "UQ_tenants_slug" UNIQUE (slug)
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenants_slug" ON auth.tenants (slug);
      CREATE INDEX IF NOT EXISTS "IDX_tenants_status" ON auth.tenants (status);
    `);
  }

  /**
   * auth.users — canonical platform identity. Wave 1 created the 5
   * MFA / accessType / notificationPreferences columns via ALTER for
   * legacy DBs; Wave 4-A.2 folds the full column set into the CREATE
   * so fresh DBs get the entity-canonical shape from birth.
   */
  private async createUsersTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.users (
        id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email                   VARCHAR(255) NOT NULL,
        password                VARCHAR(255),
        "firstName"             VARCHAR(100),
        "lastName"              VARCHAR(100),
        role                    VARCHAR(50) NOT NULL DEFAULT 'MODULE_USER',
        "tenantId"              UUID,
        "isActive"              BOOLEAN NOT NULL DEFAULT true,
        "isEmailVerified"       BOOLEAN NOT NULL DEFAULT false,
        "invitationToken"       VARCHAR(255),
        "invitationExpiresAt"   TIMESTAMP WITH TIME ZONE,
        "invitedBy"             UUID,
        "profileImageUrl"       VARCHAR(500),
        "phoneNumber"           VARCHAR(50),
        "preferredLanguage"     VARCHAR(10) DEFAULT 'en',
        "accessType"            VARCHAR(20) DEFAULT 'BOTH',
        "notificationPreferences" JSONB,
        "mfaEnabled"            BOOLEAN NOT NULL DEFAULT false,
        "mfaSecret"             VARCHAR(255),
        "mfaRecoveryCodes"      TEXT,
        "mfaFailedAttempts"     INTEGER NOT NULL DEFAULT 0,
        "mfaLockedUntil"        TIMESTAMPTZ,
        "lastLoginAt"           TIMESTAMP WITH TIME ZONE,
        "lastLoginIp"           VARCHAR(45),
        "passwordResetToken"    VARCHAR(255),
        "passwordResetExpires"  TIMESTAMP WITH TIME ZONE,
        "failedLoginAttempts"   INTEGER NOT NULL DEFAULT 0,
        "lockedUntil"           TIMESTAMP WITH TIME ZONE,
        "createdAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_users_email" UNIQUE (email)
      );
      CREATE INDEX IF NOT EXISTS "IDX_users_email" ON auth.users (email);
      CREATE INDEX IF NOT EXISTS "IDX_users_tenantId" ON auth.users ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_users_role" ON auth.users (role);
    `);
  }

  /**
   * auth.invitations — pending tenant + module invitations. Token is
   * hashed by auth-service before storage (raw token only travels via
   * email per the auth-service invitation pattern).
   */
  private async createInvitationsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.invitations (
        id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        token               VARCHAR(255) NOT NULL,
        email               VARCHAR(255) NOT NULL,
        "firstName"         VARCHAR(100),
        "lastName"          VARCHAR(100),
        role                VARCHAR(50) NOT NULL DEFAULT 'MODULE_USER',
        "tenantId"          UUID,
        "moduleIds"         JSONB,
        "primaryModuleId"   UUID,
        status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        "expiresAt"         TIMESTAMP WITH TIME ZONE NOT NULL,
        "acceptedAt"        TIMESTAMP WITH TIME ZONE,
        "userId"            UUID,
        message             TEXT,
        "invitedBy"         UUID,
        "sendCount"         INTEGER NOT NULL DEFAULT 0,
        "lastSentAt"        TIMESTAMP WITH TIME ZONE,
        "acceptedFromIp"    VARCHAR(45),
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_invitations_token" UNIQUE (token)
      );
      CREATE INDEX IF NOT EXISTS "IDX_invitations_token" ON auth.invitations (token);
      CREATE INDEX IF NOT EXISTS "IDX_invitations_email" ON auth.invitations (email);
      CREATE INDEX IF NOT EXISTS "IDX_invitations_tenantId" ON auth.invitations ("tenantId");
    `);
  }

  /**
   * auth.tenant_modules — per-tenant module activation. FK to
   * auth.tenants enforced at CREATE so cascade-delete reaches here.
   */
  private async createTenantModulesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.tenant_modules (
        id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId"          UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
        "moduleId"          UUID NOT NULL,
        "isEnabled"         BOOLEAN NOT NULL DEFAULT true,
        configuration       JSONB,
        "maxModuleUsers"    INTEGER,
        "activatedAt"       TIMESTAMP WITH TIME ZONE,
        "expiresAt"         TIMESTAMP WITH TIME ZONE,
        notes               TEXT,
        "assignedBy"        VARCHAR(255),
        "managerId"         UUID,
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_tenant_modules_tenant_module" UNIQUE ("tenantId", "moduleId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenant_modules_tenantId" ON auth.tenant_modules ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_modules_moduleId" ON auth.tenant_modules ("moduleId");
    `);
  }

  /**
   * auth.tenant_roles — per-tenant RBAC roles. snake_case columns
   * (created_at / updated_at / is_default / is_editable / display_order)
   * preserved verbatim from the legacy init-script shape; consumers in
   * admin-api-service expect the snake_case form.
   */
  private async createTenantRolesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.tenant_roles (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"          UUID NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
        code                VARCHAR(50) NOT NULL,
        name                VARCHAR(100) NOT NULL,
        description         TEXT,
        permissions         JSONB NOT NULL DEFAULT '[]',
        is_default          BOOLEAN NOT NULL DEFAULT false,
        is_editable         BOOLEAN NOT NULL DEFAULT true,
        display_order       INTEGER NOT NULL DEFAULT 0,
        created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_tenant_roles_tenant_code" UNIQUE ("tenantId", code)
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenant_roles_tenantId" ON auth.tenant_roles ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_roles_code" ON auth.tenant_roles (code);
    `);
  }

  /**
   * Create Postgres enum types used by the support / messaging /
   * announcement / audit tables. Names follow TypeORM's
   * `{table}_{column}_enum` auto-generation convention (lowercase, no
   * camelCase) so SchemaDriftValidator's `resolveEnumTypeName` finds
   * exactly these types when it introspects pg_enum.
   *
   * `DO $$ ... EXCEPTION WHEN duplicate_object` makes each block
   * idempotent without depending on `CREATE TYPE IF NOT EXISTS` (which
   * Postgres does not support).
   */
  private async createEnumTypes(queryRunner: QueryRunner): Promise<void> {
    const enums: ReadonlyArray<{ name: string; values: readonly string[] }> = [
      // announcement.entity.ts: AnnouncementType / Status / Scope
      { name: 'announcements_type_enum', values: ['info', 'warning', 'critical', 'maintenance'] },
      { name: 'announcements_status_enum', values: ['draft', 'scheduled', 'published', 'expired', 'cancelled'] },
      { name: 'announcements_scope_enum', values: ['platform', 'tenant'] },
      // message-thread.entity.ts: ThreadStatus
      { name: 'message_threads_status_enum', values: ['open', 'closed', 'archived'] },
      // message.entity.ts: SenderType (column dbName: senderType -> sendertype) / MessageStatus
      { name: 'messages_sendertype_enum', values: ['super_admin', 'tenant_admin', 'system'] },
      { name: 'messages_status_enum', values: ['sent', 'delivered', 'read'] },
      // support-ticket.entity.ts: TicketCategory / Priority / Status
      { name: 'support_tickets_category_enum', values: ['technical', 'billing', 'feature_request', 'bug', 'general'] },
      { name: 'support_tickets_priority_enum', values: ['critical', 'high', 'medium', 'low'] },
      { name: 'support_tickets_status_enum', values: ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] },
      // ticket-comment.entity.ts: CommentAuthorType (dbName: authorType -> authortype)
      { name: 'ticket_comments_authortype_enum', values: ['super_admin', 'tenant_admin', 'system'] },
      // audit-log.entity.ts: AuditLogSeverity
      { name: 'audit_logs_severity_enum', values: ['info', 'warning', 'error', 'critical'] },
    ];

    for (const enumType of enums) {
      const literals = enumType.values.map((v) => `'${v}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE auth."${enumType.name}" AS ENUM (${literals});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }
  }

  /**
   * Add the five columns the user.entity.ts declares but which the
   * legacy init-script `auth.users` table does not. Idempotent via
   * `ADD COLUMN IF NOT EXISTS`. Defaults match the entity decorators so
   * existing rows on a partially-bootstrapped DB acquire the correct
   * values without a separate backfill step.
   */
  private async alterAuthUsersAddMissingColumns(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // accessType — entity defines varchar(20), nullable, default 'BOTH'.
    await queryRunner.query(`
      ALTER TABLE auth.users
        ADD COLUMN IF NOT EXISTS "accessType" varchar(20) DEFAULT 'BOTH'
    `);

    // mfaRecoveryCodes — entity defines text, nullable.
    await queryRunner.query(`
      ALTER TABLE auth.users
        ADD COLUMN IF NOT EXISTS "mfaRecoveryCodes" text
    `);

    // mfaFailedAttempts — entity defines int NOT NULL DEFAULT 0.
    // Post-add we do NOT need a backfill: the DEFAULT clause supplies 0
    // for existing rows automatically (Postgres ≥ 11 fast-path metadata
    // default; no table rewrite).
    await queryRunner.query(`
      ALTER TABLE auth.users
        ADD COLUMN IF NOT EXISTS "mfaFailedAttempts" integer NOT NULL DEFAULT 0
    `);

    // mfaLockedUntil — entity defines timestamptz, nullable. This is the
    // column that triggered the 1781100000000 conversion failure on a
    // fresh DB (the conversion saw the column missing and now-correctly
    // skips it; this migration recreates it with the right type from
    // birth).
    await queryRunner.query(`
      ALTER TABLE auth.users
        ADD COLUMN IF NOT EXISTS "mfaLockedUntil" timestamptz
    `);

    // notificationPreferences — entity defines jsonb, nullable, select:false.
    // `select: false` is a TypeORM-only concept and has no DDL effect.
    await queryRunner.query(`
      ALTER TABLE auth.users
        ADD COLUMN IF NOT EXISTS "notificationPreferences" jsonb
    `);
  }

  /** auth.modules — system-module/entities/module.entity.ts */
  private async createModulesTable(queryRunner: QueryRunner): Promise<void> {
    // Bundled with its index in a single call so migration-sql-lint R3
    // (create-index-not-concurrent) recognizes the just-created-table
    // exemption: the linter scans each queryRunner.query call as one
    // SQL chunk and looks for a sibling CREATE TABLE in the same chunk.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.modules (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "code" varchar(50) NOT NULL,
        "name" varchar(100) NOT NULL,
        "description" text,
        "icon" varchar(50),
        "color" varchar(20),
        "isActive" boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "defaultRoute" varchar(100) NOT NULL,
        "features" text,
        "price" decimal(10, 2) DEFAULT 0,
        "is_core" boolean DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_modules_code"
        ON auth.modules ("code");
    `);
  }

  /** auth.mobile_user_settings — tenant/entities/mobile-user-settings.entity.ts */
  private async createMobileUserSettingsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // user_id has @Column({ unique: true }) — one mobile-settings row per user.
    // CREATE TABLE + UNIQUE INDEX bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.mobile_user_settings (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "allowed_features" jsonb NOT NULL DEFAULT '{
          "mortality": true, "cull": true, "harvest": true, "feeding": true,
          "waterQuality": true, "tankView": true, "transfer": true,
          "schedule": true, "attendance": true, "leave": true, "tasks": true,
          "storage": true
        }'::jsonb,
        "is_mobile_enabled" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT NOW(),
        "updated_at" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mobile_user_settings_user_id"
        ON auth.mobile_user_settings ("user_id");
    `);
  }

  /** auth.user_module_assignments — authentication/entities/user-module-assignment.entity.ts */
  private async createUserModuleAssignmentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling CREATE INDEX statements live in one chunk so
    // migration-sql-lint R3 sees the just-created-table exemption. FK
    // ADD CONSTRAINT blocks (DO $$ ... EXCEPTION ...) are kept as separate
    // calls — that pattern is independent of R3 and remains untouched.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.user_module_assignments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "moduleId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "isPrimaryManager" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
        "permissions" jsonb,
        "assignedBy" uuid NOT NULL,
        "expiresAt" timestamptz,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_user_module" UNIQUE ("userId", "moduleId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_user_module_assignments_user"
        ON auth.user_module_assignments ("userId");
      CREATE INDEX IF NOT EXISTS "IDX_user_module_assignments_module"
        ON auth.user_module_assignments ("moduleId");
      CREATE INDEX IF NOT EXISTS "IDX_user_module_assignments_tenant"
        ON auth.user_module_assignments ("tenantId");
    `);

    // FK to users (CASCADE on entity).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.user_module_assignments
          ADD CONSTRAINT "FK_user_module_assignments_user"
          FOREIGN KEY ("userId") REFERENCES auth.users("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // FK to modules (CASCADE on entity).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.user_module_assignments
          ADD CONSTRAINT "FK_user_module_assignments_module"
          FOREIGN KEY ("moduleId") REFERENCES auth.modules("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** auth.refresh_tokens — authentication/entities/refresh-token.entity.ts */
  private async createRefreshTokensTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "token" varchar(255) NOT NULL,
        "userId" uuid NOT NULL,
        "tenantId" uuid,
        "expiresAt" timestamptz NOT NULL,
        "isRevoked" boolean NOT NULL DEFAULT false,
        "revokedAt" timestamptz,
        "revokedReason" varchar(255),
        "userAgent" varchar(500),
        "ipAddress" varchar(50),
        "deviceId" varchar(100),
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_refresh_tokens_token"
        ON auth.refresh_tokens ("token");
      CREATE INDEX IF NOT EXISTS "IDX_refresh_tokens_user_revoked"
        ON auth.refresh_tokens ("userId", "isRevoked");
      CREATE INDEX IF NOT EXISTS "IDX_refresh_tokens_expires"
        ON auth.refresh_tokens ("expiresAt");
      CREATE INDEX IF NOT EXISTS "IDX_refresh_tokens_tenant"
        ON auth.refresh_tokens ("tenantId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.refresh_tokens
          ADD CONSTRAINT "FK_refresh_tokens_user"
          FOREIGN KEY ("userId") REFERENCES auth.users("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** auth.webauthn_credentials — authentication/entities/webauthn-credential.entity.ts */
  private async createWebauthnCredentialsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // `transports` is declared as `simple-array` in the entity — TypeORM
    // stores simple-array as comma-separated `text` (not a Postgres array).
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.webauthn_credentials (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "credentialId" varchar(512) NOT NULL,
        "publicKey" text NOT NULL,
        "counter" integer NOT NULL DEFAULT 0,
        "transports" text,
        "deviceName" varchar(100) NOT NULL DEFAULT 'Biometric Device',
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "lastUsedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_webauthn_credential_id"
        ON auth.webauthn_credentials ("credentialId");
      CREATE INDEX IF NOT EXISTS "IDX_webauthn_user"
        ON auth.webauthn_credentials ("userId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.webauthn_credentials
          ADD CONSTRAINT "FK_webauthn_credentials_user"
          FOREIGN KEY ("userId") REFERENCES auth.users("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** auth.announcements — announcement/entities/announcement.entity.ts */
  private async createAnnouncementsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.announcements (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "title" varchar(255) NOT NULL,
        "content" text NOT NULL,
        "type" auth.announcements_type_enum NOT NULL DEFAULT 'info',
        "status" auth.announcements_status_enum NOT NULL DEFAULT 'draft',
        "scope" auth.announcements_scope_enum NOT NULL,
        "tenantId" uuid,
        "isGlobal" boolean NOT NULL DEFAULT true,
        "targetCriteria" jsonb,
        "publishAt" timestamptz,
        "expiresAt" timestamptz,
        "requiresAcknowledgment" boolean NOT NULL DEFAULT false,
        "viewCount" integer NOT NULL DEFAULT 0,
        "acknowledgmentCount" integer NOT NULL DEFAULT 0,
        "createdBy" uuid NOT NULL,
        "createdByName" varchar(255) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_announcements_scope_status"
        ON auth.announcements ("scope", "status");
      CREATE INDEX IF NOT EXISTS "IDX_announcements_tenant_status"
        ON auth.announcements ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_announcements_publishAt"
        ON auth.announcements ("publishAt");
      CREATE INDEX IF NOT EXISTS "IDX_announcements_tenantId"
        ON auth.announcements ("tenantId");
    `);

    // FK to tenants — entity uses CASCADE, nullable: true.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.announcements
          ADD CONSTRAINT "FK_announcements_tenant"
          FOREIGN KEY ("tenantId") REFERENCES auth.tenants("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** auth.announcement_acknowledgments — announcement/entities/announcement-acknowledgment.entity.ts */
  private async createAnnouncementAcknowledgmentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.announcement_acknowledgments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "announcementId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "userName" varchar(255) NOT NULL,
        "tenantId" uuid,
        "tenantName" varchar(255),
        "viewedAt" timestamptz NOT NULL DEFAULT NOW(),
        "acknowledgedAt" timestamptz,
        CONSTRAINT "UQ_announcement_user" UNIQUE ("announcementId", "userId")
      );
      CREATE INDEX IF NOT EXISTS "IDX_announcement_acks_announcement_user"
        ON auth.announcement_acknowledgments ("announcementId", "userId");
      CREATE INDEX IF NOT EXISTS "IDX_announcement_acks_user_viewedAt"
        ON auth.announcement_acknowledgments ("userId", "viewedAt");
      CREATE INDEX IF NOT EXISTS "IDX_announcement_acks_announcementId"
        ON auth.announcement_acknowledgments ("announcementId");
      CREATE INDEX IF NOT EXISTS "IDX_announcement_acks_userId"
        ON auth.announcement_acknowledgments ("userId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.announcement_acknowledgments
          ADD CONSTRAINT "FK_announcement_acknowledgments_announcement"
          FOREIGN KEY ("announcementId") REFERENCES auth.announcements("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** auth.message_threads — messaging/entities/message-thread.entity.ts */
  private async createMessageThreadsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.message_threads (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "subject" varchar(255) NOT NULL,
        "lastMessage" text,
        "lastMessageAt" timestamptz,
        "lastMessageBy" uuid,
        "status" auth.message_threads_status_enum NOT NULL DEFAULT 'open',
        "messageCount" integer NOT NULL DEFAULT 0,
        "unreadCountAdmin" integer NOT NULL DEFAULT 0,
        "unreadCountTenant" integer NOT NULL DEFAULT 0,
        "createdBy" uuid NOT NULL,
        "createdByAdmin" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_message_threads_tenant_status"
        ON auth.message_threads ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_message_threads_tenant_updatedAt"
        ON auth.message_threads ("tenantId", "updatedAt");
      CREATE INDEX IF NOT EXISTS "IDX_message_threads_tenantId"
        ON auth.message_threads ("tenantId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.message_threads
          ADD CONSTRAINT "FK_message_threads_tenant"
          FOREIGN KEY ("tenantId") REFERENCES auth.tenants("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** auth.messages — messaging/entities/message.entity.ts */
  private async createMessagesTable(queryRunner: QueryRunner): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.messages (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "threadId" uuid NOT NULL,
        "senderId" uuid NOT NULL,
        "senderType" auth.messages_sendertype_enum NOT NULL,
        "senderName" varchar(255) NOT NULL,
        "content" text NOT NULL,
        "status" auth.messages_status_enum NOT NULL DEFAULT 'sent',
        "isInternal" boolean NOT NULL DEFAULT false,
        "attachments" jsonb,
        "readAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_messages_thread_createdAt"
        ON auth.messages ("threadId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_messages_threadId"
        ON auth.messages ("threadId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.messages
          ADD CONSTRAINT "FK_messages_thread"
          FOREIGN KEY ("threadId") REFERENCES auth.message_threads("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** auth.support_tickets — support/entities/support-ticket.entity.ts */
  private async createSupportTicketsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // `tags` is declared as `simple-array` in the entity — stored as
    // comma-separated `text` by TypeORM (not a Postgres array).
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.support_tickets (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ticketNumber" varchar(255) NOT NULL,
        "tenantId" uuid NOT NULL,
        "subject" varchar(255) NOT NULL,
        "description" text NOT NULL,
        "category" auth.support_tickets_category_enum NOT NULL,
        "priority" auth.support_tickets_priority_enum NOT NULL DEFAULT 'medium',
        "status" auth.support_tickets_status_enum NOT NULL DEFAULT 'open',
        "assignedTo" uuid,
        "assignedToName" varchar(255) DEFAULT NULL,
        "reportedBy" uuid NOT NULL,
        "reportedByName" varchar(255) NOT NULL,
        "commentCount" integer NOT NULL DEFAULT 0,
        "slaResponseDeadline" timestamptz,
        "slaResolutionDeadline" timestamptz,
        "firstResponseAt" timestamptz,
        "resolvedAt" timestamptz,
        "satisfactionRating" integer,
        "satisfactionComment" text,
        "tags" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_support_tickets_ticketNumber" UNIQUE ("ticketNumber")
      );
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_tenant_status"
        ON auth.support_tickets ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_assignedTo_status"
        ON auth.support_tickets ("assignedTo", "status");
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_priority_status"
        ON auth.support_tickets ("priority", "status");
      CREATE INDEX IF NOT EXISTS "IDX_support_tickets_tenantId"
        ON auth.support_tickets ("tenantId");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.support_tickets
          ADD CONSTRAINT "FK_support_tickets_tenant"
          FOREIGN KEY ("tenantId") REFERENCES auth.tenants("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /** auth.ticket_comments — support/entities/ticket-comment.entity.ts */
  private async createTicketCommentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling index bundled per R3 lint chunk rule.
    // Note: a single-column "IDX_ticket_comments_ticketId" would be redundant —
    // the composite (ticketId, createdAt) below already serves WHERE ticketId
    // queries via leftmost-prefix matching, with the bonus of pre-sorted
    // chronological ordering for `ORDER BY createdAt`.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.ticket_comments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ticketId" uuid NOT NULL,
        "authorId" uuid NOT NULL,
        "authorName" varchar(255) NOT NULL,
        "authorType" auth.ticket_comments_authortype_enum NOT NULL,
        "content" text NOT NULL,
        "isInternal" boolean NOT NULL DEFAULT false,
        "attachments" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_ticket_comments_ticket_createdAt"
        ON auth.ticket_comments ("ticketId", "createdAt");
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.ticket_comments
          ADD CONSTRAINT "FK_ticket_comments_ticket"
          FOREIGN KEY ("ticketId") REFERENCES auth.support_tickets("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * auth.audit_logs — audit/audit-log.entity.ts
   *
   * Standalone (no FKs) by design: audit rows must survive deletion of
   * the entities they describe (a deleted user's audit trail is exactly
   * the case audit logs exist for). The `legalHold` column is created
   * here with `NOT NULL DEFAULT false` so the immutability triggers
   * installed by `1787100000000-AddAuthAuditLogsImmutability` find the
   * column already in place; that later migration's `ADD COLUMN IF NOT
   * EXISTS` step then becomes a no-op.
   *
   * `ipAddress` is created as `inet` (matching the entity declaration)
   * so the later `1787400000000-ConvertAuthAuditIpToInet` migration's
   * conversion is a no-op on fresh DBs. That migration explicitly
   * tolerates the column already being inet via its pre-check.
   */
  private async createAuditLogsTable(queryRunner: QueryRunner): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.audit_logs (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "performedBy" varchar(100) NOT NULL,
        "performedByEmail" varchar(100),
        "action" varchar(100) NOT NULL,
        "entityType" varchar(50) NOT NULL,
        "entityId" uuid,
        "tenantId" uuid,
        "details" jsonb,
        "previousValue" jsonb,
        "newValue" jsonb,
        "severity" auth.audit_logs_severity_enum NOT NULL DEFAULT 'info',
        "requestId" varchar(100),
        "sessionId" varchar(100),
        "ipAddress" inet,
        "userAgent" varchar(500),
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "legalHold" boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS "IDX_audit_tenant_created"
        ON auth.audit_logs ("tenantId", "createdAt");
      CREATE INDEX IF NOT EXISTS "IDX_audit_performer_tenant"
        ON auth.audit_logs ("performedBy", "tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_audit_entity"
        ON auth.audit_logs ("entityType", "entityId", "tenantId");
    `);
  }
}
