import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
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
      for (const { table, column } of PARTITIONED_TABLES) {
        for (const { year, month } of months) {
          await this.createPartitionIfNotExists(schema, table, column, year, month);
        }
      }
    }
  }

  /**
   * Creates a single partition table if it does not already exist.
   */
  private async createPartitionIfNotExists(
    schema: string,
    table: string,
    _column: string,
    year: number,
    month: number,
  ): Promise<void> {
    const paddedMonth = String(month).padStart(2, '0');
    const partitionName = `${table}_${year}_${paddedMonth}`;

    // Calculate range boundaries
    const startDate = `${year}-${paddedMonth}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const paddedNextMonth = String(nextMonth).padStart(2, '0');
    const endDate = `${nextYear}-${paddedNextMonth}-01`;

    // Sanitize schema name — only allow alphanumeric + underscores
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
      this.logger.warn(`Skipping invalid schema name: ${schema}`);
      return;
    }

    const sql = `
      CREATE TABLE IF NOT EXISTS "${schema}"."${partitionName}"
        PARTITION OF "${schema}"."${table}"
        FOR VALUES FROM ('${startDate}') TO ('${endDate}')
    `;

    try {
      await this.dataSource.query(sql);
      this.logger.log(`Partition ensured: ${schema}.${partitionName}`);
    } catch (err) {
      const message = (err as Error).message;
      // PostgreSQL raises an error if the partition already overlaps — safe to ignore
      if (message.includes('already exists') || message.includes('overlaps')) {
        this.logger.debug(`Partition already exists: ${schema}.${partitionName}`);
      } else {
        this.logger.error(
          `Failed to create partition ${schema}.${partitionName}: ${message}`,
        );
        throw err;
      }
    }
  }

  /**
   * Retrieves all tenant schema names (tenant_*) from information_schema.
   */
  private async getTenantSchemas(): Promise<string[]> {
    const rows = await this.dataSource.query<Array<{ schema_name: string }>>(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name LIKE 'tenant_%'
       ORDER BY schema_name`,
    );
    return rows.map((r) => r.schema_name);
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
