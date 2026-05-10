import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  columnExists,
  tableExists,
} from '@aquaculture/backend-common/database';

/**
 * Migration: Add min_fish_weight_g column to feeds table
 *
 * Adds the minimum fish weight (in grams) field to the feeds table.
 * This allows each feed to specify the minimum recommended fish weight.
 *
 * # Bootstrap-restoration guard (Wave 4-A.2 Dalga 3)
 *
 * The whole body is wrapped in `tableExists(queryRunner, 'feeds')` because
 * `feeds` is created by a CREATE TABLE in the source-schema baseline; on
 * tenant fan-out the tenant copies are produced via `CREATE TABLE LIKE`,
 * but a fresh-volume bootstrap that runs this migration before the baseline
 * has produced the tenant copy would crash on `relation "feeds" does not
 * exist`. The guard keeps the migration a no-op until the table is in place.
 */
export class AddFeedMinFishWeight1770000000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('AddFeedMinFishWeight1770000000000');
  name = 'AddFeedMinFishWeight1770000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log('Running AddFeedMinFishWeight migration in schema:', schema);

    if (!(await tableExists(queryRunner, 'feeds'))) {
      this.logger.log(
        'Skipping AddFeedMinFishWeight — feeds table not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    const hasColumn = await columnExists(queryRunner, 'feeds', 'min_fish_weight_g');
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
    if (!(await tableExists(queryRunner, 'feeds'))) {
      return;
    }
    const hasColumn = await columnExists(queryRunner, 'feeds', 'min_fish_weight_g');
    if (hasColumn) {
      await queryRunner.query(`ALTER TABLE "feeds" DROP COLUMN "min_fish_weight_g"`);
    }
    this.logger.log('AddFeedMinFishWeight migration rollback completed');
  }
}
