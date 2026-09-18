import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Align billing.scheduled_plan_changes.currentPlanId with the entity's NOT NULL
 * declaration — the schema drift validator blocks service boot when the DB
 * column is nullable but the entity requires it.
 */
export class SetCurrentPlanIdNotNull1802700000000 implements MigrationInterface {
  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'billing'
            AND table_name = 'scheduled_plan_changes'
            AND column_name = 'currentPlanId'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "billing"."scheduled_plan_changes" ALTER COLUMN "currentPlanId" SET NOT NULL;
        END IF;
      END $$;
    `);
  }
  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'billing'
            AND table_name = 'scheduled_plan_changes'
            AND column_name = 'currentPlanId'
            AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "billing"."scheduled_plan_changes" ALTER COLUMN "currentPlanId" DROP NOT NULL;
        END IF;
      END $$;
    `);
  }
}
