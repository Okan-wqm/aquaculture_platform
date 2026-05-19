import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAdminEntitySurfaceTables1800200000000
  implements MigrationInterface
{
  name = 'CreateAdminEntitySurfaceTables1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth"."tenant_roles" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NULL,
        "code" VARCHAR(50) NULL,
        "name" VARCHAR(100) NOT NULL,
        "description" TEXT NULL,
        "permissions" JSONB NOT NULL DEFAULT '[]',
        "color" VARCHAR(20) NOT NULL DEFAULT '#6366F1',
        "icon" VARCHAR(50) NOT NULL DEFAULT 'shield',
        "level" INTEGER NOT NULL DEFAULT 50,
        "is_system" BOOLEAN NOT NULL DEFAULT false,
        "is_default" BOOLEAN NOT NULL DEFAULT false,
        "is_editable" BOOLEAN NOT NULL DEFAULT true,
        "display_order" INTEGER NOT NULL DEFAULT 0,
        "created_by" UUID NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_roles_name"
        ON "auth"."tenant_roles" ("name")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_roles_level"
        ON "auth"."tenant_roles" ("level")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_roles_is_default"
        ON "auth"."tenant_roles" ("is_default")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_roles_tenant_id"
        ON "auth"."tenant_roles" ("tenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_roles_code"
        ON "auth"."tenant_roles" ("code")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uk_tenant_roles_tenant_code"
        ON "auth"."tenant_roles" ("tenantId", "code")
        WHERE "tenantId" IS NOT NULL AND "code" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth"."tenant_role_permissions" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "role_id" UUID NOT NULL,
        "panel_permissions" JSONB NOT NULL DEFAULT '{}',
        "resource_permissions" TEXT[] NOT NULL DEFAULT '{}',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "fk_tenant_role_permissions_role"
          FOREIGN KEY ("role_id") REFERENCES "auth"."tenant_roles"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth"."user_role_assignments" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "user_id" UUID NOT NULL,
        "role_id" UUID NOT NULL,
        "permission_overrides" JSONB NOT NULL DEFAULT '{"grants":[],"revokes":[]}',
        "assigned_by" UUID NOT NULL,
        "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMPTZ NULL,
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "fk_user_role_assignments_role"
          FOREIGN KEY ("role_id") REFERENCES "auth"."tenant_roles"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_role_assignments_user_id"
        ON "auth"."user_role_assignments" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_user_role_assignments_role_id"
        ON "auth"."user_role_assignments" ("role_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_user_role_assignments_is_active"
        ON "auth"."user_role_assignments" ("is_active")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth"."tenant_invitations" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "email" VARCHAR(255) NOT NULL,
        "token" VARCHAR(100) NOT NULL UNIQUE,
        "role" VARCHAR(50) NOT NULL,
        "invitedBy" VARCHAR(100) NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "accepted" BOOLEAN NOT NULL DEFAULT false,
        "acceptedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_invitations_email_tenant"
        ON "auth"."tenant_invitations" ("email", "tenantId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_invitations_token"
        ON "auth"."tenant_invitations" ("token")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_invitations_expires_at"
        ON "auth"."tenant_invitations" ("expiresAt")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."module_pricing" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "moduleId" UUID NOT NULL,
        "moduleCode" VARCHAR(50) NOT NULL,
        "pricingMetrics" JSONB NOT NULL DEFAULT '[]',
        "tierMultipliers" JSONB NOT NULL DEFAULT '{}',
        "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
        "effectiveFrom" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "effectiveTo" TIMESTAMPTZ NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "notes" TEXT NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "createdBy" UUID NULL,
        "updatedBy" UUID NULL,
        CONSTRAINT "uk_module_pricing_module_effective"
          UNIQUE ("moduleId", "effectiveFrom")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_module_pricing_module_id"
        ON "admin"."module_pricing" ("moduleId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_module_pricing_is_active"
        ON "admin"."module_pricing" ("isActive")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_module_pricing_effective_from"
        ON "admin"."module_pricing" ("effectiveFrom")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."analytics_snapshots" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "snapshotType" VARCHAR(20) NOT NULL,
        "category" VARCHAR(20) NOT NULL,
        "snapshotDate" DATE NOT NULL,
        "metrics" JSONB NOT NULL,
        "metadata" JSONB NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_analytics_snapshots_category_type_date"
        ON "admin"."analytics_snapshots" ("category", "snapshotType", "snapshotDate")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."report_definitions" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "name" VARCHAR(200) NOT NULL,
        "description" TEXT NULL,
        "type" VARCHAR(50) NOT NULL,
        "defaultFormat" VARCHAR(20) NOT NULL DEFAULT 'json',
        "status" VARCHAR(20) NOT NULL DEFAULT 'active',
        "schedule" VARCHAR(20) NOT NULL DEFAULT 'manual',
        "defaultFilters" JSONB NULL,
        "recipients" JSONB NULL,
        "includeCharts" BOOLEAN NOT NULL DEFAULT false,
        "createdBy" UUID NULL,
        "createdByEmail" VARCHAR(255) NULL,
        "lastRunAt" TIMESTAMPTZ NULL,
        "runCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_report_definitions_created_by"
        ON "admin"."report_definitions" ("createdBy")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_report_definitions_status"
        ON "admin"."report_definitions" ("status")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."report_executions" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "definitionId" UUID NULL,
        "reportName" VARCHAR(200) NOT NULL,
        "reportType" VARCHAR(50) NOT NULL,
        "format" VARCHAR(20) NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
        "startDate" TIMESTAMPTZ NULL,
        "endDate" TIMESTAMPTZ NULL,
        "filters" JSONB NULL,
        "summary" JSONB NULL,
        "rowCount" INTEGER NULL,
        "fileSizeBytes" INTEGER NULL,
        "downloadUrl" VARCHAR(500) NULL,
        "downloadExpiresAt" TIMESTAMPTZ NULL,
        "errorMessage" TEXT NULL,
        "durationMs" INTEGER NULL,
        "executedBy" UUID NULL,
        "executedByEmail" VARCHAR(255) NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMPTZ NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_report_executions_definition_id"
        ON "admin"."report_executions" ("definitionId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_report_executions_status"
        ON "admin"."report_executions" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_report_executions_created_at"
        ON "admin"."report_executions" ("createdAt")
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only repair: these tables may already exist in deployed databases.
  }
}
