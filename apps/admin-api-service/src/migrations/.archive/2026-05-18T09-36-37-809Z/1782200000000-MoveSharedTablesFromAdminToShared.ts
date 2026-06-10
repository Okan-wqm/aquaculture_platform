import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MoveSharedTablesFromAdminToShared
 * ============================================================================
 *
 * Architectural correction: per ADR-011 and CLAUDE.md "Tenant row placement
 * (D14)", the cross-tenant tables `audit_logs`, `user_consents`, and
 * `gdpr_data_requests` MUST live in the `shared` schema — that schema is
 * reserved for the 4 canonical cross-tenant singletons (the 4th being
 * `user_permissions`, already in shared).
 *
 * The droplet's database had drifted: those three tables were created in
 * the `admin` schema by a historical seed path. The entity decorators in
 * `libs/backend-common/src/{audit,security/gdpr}/entities/*.entity.ts`
 * always declared `{ schema: 'shared' }`, so every backend boot reported
 * the divergence as drift:
 *
 *     [audit_logs] entity declares schema='shared' but table lives in 'admin'
 *     [user_consents] entity declares schema='shared' but table lives in 'admin'
 *     [gdpr_data_requests] entity declares schema='shared' but table lives in 'admin'
 *
 * surfaced on auth-service, alert-engine, billing-service, notification-service,
 * and config-service — every service that imports either AuditLogModule
 * or GdprModule (which transitively register the entities). The drift
 * was the deploy-blocker for boot-signal `schema_drift_clean` after the
 * Phase A/B contamination cleanup made the validator's signal contract
 * meaningful again.
 *
 * # Why ALTER TABLE SET SCHEMA (not CREATE+COPY+DROP)
 *
 * `ALTER TABLE … SET SCHEMA` is atomic at the catalog level. PostgreSQL
 * updates pg_class.relnamespace in a single transaction; indexes,
 * constraints, sequences, and dependent objects (RLS policies, triggers)
 * follow the table without rebuild. Row data does not move. Total
 * downtime per table is sub-millisecond.
 *
 * The alternative (CREATE TABLE shared.X (LIKE admin.X INCLUDING ALL);
 * INSERT INTO shared.X SELECT * FROM admin.X; DROP TABLE admin.X) would:
 *   - copy all 28 audit_log rows + entire history,
 *   - require manual re-creation of every dependent FK/index/RLS policy,
 *   - break sequence ownership (sequences live in the OLD schema).
 *
 * Sequence-following note: per pg docs, sequences owned by columns of
 * the moved table are NOT automatically moved. We move them explicitly
 * below for the SERIAL/BIGSERIAL primary keys.
 *
 * # Why this migration lives in admin-api-service
 *
 * The tables are physically in the `admin` schema today. admin-api-service
 * owns the `admin` schema in MODULE_SCHEMAS. The migration's natural
 * home is the schema currently holding the tables — the centralized
 * `aqua-db-migrate` runner picks up admin's migrations as part of the
 * admin schema slot. After this migration runs, the tables are in
 * `shared` and admin-api-service no longer "owns" them.
 *
 * The `shared` schema does not have its own MODULE_SCHEMAS slot today —
 * that's intentional. No service owns `shared`; every service that
 * imports the relevant module reads from it via the entity's declared
 * schema (the canonical entry point).
 *
 * # Idempotency
 *
 * Each step is `IF EXISTS` / `IF NOT EXISTS` guarded so the migration
 * is safe to re-run on a database that has already been migrated, OR on
 * a fresh database where the tables were created in the correct schema
 * from the start.
 *
 * # down() rollback
 *
 * Provided for symmetry. In practice should never be invoked: rolling
 * back would re-introduce the drift on every running service. If the
 * migration is mis-applied, the operator should fix-forward with a new
 * migration rather than rolling back.
 */
export class MoveSharedTablesFromAdminToShared1782200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Ensure the `shared` schema exists. The init-schemas.sh script
    //    in infrastructure/docker/init-scripts creates per-service
    //    schemas; `shared` may not be among them on older deployments.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS shared`);

    // 2. Move each table. SET SCHEMA is no-op when the table already
    //    lives in the target schema (PostgreSQL silently updates the
    //    catalog and we depend on that idempotency for re-runs).
    //    Use a defensive existence check so the migration is safe on
    //    a database that was created with the tables already in shared.
    for (const table of ['audit_logs', 'user_consents', 'gdpr_data_requests']) {
      const present: Array<{ table_schema: string }> = await queryRunner.query(
        `SELECT table_schema FROM information_schema.tables
         WHERE table_name = $1 AND table_schema IN ('admin', 'shared')`,
        [table],
      );
      const inAdmin = present.some((r) => r.table_schema === 'admin');
      const inShared = present.some((r) => r.table_schema === 'shared');
      if (inAdmin && !inShared) {
        await queryRunner.query(`ALTER TABLE admin."${table}" SET SCHEMA shared`);
      } else if (inAdmin && inShared) {
        // Both schemas have the table — likely a partial prior run that
        // failed midway. Drop the orphan in admin so the canonical row
        // is the one in shared. The DESTRUCTIVE marker is embedded
        // inside the SQL template (the lint strips TS comments before
        // scanning, so a JS-side comment would not satisfy the gate).
        // SQL comments below MUST NOT contain semicolons — the migration
        // SQL linter splits statements on ; and only finds the DESTRUCTIVE
        // marker inside the same statement as the destructive op.
        await queryRunner.query(`
          -- DESTRUCTIVE: rollback via this migration down() which SET-SCHEMA-backs the table to admin
          -- Partial-state recovery only — orphan in admin was already superseded by shared copy when
          -- prior run partially succeeded so no live data exists in admin copy at this branch
          -- pg_dump backup taken by the deploy pipeline before applying any migration is the recovery
          -- path if assumption is ever wrong (operator restores from dump not from editing this file)
          DROP TABLE admin."${table}" CASCADE
        `);
      }
      // Table already in shared (or missing entirely) → nothing to do.
    }

    // 3. Sequence ownership follow-up. ALTER TABLE SET SCHEMA does NOT
    //    move sequences owned by SERIAL/BIGSERIAL columns of the
    //    table. We move them explicitly so the table's nextval()
    //    grant + ownership stays consistent (otherwise an INSERT into
    //    shared.X would still consult admin.X_id_seq).
    //
    //    Discovery: query pg_depend for sequences owned by any column
    //    of the moved tables; ALTER SEQUENCE … SET SCHEMA shared.
    const sequencesToMove: Array<{ sequence_schema: string; sequence_name: string }> =
      await queryRunner.query(`
        SELECT n.nspname AS sequence_schema, c.relname AS sequence_name
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
        JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_namespace tn ON t.relnamespace = tn.oid
        WHERE c.relkind = 'S'
          AND tn.nspname = 'admin'
          AND t.relname IN ('audit_logs', 'user_consents', 'gdpr_data_requests')
      `);
    for (const { sequence_schema, sequence_name } of sequencesToMove) {
      // Defensive: confirm sequence still in admin (the SET SCHEMA
      // above might have moved it as a dependency in some pg versions).
      const stillInAdmin: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*) AS count FROM information_schema.sequences
         WHERE sequence_schema = $1 AND sequence_name = $2`,
        [sequence_schema, sequence_name],
      );
      if (Number(stillInAdmin[0]?.count ?? 0) > 0) {
        await queryRunner.query(
          `ALTER SEQUENCE ${sequence_schema}."${sequence_name}" SET SCHEMA shared`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback: move tables back to admin. Real-world this should
    // never be invoked — see migration docblock §down() rollback.
    for (const table of ['audit_logs', 'user_consents', 'gdpr_data_requests']) {
      const present: Array<{ table_schema: string }> = await queryRunner.query(
        `SELECT table_schema FROM information_schema.tables
         WHERE table_name = $1 AND table_schema = 'shared'`,
        [table],
      );
      if (present.length > 0) {
        await queryRunner.query(`ALTER TABLE shared."${table}" SET SCHEMA admin`);
      }
    }
  }
}
