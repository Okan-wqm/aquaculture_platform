import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * AlignAdminEntitySurface1789000000000
 * ============================================================================
 *
 * Closes the bootstrap-from-scratch entity-surface drift surfaced on
 * 2026-05-08 against the freshly-restored baseline migration chain. The
 * admin-api-service entity-surface assertion reads from auth, admin, and
 * billing schemas; this migration adds the four shapes the assertion
 * found missing on a fresh-volume bring-up:
 *
 *   1. auth.tenant_roles — add 5 columns the TenantRole entity declares
 *      that the 1700000000000 baseline did not (color, icon, level,
 *      is_system, created_by).
 *
 *   2. admin.tenant_role_permissions — CREATE TABLE; entity declared at
 *      apps/admin-api-service/src/users/entities/tenant-role-permissions.entity.ts
 *      but no creation migration ever existed.
 *
 *   3. admin.user_role_assignments — CREATE TABLE; entity declared at
 *      apps/admin-api-service/src/users/entities/user-role-assignment.entity.ts
 *      but no creation migration ever existed.
 *
 *   4. auth.tenant_invitations — CREATE TABLE; entity declared at
 *      apps/admin-api-service/src/tenant/entities/tenant.entity.ts
 *      (`@Entity('tenant_invitations', { schema: 'auth' })`) but no
 *      creation migration ever existed. Distinct from auth.invitations
 *      (which the auth-service baseline owns) — different shape, used
 *      by admin-api's tenant-management surface.
 *
 *   5. auth.tenant_modules — add the missing FK
 *      `moduleId → auth.modules(id) ON DELETE CASCADE`. The baseline
 *      created the table with the tenantId FK but the entity declares
 *      a second `@ManyToOne(() => Module, { onDelete: 'CASCADE' })`
 *      that the bootstrap-from-scratch test detected as a constraint
 *      drift (`pg_constraint has only 1 FK(s)` for 2 declared relations).
 *
 * # Cross-schema authorship
 *
 * admin-api-service owns the entity-surface assertion (the cross-cutting
 * read-from-auth+admin+billing surface) and runs with owner-level grants
 * on the admin schema and grants on auth.* per
 * `1787000000000-GrantSharedSchemaPrivileges`. The DDL is fully
 * schema-qualified — no `SET search_path` is required. This is the
 * Tier-1 architectural shape (impossible-to-misroute) per
 * data-expert.md "search_path / pool-contamination" guidance.
 *
 * # Why ADD COLUMN ... NULLABLE for `created_by`
 *
 * The TenantRole entity declares `@Column({ type: 'uuid', name:
 * 'created_by' })` without `nullable: true`. On a populated baseline
 * table (which auth.tenant_roles is, post-1700000000000 baseline), a
 * single-step `ADD COLUMN created_by uuid NOT NULL` would either:
 *
 *   (a) fail because legacy rows have no value for the column, OR
 *   (b) require a synthetic backfill value that misrepresents history.
 *
 * Both options are wrong. The blue-green-safe shape per migration-sql
 * R2 (`single-step-add-not-null`) is: add nullable → backfill →
 * SET NOT NULL in three migrations. This migration adds the column
 * nullable; an entity-layer guard already exists (TypeORM emits
 * `created_by` on every INSERT). The follow-up `SET NOT NULL` lands
 * after a backfill migration that resolves the legacy rows (out of
 * scope for this entity-surface alignment).
 *
 * # Idempotent
 *
 * Every DDL uses `IF NOT EXISTS` (tables, columns, indexes) and
 * `DO $$ ... EXCEPTION WHEN duplicate_object` for FK ADD CONSTRAINT.
 * Re-runs are no-ops.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignAdminEntitySurface1789000000000
  implements MigrationInterface
{
  name = 'AlignAdminEntitySurface1789000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Aligning admin-api entity surface: 5 cols on auth.tenant_roles, ' +
        '3 missing tables (admin.tenant_role_permissions, ' +
        'admin.user_role_assignments, auth.tenant_invitations), ' +
        '1 missing FK on auth.tenant_modules.',
    );

    // Defense: schemas should already exist (created by init-scripts +
    // the auth/admin baselines), but IF NOT EXISTS keeps the migration
    // safe against partial-state DBs.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS admin`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS auth`);

    await this.addTenantRolesMissingColumns(queryRunner);
    await this.createTenantRolePermissionsTable(queryRunner);
    await this.createUserRoleAssignmentsTable(queryRunner);
    await this.createTenantInvitationsTable(queryRunner);
    await this.addTenantModulesModuleFk(queryRunner);

    this.logger.log('admin-api entity surface aligned.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // WHY ordering: drop FK first (cheapest, no data loss), then the
    // 3 newly-created tables (children before parents — no inter-FK
    // among them), then the 5 column additions on auth.tenant_roles.
    this.logger.warn(
      'Reverting admin entity-surface alignment. Drops 3 tables and 5 ' +
        'columns; intended for ephemeral test environments only.',
    );

    await queryRunner.query(`
      ALTER TABLE auth.tenant_modules
        DROP CONSTRAINT IF EXISTS "FK_tenant_modules_module"
    `);

    // -- DESTRUCTIVE: drops admin.tenant_role_permissions, rollback only via pg_dump restore from pre-migration backup
    await queryRunner.query(
      `DROP TABLE IF EXISTS admin.tenant_role_permissions CASCADE`,
    );
    // -- DESTRUCTIVE: drops admin.user_role_assignments, rollback only via pg_dump restore from pre-migration backup
    await queryRunner.query(
      `DROP TABLE IF EXISTS admin.user_role_assignments CASCADE`,
    );
    // -- DESTRUCTIVE: drops auth.tenant_invitations, rollback only via pg_dump restore from pre-migration backup
    await queryRunner.query(
      `DROP TABLE IF EXISTS auth.tenant_invitations CASCADE`,
    );

    const tenantRolesColumnsToRemove = [
      'created_by',
      'is_system',
      'level',
      'icon',
      'color',
    ];
    for (const col of tenantRolesColumnsToRemove) {
      // -- DESTRUCTIVE: drops auth.tenant_roles column, rollback only via pg_dump restore
      await queryRunner.query(
        `ALTER TABLE auth.tenant_roles DROP COLUMN IF EXISTS "${col}"`,
      );
    }
  }

  /**
   * Add the 5 columns the TenantRole entity declares but which the
   * 1700000000000 baseline did not include. Each ADD COLUMN uses
   * `IF NOT EXISTS` (R9) so a partial-state replay is a no-op.
   *
   * `created_by` is nullable here despite the entity declaring it
   * non-null — see file docblock for the blue-green rationale.
   */
  private async addTenantRolesMissingColumns(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE auth.tenant_roles
        ADD COLUMN IF NOT EXISTS "color" varchar(20) NOT NULL DEFAULT '#6366F1'
    `);
    await queryRunner.query(`
      ALTER TABLE auth.tenant_roles
        ADD COLUMN IF NOT EXISTS "icon" varchar(50) NOT NULL DEFAULT 'shield'
    `);
    await queryRunner.query(`
      ALTER TABLE auth.tenant_roles
        ADD COLUMN IF NOT EXISTS "level" integer NOT NULL DEFAULT 50
    `);
    await queryRunner.query(`
      ALTER TABLE auth.tenant_roles
        ADD COLUMN IF NOT EXISTS "is_system" boolean NOT NULL DEFAULT false
    `);
    // created_by — nullable for blue-green safety; the entity emits
    // a value on every INSERT so new rows always carry it. A follow-up
    // backfill + SET NOT NULL migration tightens this once legacy rows
    // are resolved.
    await queryRunner.query(`
      ALTER TABLE auth.tenant_roles
        ADD COLUMN IF NOT EXISTS "created_by" uuid
    `);

    // Indexes the entity declares: @Index(['level']) and @Index(['isDefault']).
    // is_default is already created by the baseline as `is_default` so the
    // baseline `IDX_tenant_roles_*` indexes survive; level is new here.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tenant_roles_level"
        ON auth.tenant_roles ("level")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tenant_roles_is_system"
        ON auth.tenant_roles ("is_system")
    `);
  }

  /**
   * admin.tenant_role_permissions — TenantRolePermissions entity at
   * apps/admin-api-service/src/users/entities/tenant-role-permissions.entity.ts.
   * One-to-one relationship with auth.tenant_roles; role_id is unique.
   * No FK because the relation crosses schemas (admin → auth) and the
   * permissions row is allowed to outlive the role briefly during
   * GDPR-erasure flows (the tenant-cleanup job sweeps stale rows).
   */
  private async createTenantRolePermissionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.tenant_role_permissions (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "role_id"              uuid NOT NULL,
        "panel_permissions"    jsonb NOT NULL DEFAULT '{}'::jsonb,
        "resource_permissions" text[] NOT NULL DEFAULT '{}',
        "created_at"           timestamptz NOT NULL DEFAULT NOW(),
        "updated_at"           timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_tenant_role_permissions_role_id" UNIQUE ("role_id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenant_role_permissions_role_id"
        ON admin.tenant_role_permissions ("role_id");
    `);
  }

  /**
   * admin.user_role_assignments — UserRoleAssignment entity at
   * apps/admin-api-service/src/users/entities/user-role-assignment.entity.ts.
   *
   * @Index decorators on the entity:
   *   @Index(['userId'], { unique: true }) — one active assignment per user
   *   @Index(['roleId'])                   — bulk lookup by role
   *   @Index(['isActive'])                 — filter active assignments
   *
   * The unique-on-userId index doubles as the dedup constraint per the
   * entity contract.
   */
  private async createUserRoleAssignmentsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS admin.user_role_assignments (
        "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"              uuid NOT NULL,
        "role_id"              uuid NOT NULL,
        "permission_overrides" jsonb NOT NULL DEFAULT '{"grants":[],"revokes":[]}'::jsonb,
        "assigned_by"          uuid NOT NULL,
        "assigned_at"          timestamptz NOT NULL DEFAULT NOW(),
        "expires_at"           timestamptz,
        "is_active"            boolean NOT NULL DEFAULT true,
        "created_at"           timestamptz NOT NULL DEFAULT NOW(),
        "updated_at"           timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_role_assignments_user_id"
        ON admin.user_role_assignments ("user_id");
      CREATE INDEX IF NOT EXISTS "IDX_user_role_assignments_role_id"
        ON admin.user_role_assignments ("role_id");
      CREATE INDEX IF NOT EXISTS "IDX_user_role_assignments_is_active"
        ON admin.user_role_assignments ("is_active");
    `);
  }

  /**
   * auth.tenant_invitations — TenantInvitation entity at
   * apps/admin-api-service/src/tenant/entities/tenant.entity.ts:194.
   *
   * Distinct from auth.invitations (auth-service-owned, see
   * auth-service/src/migrations/1700000000000): tenant_invitations is
   * the admin-api-managed pre-tenant-bootstrap invitation flow (admin
   * invites a tenant founder before any auth.users row exists for them).
   *
   * @Index decorators on the entity:
   *   @Index(['email', 'tenantId'])
   *   @Index(['token'])
   *   @Index(['expiresAt'])
   *
   * `token` is `@Column({ unique: true })` so the unique index is also
   * the dedup constraint. `tenantId` is a soft FK (CASCADE on delete)
   * — invitations for a deleted tenant must vanish atomically.
   */
  private async createTenantInvitationsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.tenant_invitations (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"    uuid NOT NULL,
        "email"       varchar(255) NOT NULL,
        "token"       varchar(100) NOT NULL,
        "role"        varchar(50) NOT NULL,
        "invitedBy"   varchar(100),
        "expiresAt"   timestamptz NOT NULL,
        "accepted"    boolean NOT NULL DEFAULT false,
        "acceptedAt"  timestamptz,
        "createdAt"   timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_tenant_invitations_token" UNIQUE ("token")
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenant_invitations_email_tenantId"
        ON auth.tenant_invitations ("email", "tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_invitations_token"
        ON auth.tenant_invitations ("token");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_invitations_expiresAt"
        ON auth.tenant_invitations ("expiresAt");
    `);

    // FK to auth.tenants — invitations must vanish when the target
    // tenant is hard-deleted. Wrapped in DO/EXCEPTION per R11.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.tenant_invitations
          ADD CONSTRAINT "FK_tenant_invitations_tenant"
          FOREIGN KEY ("tenantId") REFERENCES auth.tenants("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  /**
   * auth.tenant_modules — add the FK on `moduleId` that the entity's
   * second `@ManyToOne(() => Module, { onDelete: 'CASCADE' })` declares
   * but the 1700000000000 baseline omitted. The baseline created the
   * tenantId FK inline; the moduleId FK was missed.
   *
   * Bootstrap-from-scratch test surfaced this as:
   *   `auth.tenant_modules: fk drift: declares 2 @ManyToOne relation(s)
   *    but pg_constraint has only 1 FK(s)`
   *
   * Constraint name follows the same `FK_<table>_<target>` convention
   * the auth baseline uses for `FK_user_module_assignments_module`,
   * `FK_announcements_tenant`, etc.
   */
  private async addTenantModulesModuleFk(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE auth.tenant_modules
          ADD CONSTRAINT "FK_tenant_modules_module"
          FOREIGN KEY ("moduleId") REFERENCES auth.modules("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }
}
