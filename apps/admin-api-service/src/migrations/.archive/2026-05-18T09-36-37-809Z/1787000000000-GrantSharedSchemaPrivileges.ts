import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GrantSharedSchemaPrivileges
 * ============================================================================
 *
 * Catch-up migration that grants USAGE + table-level privileges on the
 * `shared` schema to every per-service DB role on existing droplets.
 *
 * # Why this migration exists
 *
 * `infrastructure/docker/init-scripts/00-init-schemas.sh` runs ONCE at
 * postgres container first-init. The shared-schema GRANT block was added
 * to its codegen (`scripts/schema-registry/generate-init-schemas.ts`)
 * in this PR, so NEW droplets will be born with the correct grants.
 * EXISTING droplets (the live one, every staging instance, every dev box
 * that initialized before this PR) have the `shared` schema and its
 * tables but ZERO grants to per-service roles.
 *
 * # Production symptom — boot-signal failure on 6 of 7 services
 *
 * SchemaDriftValidator runs as the per-service role. PostgreSQL's
 * `information_schema.columns` view filters by privilege: a role with no
 * grant on `shared.audit_logs` sees ZERO columns and reports every
 * @Entity-declared field as "DB has no such column". Live droplet
 * 2026-04-20 13:53 UTC verified:
 *
 *   alert-engine        14 violations (all on shared.audit_logs)
 *   billing-service     14 violations (all on shared.audit_logs)
 *   notification-service 14 violations (all on shared.audit_logs)
 *   config-service      14 violations (all on shared.audit_logs)
 *   auth-service        30 violations (shared.gdpr_data_requests +
 *                                      shared.user_consents)
 *
 * Every one is a permission-shadow false positive — the columns DO exist
 * in `shared.*` (verified as superuser), but the per-service role lacks
 * SELECT and so cannot enumerate them via information_schema. The boot
 * signal `schema_drift_clean` requires zero violations to be emitted, so
 * the false positives keep all 5 signals RED and the deploy gate fails.
 *
 * # Architectural fix vs symptom-only fix
 *
 * Two paths:
 *
 *   1. (CHOSEN) Grant per-service roles the access they actually need on
 *      the cross-service shared schema. The shared schema is by design
 *      a multi-writer surface (every service writes to audit_logs;
 *      auth manages gdpr_data_requests + user_consents; admin-api
 *      manages user_permissions). The grants reflect that real usage.
 *      `00-init-schemas.sh` codegen already emits the grants for new
 *      droplets; this migration backfills existing droplets.
 *
 *   2. Refactor every service to stop registering shared entities. Would
 *      mean writing audit logs via raw SQL through a privileged
 *      connection — a much larger refactor that doesn't reflect the
 *      actual architecture (services SHOULD have repository access to
 *      the shared schema, that's its purpose).
 *
 * Option 1 is the architecturally correct answer for the `shared` schema
 * specifically because the shared schema's semantics ARE cross-service.
 * Option 2 is the right answer for admin-api's cross-schema entities on
 * billing.* / auth.* (tracked separately under INFRA-CRITICAL-032 with
 * owner @okan-wqm + deadline 2026-05-15) because those reads cross
 * service-domain boundaries that ADR-011 forbids.
 *
 * # Idempotent
 *
 * GRANT is idempotent in PostgreSQL — granting the same privilege twice
 * is a no-op. The migration also handles the case where a future shared
 * table is added but a per-service role hasn't been migrated for it yet
 * (catches `pg_class` "relation does not exist" and continues so a
 * partial drift doesn't fail the whole migration).
 *
 * # Why this migration lives in admin-api-service
 *
 * admin-api-service already owns the shared-schema lifecycle migrations:
 *   - 1782200000000-MoveSharedTablesFromAdminToShared.ts (created
 *     `shared` schema + moved 3 tables in)
 *   - 1786900000000-MoveUserPermissionsToShared.ts (moved
 *     user_permissions in)
 *
 * Keeping shared-schema concerns in admin-api makes operator runbook
 * navigation predictable — "who owns shared?" → admin-api-service.
 *
 * # Down-rollback
 *
 * Provided for symmetry. Practical rollback would re-RED the 5 boot
 * signals immediately on next deploy; operators should fix-forward.
 */
export class GrantSharedSchemaPrivileges1787000000000
  implements MigrationInterface
{
  private readonly logger = new Logger(
    'GrantSharedSchemaPrivileges1787000000000',
  );

  /**
   * Cross-service shared tables. Mirrors:
   *   - SHARED_SCHEMA_TABLES in scripts/schema-registry/generate-init-schemas.ts
   *   - SHARED_SCHEMA_TABLES in e2e/tests/integration/schema-invariants.spec.ts:51-56
   *
   * Adding a 5th shared table requires updating ALL THREE constants
   * in the same PR; the invariant test catches drift between them.
   */
  private static readonly SHARED_TABLES = [
    'audit_logs',
    'gdpr_data_requests',
    'user_consents',
    'user_permissions',
  ] as const;

  /**
   * Per-service DB roles that need read/write access to shared.*.
   * Mirrors SCHEMA_REGISTRY entries with `role` field populated in
   * apps/db-migrate/src/schema-registry.ts.
   */
  private static readonly SERVICE_ROLES = [
    'auth_service',
    'farm_service',
    'sensor_service',
    'hr_service',
    'messaging_service',
    'hydroponics_service',
    'alert_service',
    'billing_service',
    'notification_service',
    'ai_service',
    'admin_service',
    'observability_service',
    'event_store_service',
  ] as const;

  /** Safe SQL identifier regex — defense in depth even though both lists are hardcoded. */
  private static readonly SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 0. Defensive: shared schema must exist (created by
    //    1782200000000-MoveSharedTablesFromAdminToShared). If absent,
    //    the migration is a hard error — the topology is broken.
    const schemaExists: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'shared') AS exists`,
    );
    if (!schemaExists[0]?.exists) {
      throw new Error(
        'GrantSharedSchemaPrivileges: `shared` schema does not exist. ' +
          'Migration 1782200000000-MoveSharedTablesFromAdminToShared must run first.',
      );
    }

    let grantedSchemas = 0;
    let grantedTables = 0;
    let skippedRoles = 0;
    let skippedMissingTables = 0;

    for (const role of GrantSharedSchemaPrivileges1787000000000.SERVICE_ROLES) {
      if (!GrantSharedSchemaPrivileges1787000000000.SAFE_IDENT.test(role)) {
        throw new Error(`Unsafe role identifier: "${role}"`);
      }

      // Skip roles that don't exist on this droplet (e.g. observability
      // role missing on a partially-init'd dev box). Logged as warn —
      // operator should verify init-schemas.sh ran with all roles.
      const roleExists: Array<{ exists: boolean }> = await queryRunner.query(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
        [role],
      );
      if (!roleExists[0]?.exists) {
        skippedRoles++;
        this.logger.warn(
          `Role "${role}" does not exist on this droplet — skipping shared-schema grants. ` +
            `Re-run init-schemas.sh + this migration after the role is created.`,
        );
        continue;
      }

      // 1. USAGE on the shared schema itself — required for any
      //    name-resolution into shared.*.
      await queryRunner.query(`GRANT USAGE ON SCHEMA shared TO "${role}"`);
      grantedSchemas++;

      // 2. Per-table grants. Each table is checked for existence so a
      //    partial drift (table not yet moved into shared on this
      //    droplet) doesn't abort the whole migration. The operator
      //    sees a debug log per missing table.
      for (const tbl of GrantSharedSchemaPrivileges1787000000000.SHARED_TABLES) {
        if (!GrantSharedSchemaPrivileges1787000000000.SAFE_IDENT.test(tbl)) {
          throw new Error(`Unsafe table identifier: "${tbl}"`);
        }
        const tableExists: Array<{ exists: boolean }> = await queryRunner.query(
          `SELECT EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'shared' AND c.relname = $1 AND c.relkind = 'r'
           ) AS exists`,
          [tbl],
        );
        if (!tableExists[0]?.exists) {
          skippedMissingTables++;
          this.logger.debug(
            `[${role}] shared.${tbl} not present yet — grant skipped. ` +
              `Will be picked up by ALTER DEFAULT PRIVILEGES when the table is created.`,
          );
          continue;
        }
        await queryRunner.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON shared."${tbl}" TO "${role}"`,
        );
        grantedTables++;
      }

      // 3. Default privileges so future shared tables (e.g. when a 5th
      //    cross-service table is added) automatically grant to this
      //    role without re-running this migration.
      await queryRunner.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"`,
      );
      await queryRunner.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO "${role}"`,
      );
    }

    this.logger.log(
      `Shared-schema grants applied: schemas=${grantedSchemas}, tables=${grantedTables}, ` +
        `skipped-roles=${skippedRoles}, skipped-missing-tables=${skippedMissingTables}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback REVOKEs the same grants. Operators should fix-forward —
    // re-revoking shared-schema access immediately re-RED's the 5 boot
    // signals on the next deploy.
    for (const role of GrantSharedSchemaPrivileges1787000000000.SERVICE_ROLES) {
      const roleExists: Array<{ exists: boolean }> = await queryRunner.query(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`,
        [role],
      );
      if (!roleExists[0]?.exists) continue;

      for (const tbl of GrantSharedSchemaPrivileges1787000000000.SHARED_TABLES) {
        const tableExists: Array<{ exists: boolean }> = await queryRunner.query(
          `SELECT EXISTS (
             SELECT 1 FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'shared' AND c.relname = $1 AND c.relkind = 'r'
           ) AS exists`,
          [tbl],
        );
        if (!tableExists[0]?.exists) continue;
        await queryRunner.query(
          `REVOKE SELECT, INSERT, UPDATE, DELETE ON shared."${tbl}" FROM "${role}"`,
        );
      }
      await queryRunner.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA shared REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM "${role}"`,
      );
      await queryRunner.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA shared REVOKE USAGE, SELECT ON SEQUENCES FROM "${role}"`,
      );
      await queryRunner.query(`REVOKE USAGE ON SCHEMA shared FROM "${role}"`);
    }
  }
}
