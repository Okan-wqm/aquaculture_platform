import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateSlaughterFacilities1803450000000
 *
 * Slaughter-facility catalog (user decision: catalog over the single
 * settings field). Seeds one default row from
 * regulatory_settings.slaughter_approval_number where present; the settings
 * field stays as a read fallback until Phase 4 drops it.
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class CreateSlaughterFacilities1803450000000 implements MigrationInterface {
  name = 'CreateSlaughterFacilities1803450000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "slaughter_facilities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "name" character varying(150) NOT NULL,
        "godkjenningsnummer" character varying(6) NOT NULL,
        "isDefault" boolean NOT NULL DEFAULT false,
        "address" character varying(255),
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_slaughter_facilities" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_slaughter_facilities_tenant_nr"
        ON "slaughter_facilities" ("tenantId", "godkjenningsnummer")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_slaughter_facilities_tenant_default"
        ON "slaughter_facilities" ("tenantId", "isDefault")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_slaughter_facilities_tenant"
        ON "slaughter_facilities" ("tenantId")
    `);

    // Seed the catalog from the legacy single-field configuration. The
    // official number is 1–6 alphanumeric; anything longer in the legacy
    // varchar(50) field cannot be a valid godkjenningsnummer and is skipped
    // (the operator re-enters it in the catalog).
    await queryRunner.query(`
      INSERT INTO "slaughter_facilities"
        ("tenantId", "name", "godkjenningsnummer", "isDefault")
      SELECT rs."tenant_id",
             'Default facility',
             rs."slaughter_approval_number",
             true
        FROM "regulatory_settings" rs
       WHERE rs."slaughter_approval_number" IS NOT NULL
         AND rs."slaughter_approval_number" ~ '^[A-Za-z0-9]{1,6}$'
         AND NOT EXISTS (
           SELECT 1 FROM "slaughter_facilities" sf
            WHERE sf."tenantId" = rs."tenant_id"
              AND sf."godkjenningsnummer" = rs."slaughter_approval_number"
         )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP TABLE IF EXISTS "slaughter_facilities"`);
  }
}
