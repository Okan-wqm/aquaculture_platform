import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Retention Policy Service
 *
 * Provides runtime visibility into TimescaleDB retention policies and
 * allows programmatic creation/update of policies without a schema
 * migration.  All DDL is idempotent (uses IF NOT EXISTS / OR REPLACE
 * equivalents where available).
 *
 * CRITICAL-005: Previously a 1-line stub.
 */
@Injectable()
export class RetentionPolicyService {
  private readonly logger = new Logger(RetentionPolicyService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns the current retention policy for a hypertable or
   * continuous-aggregate view, or null if none is configured.
   */
  async getPolicy(hypertable: string): Promise<{
    hypertable: string;
    retentionInterval: string | null;
    scheduledAt: string | null;
  } | null> {
    const rows: Array<{
      drop_after: string;
      schedule_interval: string;
    }> = await this.dataSource.query(
      `SELECT drop_after::text, schedule_interval::text
       FROM timescaledb_information.jobs j
       JOIN timescaledb_information.job_stats js ON js.job_id = j.job_id
       WHERE j.proc_name = 'policy_retention'
         AND j.hypertable_name = $1
       LIMIT 1`,
      [hypertable],
    );

    if (rows.length === 0) return null;

    return {
      hypertable,
      retentionInterval: rows[0]?.drop_after ?? null,
      scheduledAt:       rows[0]?.schedule_interval ?? null,
    };
  }

  /**
   * Apply (or update) a retention policy for a hypertable.
   * Existing policies are removed before the new one is added.
   */
  async setPolicy(hypertable: string, retentionInterval: string): Promise<void> {
    this.logger.log(`Setting retention policy on ${hypertable}: drop after ${retentionInterval}`);

    await this.dataSource.query(
      `SELECT remove_retention_policy($1, if_exists => TRUE)`,
      [hypertable],
    );
    await this.dataSource.query(
      `SELECT add_retention_policy($1, INTERVAL $2, if_not_exists => TRUE)`,
      [hypertable, retentionInterval],
    );
  }

  /**
   * Remove the retention policy from a hypertable.
   */
  async removePolicy(hypertable: string): Promise<void> {
    this.logger.log(`Removing retention policy from ${hypertable}`);
    await this.dataSource.query(
      `SELECT remove_retention_policy($1, if_exists => TRUE)`,
      [hypertable],
    );
  }
}
