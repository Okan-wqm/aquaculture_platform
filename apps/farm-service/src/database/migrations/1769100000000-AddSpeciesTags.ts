import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add Species Tags
 *
 * This migration adds tagging capability to species:
 * 1. Adds tags JSONB column to species table
 * 2. Creates GIN index for efficient tag queries
 * 3. Migrates existing cleaner fish to have 'cleaner-fish' tag
 *
 * Predefined tags: smolt, cleaner-fish, broodstock, fry, fingerling, grower, market-size, organic, certified
 * Custom tags are also supported.
 */
export class AddSpeciesTags1769100000000 implements MigrationInterface {
  name = 'AddSpeciesTags1769100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check current schema
    const schema = await queryRunner.query(`SELECT current_schema()`);
    console.log('Running species tags migration in schema:', schema);

    // =========================================================================
    // 1. ADD TAGS COLUMN TO SPECIES TABLE
    // =========================================================================

    const hasTagsColumn = await this.columnExists(queryRunner, 'species', 'tags');
    if (!hasTagsColumn) {
      await queryRunner.query(`
        ALTER TABLE "species"
        ADD COLUMN "tags" JSONB DEFAULT '[]'
      `);
      console.log('Added tags column to species');

      // Create GIN index for efficient tag queries
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_species_tags"
        ON "species" USING GIN ("tags")
      `);
      console.log('Created GIN index on species.tags');
    } else {
      console.log('tags column already exists, skipping');
    }

    // =========================================================================
    // 2. MIGRATE EXISTING CLEANER FISH TO HAVE TAG
    // =========================================================================

    // Update existing cleaner fish species to have 'cleaner-fish' tag
    const result = await queryRunner.query(`
      UPDATE "species"
      SET "tags" = CASE
        WHEN "tags" IS NULL THEN '["cleaner-fish"]'::jsonb
        WHEN NOT ("tags" ? 'cleaner-fish') THEN "tags" || '["cleaner-fish"]'::jsonb
        ELSE "tags"
      END
      WHERE "isCleanerFish" = true
      RETURNING id, "commonName"
    `);

    if (result && result.length > 0) {
      console.log(`Updated ${result.length} cleaner fish species with 'cleaner-fish' tag`);
    } else {
      console.log('No cleaner fish species to update');
    }

    console.log('Species tags migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index first
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_species_tags"`);

    // Remove tags column
    const hasTagsColumn = await this.columnExists(queryRunner, 'species', 'tags');
    if (hasTagsColumn) {
      await queryRunner.query(`ALTER TABLE "species" DROP COLUMN "tags"`);
    }

    console.log('Species tags migration rollback completed');
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
