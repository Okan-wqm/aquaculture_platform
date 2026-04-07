import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  convertAuditColumnsToTimestamptz,
  revertAuditColumnsToTimestamp,
  MigrationLogger,
} from '@aquaculture/backend-common';

/**
 * ConvertAuditColumnsToTimestamptz1781900000000
 * ============================================================================
 *
 * NEW-H1 fix for the sensor schema. Phase B audit found 5 entity files
 * with bare `@CreateDateColumn()` decorators. Sensor audit columns are
 * relatively low-stakes for compliance (sensor metadata, not user
 * actions) but still get converted for consistency with the rest of
 * the platform.
 *
 * NOTE: This migration is INDEPENDENT of the time-series sensor_metrics
 * table, which already uses TIMESTAMPTZ on its `time` column (verified
 * by Phase 1 audit). The sensor_metrics table is also a TimescaleDB
 * hypertable; the helper's information_schema query operates on regular
 * tables and would handle a hypertable's chunks transparently if
 * needed, but in this case sensor_metrics has no audit columns to
 * touch.
 *
 * See the auth-service variant for the full design notes.
 */
export class ConvertAuditColumnsToTimestamptz1781900000000
  implements MigrationInterface
{
  name = 'ConvertAuditColumnsToTimestamptz1781900000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await convertAuditColumnsToTimestamptz(queryRunner, {
      // sensor_metrics is a hypertable; its time column is already
      // tz-aware. Exclude the audit log + outbox tables for parity
      // with farm-service's exclusion list.
      excludeTables: ['sensor_audit_logs'],
      logger: this.logger,
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await revertAuditColumnsToTimestamp(queryRunner, {
      excludeTables: ['sensor_audit_logs'],
      logger: this.logger,
    });
  }
}
