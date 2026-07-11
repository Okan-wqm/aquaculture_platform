import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateLiceCounts1802700000000
 *
 * Operational lice-counting records (RPT-004): one row per pen per counting
 * date with the three official stages as per-fish averages. The weekly
 * lakselus report assembles from these — the legal core of the report stops
 * being typed free text.
 *
 * current_schema-relative (farm + every tenant_<uuid>), idempotent,
 * forward-only.
 */
export class CreateLiceCounts1802700000000 implements MigrationInterface {
  name = 'CreateLiceCounts1802700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lice_counts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "tankId" uuid NOT NULL,
        "batchId" uuid,
        "countDate" date NOT NULL,
        "reportingYear" integer NOT NULL,
        "reportingWeek" integer NOT NULL,
        "adultFemaleLice" numeric(6,2) NOT NULL,
        "mobileLice" numeric(6,2) NOT NULL,
        "attachedLice" numeric(6,2) NOT NULL,
        "fishSampled" integer NOT NULL,
        "seaTemperatureC" numeric(4,1),
        "temperatureSource" character varying(10),
        "countedBy" uuid,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lice_counts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lice_counts_tenant_tank_date"
        ON "lice_counts" ("tenantId", "tankId", "countDate")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lice_counts_tenant_site_week"
        ON "lice_counts" ("tenantId", "siteId", "reportingYear", "reportingWeek")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lice_counts_tenant"
        ON "lice_counts" ("tenantId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP TABLE IF EXISTS "lice_counts"`);
  }
}
