import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  columnExists,
} from '@aquaculture/backend-common/database';

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
 *
 * # Bootstrap-restoration guard (Wave 4-A.2 Dalga 3)
 *
 * The cleaner-fish backfill executes `UPDATE ... WHERE "isCleanerFish" = true`.
 * `species.isCleanerFish` was created by an early migration that has since
 * been squashed; the Wave 2-A baseline now creates the column directly. On
 * legacy DBs the column still exists and the UPDATE behaves identically; on
 * fresh DBs whose baseline already sets the canonical shape, the column may
 * be present or absent depending on baseline timing — guarding the UPDATE
 * with `columnExists` keeps the migration idempotent in both worlds and
 * skips the no-op cleanly when the column was never created on this DB.
 */
export class AddSpeciesTags1769100000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('AddSpeciesTags1769100000000');
  name = 'AddSpeciesTags1769100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check current schema
    const schema = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log('Running species tags migration in schema:', schema);

    // =========================================================================
    // 1. ADD TAGS COLUMN TO SPECIES TABLE
    // =========================================================================

    const hasTagsColumn = await columnExists(queryRunner, 'species', 'tags');
    if (!hasTagsColumn) {
      await queryRunner.query(`
        ALTER TABLE "species"
        ADD COLUMN "tags" JSONB DEFAULT '[]'
      `);
      this.logger.log('Added tags column to species');

      // Create GIN index for efficient tag queries
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_species_tags"
        ON "species" USING GIN ("tags")
      `);
      this.logger.log('Created GIN index on species.tags');
    } else {
      this.logger.log('tags column already exists, skipping');
    }

    // =========================================================================
    // 2. MIGRATE EXISTING CLEANER FISH TO HAVE TAG
    // =========================================================================

    // Update existing cleaner fish species to have 'cleaner-fish' tag.
    // Guarded with `columnExists` because `species.isCleanerFish` is
    // created by a now-squashed earlier migration; if the column never
    // landed on this DB the backfill has nothing to do.
    const hasIsCleanerFish = await columnExists(
      queryRunner,
      'species',
      'isCleanerFish',
    );

    if (hasIsCleanerFish) {
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
        this.logger.log(
          `Updated ${result.length} cleaner fish species with 'cleaner-fish' tag`,
        );
      } else {
        this.logger.log('No cleaner fish species to update');
      }
    } else {
      this.logger.log(
        'Skipping cleaner-fish backfill — species.isCleanerFish column not present on this DB (installed by sibling baseline migration; nothing to backfill)',
      );
    }

    this.logger.log('Species tags migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop index first
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_species_tags"`);

    // Remove tags column
    const hasTagsColumn = await columnExists(queryRunner, 'species', 'tags');
    if (hasTagsColumn) {
      await queryRunner.query(`ALTER TABLE "species" DROP COLUMN "tags"`);
    }

    this.logger.log('Species tags migration rollback completed');
  }
}
