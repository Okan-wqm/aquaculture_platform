import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SensorMetricInput } from '../database/entities/sensor-metric.entity';

/**
 * Batch Processor Service
 *
 * Accumulates sensor metric rows in an in-process buffer and flushes them
 * to TimescaleDB in a single parameterized INSERT every 500 ms or when the
 * buffer reaches 500 rows — whichever comes first.
 *
 * CRITICAL-005: Previously a 1-line stub. This implementation provides the
 * batching layer described in the architecture documentation.
 *
 * Usage:
 *   Inject BatchProcessorService and call enqueue() instead of issuing
 *   individual INSERT statements in the hot MQTT path.
 */
@Injectable()
export class BatchProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BatchProcessorService.name);

  private readonly buffer: SensorMetricInput[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly MAX_BUFFER_SIZE   = 500;
  private static readonly PARAMS_PER_ROW    = 19;
  private static readonly MAX_PG_PARAMS     = 65535;
  private static readonly CHUNK_SIZE        = Math.floor(
    BatchProcessorService.MAX_PG_PARAMS / BatchProcessorService.PARAMS_PER_ROW,
  ); // ≈ 3449, capped to 1000 for safety
  private static readonly SAFE_CHUNK        = Math.min(
    BatchProcessorService.CHUNK_SIZE,
    1000,
  );

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) =>
        this.logger.error(`Batch flush failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, BatchProcessorService.FLUSH_INTERVAL_MS);

    this.logger.log(
      `BatchProcessorService started — flush every ${BatchProcessorService.FLUSH_INTERVAL_MS} ms ` +
      `or at ${BatchProcessorService.MAX_BUFFER_SIZE} rows`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush on shutdown
    await this.flush();
    this.logger.log('BatchProcessorService stopped');
  }

  /**
   * Enqueue a metric for buffered batch insertion.
   * If the buffer reaches MAX_BUFFER_SIZE the flush is triggered immediately.
   */
  enqueue(metric: SensorMetricInput): void {
    this.buffer.push(metric);
    if (this.buffer.length >= BatchProcessorService.MAX_BUFFER_SIZE) {
      this.flush().catch((err) =>
        this.logger.error(`Eager batch flush failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  /**
   * Enqueue multiple metrics at once.
   */
  enqueueBatch(metrics: SensorMetricInput[]): void {
    for (const m of metrics) {
      this.enqueue(m);
    }
  }

  /**
   * Drain the buffer and write all accumulated metrics to sensor_metrics.
   * Uses parameterized queries chunked to stay within PostgreSQL's 65 535
   * parameter limit.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);
    const valid: SensorMetricInput[] = [];

    for (const m of batch) {
      if (!this.isValidUUID(m.sensorId)) {
        this.logger.warn(`Invalid sensor UUID dropped: ${m.sensorId}`, 'BatchProcessor');
        continue;
      }
      if (!this.isValidUUID(m.channelId)) {
        this.logger.warn(`Invalid channel UUID dropped: ${m.channelId}`, 'BatchProcessor');
        continue;
      }
      if (!this.isValidUUID(m.tenantId)) {
        this.logger.warn(`Invalid tenant UUID dropped: ${m.tenantId}`, 'BatchProcessor');
        continue;
      }
      valid.push(m);
    }

    if (valid.length === 0) return;

    // Process in chunks to stay within PG parameter limits
    for (let i = 0; i < valid.length; i += BatchProcessorService.SAFE_CHUNK) {
      const chunk = valid.slice(i, i + BatchProcessorService.SAFE_CHUNK);
      await this.insertChunk(chunk);
    }

    this.logger.debug(`Batch flushed ${valid.length} metrics`);
  }

  private async insertChunk(metrics: SensorMetricInput[]): Promise<void> {
    const params: unknown[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;

    for (const m of metrics) {
      const rowPlaceholders: string[] = [];
      for (let i = 0; i < BatchProcessorService.PARAMS_PER_ROW; i++) {
        rowPlaceholders.push(`$${paramIdx++}`);
      }
      placeholders.push(`(${rowPlaceholders.join(', ')})`);

      params.push(
        m.time.toISOString(),
        m.sensorId,
        m.channelId,
        m.tenantId,
        m.siteId       || null,
        m.departmentId || null,
        m.systemId     || null,
        m.equipmentId  || null,
        m.tankId       || null,
        m.pondId       || null,
        m.farmId       || null,
        Number.isFinite(m.rawValue) ? m.rawValue : 0,
        Number.isFinite(m.value)    ? m.value    : 0,
        Number.isInteger(m.qualityCode)  ? m.qualityCode  : 192,
        Number.isInteger(m.qualityBits)  ? m.qualityBits  : 0,
        m.sourceProtocol ? m.sourceProtocol.replace(/[^a-zA-Z0-9_-]/g, '') : null,
        m.sourceTimestamp?.toISOString() || null,
        m.sourceTimestamp ? Date.now() - m.sourceTimestamp.getTime() : null,
        m.batchId || null,
      );
    }

    await this.dataSource.query(
      `INSERT INTO sensor.sensor_metrics (
         time, sensor_id, channel_id, tenant_id,
         site_id, department_id, system_id, equipment_id, tank_id, pond_id, farm_id,
         raw_value, value, quality_code, quality_bits,
         source_protocol, source_timestamp, ingestion_latency_ms, batch_id
       ) VALUES ${placeholders.join(',\n')}
       ON CONFLICT (time, sensor_id, channel_id) DO UPDATE SET
         value        = EXCLUDED.value,
         raw_value    = EXCLUDED.raw_value,
         quality_code = EXCLUDED.quality_code`,
      params,
    );
  }

  private isValidUUID(str: string | null | undefined): boolean {
    if (!str) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }
}
