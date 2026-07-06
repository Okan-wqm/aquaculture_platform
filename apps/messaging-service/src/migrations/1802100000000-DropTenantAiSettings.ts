import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop `tenant_ai_settings` — the duplicate tenant-level AI "enabled" master
 * switch. ai-service is now the single source of truth for tenant AI enablement
 * (`request.ai.isEnabled`, driven by `TenantAgentConfig.isEnabled` AND a valid
 * provider key). Messaging's `AiPrivacyService.isTenantAiEnabled` queries
 * ai-service over NATS instead of this local flag, so the table is unread as of
 * this release (the entity, the `updateTenantAiSetting` mutation, and
 * `setTenantAiEnabled` are all removed in the same change).
 *
 * `tenant_ai_settings` is a PER-TENANT cloned table (messaging module tenant
 * set — schema-manager.service.ts). The runner pins search_path to `messaging`
 * (source template) and then to each `tenant_<uuid>` schema, so the name MUST be
 * UNQUALIFIED (resolved against current_schema()) or the DROP only touches the
 * template and every tenant keeps the table forever. Mirrors the channels
 * precedent 1802000000000-DropChannelAiServiceUrl.
 *
 * Safe drop: old pods fail closed (AI shown disabled) during the brief rollout
 * window if they read a dropped table. down() recreates the table shape only —
 * the enablement values are authoritative in ai-service and are not recovered.
 */
const TABLE = 'tenant_ai_settings';

export class DropTenantAiSettings1802100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "${TABLE}"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "${TABLE}" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "aiEnabled" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_${TABLE}" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_${TABLE}_tenantId" UNIQUE ("tenantId")
      )`,
    );
  }
}
