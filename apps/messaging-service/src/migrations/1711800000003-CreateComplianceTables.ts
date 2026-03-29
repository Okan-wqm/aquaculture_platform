import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates compliance-related tables for the messaging service:
 * - retention_policies: per-tenant and per-channel message retention rules
 * - legal_holds: freezes data deletion for compliance/legal requirements
 * - compliance_audit_log: immutable audit trail for all compliance actions
 * - tenant_ai_settings: per-tenant AI feature configuration
 * - user_ai_consents: tracks user consent for AI features (GDPR)
 *
 * @see ADR-012 Phase 3 (Compliance & Governance)
 */
export class CreateComplianceTables1711800000003 implements MigrationInterface {
  name = 'CreateComplianceTables1711800000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── retention_policies ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retention_policies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "channelId" UUID,
        "retentionDays" INTEGER NOT NULL DEFAULT 365,
        "createdBy" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_retention_tenant_channel UNIQUE ("tenantId", "channelId")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_retention_policies_tenant
        ON retention_policies ("tenantId");
    `);

    // ── legal_holds ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS legal_holds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "channelId" UUID,
        reason TEXT NOT NULL,
        "activatedBy" UUID NOT NULL,
        "activatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "releasedBy" UUID,
        "releasedAt" TIMESTAMPTZ,
        "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_legal_holds_tenant_active
        ON legal_holds ("tenantId", "isActive")
        WHERE "isActive" = TRUE;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_legal_holds_channel
        ON legal_holds ("channelId")
        WHERE "channelId" IS NOT NULL AND "isActive" = TRUE;
    `);

    // ── compliance_audit_log ─────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS compliance_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "userId" UUID NOT NULL,
        action VARCHAR(100) NOT NULL,
        "resourceType" VARCHAR(50) NOT NULL,
        "resourceId" UUID NOT NULL,
        details JSONB,
        "ipAddress" VARCHAR(45),
        "userAgent" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_audit_tenant_date
        ON compliance_audit_log ("tenantId", "createdAt" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_audit_action
        ON compliance_audit_log (action);
    `);

    // ── tenant_ai_settings ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tenant_ai_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL UNIQUE,
        "aiEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
        "allowedPersonas" TEXT[] DEFAULT '{}',
        "maxAiChannelsPerUser" INTEGER NOT NULL DEFAULT 3,
        "dataRetentionDays" INTEGER NOT NULL DEFAULT 90,
        "consentRequired" BOOLEAN NOT NULL DEFAULT TRUE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── user_ai_consents ─────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_ai_consents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "userId" UUID NOT NULL,
        "consentGiven" BOOLEAN NOT NULL DEFAULT FALSE,
        "consentVersion" VARCHAR(20) NOT NULL DEFAULT '1.0',
        "givenAt" TIMESTAMPTZ,
        "revokedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_user_ai_consent UNIQUE ("tenantId", "userId")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_user_ai_consents_tenant
        ON user_ai_consents ("tenantId");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS user_ai_consents CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS tenant_ai_settings CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS compliance_audit_log CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS legal_holds CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS retention_policies CASCADE;`);
  }
}
