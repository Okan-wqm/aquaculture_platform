import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * Creates compliance-related tables for the messaging service:
 * - retention_policies: per-tenant and per-channel message retention rules
 * - legal_holds: freezes data deletion for compliance/legal requirements
 * - compliance_audit_log: immutable audit trail for all compliance actions
 * - tenant_ai_settings: per-tenant AI feature configuration
 * - user_ai_consents: tracks user consent for AI features (GDPR)
 *
 * All tables are schema-qualified using the current search_path so they
 * are created in the correct schema (messaging or tenant_*).
 *
 * @see ADR-012 Phase 3 (Compliance & Governance)
 */
export class CreateComplianceTables1711800000003 implements MigrationInterface {
  private readonly logger = new MigrationLogger('CreateComplianceTables1711800000003');
  name = 'CreateComplianceTables1711800000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Determine which schema we are operating in (messaging or tenant_*)
    const [{ current_schema }] = await queryRunner.query(
      'SELECT current_schema()',
    );
    const s = current_schema;

    // ── retention_policies ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."retention_policies" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "channelId" UUID,
        "retentionDays" INTEGER NOT NULL DEFAULT 365,
        "createdBy" UUID NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_retention_tenant_channel" UNIQUE ("tenantId", "channelId")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_retention_policies_tenant"
        ON "${s}"."retention_policies" ("tenantId");
    `);

    // ── legal_holds ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."legal_holds" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "channelId" UUID,
        "reason" TEXT NOT NULL,
        "startedBy" UUID NOT NULL,
        "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "releasedBy" UUID,
        "releasedAt" TIMESTAMPTZ,
        "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_legal_holds_tenant_active"
        ON "${s}"."legal_holds" ("tenantId", "isActive")
        WHERE "isActive" = TRUE;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_legal_holds_channel"
        ON "${s}"."legal_holds" ("channelId")
        WHERE "channelId" IS NOT NULL AND "isActive" = TRUE;
    `);

    // ── compliance_audit_log ─────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."compliance_audit_log" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "userId" UUID NOT NULL,
        "action" VARCHAR(30) NOT NULL,
        "resourceType" VARCHAR(50) NOT NULL,
        "resourceId" UUID NOT NULL,
        "details" JSONB,
        "ipAddress" VARCHAR(45),
        "userAgent" VARCHAR(512),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_compliance_audit_tenant_date"
        ON "${s}"."compliance_audit_log" ("tenantId", "createdAt" DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_compliance_audit_action"
        ON "${s}"."compliance_audit_log" ("action");
    `);

    // ── tenant_ai_settings ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."tenant_ai_settings" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
      CREATE TABLE IF NOT EXISTS "${s}"."user_ai_consents" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL,
        "userId" UUID NOT NULL,
        "consentGiven" BOOLEAN NOT NULL DEFAULT FALSE,
        "consentVersion" VARCHAR(20) NOT NULL DEFAULT '1.0',
        "givenAt" TIMESTAMPTZ,
        "revokedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_user_ai_consent" UNIQUE ("tenantId", "userId")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_user_ai_consents_tenant"
        ON "${s}"."user_ai_consents" ("tenantId");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ current_schema }] = await queryRunner.query(
      'SELECT current_schema()',
    );
    const s = current_schema;

    await queryRunner.query(`DROP TABLE IF EXISTS "${s}"."user_ai_consents" CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${s}"."tenant_ai_settings" CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${s}"."compliance_audit_log" CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${s}"."legal_holds" CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${s}"."retention_policies" CASCADE;`);
  }
}
