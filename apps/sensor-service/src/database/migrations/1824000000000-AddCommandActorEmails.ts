import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The e-mail of the person behind two command records:
 * `deployment_logs.deployed_by_email` and `feeding_parameters."createdByEmail"`.
 *
 * # Why
 *
 * Both records name their actor by the JWT subject only (`deployed_by`,
 * `"createdBy"`): a user UUID nobody reading the command log recognises. The
 * VFD command ledger and the calibration history already keep the e-mail
 * next to the id (`performed_by_email`); these two records now do the same.
 * The id stays the identity checks compare (the rollback four-eyes rule);
 * the e-mail is what the record shows, as it was when the person acted.
 *
 * NULL for every existing row (no e-mail was captured then; readers fall back
 * to the id) and set by the write paths from the authenticated caller. Each
 * column follows its table's naming: `deployment_logs` is snake_case,
 * `feeding_parameters` keeps TypeORM's default camelCase names.
 *
 * # Tenant routing
 *
 * Both are per-tenant tables: run once per schema with the search_path pinned
 * (the orchestrator), unqualified, each guarded for a schema without it.
 * Blue-green safe: nullable, no default. `down` drops both columns.
 */
export class AddCommandActorEmails1824000000000 implements MigrationInterface {
  name = 'AddCommandActorEmails1824000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    if (await hasTable(queryRunner, 'deployment_logs')) {
      await queryRunner.query(
        `ALTER TABLE "deployment_logs" ADD COLUMN IF NOT EXISTS "deployed_by_email" character varying(255)`,
      );
    }
    if (await hasTable(queryRunner, 'feeding_parameters')) {
      await queryRunner.query(
        `ALTER TABLE "feeding_parameters" ADD COLUMN IF NOT EXISTS "createdByEmail" character varying(255)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    if (await hasTable(queryRunner, 'feeding_parameters')) {
      await queryRunner.query(
        `ALTER TABLE "feeding_parameters" DROP COLUMN IF EXISTS "createdByEmail"`,
      );
    }
    if (await hasTable(queryRunner, 'deployment_logs')) {
      await queryRunner.query(
        `ALTER TABLE "deployment_logs" DROP COLUMN IF EXISTS "deployed_by_email"`,
      );
    }
  }
}

async function hasTable(
  queryRunner: QueryRunner,
  table: 'deployment_logs' | 'feeding_parameters',
): Promise<boolean> {
  const present: Array<{ ready: boolean }> = await queryRunner.query(
    `SELECT to_regclass($1) IS NOT NULL AS ready`,
    [table],
  );
  return present[0]?.ready === true;
}
