import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * Migration: Add min_fish_weight_g column to feeds table
 *
 * Adds the minimum fish weight (in grams) field to the feeds table.
 * This allows each feed to specify the minimum recommended fish weight.
 */
export class AddFeedMinFishWeight1770000000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('AddFeedMinFishWeight1770000000000');
  name = 'AddFeedMinFishWeight1770000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log('Running AddFeedMinFishWeight migration in schema:', schema);

    const hasColumn = await this.columnExists(queryRunner, 'feeds', 'min_fish_weight_g');
    if (!hasColumn) {
      await queryRunner.query(`
        ALTER TABLE "feeds"
        ADD COLUMN "min_fish_weight_g" DECIMAL(10, 2) DEFAULT NULL
      `);
      this.logger.log('Added min_fish_weight_g column to feeds');
    } else {
      this.logger.log('min_fish_weight_g column already exists, skipping');
    }

    this.logger.log('AddFeedMinFishWeight migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await this.columnExists(queryRunner, 'feeds', 'min_fish_weight_g');
    if (hasColumn) {
      await queryRunner.query(`ALTER TABLE "feeds" DROP COLUMN "min_fish_weight_g"`);
    }
    this.logger.log('AddFeedMinFishWeight migration rollback completed');
  }

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
