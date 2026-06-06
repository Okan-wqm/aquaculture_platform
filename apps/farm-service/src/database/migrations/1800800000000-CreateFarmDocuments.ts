import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const FARM_DOCUMENT_TABLE = 'farm_documents';

export class CreateFarmDocuments1800800000000 implements MigrationInterface {
  name = 'CreateFarmDocuments1800800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureEnums(queryRunner);
    await this.ensureTable(queryRunner);
    await this.ensureIndexes(queryRunner);

    await applyTenantRlsToSchema(queryRunner, {
      includeTables: [FARM_DOCUMENT_TABLE],
      tenantIdColumns: ['tenantId'],
    });
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.farm_documents') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'farm_documents'
            AND column_name = 'legalHold'
        )
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'farm_documents'
            AND column_name = 'retentionUntil'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'uq_farm_documents_tenant_object'
        )
        AND EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname = 'farm_documents'
            AND c.relrowsecurity = true
            AND c.relforcerowsecurity = true
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only SSOT migration. Rollback is application deploy rollback
    // plus restore rehearsal; do not drop canonical document metadata.
  }

  private async ensureEnums(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE farm_documents_state_enum AS ENUM (
          'PENDING_UPLOAD',
          'UPLOADED_UNVERIFIED',
          'ACTIVE',
          'QUARANTINED',
          'DELETE_PENDING',
          'DELETED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE farm_documents_owner_type_enum AS ENUM (
          'CHEMICAL',
          'FEED',
          'BATCH',
          'SITE',
          'SUPPLIER',
          'EQUIPMENT',
          'TANK',
          'WORKER',
          'SENTINEL_SETTINGS',
          'OTHER'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE farm_documents_scan_state_enum AS ENUM (
          'NOT_REQUIRED',
          'PENDING',
          'PASSED',
          'FAILED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  private async ensureTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm_documents (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "ownerType" farm_documents_owner_type_enum NOT NULL,
        "ownerId" UUID NOT NULL,
        "documentName" VARCHAR(255) NOT NULL,
        "documentType" VARCHAR(80) NOT NULL,
        "description" TEXT NULL,
        "state" farm_documents_state_enum NOT NULL DEFAULT 'PENDING_UPLOAD',
        "scanState" farm_documents_scan_state_enum NOT NULL DEFAULT 'PENDING',
        "bucket" VARCHAR(120) NOT NULL,
        "objectKey" VARCHAR(1024) NOT NULL,
        "originalFilename" VARCHAR(255) NULL,
        "mimeType" VARCHAR(160) NULL,
        "fileSizeBytes" INTEGER NULL,
        "checksumSha256" VARCHAR(128) NULL,
        "etag" VARCHAR(255) NULL,
        "uploadExpiresAt" TIMESTAMPTZ NULL,
        "uploadedAt" TIMESTAMPTZ NULL,
        "uploadedBy" UUID NULL,
        "stateChangedAt" TIMESTAMPTZ NULL DEFAULT now(),
        "metadata" JSONB NULL,
        "retentionUntil" TIMESTAMPTZ NULL,
        "legalHold" BOOLEAN NOT NULL DEFAULT false,
        "legalHoldReason" TEXT NULL,
        "deleteRequestedAt" TIMESTAMPTZ NULL,
        "deleteRequestedBy" UUID NULL,
        "deletedAt" TIMESTAMPTZ NULL,
        "deletedBy" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "createdBy" UUID NULL,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedBy" UUID NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        CONSTRAINT "ck_farm_documents_file_size_positive"
          CHECK ("fileSizeBytes" IS NULL OR "fileSizeBytes" > 0),
        CONSTRAINT "ck_farm_documents_uploaded_state_has_upload"
          CHECK (
            "state" IN ('PENDING_UPLOAD')
            OR "uploadedAt" IS NOT NULL
          ),
        CONSTRAINT "ck_farm_documents_delete_pending_has_request"
          CHECK (
            "state" <> 'DELETE_PENDING'
            OR "deleteRequestedAt" IS NOT NULL
          ),
        CONSTRAINT "ck_farm_documents_deleted_has_deleted_at"
          CHECK (
            "state" <> 'DELETED'
            OR "deletedAt" IS NOT NULL
          )
      )
    `);
  }

  private async ensureIndexes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_farm_documents_tenant_object"
        ON farm_documents ("tenantId", "bucket", "objectKey")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_farm_documents_tenant_owner"
        ON farm_documents ("tenantId", "ownerType", "ownerId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_farm_documents_tenant_state"
        ON farm_documents ("tenantId", "state")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_farm_documents_tenant_scan_state"
        ON farm_documents ("tenantId", "scanState")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_farm_documents_tenant_type"
        ON farm_documents ("tenantId", "documentType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_farm_documents_retention"
        ON farm_documents ("tenantId", "retentionUntil")
        WHERE "retentionUntil" IS NOT NULL AND "legalHold" = false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_farm_documents_legal_hold"
        ON farm_documents ("tenantId", "legalHold")
        WHERE "legalHold" = true
    `);
  }
}
