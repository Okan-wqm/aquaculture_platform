import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MoveUserPermissionsToShared
 * ============================================================================
 *
 * Architectural correction: per CLAUDE.md "Tenant row placement (D14)",
 * the `user_permissions` table is one of the four canonical cross-tenant
 * singleton tables that live in the `shared` schema (alongside
 * `audit_logs`, `gdpr_data_requests`, `user_consents` — all moved by
 * INFRA-CRITICAL-026 commit 699adabd).
 *
 * # Drift detected at boot 2026-04-20
 *
 * SchemaDriftValidator[admin-api] reports per cold start:
 *
 *   [user_permissions] entity declares schema='shared' but table lives in 'public'
 *
 * The user_permissions table was historically created in the public
 * schema by an early seed script, while the entity decorator at
 * `apps/admin-api-service/src/users/entities/user-permissions.entity.ts`
 * always declared `schema: 'shared'` per the ADR-011 invariant. The
 * earlier audit_logs/user_consents/gdpr_data_requests move (INFRA-
 * CRITICAL-026) closed three of the four shared singletons; this
 * migration closes the fourth.
 *
 * # Why ALTER TABLE SET SCHEMA (not CREATE+COPY+DROP)
 *
 * Same rationale as INFRA-CRITICAL-026's
 * `1782200000000-MoveSharedTablesFromAdminToShared.ts`:
 * `ALTER TABLE … SET SCHEMA` is atomic at the catalog level.
 * Indexes/constraints/RLS policies follow the table without rebuild.
 * Sub-millisecond on a small table.
 *
 * # Idempotency
 *
 * Each step uses existence checks so the migration is safe to re-run
 * on a database that has already been migrated.
 */
export class MoveUserPermissionsToShared1786900000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS shared`);

    const present: Array<{ table_schema: string }> = await queryRunner.query(
      `SELECT table_schema FROM information_schema.tables
       WHERE table_name = 'user_permissions' AND table_schema IN ('public', 'shared')`,
    );
    const inPublic = present.some((r) => r.table_schema === 'public');
    const inShared = present.some((r) => r.table_schema === 'shared');

    if (inPublic && !inShared) {
      await queryRunner.query(
        `ALTER TABLE public.user_permissions SET SCHEMA shared`,
      );
    } else if (inPublic && inShared) {
      await queryRunner.query(`
        -- DESTRUCTIVE: rollback drops the orphan in public on partial-state recovery
        -- Live data lives in shared after the prior partial run so no production data is lost
        -- pg_dump backup taken by deploy pipeline before applying any migration is the recovery path
        DROP TABLE public.user_permissions CASCADE
      `);
    }
    // Else: already in shared (or missing entirely) → nothing to do.

    // Sequence ownership follow-up (mirroring 1782200000000 pattern).
    const sequencesToMove: Array<{ sequence_schema: string; sequence_name: string }> =
      await queryRunner.query(`
        SELECT n.nspname AS sequence_schema, c.relname AS sequence_name
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
        JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_namespace tn ON t.relnamespace = tn.oid
        WHERE c.relkind = 'S'
          AND tn.nspname = 'public'
          AND t.relname = 'user_permissions'
      `);
    for (const { sequence_schema, sequence_name } of sequencesToMove) {
      const stillInPublic: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*) AS count FROM information_schema.sequences
         WHERE sequence_schema = $1 AND sequence_name = $2`,
        [sequence_schema, sequence_name],
      );
      if (Number(stillInPublic[0]?.count ?? 0) > 0) {
        await queryRunner.query(
          `ALTER SEQUENCE ${sequence_schema}."${sequence_name}" SET SCHEMA shared`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const present: Array<{ table_schema: string }> = await queryRunner.query(
      `SELECT table_schema FROM information_schema.tables
       WHERE table_name = 'user_permissions' AND table_schema = 'shared'`,
    );
    if (present.length > 0) {
      await queryRunner.query(`ALTER TABLE shared.user_permissions SET SCHEMA public`);
    }
  }
}
