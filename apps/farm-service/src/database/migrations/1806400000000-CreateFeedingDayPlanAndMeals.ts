import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateFeedingDayPlanAndMeals1806400000000 (Faz 5 — plan §2 + NFR indeks seti)
 *
 * Öğün-bazlı yürütme motorunun tabloları:
 *  - `feeding_day_plans`: ünite × gün planı; `(tenantId, unitId, planDate)`
 *    unique → 06:00 üretimi upsert-idempotent; rollup partial indeksi DAILY
 *    growth süpürmesini indeksli kılar.
 *  - `feeding_meals`: day plan'ın öğünleri + kısmi dökümler (D-8);
 *    15dk pencere cron'u yalnız partial indeks üzerinden okur.
 *  - `feeding_records` ekleri: nullable `mealId/pourIndex/dayPlanId/
 *    sourceExecutionId` + `(mealId, pourIndex)` unique partial indeks —
 *    P-05 invariantı (bir dökümün tam bir kaydı) YAPISAL; `sourceExecutionId`
 *    unique partial indeksi Faz 6 tarihsel backfill'inin idempotency anahtarı.
 *
 * Her iki yeni tablo TENANT-SCOPED'tur; DDL şema-nitelemesizdir (enum tipleri
 * dahil — her pass nesneleri kendi şemasına indirir; ORPHAN-HIGH-408 dersi).
 */
export class CreateFeedingDayPlanAndMeals1806400000000 implements MigrationInterface {
  name = 'CreateFeedingDayPlanAndMeals1806400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feeding_day_plans_status_enum AS ENUM ('planned', 'in_progress', 'completed', 'skipped', 'cancelled');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feeding_meals_status_enum AS ENUM ('scheduled', 'fed', 'partially_fed', 'skipped', 'missed', 'cancelled');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "feeding_day_plans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "assignmentId" uuid NOT NULL,
        "protocolId" uuid NOT NULL,
        "unitId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "unitType" feeding_protocol_assignments_unittype_enum NOT NULL,
        "unitName" character varying(200) NOT NULL,
        "unitCode" character varying(50) NOT NULL,
        "planDate" date NOT NULL,
        "snapshot" jsonb NOT NULL,
        "plannedTotalKg" numeric(12,3) NOT NULL,
        "unplannedActualKg" numeric(12,3) NOT NULL DEFAULT 0,
        "mealsPlanned" integer NOT NULL,
        "status" feeding_day_plans_status_enum NOT NULL DEFAULT 'planned',
        "rollupAppliedAt" TIMESTAMP WITH TIME ZONE,
        "skipReason" text,
        "recalcLog" jsonb NOT NULL DEFAULT '[]',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL,
        CONSTRAINT "PK_feeding_day_plans" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fdp_tenant_unit_date" ON "feeding_day_plans" ("tenantId", "unitId", "planDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fdp_tenant_date" ON "feeding_day_plans" ("tenantId", "planDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fdp_rollup_pending" ON "feeding_day_plans" ("tenantId", "planDate") WHERE "rollupAppliedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fdp_assignment_date" ON "feeding_day_plans" ("assignmentId", "planDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fdp_tenant_site_date" ON "feeding_day_plans" ("tenantId", "siteId", "planDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fdp_tenant" ON "feeding_day_plans" ("tenantId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "feeding_meals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "dayPlanId" uuid NOT NULL,
        "unitId" uuid NOT NULL,
        "siteId" uuid NOT NULL,
        "mealIndex" integer NOT NULL,
        "scheduledAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "percentOfDaily" numeric(6,2) NOT NULL,
        "plannedKg" numeric(12,3) NOT NULL,
        "status" feeding_meals_status_enum NOT NULL DEFAULT 'scheduled',
        "actualKg" numeric(12,3) NOT NULL DEFAULT 0,
        "pours" jsonb NOT NULL DEFAULT '[]',
        "varianceKg" numeric(12,3),
        "variancePercent" numeric(7,2),
        "feedId" uuid NOT NULL,
        "fedAt" TIMESTAMP WITH TIME ZONE,
        "fedBy" uuid,
        "feedingMethod" character varying(50),
        "recalculatedAt" TIMESTAMP WITH TIME ZONE,
        "windowNotifiedAt" TIMESTAMP WITH TIME ZONE,
        "notes" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL,
        CONSTRAINT "PK_feeding_meals" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fm_dayplan_index" ON "feeding_meals" ("dayPlanId", "mealIndex")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fm_tenant_dayplan" ON "feeding_meals" ("tenantId", "dayPlanId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fm_window_pending" ON "feeding_meals" ("tenantId", "scheduledAt") WHERE "status" = 'scheduled' AND "windowNotifiedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fm_tenant_unit_scheduled" ON "feeding_meals" ("tenantId", "unitId", "scheduledAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fm_tenant" ON "feeding_meals" ("tenantId")`,
    );

    // feeding_records ekleri — hepsi nullable (blue-green güvenli, additive).
    await queryRunner.query(
      `ALTER TABLE "feeding_records" ADD COLUMN IF NOT EXISTS "mealId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "feeding_records" ADD COLUMN IF NOT EXISTS "pourIndex" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "feeding_records" ADD COLUMN IF NOT EXISTS "dayPlanId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "feeding_records" ADD COLUMN IF NOT EXISTS "sourceExecutionId" uuid`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fr_meal_pour" ON "feeding_records" ("mealId", "pourIndex") WHERE "mealId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fr_source_execution" ON "feeding_records" ("sourceExecutionId") WHERE "sourceExecutionId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fr_dayplan" ON "feeding_records" ("dayPlanId") WHERE "dayPlanId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fr_dayplan"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fr_source_execution"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fr_meal_pour"`);
    await queryRunner.query(`ALTER TABLE "feeding_records" DROP COLUMN IF EXISTS "sourceExecutionId"`);
    await queryRunner.query(`ALTER TABLE "feeding_records" DROP COLUMN IF EXISTS "dayPlanId"`);
    await queryRunner.query(`ALTER TABLE "feeding_records" DROP COLUMN IF EXISTS "pourIndex"`);
    await queryRunner.query(`ALTER TABLE "feeding_records" DROP COLUMN IF EXISTS "mealId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feeding_meals"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "feeding_day_plans"`);
    await queryRunner.query(`DROP TYPE IF EXISTS feeding_meals_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS feeding_day_plans_status_enum`);
  }
}
