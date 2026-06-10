import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger, pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * CreateHrOutbox1789200000000
 * ============================================================================
 *
 * Forward-only alignment for HrOutbox (apps/hr-service/src/hr/entities/
 * hr-outbox.entity.ts). The table used to exist only as a Docker init script,
 * which meant upgraded databases could pass the migration ledger while the
 * runtime outbox worker still saw a missing/partial table.
 */
export class CreateHrOutbox1789200000000 implements MigrationInterface {
  name = 'CreateHrOutbox1789200000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'hr');

    this.logger.log('Creating and aligning hr.hr_outbox.');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hr.hr_outbox (
        "id"              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "eventType"       VARCHAR(100) NOT NULL,
        "tenantId"        UUID,
        "aggregateId"     UUID,
        "payload"         JSONB NOT NULL,
        "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "publishedAt"     TIMESTAMPTZ,
        "retryCount"      INTEGER NOT NULL DEFAULT 0,
        "lastError"       TEXT,
        "nextAttemptAt"   TIMESTAMPTZ,
        "idempotencyKey"  VARCHAR(255),
        "isDeadLettered"  BOOLEAN NOT NULL DEFAULT false,
        "leasedAt"        TIMESTAMPTZ,
        "leasedBy"        VARCHAR(128)
      )
    `);

    await queryRunner.query(`
      ALTER TABLE hr.hr_outbox
        ADD COLUMN IF NOT EXISTS "eventType" VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "tenantId" UUID,
        ADD COLUMN IF NOT EXISTS "aggregateId" UUID,
        ADD COLUMN IF NOT EXISTS "payload" JSONB,
        ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "retryCount" INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "lastError" TEXT,
        ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "isDeadLettered" BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS "leasedAt" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "leasedBy" VARCHAR(128)
    `);

    await queryRunner.query(`
      UPDATE hr.hr_outbox
         SET "eventType" = COALESCE("eventType", payload->>'type', 'UnknownEvent'),
             "payload" = COALESCE("payload", '{}'::jsonb),
             "createdAt" = COALESCE("createdAt", NOW()),
             "retryCount" = COALESCE("retryCount", 0),
             "isDeadLettered" = COALESCE("isDeadLettered", false)
       WHERE "eventType" IS NULL
          OR "payload" IS NULL
          OR "createdAt" IS NULL
          OR "retryCount" IS NULL
          OR "isDeadLettered" IS NULL
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'hr' AND table_name = 'hr_outbox'
             AND column_name = 'eventType'
        ) THEN
          ALTER TABLE hr.hr_outbox ALTER COLUMN "eventType" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'hr' AND table_name = 'hr_outbox'
             AND column_name = 'payload'
        ) THEN
          ALTER TABLE hr.hr_outbox ALTER COLUMN "payload" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'hr' AND table_name = 'hr_outbox'
             AND column_name = 'createdAt'
        ) THEN
          ALTER TABLE hr.hr_outbox ALTER COLUMN "createdAt" SET NOT NULL;
          ALTER TABLE hr.hr_outbox ALTER COLUMN "createdAt" SET DEFAULT NOW();
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'hr' AND table_name = 'hr_outbox'
             AND column_name = 'retryCount'
        ) THEN
          ALTER TABLE hr.hr_outbox ALTER COLUMN "retryCount" SET NOT NULL;
          ALTER TABLE hr.hr_outbox ALTER COLUMN "retryCount" SET DEFAULT 0;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'hr' AND table_name = 'hr_outbox'
             AND column_name = 'isDeadLettered'
        ) THEN
          ALTER TABLE hr.hr_outbox ALTER COLUMN "isDeadLettered" SET NOT NULL;
          ALTER TABLE hr.hr_outbox ALTER COLUMN "isDeadLettered" SET DEFAULT false;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hr_outbox_poll
        ON hr.hr_outbox ("createdAt" ASC)
        WHERE "publishedAt" IS NULL AND "isDeadLettered" = false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hr_outbox_published_at
        ON hr.hr_outbox ("publishedAt")
        WHERE "publishedAt" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_outbox_idempotency
        ON hr.hr_outbox ("tenantId", "idempotencyKey")
        WHERE "idempotencyKey" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_hr_outbox_lease
        ON hr.hr_outbox ("leasedAt")
        WHERE "leasedAt" IS NOT NULL AND "publishedAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION hr.notify_hr_outbox_new()
        RETURNS TRIGGER
        LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_notify('hr_outbox_notify', '');
        RETURN NULL;
      END;
      $$;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS hr_outbox_notify_trigger ON hr.hr_outbox
    `);
    await queryRunner.query(`
      CREATE TRIGGER hr_outbox_notify_trigger
        AFTER INSERT ON hr.hr_outbox
        FOR EACH ROW
        EXECUTE FUNCTION hr.notify_hr_outbox_new()
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hr_service') THEN
          ALTER TABLE hr.hr_outbox OWNER TO hr_service;
          ALTER FUNCTION hr.notify_hr_outbox_new() OWNER TO hr_service;
        END IF;
      END $$;
    `);

    this.logger.log('hr.hr_outbox aligned.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn('Dropping hr.hr_outbox. Intended for ephemeral test environments only.');

    await pinSearchPath(queryRunner, 'hr');
    await queryRunner.query(`DROP TRIGGER IF EXISTS hr_outbox_notify_trigger ON hr.hr_outbox`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS hr.notify_hr_outbox_new()`);
    await queryRunner.query(`DROP TABLE IF EXISTS hr.hr_outbox`);
  }
}
