import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * AddLoraDevicesEdgeDeviceFk1736800001000
 * ============================================================================
 *
 * Adds the FK that `1735850000000-CreateSensorBaselineTables` could not
 * declare at creation time:
 *
 *     lora_devices.edge_device_id → edge_devices(id) ON DELETE CASCADE
 *
 * `edge_devices` is created at `1736800000000-CreateEdgeDevicesTable`
 * — one slot before this migration. By placing the FK addition at
 * `1736800001000` we guarantee the parent table exists at the moment
 * the constraint is added, while keeping the per-migration purpose
 * narrow.
 *
 * The entity decorator
 *   `@ManyToOne(() => EdgeDevice, { onDelete: 'CASCADE' })`
 *   `@JoinColumn({ name: 'edge_device_id' })`
 * mirrors this exact constraint shape — without this FK at the DB
 * layer, application-side cascade-on-delete is silently dropped for
 * any deployment where TypeORM does not maintain referential integrity
 * (raw SQL deletes, BACKUP/RESTORE round-trips, schema-clone operations).
 *
 * # edge_device_id type alignment
 *
 * `1735850000000` created `lora_devices.edge_device_id` as `varchar`
 * (the entity declares no explicit type — TypeORM defaults to `varchar`
 * for unannotated `@Column({ name })` declarations). `edge_devices.id`
 * is UUID. Postgres FK targets must match the parent column type, so
 * this migration ALTERs `edge_device_id` to UUID before adding the FK.
 * The conversion is safe because `lora_devices` is freshly created
 * and contains zero rows at this point in the migration chain.
 *
 * # Idempotency
 *
 * `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL` for the FK
 * ADD; type ALTER is wrapped in a duplicate-check block. Re-running
 * the migration is a no-op.
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */
export class AddLoraDevicesEdgeDeviceFk1736800001000
  implements MigrationInterface
{
  name = 'AddLoraDevicesEdgeDeviceFk1736800001000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Skip the entire migration if either table is missing — a guard
    // against partial fresh-DB bootstraps that may not have run the
    // baseline migrations yet.
    const tableExists = await this.tableExists(queryRunner, 'lora_devices');
    const parentExists = await this.tableExists(queryRunner, 'edge_devices');
    if (!tableExists || !parentExists) {
      this.logger.warn(
        `Skipping FK addition — lora_devices=${tableExists}, edge_devices=${parentExists}`,
      );
      return;
    }

    // Align edge_device_id column type with edge_devices.id (UUID).
    // information_schema check makes this idempotent + defensive on
    // already-converted columns.
    const columnTypeResult: Array<{ data_type: string }> = await queryRunner.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'lora_devices'
          AND column_name = 'edge_device_id'`,
    );
    const currentType = columnTypeResult[0]?.data_type;
    if (currentType && currentType !== 'uuid') {
      await queryRunner.query(`
        ALTER TABLE "lora_devices"
          ALTER COLUMN "edge_device_id" TYPE uuid
          USING "edge_device_id"::uuid
      `);
      this.logger.log('Converted lora_devices.edge_device_id to UUID');
    }

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "lora_devices"
          ADD CONSTRAINT "FK_lora_devices_edge_device"
          FOREIGN KEY ("edge_device_id")
          REFERENCES "edge_devices"("id")
          ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    this.logger.log('Added FK_lora_devices_edge_device');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "lora_devices"
        DROP CONSTRAINT IF EXISTS "FK_lora_devices_edge_device"
    `);
    this.logger.log('Dropped FK_lora_devices_edge_device');
  }

  private async tableExists(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<boolean> {
    const result: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = $1
      )`,
      [tableName],
    );
    return result[0]?.exists === true;
  }
}
