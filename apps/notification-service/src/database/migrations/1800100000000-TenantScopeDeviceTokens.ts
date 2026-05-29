import { MigrationInterface, QueryRunner } from 'typeorm';

export class TenantScopeDeviceTokens1800100000000 implements MigrationInterface {
  name = 'TenantScopeDeviceTokens1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "notification"."device_tokens" dt
      USING (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY token
                 ORDER BY COALESCE(last_seen_at, created_at) DESC,
                          created_at DESC,
                          id DESC
               ) AS rn
          FROM "notification"."device_tokens"
      ) ranked
      WHERE dt.id = ranked.id
        AND ranked.rn > 1
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'UQ_a070dfec1c8f06cd29b854169f2'
            AND conrelid = 'notification.device_tokens'::regclass
        ) THEN
          ALTER TABLE "notification"."device_tokens"
            DROP CONSTRAINT "UQ_a070dfec1c8f06cd29b854169f2";
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_device_tokens_tenant_user_token'
            AND conrelid = 'notification.device_tokens'::regclass
        ) THEN
          ALTER TABLE "notification"."device_tokens"
            ADD CONSTRAINT "uq_device_tokens_tenant_user_token"
            UNIQUE ("tenant_id", "user_id", "token");
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_tokens_token"
        ON "notification"."device_tokens" ("token")
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only: do not restore the legacy cross-tenant device token key.
  }
}
