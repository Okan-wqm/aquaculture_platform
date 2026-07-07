import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Faz 1 BYOK: per-tenant AI credentials on tenant_agent_configs.
 *
 * `tenant_agent_configs` is a PER-TENANT cloned table (it is in the `ai`
 * module's tenant `tables` set — schema-manager.service.ts). The migration
 * runner pins search_path to `ai` (the source template) and then to each
 * `tenant_<uuid>` schema, running this migration once per schema — so the table
 * name MUST be UNQUALIFIED (resolved against current_schema()). Schema-
 * qualifying it as "ai"."tenant_agent_configs" would only ever touch the source
 * template and leave every already-provisioned tenant's clone without the new
 * columns, 500-ing every chat + settings read for those tenants. Mirrors the
 * farm precedent 1801100000000-EncryptFarmWorkerPii (`const TABLE = 'farm_workers'`).
 *
 * Blue-green safe — every column is additive and either nullable or carries a
 * default:
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
const TABLE = 'tenant_agent_configs';

export class AddByokTenantAiCredentials1802000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "provider" character varying(20) NOT NULL DEFAULT 'anthropic'`,
    );
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "anthropicApiKey" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "openaiApiKey" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "chatModel" character varying(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "chatModel"`,
    );
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "openaiApiKey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "anthropicApiKey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "provider"`,
    );
  }
}
