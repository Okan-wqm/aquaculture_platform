import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  tableExists,
} from '@aquaculture/backend-common/database';

/**
 * EnterprisePerformanceOptimizations1741200000000
 *
 * # Bootstrap-restoration guards (Wave 4-A.2 Dalga 3)
 *
 * Each block below references a table created by a sibling migration
 * (sensors, edge_devices, plc_alarms). Where the source CREATE TABLE
 * was squashed, the lookup is fragile on fresh-volume bootstrap. Each
 * block is now wrapped in a `tableExists` guard with a skip-with-reason
 * log; legacy DBs behave identically, fresh DBs proceed once the
 * sibling baseline migration has installed the table.
 */
export class EnterprisePerformanceOptimizations1741200000000 implements MigrationInterface {
  name = 'EnterprisePerformanceOptimizations1741200000000';

  private readonly logger = new MigrationLogger(
    'EnterprisePerformanceOptimizations1741200000000',
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasSensors = await tableExists(queryRunner, 'sensors');
    if (hasSensors) {
      // 1. Partial index: Active sensors per tenant (most common query pattern)
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS idx_sensors_active_tenant
        ON sensors ("tenant_id")
        WHERE "registration_status" = 'active' AND "is_active" = true
      `);

      // 2. Partial index: Offline detection (sensor health monitoring)
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS idx_sensors_offline_detection
        ON sensors ("tenant_id", "last_seen_at")
        WHERE "last_seen_at" IS NOT NULL
      `);
    } else {
      this.logger.log(
        'Skipping sensors performance indexes — sensors table not present on this DB (installed by sibling baseline migration)',
      );
    }

    // 3. Partial index: Edge device lifecycle filtering
    if (await tableExists(queryRunner, 'edge_devices')) {
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS idx_edge_devices_lifecycle
        ON edge_devices ("tenant_id", "lifecycle_state")
        WHERE "lifecycle_state" IN ('active', 'offline', 'error')
      `);
    } else {
      this.logger.log(
        'Skipping edge_devices lifecycle index — edge_devices table not present on this DB (installed by sibling baseline migration)',
      );
    }

    // 4. Audit logs table (created here instead of via TypeORM sync to have proper indexes from the start)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        entity_type VARCHAR(100) NOT NULL,
        entity_id UUID NOT NULL,
        action VARCHAR(20) NOT NULL,
        previous_value JSONB,
        new_value JSONB,
        changed_fields JSONB,
        changed_by UUID,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sensor_audit_logs_tenant_entity
      ON sensor_audit_logs (tenant_id, entity_type, entity_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sensor_audit_logs_tenant_time
      ON sensor_audit_logs (tenant_id, changed_at DESC)
    `);

    // 5. Device groups table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device_groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        type VARCHAR(50) NOT NULL DEFAULT 'custom',
        parent_group_id UUID REFERENCES device_groups(id) ON DELETE SET NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_device_groups_tenant
      ON device_groups (tenant_id)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device_group_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
        device_type VARCHAR(50) NOT NULL,
        device_id UUID NOT NULL,
        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(group_id, device_type, device_id)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_device_group_members_group
      ON device_group_members (group_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_device_group_members_device
      ON device_group_members (device_type, device_id)
    `);

    // 6. PlcAlarm approval workflow columns
    if (await tableExists(queryRunner, 'plc_alarms')) {
      await queryRunner.query(`
        ALTER TABLE plc_alarms
          ADD COLUMN IF NOT EXISTS approval_level INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS required_approval_level INTEGER NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS approval_chain JSONB DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS auto_escalate_after_ms INTEGER,
          ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT false
      `);

      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS idx_plc_alarms_sla
        ON plc_alarms (tenant_id, sla_breached, sla_deadline)
        WHERE sla_breached = false AND sla_deadline IS NOT NULL
      `);
    } else {
      this.logger.log(
        'Skipping plc_alarms approval workflow ALTER — plc_alarms table not present on this DB (installed by sibling baseline migration)',
      );
    }

    // 7. Denormalization trigger: sync sensor location to recent metrics
    // Only updates non-compressed chunks (last 7 days) for performance
    if (hasSensors) {
      await queryRunner.query(`
        CREATE OR REPLACE FUNCTION sync_sensor_metric_location()
        RETURNS trigger AS $$
        BEGIN
          -- Only run if location fields actually changed
          IF OLD."site_id" IS DISTINCT FROM NEW."site_id"
            OR OLD."department_id" IS DISTINCT FROM NEW."department_id"
            OR OLD."system_id" IS DISTINCT FROM NEW."system_id"
            OR OLD."equipment_id" IS DISTINCT FROM NEW."equipment_id"
          THEN
            UPDATE sensor_metrics SET
              site_id = NEW."site_id",
              department_id = NEW."department_id",
              system_id = NEW."system_id",
              equipment_id = NEW."equipment_id"
            WHERE sensor_id = NEW.id
              AND time > NOW() - INTERVAL '5 days';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);

      await queryRunner.query(`
        DROP TRIGGER IF EXISTS trg_sensor_location_sync ON sensors
      `);

      await queryRunner.query(`
        CREATE TRIGGER trg_sensor_location_sync
          AFTER UPDATE OF "site_id", "department_id", "system_id", "equipment_id"
          ON sensors
          FOR EACH ROW
          EXECUTE FUNCTION sync_sensor_metric_location()
      `);
    } else {
      this.logger.log(
        'Skipping sensors location-sync trigger — sensors table not present on this DB (installed by sibling baseline migration)',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in opposite order
    if (await tableExists(queryRunner, 'sensors')) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS trg_sensor_location_sync ON sensors`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS sync_sensor_metric_location()`);

    if (await tableExists(queryRunner, 'plc_alarms')) {
      await queryRunner.query(`
        ALTER TABLE plc_alarms
          DROP COLUMN IF EXISTS approval_level,
          DROP COLUMN IF EXISTS required_approval_level,
          DROP COLUMN IF EXISTS approval_chain,
          DROP COLUMN IF EXISTS escalated_at,
          DROP COLUMN IF EXISTS auto_escalate_after_ms,
          DROP COLUMN IF EXISTS sla_deadline,
          DROP COLUMN IF EXISTS sla_breached
      `);
    }

    await queryRunner.query(`DROP TABLE IF EXISTS device_group_members`);
    await queryRunner.query(`DROP TABLE IF EXISTS device_groups`);
    await queryRunner.query(`DROP TABLE IF EXISTS sensor_audit_logs`);

    await queryRunner.query(`DROP INDEX IF EXISTS idx_edge_devices_lifecycle`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sensors_offline_detection`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_sensors_active_tenant`);
  }
}
