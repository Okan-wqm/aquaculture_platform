import { MigrationInterface, QueryRunner } from 'typeorm';

export class SensorRustIngestionOutbox1800800000000 implements MigrationInterface {
  name = 'SensorRustIngestionOutbox1800800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sensor"."event_outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "event_type" character varying(100) NOT NULL,
        "payload" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "dispatched_at" TIMESTAMP WITH TIME ZONE,
        "dispatch_attempts" integer NOT NULL DEFAULT 0,
        "last_attempted_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "claimed_at" TIMESTAMP WITH TIME ZONE,
        "claimed_by" character varying(128),
        CONSTRAINT "PK_sensor_event_outbox_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_sensor_event_outbox_dispatch_attempts_nonnegative"
          CHECK ("dispatch_attempts" >= 0)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "sensor"."event_outbox"
        ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "sensor"."event_outbox"
        ADD COLUMN IF NOT EXISTS "claimed_by" character varying(128)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sensor_event_outbox_pending"
        ON "sensor"."event_outbox" ("created_at")
        WHERE "dispatched_at" IS NULL AND "dispatch_attempts" < 10
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sensor_event_outbox_tenant_created"
        ON "sensor"."event_outbox" ("tenant_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sensor_event_outbox_dispatched"
        ON "sensor"."event_outbox" ("dispatched_at")
        WHERE "dispatched_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "sensor"."IDX_sensor_event_outbox_dispatched"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "sensor"."IDX_sensor_event_outbox_tenant_created"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "sensor"."IDX_sensor_event_outbox_pending"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sensor"."event_outbox"`);
  }
}
