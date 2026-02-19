import { MigrationInterface, QueryRunner, Logger } from 'typeorm';

/**
 * Migration: Add feeder_calibrations table
 *
 * Two-phase approach:
 * 1. Create table in farm schema (source for new tenants)
 * 2. Copy table to all existing tenant schemas
 */
export class AddFeederCalibrations1774000000000 implements MigrationInterface {
  name = 'AddFeederCalibrations1774000000000';
  private readonly logger = new Logger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log(`Running AddFeederCalibrations migration in schema: ${JSON.stringify(schema)}`);

    // =========================================================================
    // 1. feeder_calibrations
    // =========================================================================
    const hasTable = await this.tableExists(queryRunner, 'feeder_calibrations');
    if (!hasTable) {
      await queryRunner.query(`
        CREATE TABLE "feeder_calibrations" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "tenant_id" UUID NOT NULL,
          "equipment_id" UUID NOT NULL,
          "feed_size_mm" DECIMAL(5,2) NOT NULL,
          "feed_size_label" VARCHAR(100),
          "grams_per_dispensing" DECIMAL(8,2) NOT NULL,
          "silo_capacity_kg" DECIMAL(8,2) NOT NULL,
          "notes" TEXT,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT "uq_feeder_cal" UNIQUE ("tenant_id", "equipment_id", "feed_size_mm")
        )
      `);
      await queryRunner.query(`CREATE INDEX "idx_feeder_cal_tenant" ON "feeder_calibrations" ("tenant_id")`);
      await queryRunner.query(`CREATE INDEX "idx_feeder_cal_equipment" ON "feeder_calibrations" ("tenant_id", "equipment_id")`);
      this.logger.log('Created feeder_calibrations table');
    } else {
      this.logger.log('feeder_calibrations table already exists, skipping');
    }

    // =========================================================================
    // 2. Copy to existing tenant schemas
    // =========================================================================
    try {
      const tenantSchemas = await queryRunner.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
      `);

      for (const { schema_name } of tenantSchemas) {
        try {
          await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "${schema_name}"."feeder_calibrations"
            (LIKE "feeder_calibrations" INCLUDING ALL)
          `);
          this.logger.log(`Created feeder_calibrations in ${schema_name}`);
        } catch (err) {
          this.logger.warn(`Could not create table in ${schema_name}: ${err}`);
        }
      }
    } catch (err) {
      this.logger.warn(`Could not propagate to tenant schemas: ${err}`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop from tenant schemas first
    try {
      const tenantSchemas = await queryRunner.query(`
        SELECT schema_name FROM information_schema.schemata
        WHERE schema_name LIKE 'tenant_%'
      `);
      for (const { schema_name } of tenantSchemas) {
        await queryRunner.query(`DROP TABLE IF EXISTS "${schema_name}"."feeder_calibrations" CASCADE`);
      }
    } catch (err) {
      this.logger.warn(`Could not drop from tenant schemas: ${err}`);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS "feeder_calibrations" CASCADE`);
  }

  private async tableExists(queryRunner: QueryRunner, tableName: string): Promise<boolean> {
    const result = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = $1 AND table_schema = current_schema()
      )`,
      [tableName],
    );
    return result[0]?.exists === true;
  }
}
