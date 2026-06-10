import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateActionTokens1800200000000 implements MigrationInterface {
  name = 'CreateActionTokens1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth"."action_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "purpose" varchar(32) NOT NULL,
        "tenantId" uuid NULL,
        "userId" uuid NOT NULL,
        "tokenHash" varchar(128) NOT NULL,
        "deliveryIdempotencyKey" varchar(128) NULL,
        "status" varchar(32) NOT NULL DEFAULT 'ACTIVE',
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumedAt" TIMESTAMP WITH TIME ZONE NULL,
        "revokedAt" TIMESTAMP WITH TIME ZONE NULL,
        "auditMetadata" jsonb NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_auth_action_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_action_tokens_user" FOREIGN KEY ("userId")
          REFERENCES "auth"."users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_action_tokens_tenant_purpose"
        ON "auth"."action_tokens" ("tenantId", "purpose")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_action_tokens_user_purpose"
        ON "auth"."action_tokens" ("userId", "purpose")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_action_tokens_token_hash"
        ON "auth"."action_tokens" ("tokenHash")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UX_action_tokens_delivery"
        ON "auth"."action_tokens" ("deliveryIdempotencyKey")
        WHERE "deliveryIdempotencyKey" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "auth"."UX_action_tokens_delivery"');
    await queryRunner.query('DROP INDEX IF EXISTS "auth"."IDX_action_tokens_token_hash"');
    await queryRunner.query('DROP INDEX IF EXISTS "auth"."IDX_action_tokens_user_purpose"');
    await queryRunner.query('DROP INDEX IF EXISTS "auth"."IDX_action_tokens_tenant_purpose"');
    await queryRunner.query('DROP TABLE IF EXISTS "auth"."action_tokens"');
  }
}
