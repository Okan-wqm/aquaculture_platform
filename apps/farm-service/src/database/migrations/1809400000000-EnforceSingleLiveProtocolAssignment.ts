import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Converges active/paused lifecycle states onto one physical live assignment identity. */
export class EnforceSingleLiveProtocolAssignment1809400000000 implements MigrationInterface {
  name = 'EnforceSingleLiveProtocolAssignment1809400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '120s'`);
    const presence: Array<{ assignments: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feeding_protocol_assignments')::text AS assignments`,
    );
    if (!presence[0]?.assignments) return;

    // Prefer ACTIVE, otherwise the newest PAUSED identity. Every loser is
    // ended with its own durable timestamp rather than a migration-clock value.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY "tenantId", "unitId"
                 ORDER BY
                   CASE status WHEN 'active' THEN 0 ELSE 1 END,
                   "effectiveFrom" DESC,
                   "createdAt" DESC,
                   id DESC
               ) AS live_rank
          FROM "feeding_protocol_assignments"
         WHERE status <> 'ended'
      )
      UPDATE "feeding_protocol_assignments" assignment
         SET status = 'ended',
             "endedAt" = COALESCE(
               assignment."endedAt",
               assignment."updatedAt",
               assignment."createdAt"
             ),
             "updatedAt" = GREATEST(assignment."updatedAt", assignment."createdAt"),
             version = version + 1
        FROM ranked
       WHERE ranked.id = assignment.id
         AND ranked.live_rank > 1
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fpa_tenant_unit_active"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fpa_tenant_unit_live"
        ON "feeding_protocol_assignments" ("tenantId", "unitId")
        WHERE status <> 'ended'
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT to_regclass('feeding_protocol_assignments') IS NULL OR (
        NOT EXISTS (
          SELECT 1
            FROM "feeding_protocol_assignments"
           WHERE status <> 'ended'
           GROUP BY "tenantId", "unitId"
          HAVING COUNT(*) > 1
        )
        AND to_regclass('"IDX_fpa_tenant_unit_live"') IS NOT NULL
        AND to_regclass('"IDX_fpa_tenant_unit_active"') IS NULL
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only: resurrecting duplicate paused identities is ambiguous and
    // would make assignment mutation ownership non-deterministic.
  }
}
