import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateIncidentMedia1806000000000
 *
 * Per-tenant `farm_incident_media` table: photos attached to the three
 * field-capture incident records (escape / welfare / lice). Rows are written in
 * the SAME transaction as the incident they back, keyed polymorphically by
 * (incidentType, referenceId) — not an FK, since it spans three parent tables.
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class CreateIncidentMedia1806000000000 implements MigrationInterface {
  name = 'CreateIncidentMedia1806000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE farm_incident_media_incidenttype_enum AS ENUM ('ESCAPE', 'WELFARE', 'LICE');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "farm_incident_media" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "incidentType" farm_incident_media_incidenttype_enum NOT NULL,
        "referenceId" uuid NOT NULL,
        "storageKey" varchar(512) NOT NULL,
        "mimeType" varchar(127) NOT NULL,
        "fileSizeBytes" bigint NOT NULL,
        "originalFilename" varchar(255),
        "createdBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_farm_incident_media" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_farm_incident_media_tenant_type_ref"
        ON "farm_incident_media" ("tenantId", "incidentType", "referenceId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_farm_incident_media_tenant"
        ON "farm_incident_media" ("tenantId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP TABLE IF EXISTS "farm_incident_media"`);
    await queryRunner.query(`DROP TYPE IF EXISTS farm_incident_media_incidenttype_enum`);
  }
}
