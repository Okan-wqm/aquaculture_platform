import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { createMonthlyPartition, MESSAGING_PARTITIONED_TABLES } from './partition-queries';

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
export class PartitionManagerService {
  private readonly logger = new Logger(PartitionManagerService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Ensure current + next 2 months exist for source + tenant schemas. */
  async ensureStartupPartitions(): Promise<void> {
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
      this.logger.error(`Monthly partition cron failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Ensure partitions exist for the given months across all schemas.
   */
  private async ensurePartitions(months: Array<{ year: number; month: number }>): Promise<void> {
    const schemas = await this.getTenantSchemas();
    // Always include the 'messaging' source schema
    await this.ensurePartitionsForSchemas(['messaging', ...schemas], months);
  }

  /**
   * Public hook used by tenant-provisioning and E2E bootstrap when tenant
   * schemas are created after app bootstrap. The same runtime SSoT creates
   * current + next two monthly partitions for those late-born schemas.
   */
  async ensureCurrentPartitionsForSchemas(schemas: readonly string[]): Promise<void> {
    await this.ensurePartitionsForSchemas(schemas, this.getMonthRange(0, 2));
  }

  private async ensurePartitionsForSchemas(
    schemas: readonly string[],
    months: Array<{ year: number; month: number }>,
  ): Promise<void> {
    for (const schema of schemas) {
      for (const { table, column } of MESSAGING_PARTITIONED_TABLES) {
        await this.assertPartitionParent(schema, table, column);
        for (const { year, month } of months) {
          await this.createPartitionIfNotExists(schema, table, year, month);
        }
      }
    }
  }

  private async assertPartitionParent(
    schema: string,
    table: string,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(schema, 'schema');
    this.assertSafeIdentifier(table, 'table');
    const rows: Array<{ partition_key: string | null }> = await this.dataSource.query(
      `SELECT pg_get_partkeydef(c.oid) AS partition_key
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relname = $2
         AND c.relkind = 'p'`,
      [schema, table],
    );

    const partitionKey = rows[0]?.partition_key;
    if (!partitionKey) {
      throw new Error(`Messaging partition parent missing or not partitioned: ${schema}.${table}`);
    }
    const expectedPartitionKey = `RANGE ("${column}")`;
    if (this.normalizePartitionKey(partitionKey) !== expectedPartitionKey) {
      throw new Error(
        `Messaging partition parent ${schema}.${table} uses ${partitionKey}, expected ${expectedPartitionKey}`,
      );
    }
  }

  /**
   * Creates a single partition table if it does not already exist.
   */
  private async createPartitionIfNotExists(
    schema: string,
    table: string,
    year: number,
    month: number,
  ): Promise<void> {
    const paddedMonth = String(month).padStart(2, '0');
    const partitionName = `${table}_${year}_${paddedMonth}`;

    this.assertSafeIdentifier(schema, 'schema');
    this.assertSafeIdentifier(table, 'table');
    const sql = createMonthlyPartition(schema, table, year, month);

    try {
      await this.dataSource.query(sql);
      this.logger.log(`Partition ensured: ${schema}.${partitionName}`);
    } catch (err) {
      const message = (err as Error).message;
      // PostgreSQL raises an error if the partition already overlaps — safe to ignore
      if (message.includes('already exists') || message.includes('overlaps')) {
        this.logger.debug(`Partition already exists: ${schema}.${partitionName}`);
      } else {
        this.logger.error(`Failed to create partition ${schema}.${partitionName}: ${message}`);
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

  private assertSafeIdentifier(value: string, label: 'schema' | 'table'): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      throw new Error(`Invalid ${label} name: ${value}`);
    }
  }

  private normalizePartitionKey(partitionKey: string): string {
    return partitionKey.replace(/\s+/g, ' ').trim();
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
