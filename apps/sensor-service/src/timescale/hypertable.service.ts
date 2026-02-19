import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Hypertable Service
 *
 * Runtime introspection helpers for TimescaleDB hypertables.
 * Allows application code to query chunk intervals, compression
 * status, and size without embedding raw SQL everywhere.
 *
 * CRITICAL-005: Previously a 1-line stub.
 */
@Injectable()
export class HypertableService {
  private readonly logger = new Logger(HypertableService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns the number of chunks in a hypertable.
   * Useful for monitoring and alerting.
   */
  async getChunkCount(hypertable: string): Promise<number> {
    const rows: Array<{ cnt: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS cnt
       FROM timescaledb_information.chunks
       WHERE hypertable_name = $1`,
      [hypertable],
    );
    return parseInt(rows[0]?.cnt ?? '0', 10);
  }

  /**
   * Returns approximate compressed / uncompressed size in bytes.
   */
  async getSize(hypertable: string): Promise<{
    totalBytes: number;
    compressedBytes: number;
    uncompressedBytes: number;
  }> {
    const rows: Array<{
      total_bytes: string;
      compressed_total_bytes: string | null;
    }> = await this.dataSource.query(
      `SELECT
         hypertable_size($1::regclass) AS total_bytes,
         compressed_total_bytes
       FROM timescaledb_information.hypertable_compression_stats
       WHERE hypertable_name = $1
       LIMIT 1`,
      [hypertable],
    );

    const row = rows[0];
    const totalBytes       = parseInt(row?.total_bytes ?? '0', 10);
    const compressedBytes  = parseInt(row?.compressed_total_bytes ?? '0', 10);
    return {
      totalBytes,
      compressedBytes,
      uncompressedBytes: totalBytes - compressedBytes,
    };
  }

  /**
   * Returns the chunk time interval configured for a hypertable.
   */
  async getChunkInterval(hypertable: string): Promise<string | null> {
    const rows: Array<{ time_interval: string }> = await this.dataSource.query(
      `SELECT time_interval::text
       FROM timescaledb_information.dimensions
       WHERE hypertable_name = $1
         AND dimension_type  = 'Time'
       LIMIT 1`,
      [hypertable],
    );
    return rows[0]?.time_interval ?? null;
  }
}
