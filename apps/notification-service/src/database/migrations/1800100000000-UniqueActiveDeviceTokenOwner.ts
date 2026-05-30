import { MigrationInterface, QueryRunner } from 'typeorm';

export class UniqueActiveDeviceTokenOwner1800100000000 implements MigrationInterface {
  name = 'UniqueActiveDeviceTokenOwner1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY token
            ORDER BY last_seen_at DESC NULLS LAST, created_at DESC, id DESC
          ) AS rn
        FROM notification.device_tokens
      )
      DELETE FROM notification.device_tokens dt
      USING ranked r
      WHERE dt.id = r.id
        AND r.rn > 1
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_device_tokens_single_active_owner"
      ON notification.device_tokens (token)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS notification."IDX_device_tokens_single_active_owner"
    `);
  }
}
