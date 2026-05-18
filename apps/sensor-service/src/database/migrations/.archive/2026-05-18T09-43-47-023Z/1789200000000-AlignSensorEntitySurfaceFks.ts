import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
} from '@aquaculture/backend-common/database';

/**
 * AlignSensorEntitySurfaceFks1789200000000
 * ============================================================================
 *
 * Closes the residual FK and NOT NULL drifts surfaced by the
 * bootstrap-from-scratch CI test at 8d239f7f after AlignSensorEntitySurface
 * + AlignSensorEntitySurfaceExt landed:
 *
 *   - sensor.feeding_parameters: declares 1 @ManyToOne FK, DB has 0
 *     → ADD CONSTRAINT FK_feeding_parameters_plc_connection
 *       (plcConnectionId -> plc_connections.id ON DELETE CASCADE)
 *   - sensor.device_io_configs: declares 1 @ManyToOne FK, DB has 0
 *     → ADD CONSTRAINT FK_device_io_configs_device
 *       (device_id -> edge_devices.id ON DELETE CASCADE)
 *   - sensor.sensor_metrics: declares 2 @ManyToOne FKs, DB has 0
 *     → ADD CONSTRAINT FK_sensor_metrics_sensor (sensor_id -> sensors.id)
 *     → ADD CONSTRAINT FK_sensor_metrics_channel (channel_id -> sensor_data_channels.id)
 *   - sensor.deployment_logs.updated_at: entity NOT NULL but DB nullable
 *     → backfill NULLs with NOW(), then SET NOT NULL guarded by R10
 *
 * # Why a separate migration
 *
 * AlignSensorEntitySurface and AlignSensorEntitySurfaceExt have already
 * been authored and committed in this PR. The architectural pattern
 * across the W4-A2 alignment slices is "one slice per CI surfacing"
 * — keeping each slice scoped to the drifts visible at the timestamp
 * it was authored against. Timestamp 1789200000000 places this slice
 * after both prior sensor align migrations.
 *
 * # Idempotency posture
 *
 *   - FKs: DO $$ BEGIN ALTER TABLE ... ADD CONSTRAINT ... EXCEPTION
 *     WHEN duplicate_object THEN NULL; END $$ (R11)
 *   - NOT NULL: backfill + ALTER COLUMN SET NOT NULL guarded by
 *     information_schema.columns lookup (R10)
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignSensorEntitySurfaceFks1789200000000
  implements MigrationInterface
{
  name = 'AlignSensorEntitySurfaceFks1789200000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'sensor');

    this.logger.log(
      'Adding 4 missing FKs + 1 NOT NULL drift fix for sensor entity surface.',
    );

    // 1. feeding_parameters.plcConnectionId -> plc_connections.id (CASCADE).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE sensor.feeding_parameters
          ADD CONSTRAINT "FK_feeding_parameters_plc_connection"
          FOREIGN KEY ("plcConnectionId")
          REFERENCES sensor.plc_connections("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // 2. device_io_configs.device_id -> edge_devices.id (CASCADE).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE sensor.device_io_configs
          ADD CONSTRAINT "FK_device_io_configs_device"
          FOREIGN KEY ("device_id")
          REFERENCES sensor.edge_devices("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // 3. sensor_metrics.sensor_id -> sensors.id (CASCADE).
    //    The entity's @ManyToOne relation declares onDelete: 'CASCADE'.
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE sensor.sensor_metrics
          ADD CONSTRAINT "FK_sensor_metrics_sensor"
          FOREIGN KEY ("sensor_id")
          REFERENCES sensor.sensors("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // 4. sensor_metrics.channel_id -> sensor_data_channels.id (CASCADE).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE sensor.sensor_metrics
          ADD CONSTRAINT "FK_sensor_metrics_channel"
          FOREIGN KEY ("channel_id")
          REFERENCES sensor.sensor_data_channels("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // 5. deployment_logs.updated_at — backfill NULLs, then SET NOT NULL.
    //    My AlignSensorEntitySurface migration created this column as
    //    nullable but the entity declares @UpdateDateColumn() (NOT NULL).
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'sensor'
            AND table_name = 'deployment_logs'
            AND column_name = 'updated_at'
            AND is_nullable = 'YES'
        ) THEN
          UPDATE sensor.deployment_logs
            SET "updated_at" = NOW()
            WHERE "updated_at" IS NULL;
          ALTER TABLE sensor.deployment_logs
            ALTER COLUMN "updated_at" SET NOT NULL;
        END IF;
      END $$
    `);

    this.logger.log('sensor FK + NOT NULL alignment complete.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting sensor FK alignment. Test-environment only.',
    );

    await pinSearchPath(queryRunner, 'sensor');

    await queryRunner.query(`
      ALTER TABLE sensor.feeding_parameters
        DROP CONSTRAINT IF EXISTS "FK_feeding_parameters_plc_connection"
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.device_io_configs
        DROP CONSTRAINT IF EXISTS "FK_device_io_configs_device"
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.sensor_metrics
        DROP CONSTRAINT IF EXISTS "FK_sensor_metrics_sensor"
    `);
    await queryRunner.query(`
      ALTER TABLE sensor.sensor_metrics
        DROP CONSTRAINT IF EXISTS "FK_sensor_metrics_channel"
    `);
  }
}
