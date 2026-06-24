import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { listTenantSchemas } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';

/**
 * Tables that are partitioned by month via RANGE partitioning.
 * Each entry maps a table name to the column used as the partition key.
 */
const PARTITIONED_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'messages', column: 'created_at' },
  { table: 'message_receipts', column: 'receipt_created_at' },
];

/**
 * Manages monthly RANGE partitions for large time-series tables.
 *
 * - On the 1st of every month (cron) creates partitions for the next 3 months.
 * - On startup verifies that current + next 2 months exist, creating missing ones.
 * - Partitions are created in:
 *   1. The 'messaging' source schema (template).
 *   2. Every `tenant_*` schema in the database.
 *
 * WHY no DEFAULT partition: We intentionally do NOT create a DEFAULT partition.
 * Without a DEFAULT, inserts with timestamps outside any defined partition range
 * will fail with a PostgreSQL error. This is a deliberate fail-fast strategy:
 * a missing partition is an operational signal that the cron job failed or that
 * data is arriving with unexpected timestamps. A DEFAULT partition would silently
 * route such rows to a catch-all, masking the problem until the table grows
 * unboundedly and query performance degrades.
 */
@Injectable()
export class PartitionManagerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PartitionManagerService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** On startup, ensure current + next 2 months exist. */
  async onApplicationBootstrap(): Promise<void> {
    const months = this.getMonthRange(0, 2);
    await this.ensurePartitions(months);
  }

  /** Monthly cron: 1st of every month at 00:00. Creates partitions for next 3 months. */
  @Cron('0 0 1 * *', { name: 'partition-manager' })
  async handleMonthlyPartitionCron(): Promise<void> {
    this.logger.log('Monthly partition creation cron triggered');
    try {
      const months = this.getMonthRange(1, 3);
      await this.ensurePartitions(months);
    } catch (err) {
      this.logger.error(
        `Monthly partition cron failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Ensure partitions exist for the given months across all schemas.
   */
  private async ensurePartitions(
    months: Array<{ year: number; month: number }>,
  ): Promise<void> {
    const schemas = await this.getTenantSchemas();
    // Always include the 'messaging' source schema
    const allSchemas = ['messaging', ...schemas];

    for (const schema of allSchemas) {
      for (const { table } of PARTITIONED_TABLES) {
        for (const { year, month } of months) {
          await this.createPartitionIfNotExists(schema, table, year, month);
        }
      }
    }
  }

  /**
   * Ensures a single monthly partition via the platform's SECURITY DEFINER
   * primitive (DATA-HIGH-006).
   *
   * WHY no raw DDL here: pg16 requires schema CREATE (checked BEFORE the
   * IF NOT EXISTS short-circuit) AND parent-table ownership to create a
   * partition — both empirically proven on the production image. The
   * runtime role deliberately holds neither; its entire DDL surface is
   * EXECUTE on platform.create_messaging_partition, whose owner
   * (messaging_schema_owner) carries the authority and whose body enforces
   * the schema/table allowlists, month-boundary math, and idempotency.
   * Errors propagate untouched: a failure here means the privilege SSoT is
   * broken, which must fail the boot loudly (see class docblock on the
   * deliberate absence of a DEFAULT partition).
   */
  private async createPartitionIfNotExists(
    schema: string,
    table: string,
    year: number,
    month: number,
  ): Promise<void> {
    await this.dataSource.query(
      'SELECT platform.create_messaging_partition($1, $2, $3, $4)',
      [schema, table, year, month],
    );
    this.logger.log(
      `Partition ensured: ${schema}.${table}_${year}_${String(month).padStart(2, '0')}`,
    );
  }

  /**
   * Retrieves all tenant schema names from the canonical database utility.
   */
  private async getTenantSchemas(): Promise<string[]> {
    return listTenantSchemas(this.dataSource);
  }

  /**
   * Returns an array of { year, month } from (now + offsetMonths) through
   * (now + offsetMonths + count).
   */
  private getMonthRange(
    offsetMonths: number,
    count: number,
  ): Array<{ year: number; month: number }> {
    const result: Array<{ year: number; month: number }> = [];
    const now = new Date();

    for (let i = 0; i <= count; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + offsetMonths + i, 1);
      result.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }

    return result;
  }
}
