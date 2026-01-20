import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add Cleaner Fish Support
 *
 * This migration adds cleaner fish (lumpfish, wrasse) tracking capabilities:
 * 1. Species table: isCleanerFish flag, cleanerFishType
 * 2. Batches table: batchType enum (production, cleaner_fish), sourceType, sourceLocation
 * 3. TankBatch table: cleanerFishQuantity, cleanerFishBiomassKg, cleanerFishDetails JSONB
 * 4. TankOperation table: cleaner fish operation types, isCleanerFishOperation, cleanerSpeciesName
 * 5. Seed data for cleaner fish species (Lumpfish, Ballan/Corkwing/Goldsinny Wrasse)
 */
export class AddCleanerFishSupport1768500000000 implements MigrationInterface {
  name = 'AddCleanerFishSupport1768500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check current schema
    const schema = await queryRunner.query(`SELECT current_schema()`);
    console.log('Running cleaner fish migration in schema:', schema);

    // =========================================================================
    // 1. SPECIES TABLE UPDATES
    // =========================================================================

    // Add isCleanerFish column
    const hasIsCleanerFish = await this.columnExists(queryRunner, 'species', 'isCleanerFish');
    if (!hasIsCleanerFish) {
      await queryRunner.query(`
        ALTER TABLE "species"
        ADD COLUMN "isCleanerFish" BOOLEAN NOT NULL DEFAULT false
      `);
      console.log('Added isCleanerFish column to species');

      // Create index
      await queryRunner.query(`
        CREATE INDEX "IDX_species_tenantId_isCleanerFish"
        ON "species" ("tenantId", "isCleanerFish")
      `);
      console.log('Created index on species.isCleanerFish');
    } else {
      console.log('isCleanerFish column already exists, skipping');
    }

    // Add cleanerFishType column
    const hasCleanerFishType = await this.columnExists(queryRunner, 'species', 'cleanerFishType');
    if (!hasCleanerFishType) {
      await queryRunner.query(`
        ALTER TABLE "species"
        ADD COLUMN "cleanerFishType" VARCHAR(50)
      `);
      console.log('Added cleanerFishType column to species');
    } else {
      console.log('cleanerFishType column already exists, skipping');
    }

    // =========================================================================
    // 2. BATCHES TABLE UPDATES
    // =========================================================================

    // Create batch_type enum
    const batchTypeEnumExists = await this.enumExists(queryRunner, 'batch_type_enum');
    if (!batchTypeEnumExists) {
      await queryRunner.query(`
        CREATE TYPE "batch_type_enum" AS ENUM ('production', 'cleaner_fish')
      `);
      console.log('Created batch_type_enum');
    } else {
      console.log('batch_type_enum already exists, skipping');
    }

    // Add batchType column
    const hasBatchType = await this.columnExists(queryRunner, 'batches_v2', 'batchType');
    if (!hasBatchType) {
      await queryRunner.query(`
        ALTER TABLE "batches_v2"
        ADD COLUMN "batchType" "batch_type_enum" NOT NULL DEFAULT 'production'
      `);
      console.log('Added batchType column to batches_v2');

      // Create index
      await queryRunner.query(`
        CREATE INDEX "IDX_batches_tenantId_batchType"
        ON "batches_v2" ("tenantId", "batchType")
      `);
      console.log('Created index on batches_v2.batchType');
    } else {
      console.log('batchType column already exists, skipping');
    }

    // Add sourceType column
    const hasSourceType = await this.columnExists(queryRunner, 'batches_v2', 'sourceType');
    if (!hasSourceType) {
      await queryRunner.query(`
        ALTER TABLE "batches_v2"
        ADD COLUMN "sourceType" VARCHAR(50)
      `);
      console.log('Added sourceType column to batches_v2');
    } else {
      console.log('sourceType column already exists, skipping');
    }

    // Add sourceLocation column
    const hasSourceLocation = await this.columnExists(queryRunner, 'batches_v2', 'sourceLocation');
    if (!hasSourceLocation) {
      await queryRunner.query(`
        ALTER TABLE "batches_v2"
        ADD COLUMN "sourceLocation" TEXT
      `);
      console.log('Added sourceLocation column to batches_v2');
    } else {
      console.log('sourceLocation column already exists, skipping');
    }

    // =========================================================================
    // 3. TANK_BATCHES TABLE UPDATES
    // =========================================================================

    // Add cleanerFishQuantity column
    const hasCleanerFishQty = await this.columnExists(queryRunner, 'tank_batches', 'cleanerFishQuantity');
    if (!hasCleanerFishQty) {
      await queryRunner.query(`
        ALTER TABLE "tank_batches"
        ADD COLUMN "cleanerFishQuantity" INTEGER NOT NULL DEFAULT 0
      `);
      console.log('Added cleanerFishQuantity column to tank_batches');
    } else {
      console.log('cleanerFishQuantity column already exists, skipping');
    }

    // Add cleanerFishBiomassKg column
    const hasCleanerFishBiomass = await this.columnExists(queryRunner, 'tank_batches', 'cleanerFishBiomassKg');
    if (!hasCleanerFishBiomass) {
      await queryRunner.query(`
        ALTER TABLE "tank_batches"
        ADD COLUMN "cleanerFishBiomassKg" DECIMAL(10,2) NOT NULL DEFAULT 0
      `);
      console.log('Added cleanerFishBiomassKg column to tank_batches');
    } else {
      console.log('cleanerFishBiomassKg column already exists, skipping');
    }

    // Add cleanerFishDetails JSONB column
    const hasCleanerFishDetails = await this.columnExists(queryRunner, 'tank_batches', 'cleanerFishDetails');
    if (!hasCleanerFishDetails) {
      await queryRunner.query(`
        ALTER TABLE "tank_batches"
        ADD COLUMN "cleanerFishDetails" JSONB
      `);
      console.log('Added cleanerFishDetails column to tank_batches');
    } else {
      console.log('cleanerFishDetails column already exists, skipping');
    }

    // =========================================================================
    // 4. TANK_OPERATIONS TABLE UPDATES
    // =========================================================================

    // Add cleaner fish operation types to operation_type enum
    // Note: PostgreSQL doesn't allow IF NOT EXISTS for ALTER TYPE ADD VALUE
    // We need to check manually first
    const operationTypeEnumValues = await this.getEnumValues(queryRunner, 'operation_type_enum');

    const cleanerOpTypes = [
      'cleaner_deployment',
      'cleaner_mortality',
      'cleaner_removal',
      'cleaner_transfer_out',
      'cleaner_transfer_in',
    ];

    for (const opType of cleanerOpTypes) {
      if (!operationTypeEnumValues.includes(opType)) {
        await queryRunner.query(`
          ALTER TYPE "operation_type_enum" ADD VALUE '${opType}'
        `);
        console.log(`Added ${opType} to operation_type_enum`);
      } else {
        console.log(`${opType} already exists in operation_type_enum, skipping`);
      }
    }

    // Add isCleanerFishOperation column
    const hasIsCleanerFishOp = await this.columnExists(queryRunner, 'tank_operations', 'isCleanerFishOperation');
    if (!hasIsCleanerFishOp) {
      await queryRunner.query(`
        ALTER TABLE "tank_operations"
        ADD COLUMN "isCleanerFishOperation" BOOLEAN NOT NULL DEFAULT false
      `);
      console.log('Added isCleanerFishOperation column to tank_operations');
    } else {
      console.log('isCleanerFishOperation column already exists, skipping');
    }

    // Add cleanerSpeciesName column
    const hasCleanerSpeciesName = await this.columnExists(queryRunner, 'tank_operations', 'cleanerSpeciesName');
    if (!hasCleanerSpeciesName) {
      await queryRunner.query(`
        ALTER TABLE "tank_operations"
        ADD COLUMN "cleanerSpeciesName" VARCHAR(100)
      `);
      console.log('Added cleanerSpeciesName column to tank_operations');
    } else {
      console.log('cleanerSpeciesName column already exists, skipping');
    }

    // Add cleanerBatchId column
    const hasCleanerBatchId = await this.columnExists(queryRunner, 'tank_operations', 'cleanerBatchId');
    if (!hasCleanerBatchId) {
      await queryRunner.query(`
        ALTER TABLE "tank_operations"
        ADD COLUMN "cleanerBatchId" UUID
      `);
      console.log('Added cleanerBatchId column to tank_operations');
    } else {
      console.log('cleanerBatchId column already exists, skipping');
    }

    // =========================================================================
    // 5. SEED CLEANER FISH SPECIES (Global/Template species)
    // =========================================================================
    // Note: These are seed species that will be copied to tenant schemas
    // tenantId of all-zeros represents global/template data

    const globalTenantId = '00000000-0000-0000-0000-000000000000';

    // Check if cleaner fish species already exist
    const existingCleanerFish = await queryRunner.query(`
      SELECT COUNT(*) as count FROM "species"
      WHERE "isCleanerFish" = true AND "tenantId" = $1
    `, [globalTenantId]);

    if (parseInt(existingCleanerFish[0]?.count || '0') === 0) {
      // Insert cleaner fish species
      await queryRunner.query(`
        INSERT INTO "species" (
          "id", "tenantId", "scientificName", "commonName", "localName", "code",
          "category", "waterType", "isCleanerFish", "cleanerFishType", "status", "isActive",
          "createdAt", "updatedAt", "isDeleted"
        ) VALUES
        (
          gen_random_uuid(), $1, 'Cyclopterus lumpus', 'Lumpfish', 'Rognkjeks', 'LUMPFISH',
          'fish', 'saltwater', true, 'lumpfish', 'active', true,
          NOW(), NOW(), false
        ),
        (
          gen_random_uuid(), $1, 'Labrus bergylta', 'Ballan Wrasse', 'Berggylt', 'BALLAN',
          'fish', 'saltwater', true, 'wrasse', 'active', true,
          NOW(), NOW(), false
        ),
        (
          gen_random_uuid(), $1, 'Symphodus melops', 'Corkwing Wrasse', 'Grønngylt', 'CORKWING',
          'fish', 'saltwater', true, 'wrasse', 'active', true,
          NOW(), NOW(), false
        ),
        (
          gen_random_uuid(), $1, 'Ctenolabrus rupestris', 'Goldsinny Wrasse', 'Bergnebb', 'GOLDSINNY',
          'fish', 'saltwater', true, 'wrasse', 'active', true,
          NOW(), NOW(), false
        )
        ON CONFLICT DO NOTHING
      `, [globalTenantId]);
      console.log('Inserted cleaner fish species seed data');
    } else {
      console.log('Cleaner fish species already exist, skipping seed data');
    }

    console.log('Cleaner fish migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Note: We don't remove enum values in PostgreSQL as it's complex and risky
    // We'll only remove the columns

    // 1. Remove tank_operations columns
    const hasCleanerBatchId = await this.columnExists(queryRunner, 'tank_operations', 'cleanerBatchId');
    if (hasCleanerBatchId) {
      await queryRunner.query(`ALTER TABLE "tank_operations" DROP COLUMN "cleanerBatchId"`);
    }

    const hasCleanerSpeciesName = await this.columnExists(queryRunner, 'tank_operations', 'cleanerSpeciesName');
    if (hasCleanerSpeciesName) {
      await queryRunner.query(`ALTER TABLE "tank_operations" DROP COLUMN "cleanerSpeciesName"`);
    }

    const hasIsCleanerFishOp = await this.columnExists(queryRunner, 'tank_operations', 'isCleanerFishOperation');
    if (hasIsCleanerFishOp) {
      await queryRunner.query(`ALTER TABLE "tank_operations" DROP COLUMN "isCleanerFishOperation"`);
    }

    // 2. Remove tank_batches columns
    const hasCleanerFishDetails = await this.columnExists(queryRunner, 'tank_batches', 'cleanerFishDetails');
    if (hasCleanerFishDetails) {
      await queryRunner.query(`ALTER TABLE "tank_batches" DROP COLUMN "cleanerFishDetails"`);
    }

    const hasCleanerFishBiomass = await this.columnExists(queryRunner, 'tank_batches', 'cleanerFishBiomassKg');
    if (hasCleanerFishBiomass) {
      await queryRunner.query(`ALTER TABLE "tank_batches" DROP COLUMN "cleanerFishBiomassKg"`);
    }

    const hasCleanerFishQty = await this.columnExists(queryRunner, 'tank_batches', 'cleanerFishQuantity');
    if (hasCleanerFishQty) {
      await queryRunner.query(`ALTER TABLE "tank_batches" DROP COLUMN "cleanerFishQuantity"`);
    }

    // 3. Remove batches columns
    const hasSourceLocation = await this.columnExists(queryRunner, 'batches_v2', 'sourceLocation');
    if (hasSourceLocation) {
      await queryRunner.query(`ALTER TABLE "batches_v2" DROP COLUMN "sourceLocation"`);
    }

    const hasSourceType = await this.columnExists(queryRunner, 'batches_v2', 'sourceType');
    if (hasSourceType) {
      await queryRunner.query(`ALTER TABLE "batches_v2" DROP COLUMN "sourceType"`);
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_batches_tenantId_batchType"`);

    const hasBatchType = await this.columnExists(queryRunner, 'batches_v2', 'batchType');
    if (hasBatchType) {
      await queryRunner.query(`ALTER TABLE "batches_v2" DROP COLUMN "batchType"`);
    }

    // 4. Remove species columns
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_species_tenantId_isCleanerFish"`);

    const hasCleanerFishType = await this.columnExists(queryRunner, 'species', 'cleanerFishType');
    if (hasCleanerFishType) {
      await queryRunner.query(`ALTER TABLE "species" DROP COLUMN "cleanerFishType"`);
    }

    const hasIsCleanerFish = await this.columnExists(queryRunner, 'species', 'isCleanerFish');
    if (hasIsCleanerFish) {
      await queryRunner.query(`ALTER TABLE "species" DROP COLUMN "isCleanerFish"`);
    }

    // 5. Drop batch_type enum (only if no data depends on it)
    // This might fail if there's existing data - that's intentional
    const batchTypeEnumExists = await this.enumExists(queryRunner, 'batch_type_enum');
    if (batchTypeEnumExists) {
      await queryRunner.query(`DROP TYPE "batch_type_enum"`);
    }

    console.log('Cleaner fish migration rollback completed');
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
   * Helper to get enum values
   */
  private async getEnumValues(
    queryRunner: QueryRunner,
    enumName: string
  ): Promise<string[]> {
    const result = await queryRunner.query(`
      SELECT enumlabel
      FROM pg_enum
      WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = $1)
    `, [enumName]);
    return result.map((r: any) => r.enumlabel);
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
}
