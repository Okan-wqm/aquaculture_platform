import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add Batch Documents Support
 *
 * This migration adds:
 * 1. arrival_method enum and column to batches_v2 table
 * 2. batch_document_type enum
 * 3. batch_documents table for storing document metadata
 *
 * Documents are stored in MinIO, this table stores metadata.
 */
export class AddBatchDocuments1734500000000 implements MigrationInterface {
  name = 'AddBatchDocuments1734500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if we're running in the correct schema
    const schema = await queryRunner.query(`SELECT current_schema()`);
    console.log('Running migration in schema:', schema);

    // 1. Create arrival_method enum if not exists
    const arrivalMethodEnumExists = await this.enumExists(queryRunner, 'arrival_method_enum');
    if (!arrivalMethodEnumExists) {
      await queryRunner.query(`
        CREATE TYPE "arrival_method_enum" AS ENUM (
          'air_cargo',
          'truck',
          'boat',
          'rail',
          'local_pickup',
          'other'
        )
      `);
      console.log('Created arrival_method_enum');
    } else {
      console.log('arrival_method_enum already exists, skipping');
    }

    // 2. Add arrivalMethod column to batches_v2 table
    const hasArrivalMethodCol = await this.columnExists(queryRunner, 'batches_v2', 'arrivalMethod');
    if (!hasArrivalMethodCol) {
      await queryRunner.query(`
        ALTER TABLE "batches_v2"
        ADD COLUMN "arrivalMethod" "arrival_method_enum"
      `);
      console.log('Added arrivalMethod column to batches_v2');
    } else {
      console.log('arrivalMethod already exists in batches_v2, skipping');
    }

    // 3. Create batch_document_type enum if not exists
    const batchDocTypeEnumExists = await this.enumExists(queryRunner, 'batch_document_type_enum');
    if (!batchDocTypeEnumExists) {
      await queryRunner.query(`
        CREATE TYPE "batch_document_type_enum" AS ENUM (
          'health_certificate',
          'import_document',
          'origin_certificate',
          'quarantine_permit',
          'transport_document',
          'veterinary_certificate',
          'customs_declaration',
          'other'
        )
      `);
      console.log('Created batch_document_type_enum');
    } else {
      console.log('batch_document_type_enum already exists, skipping');
    }

    // 4. Create batch_documents table if not exists
    const tableExists = await this.tableExists(queryRunner, 'batch_documents');
    if (!tableExists) {
      await queryRunner.query(`
        CREATE TABLE "batch_documents" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "tenantId" uuid NOT NULL,
          "batchId" uuid NOT NULL,
          "documentType" "batch_document_type_enum" NOT NULL,
          "documentName" varchar(255) NOT NULL,
          "documentNumber" varchar(255),
          "storagePath" varchar(500) NOT NULL,
          "storageUrl" varchar(500) NOT NULL,
          "originalFilename" varchar(255) NOT NULL,
          "mimeType" varchar(100) NOT NULL,
          "fileSize" int NOT NULL,
          "issueDate" date,
          "expiryDate" date,
          "issuingAuthority" varchar(255),
          "notes" text,
          "isActive" boolean NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "createdBy" uuid,
          CONSTRAINT "PK_batch_documents" PRIMARY KEY ("id")
        )
      `);
      console.log('Created batch_documents table');

      // Add foreign key to batches_v2
      await queryRunner.query(`
        ALTER TABLE "batch_documents"
        ADD CONSTRAINT "FK_batch_documents_batch"
        FOREIGN KEY ("batchId")
        REFERENCES "batches_v2"("id")
        ON DELETE CASCADE
      `);
      console.log('Added foreign key FK_batch_documents_batch');

      // Create indexes
      await queryRunner.query(`
        CREATE INDEX "IDX_batch_documents_tenant_batch"
        ON "batch_documents" ("tenantId", "batchId")
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_batch_documents_tenant_type"
        ON "batch_documents" ("tenantId", "documentType")
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_batch_documents_tenantId"
        ON "batch_documents" ("tenantId")
      `);

      await queryRunner.query(`
        CREATE INDEX "IDX_batch_documents_batchId"
        ON "batch_documents" ("batchId")
      `);

      console.log('Created indexes for batch_documents');
    } else {
      console.log('batch_documents table already exists, skipping');
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop batch_documents table and its constraints
    const tableExists = await this.tableExists(queryRunner, 'batch_documents');
    if (tableExists) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_batch_documents_batchId"`);
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_batch_documents_tenantId"`);
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_batch_documents_tenant_type"`);
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_batch_documents_tenant_batch"`);
      await queryRunner.query(`ALTER TABLE "batch_documents" DROP CONSTRAINT IF EXISTS "FK_batch_documents_batch"`);
      await queryRunner.query(`DROP TABLE "batch_documents"`);
      console.log('Dropped batch_documents table');
    }

    // 2. Drop batch_document_type enum
    const batchDocTypeEnumExists = await this.enumExists(queryRunner, 'batch_document_type_enum');
    if (batchDocTypeEnumExists) {
      await queryRunner.query(`DROP TYPE "batch_document_type_enum"`);
      console.log('Dropped batch_document_type_enum');
    }

    // 3. Drop arrivalMethod column from batches_v2
    const hasArrivalMethodCol = await this.columnExists(queryRunner, 'batches_v2', 'arrivalMethod');
    if (hasArrivalMethodCol) {
      await queryRunner.query(`ALTER TABLE "batches_v2" DROP COLUMN "arrivalMethod"`);
      console.log('Dropped arrivalMethod column from batches_v2');
    }

    // 4. Drop arrival_method enum
    const arrivalMethodEnumExists = await this.enumExists(queryRunner, 'arrival_method_enum');
    if (arrivalMethodEnumExists) {
      await queryRunner.query(`DROP TYPE "arrival_method_enum"`);
      console.log('Dropped arrival_method_enum');
    }
  }

  /**
   * Helper to check if an enum type exists
   */
  private async enumExists(
    queryRunner: QueryRunner,
    enumName: string
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_type
        WHERE typname = $1
      )
    `, [enumName]);
    return result[0]?.exists === true;
  }

  /**
   * Helper to check if a column exists
   */
  private async columnExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1
        AND column_name = $2
      )
    `, [tableName, columnName]);
    return result[0]?.exists === true;
  }

  /**
   * Helper to check if a table exists
   */
  private async tableExists(
    queryRunner: QueryRunner,
    tableName: string
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = $1
      )
    `, [tableName]);
    return result[0]?.exists === true;
  }
}
