import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSensorEventIdempotency1816000000002 implements MigrationInterface {
  name = 'AddSensorEventIdempotency1816000000002';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "alert"."alert_history"
            ADD COLUMN IF NOT EXISTS "source_event_id" uuid
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_alert_history_source_event_rule"
            ON "alert"."alert_history" ("source_event_id", "rule_id")
            WHERE "source_event_id" IS NOT NULL
        `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    throw new Error(
      'Alert source-event idempotency is forward-only; rollback must preserve committed effect identities',
    );
  }
}
