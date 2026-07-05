import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Faz 1 BYOK: per-tenant AI credentials on ai.tenant_agent_configs.
 *
 * Blue-green safe — every column is additive and either nullable or carries a
 * default, so an old service version keeps running against the new schema:
 *   - provider       NOT NULL DEFAULT 'anthropic' (existing rows backfill to the
 *                    prior implicit provider; no orphan rows)
 *   - anthropicApiKey / openaiApiKey  nullable text — AES-256-GCM encrypted at
 *                    the application layer (enc: prefix), so the column holds
 *                    ciphertext, never plaintext
 *   - chatModel      nullable — null means "use the persona default"
 *
 * No backfill step and no follow-up NOT NULL migration: keys are legitimately
 * absent until a tenant enters one (key-absent = AI disabled, by design).
 */
export class AddByokTenantAiCredentials1802000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai"."tenant_agent_configs" ADD COLUMN IF NOT EXISTS "provider" character varying(20) NOT NULL DEFAULT 'anthropic'`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai"."tenant_agent_configs" ADD COLUMN IF NOT EXISTS "anthropicApiKey" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai"."tenant_agent_configs" ADD COLUMN IF NOT EXISTS "openaiApiKey" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai"."tenant_agent_configs" ADD COLUMN IF NOT EXISTS "chatModel" character varying(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai"."tenant_agent_configs" DROP COLUMN IF EXISTS "chatModel"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai"."tenant_agent_configs" DROP COLUMN IF EXISTS "openaiApiKey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai"."tenant_agent_configs" DROP COLUMN IF EXISTS "anthropicApiKey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai"."tenant_agent_configs" DROP COLUMN IF EXISTS "provider"`,
    );
  }
}
