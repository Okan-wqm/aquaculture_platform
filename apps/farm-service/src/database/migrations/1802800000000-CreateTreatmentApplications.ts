import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateTreatmentApplications1802800000000
 *
 * Per-application treatment records (RPT-008) — the operational source for
 * the lakselus report's behandlinger arrays. Application FACTS live only
 * here; health_events keeps the clinical narrative.
 *
 * Backfill: existing health_events rows whose `treatment` jsonb carries a
 * medication produce one application row (best-effort mapping: method from
 * treatment.method, virkestoff free-name into beskrivelse — the official
 * enum cannot be derived reliably from free text, so it stays NULL for the
 * operator to classify). The jsonb is left intact for the clinical record;
 * assemblers read ONLY this table.
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class CreateTreatmentApplications1802800000000 implements MigrationInterface {
  name = 'CreateTreatmentApplications1802800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE treatment_applications_category_enum AS ENUM ('medicinal', 'non_medicinal');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "treatment_applications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "tankId" uuid,
        "batchId" uuid,
        "healthEventId" uuid,
        "category" treatment_applications_category_enum NOT NULL,
        "method" character varying(40) NOT NULL,
        "chemicalId" uuid,
        "virkestoffType" character varying(30),
        "styrkeVerdi" numeric(10,3),
        "styrkeEnhet" character varying(30),
        "mengdeVerdi" numeric(12,3),
        "mengdeEnhet" character varying(10),
        "wholeSite" boolean NOT NULL DEFAULT false,
        "pensCount" integer,
        "appliedAt" timestamptz NOT NULL,
        "completedAt" timestamptz,
        "veterinarianWorkerId" uuid,
        "externalVetName" character varying(255),
        "beskrivelse" text,
        "recordedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_treatment_applications" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_treatment_applications_tenant_site_applied"
        ON "treatment_applications" ("tenantId", "siteId", "appliedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_treatment_applications_tenant_batch"
        ON "treatment_applications" ("tenantId", "batchId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_treatment_applications_tenant"
        ON "treatment_applications" ("tenantId")
    `);

    // Best-effort backfill from health_events treatment jsonb: one row per
    // event that started a treatment with a medication block. tank → site
    // resolves through the department chain; events whose tank cannot be
    // resolved are skipped (no site key to report under).
    await queryRunner.query(`
      INSERT INTO "treatment_applications" (
        "tenantId", "siteId", "tankId", "batchId", "healthEventId",
        "category", "method", "beskrivelse", "appliedAt", "recordedBy"
      )
      SELECT he."tenantId",
             d."siteId",
             he."tankId",
             he."batchId",
             he.id,
             (CASE WHEN he.treatment->'medication' IS NOT NULL THEN 'medicinal'
                   ELSE 'non_medicinal' END)::treatment_applications_category_enum,
             CASE upper(COALESCE(he.treatment->>'method', ''))
               WHEN 'BATH' THEN 'BADEBEHANDLING'
               ELSE 'ANNEN_BEHANDLING'
             END,
             NULLIF(concat_ws(' — ',
               he.treatment->'medication'->>'name',
               he.treatment->'medication'->>'activeIngredient'
             ), ''),
             COALESCE(
               (he.treatment->'duration'->>'startDate')::timestamptz,
               he."createdAt"
             ),
             he."reportedBy"
        FROM "health_events" he
        JOIN "tanks" t ON t.id = he."tankId"
        JOIN "departments" d ON d.id = t."departmentId" AND d."siteId" IS NOT NULL
       WHERE he.treatment IS NOT NULL
         AND he.treatment->>'method' IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM "treatment_applications" ta
            WHERE ta."healthEventId" = he.id
         )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP TABLE IF EXISTS "treatment_applications"`);
    await queryRunner.query(`DROP TYPE IF EXISTS treatment_applications_category_enum`);
  }
}
