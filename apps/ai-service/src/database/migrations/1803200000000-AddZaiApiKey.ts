/**
 * MSGFIX-ZAI (2026-09-17): add the Z.ai (Zhipu GLM) BYOK key column.
 *
 * Mirrors 1802000000000-AddByokTenantAiCredentials: the table is unqualified
 * (resolved against current_schema()) because db-migrate runs this migration
 * once per schema — the source `ai` schema and every tenant clone (the table
 * is in the schema-manager's tenant tables set). Additive + nullable + IF NOT
 * EXISTS: a key is legitimately absent until a tenant enters one, and
 * re-running against a schema that already has the column is a no-op.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'tenant_agent_configs';

export class AddZaiApiKey1803200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "zaiApiKey" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "zaiApiKey"`);
  }
}
