import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddWorkerVeterinaryFields1803400000000
 *
 * Marks farm workers who are veterinarians (RPT-011) so treatment applications
 * can attribute the responsible vet (treatment_applications.veterinarianWorkerId)
 * and capture forms can present a vet-only picker.
 *
 * Plain additive columns on a per-tenant table — blue-green safe (boolean has a
 * DEFAULT; the licence column is nullable). current_schema-relative, idempotent,
 * forward-only.
 */
export class AddWorkerVeterinaryFields1803400000000 implements MigrationInterface {
  name = 'AddWorkerVeterinaryFields1803400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "farm_workers"
        ADD COLUMN IF NOT EXISTS "isVeterinarian" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "farm_workers"
        ADD COLUMN IF NOT EXISTS "veterinaryLicenseNumber" character varying(50)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_farm_workers_tenant_vet"
        ON "farm_workers" ("tenantId", "isVeterinarian")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_farm_workers_tenant_vet"`);
    await queryRunner.query(
      `ALTER TABLE "farm_workers" DROP COLUMN IF EXISTS "veterinaryLicenseNumber"`,
    );
    await queryRunner.query(`ALTER TABLE "farm_workers" DROP COLUMN IF EXISTS "isVeterinarian"`);
  }
}
