import {
  getTenantSchemaName,
  isValidUUID,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
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
  private static readonly RAW_HYPERTABLE = 'sensor_metrics';

  private static readonly CHUNK_CANDIDATES = [
    { hours: 1, interval: '1 hour' },
    { hours: 6, interval: '6 hours' },
    { hours: 24, interval: '24 hours' },
  ] as const;

  private static readonly CHUNK_TARGET_MIDPOINT_BYTES = 384 * 1024 * 1024;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns the number of chunks in a hypertable.
   * Useful for monitoring and alerting.
   */
  async getChunkCount(tenantId: string): Promise<number> {
    const schema = this.getTenantSchema(tenantId);
    const rows: Array<{ cnt: string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS cnt
       FROM timescaledb_information.chunks
       WHERE hypertable_schema = $1
         AND hypertable_name = $2`,
      [schema, HypertableService.RAW_HYPERTABLE],
    );
    return parseInt(rows[0]?.cnt ?? '0', 10);
  }

  /**
   * Returns approximate compressed / uncompressed size in bytes.
   */
  async getSize(tenantId: string): Promise<{
    totalBytes: number;
    compressedBytes: number;
    uncompressedBytes: number;
  }> {
    const schema = this.getTenantSchema(tenantId);
    const relation = `${schema}.${HypertableService.RAW_HYPERTABLE}`;
    const rows: Array<{
      total_bytes: string;
      compressed_total_bytes: string | null;
    }> = await this.dataSource.query(
      `SELECT
         hypertable_size($1::regclass) AS total_bytes,
         COALESCE((
           SELECT compressed_total_bytes
             FROM timescaledb_information.hypertable_compression_stats
            WHERE hypertable_schema = $2
              AND hypertable_name = $3
            LIMIT 1
         ), 0) AS compressed_total_bytes`,
      [relation, schema, HypertableService.RAW_HYPERTABLE],
    );

    const row = rows[0];
    const totalBytes = parseInt(row?.total_bytes ?? '0', 10);
    const compressedBytes = parseInt(row?.compressed_total_bytes ?? '0', 10);
    return {
      totalBytes,
      compressedBytes,
      uncompressedBytes: totalBytes - compressedBytes,
    };
  }

  /**
   * Returns the chunk time interval configured for a hypertable.
   */
  async getChunkInterval(tenantId: string): Promise<string | null> {
    const schema = this.getTenantSchema(tenantId);
    const rows: Array<{ time_interval: string }> = await this.dataSource.query(
      `SELECT time_interval::text
       FROM timescaledb_information.dimensions
       WHERE hypertable_schema = $1
         AND hypertable_name = $2
         AND dimension_type  = 'Time'
       LIMIT 1`,
      [schema, HypertableService.RAW_HYPERTABLE],
    );
    return rows[0]?.time_interval ?? null;
  }

  /**
   * Select the 1h/6h/24h candidate whose projected uncompressed size is
   * closest to the centre of the measured 256–512 MiB operating envelope.
   */
  recommendChunkInterval(measuredBytesPerHour: number): '1 hour' | '6 hours' | '24 hours' {
    if (!Number.isFinite(measuredBytesPerHour) || measuredBytesPerHour <= 0) {
      throw new Error('Measured bytes per hour must be a positive finite number');
    }

    type ChunkCandidate = (typeof HypertableService.CHUNK_CANDIDATES)[number];
    let best: ChunkCandidate = HypertableService.CHUNK_CANDIDATES[0];
    for (const candidate of HypertableService.CHUNK_CANDIDATES.slice(1)) {
      const bestDistance = Math.abs(
        measuredBytesPerHour * best.hours - HypertableService.CHUNK_TARGET_MIDPOINT_BYTES,
      );
      const candidateDistance = Math.abs(
        measuredBytesPerHour * candidate.hours - HypertableService.CHUNK_TARGET_MIDPOINT_BYTES,
      );
      if (candidateDistance < bestDistance) {
        best = candidate;
      }
    }
    return best.interval;
  }

  private getTenantSchema(tenantId: string): string {
    if (!isValidUUID(tenantId)) {
      throw new Error(`Invalid tenant ID for hypertable introspection: ${tenantId}`);
    }
    return validateTenantSchemaName(getTenantSchemaName(tenantId));
  }
}
