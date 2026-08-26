import {
  getTenantSchemaName,
  isValidUUID,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const RETENTION_TARGETS = ['metrics_1min', 'metrics_1hour', 'metrics_1day'] as const;
type RetentionTarget = (typeof RETENTION_TARGETS)[number];

const ISO_CALENDAR_PERIOD = /^P(?=\d+[YMD])(?:\d+Y)?(?:\d+M)?(?:\d+D)?$/;

/**
 * Tenant-scoped continuous-aggregate retention management.
 *
 * Raw telemetry retention is deliberately not exposed. LEGAL-001 must be
 * approved before a separate, archive-verified raw-drop path may exist.
 */
@Injectable()
export class RetentionPolicyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionPolicyService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const rows: Array<{ hypertable_schema: string }> = await this.dataSource.query(
      `SELECT j.hypertable_schema
         FROM timescaledb_information.jobs j
        WHERE j.proc_name = 'policy_retention'
          AND j.hypertable_name = 'sensor_metrics'
        ORDER BY j.hypertable_schema`,
    );

    for (const row of rows) {
      const tenantSchema = validateTenantSchemaName(row.hypertable_schema);
      if (!tenantSchema.startsWith('tenant_')) {
        throw new Error(`Raw retention job targets non-tenant schema ${tenantSchema}`);
      }
      const qualifiedTarget = `${tenantSchema}.sensor_metrics`;
      this.logger.warn(`Removing prohibited raw telemetry retention job from ${qualifiedTarget}`);
      await this.dataSource.query(`SELECT remove_retention_policy($1, if_exists => TRUE)`, [
        qualifiedTarget,
      ]);
    }
  }

  async getPolicy(
    tenantId: string,
    target: string,
  ): Promise<{
    hypertable: string;
    retentionInterval: string | null;
    scheduledAt: string | null;
  } | null> {
    const retentionTarget = this.assertRetentionTarget(target);
    const tenantSchema = this.getTenantSchema(tenantId);
    const rows: Array<{
      drop_after: string;
      schedule_interval: string;
    }> = await this.dataSource.query(
      `SELECT drop_after::text, schedule_interval::text
       FROM timescaledb_information.jobs j
       JOIN timescaledb_information.job_stats js ON js.job_id = j.job_id
       WHERE j.proc_name = 'policy_retention'
         AND j.hypertable_schema = $1
         AND j.hypertable_name = $2
       LIMIT 1`,
      [tenantSchema, retentionTarget],
    );

    if (rows.length === 0) return null;

    return {
      hypertable: `${tenantSchema}.${retentionTarget}`,
      retentionInterval: rows[0]?.drop_after ?? null,
      scheduledAt: rows[0]?.schedule_interval ?? null,
    };
  }

  async setPolicy(tenantId: string, target: string, retentionPeriod: string): Promise<void> {
    const retentionTarget = this.assertRetentionTarget(target);
    this.assertCalendarPeriod(retentionPeriod);
    const qualifiedTarget = `${this.getTenantSchema(tenantId)}.${retentionTarget}`;

    this.logger.log(
      `Setting continuous-aggregate retention policy on ${qualifiedTarget}: ${retentionPeriod}`,
    );
    await this.dataSource.query(`SELECT remove_retention_policy($1, if_exists => TRUE)`, [
      qualifiedTarget,
    ]);
    await this.dataSource.query(
      `SELECT add_retention_policy($1, $2::interval, if_not_exists => TRUE)`,
      [qualifiedTarget, retentionPeriod],
    );
  }

  async removePolicy(tenantId: string, target: string): Promise<void> {
    const retentionTarget = this.assertRetentionTarget(target);
    const qualifiedTarget = `${this.getTenantSchema(tenantId)}.${retentionTarget}`;

    this.logger.log(`Removing continuous-aggregate retention policy from ${qualifiedTarget}`);
    await this.dataSource.query(`SELECT remove_retention_policy($1, if_exists => TRUE)`, [
      qualifiedTarget,
    ]);
  }

  private assertRetentionTarget(target: string): RetentionTarget {
    if (target === 'sensor_metrics') {
      throw new Error(
        'Raw sensor_metrics retention is disabled until LEGAL-001 is approved and archive verification is complete',
      );
    }
    if (target === 'metrics_1min' || target === 'metrics_1hour' || target === 'metrics_1day') {
      return target;
    }
    throw new Error(`Retention target ${target} is outside the continuous-aggregate allowlist`);
  }

  private assertCalendarPeriod(period: string): void {
    if (!ISO_CALENDAR_PERIOD.test(period)) {
      throw new Error(`Retention period ${period} must be an ISO-8601 calendar period`);
    }
  }

  private getTenantSchema(tenantId: string): string {
    if (!isValidUUID(tenantId)) {
      throw new Error(`Invalid tenant ID for retention policy: ${tenantId}`);
    }
    return validateTenantSchemaName(getTenantSchemaName(tenantId));
  }
}
