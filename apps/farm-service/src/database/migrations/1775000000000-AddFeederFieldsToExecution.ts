import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';
import { tableExists } from '@aquaculture/backend-common/database';

/**
 * Migration: Add feeder fields to daily_feeding_executions table
 *
 * Adds feeder_equipment_id, feeder_name, and feeding_method columns
 * to track who/what performed the feeding.
 *
 * # Bootstrap-restoration guard (Wave 4-A.2 Dalga 3)
 *
 * The whole body is wrapped in `tableExists(queryRunner,
 * 'daily_feeding_executions')` because the original CREATE TABLE for
 * `daily_feeding_executions` lived in a now-squashed earlier migration;
 * on fresh-volume bootstrap the table only lands once the Wave 2-A
 * baseline runs. Without the guard, the ALTER COLUMN body crashes with
 * `relation "daily_feeding_executions" does not exist`.
 */
export class AddFeederFieldsToExecution1775000000000 implements MigrationInterface {
  name = 'AddFeederFieldsToExecution1775000000000';
  private readonly logger = new Logger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log(`Running AddFeederFieldsToExecution migration in schema: ${JSON.stringify(schema)}`);

    if (!(await tableExists(queryRunner, 'daily_feeding_executions'))) {
      this.logger.log(
        'Skipping AddFeederFieldsToExecution — daily_feeding_executions table not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    // Check if feeding_method enum type exists (may already be registered from feeding_records table)
    const enumExists = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'feedingmethod'
      )
    `);

    // Add feeder_equipment_id column
    const hasFeederEquipmentId = await this.columnExists(queryRunner, 'daily_feeding_executions', 'feeder_equipment_id');
    if (!hasFeederEquipmentId) {
      await queryRunner.query(`
        ALTER TABLE "daily_feeding_executions"
        ADD COLUMN "feeder_equipment_id" UUID
      `);
      this.logger.log('Added feeder_equipment_id column');
    } else {
      this.logger.log('feeder_equipment_id column already exists, skipping');
    }

    // Add feeder_name column
    const hasFeederName = await this.columnExists(queryRunner, 'daily_feeding_executions', 'feeder_name');
    if (!hasFeederName) {
      await queryRunner.query(`
        ALTER TABLE "daily_feeding_executions"
        ADD COLUMN "feeder_name" VARCHAR(100)
      `);
      this.logger.log('Added feeder_name column');
    } else {
      this.logger.log('feeder_name column already exists, skipping');
    }

    // Add feeding_method column - use enum type if it exists, otherwise varchar
    const hasFeedingMethod = await this.columnExists(queryRunner, 'daily_feeding_executions', 'feeding_method');
    if (!hasFeedingMethod) {
      if (enumExists[0]?.exists) {
        await queryRunner.query(`
          ALTER TABLE "daily_feeding_executions"
          ADD COLUMN "feeding_method" "feedingmethod"
        `);
      } else {
        await queryRunner.query(`
          ALTER TABLE "daily_feeding_executions"
          ADD COLUMN "feeding_method" VARCHAR(20)
        `);
      }
      this.logger.log('Added feeding_method column');
    } else {
      this.logger.log('feeding_method column already exists, skipping');
    }

    this.logger.log('AddFeederFieldsToExecution migration completed successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await tableExists(queryRunner, 'daily_feeding_executions'))) {
      return;
    }
    const hasFeederEquipmentId = await this.columnExists(queryRunner, 'daily_feeding_executions', 'feeder_equipment_id');
    if (hasFeederEquipmentId) {
      await queryRunner.query(`ALTER TABLE "daily_feeding_executions" DROP COLUMN "feeder_equipment_id"`);
    }

    const hasFeederName = await this.columnExists(queryRunner, 'daily_feeding_executions', 'feeder_name');
    if (hasFeederName) {
      await queryRunner.query(`ALTER TABLE "daily_feeding_executions" DROP COLUMN "feeder_name"`);
    }

    const hasFeedingMethod = await this.columnExists(queryRunner, 'daily_feeding_executions', 'feeding_method');
    if (hasFeedingMethod) {
      await queryRunner.query(`ALTER TABLE "daily_feeding_executions" DROP COLUMN "feeding_method"`);
    }

    this.logger.log('AddFeederFieldsToExecution migration rollback completed');
  }

  private async columnExists(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
  ): Promise<boolean> {
    const result = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = $1
        AND column_name = $2
        AND table_schema = current_schema()
      )
    `, [tableName, columnName]);
    return result[0]?.exists === true;
  }
}
