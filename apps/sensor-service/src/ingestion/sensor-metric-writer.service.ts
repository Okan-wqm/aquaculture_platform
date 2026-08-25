import {
  getTenantSchemaName,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SensorMetricInput } from '../database/entities/sensor-metric.entity';

export interface WriteOutcome {
  status: 'COMMITTED' | 'POISON';
  reason?: string;
}

export interface MetricQueryExecutor {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

interface BufferedMetric {
  metric: SensorMetricInput;
  resolve: (outcome: WriteOutcome) => void;
  reject: (error: Error) => void;
}

/**
 * Sensor Metric Writer Service
 *
 * SENSOR-MEDIUM-068 (reading-store convergence, Phase 2B): the SINGLE writer for
 * `sensor_metrics`. It owns the one INSERT statement and the one 19-column
 * parameter marshalling; the four ingestion paths that each used to carry a
 * hand-copied INSERT now route through it:
 *
 *   - enqueue() / buffered flush  — high-throughput background paths (the Rust
 *     sidecar NATS consumer, the MQTT edge io_data + adapter paths). Coalesces
 *     rows and flushes every 500 ms or at 500 rows.
 *   - writeImmediate(metrics)     — background paths that write now on the
 *     service's own connection (MQTT io_data).
 *   - writeManaged(metrics, mgr)  — the transactional saveReading paths, which
 *     write metrics + the outbox event atomically in ONE transaction; the
 *     caller's EntityManager is used so atomicity is preserved
 *     (SENSOR-CRITICAL-001 discipline — do not change it).
 *
 * ## Tenant residency: the destination schema is DERIVED FROM THE DATA
 *
 * `sensor_metrics` is a PER-TENANT table: every tenant's telemetry lives in that
 * tenant's own `tenant_<uuid>` schema, never in a shared one. The hard problem
 * this writer solves is that three of its four callers are process-wide
 * singletons (buffered flush, MQTT io_data, the NATS sidecar consumer) with NO
 * request scope and therefore NO ambient `search_path` — historically their
 * unqualified INSERTs landed wherever the pooled session happened to point,
 * which is the real cause of the "split-brain clones" defect. Pinning the table
 * to a shared schema would hide that bug at the cost of tenant isolation.
 *
 * The structural fix (tier-1): a metric row already carries its own `tenantId`,
 * so the destination schema is a pure function of the data. Rows are grouped by
 * tenant and each group is inserted into `"<tenant schema>".sensor_metrics`,
 * resolved through the platform SSoT (`getTenantSchemaName` +
 * `validateTenantSchemaName`) and never string-built. Consequences:
 *
 *   - a singleton with no tenant context still writes to exactly the right
 *     schema, because the schema comes from the row, not from the session;
 *   - a MIXED-tenant batch is impossible to mis-file — it fans out per tenant
 *     instead of silently landing in whichever schema the session resolved;
 *   - `buildInsertSql` cannot be called without a validated schema, so no code
 *     path can emit a schema-less or hand-qualified metric INSERT.
 *
 * Invalid rows are dropped, never written: a row is invalid if any of
 * sensorId/channelId/tenantId is not a UUID, or if value/rawValue is non-finite
 * (Infinity/NaN corrupts TimescaleDB AVG/SUM continuous aggregates). This is the
 * safe, stricter behaviour the MQTT/edge writers already applied; the previous
 * batch-processor coerced non-finite to 0, which silently corrupted aggregates.
 */
@Injectable()
export class SensorMetricWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SensorMetricWriterService.name);

  private readonly buffer: BufferedMetric[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly MAX_BUFFER_SIZE = 500;
  private static readonly PARAMS_PER_ROW = 21;
  private static readonly MAX_PG_PARAMS = 65535;
  // floor(65535 / 21) = 3120, capped to 1000 for plan-cache friendliness.
  private static readonly SAFE_CHUNK = Math.min(
    Math.floor(SensorMetricWriterService.MAX_PG_PARAMS / SensorMetricWriterService.PARAMS_PER_ROW),
    1000,
  );

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) =>
        this.logger.error(
          `Metric flush failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, SensorMetricWriterService.FLUSH_INTERVAL_MS);

    this.logger.log(
      `SensorMetricWriterService started — flush every ${SensorMetricWriterService.FLUSH_INTERVAL_MS} ms ` +
        `or at ${SensorMetricWriterService.MAX_BUFFER_SIZE} rows`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush on shutdown so buffered rows are not lost.
    await this.flush();
    this.logger.log('SensorMetricWriterService stopped');
  }

  /**
   * Enqueue a metric for buffered batch insertion. If the buffer reaches
   * MAX_BUFFER_SIZE the flush is triggered immediately.
   */
  enqueue(metric: SensorMetricInput): Promise<WriteOutcome> {
    const ticket = new Promise<WriteOutcome>((resolve, reject) => {
      this.buffer.push({ metric, resolve, reject });
    });
    if (this.buffer.length >= SensorMetricWriterService.MAX_BUFFER_SIZE) {
      this.flush().catch((err) =>
        this.logger.error(
          `Eager metric flush failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    return ticket;
  }

  /** Enqueue multiple metrics at once for buffered insertion. */
  enqueueBatch(metrics: SensorMetricInput[]): Promise<WriteOutcome[]> {
    return Promise.all(metrics.map((metric) => this.enqueue(metric)));
  }

  /**
   * Drain one immutable buffer snapshot. Each tenant's tickets settle from
   * that tenant's own write, so an unavailable tenant cannot make successfully
   * committed neighbours look failed to their MQTT/NATS callers.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const valid = new Map<string, BufferedMetric[]>();

    for (const item of batch) {
      const invalidReason = this.validationFailure(item.metric);
      if (invalidReason !== null) {
        this.logInvalidMetric(item.metric, invalidReason);
        item.resolve({ status: 'POISON', reason: invalidReason });
        continue;
      }
      const tenantItems = valid.get(item.metric.tenantId);
      if (tenantItems) tenantItems.push(item);
      else valid.set(item.metric.tenantId, [item]);
    }

    const failures: string[] = [];
    for (const [tenantId, items] of valid) {
      try {
        await this.insertForTenant(
          tenantId,
          items.map(({ metric }) => metric),
          (sql, params) => this.dataSource.query(sql, params),
        );
        for (const item of items) item.resolve({ status: 'COMMITTED' });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        for (const item of items) item.reject(cause);
        failures.push(`${this.tenantLabel(tenantId)}: ${cause.message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `sensor_metrics write failed for ${failures.length} tenant(s): ${failures.join('; ')}`,
      );
    }
  }

  /**
   * Write metrics now on the service's own connection (background paths that do
   * not participate in a caller transaction). Chunked to stay within
   * PostgreSQL's 65 535 parameter limit.
   */
  async writeImmediate(metrics: SensorMetricInput[]): Promise<void> {
    const valid = this.filterValid(metrics);
    if (valid.length === 0) return;

    // Background path: attempt EVERY tenant even if one fails, so a single bad
    // tenant cannot discard other tenants' telemetry — then surface every
    // failure. Failures are never swallowed; the caller sees an aggregate error.
    const failures: string[] = [];
    let written = 0;
    for (const [tenantId, rows] of this.groupByTenant(valid)) {
      try {
        await this.insertForTenant(tenantId, rows, (sql, params) =>
          this.dataSource.query(sql, params),
        );
        written += rows.length;
      } catch (error) {
        failures.push(
          `${this.tenantLabel(tenantId)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.debug(
      `Wrote ${written} metrics across ${this.groupByTenant(valid).size} tenant(s)`,
    );

    if (failures.length > 0) {
      throw new Error(
        `sensor_metrics write failed for ${failures.length} tenant(s): ${failures.join('; ')}`,
      );
    }
  }

  /**
   * Write metrics on the caller's transaction manager. Used by the transactional
   * saveReading paths so the metric rows commit atomically with the outbox event
   * in one transaction — do NOT change this atomicity: any failure propagates so
   * the whole transaction rolls back.
   */
  async writeManaged(metrics: SensorMetricInput[], manager: MetricQueryExecutor): Promise<void> {
    const valid = this.filterValid(metrics);
    if (valid.length === 0) return;
    for (const [tenantId, rows] of this.groupByTenant(valid)) {
      await this.insertForTenant(tenantId, rows, (sql, params) => manager.query(sql, params));
    }
  }

  /**
   * Insert one tenant's rows into that tenant's own schema, chunked to stay
   * within PostgreSQL's 65 535 parameter limit. The schema is resolved once per
   * tenant through the platform SSoT and validated before it reaches any SQL.
   */
  private async insertForTenant(
    tenantId: string,
    rows: SensorMetricInput[],
    exec: (sql: string, params: unknown[]) => Promise<unknown>,
  ): Promise<void> {
    const schema = this.resolveTenantSchema(tenantId);
    for (let i = 0; i < rows.length; i += SensorMetricWriterService.SAFE_CHUNK) {
      const chunk = rows.slice(i, i + SensorMetricWriterService.SAFE_CHUNK);
      await exec(this.buildInsertSql(schema, chunk.length), this.marshalParams(chunk));
    }
  }

  /** Group rows by owning tenant — the destination schema is a function of the data. */
  private groupByTenant(metrics: SensorMetricInput[]): Map<string, SensorMetricInput[]> {
    const byTenant = new Map<string, SensorMetricInput[]>();
    for (const m of metrics) {
      const rows = byTenant.get(m.tenantId);
      if (rows) {
        rows.push(m);
      } else {
        byTenant.set(m.tenantId, [m]);
      }
    }
    return byTenant;
  }

  /**
   * The tenant's schema, via the platform SSoT. `validateTenantSchemaName`
   * enforces the `tenant_<16 hex>` shape, so the identifier interpolated into
   * the INSERT can never be attacker-influenced (SEC-M13).
   */
  private resolveTenantSchema(tenantId: string): string {
    return validateTenantSchemaName(getTenantSchemaName(tenantId));
  }

  /** Tenant schema is safe to log; the raw tenant UUID is not (maskPii discipline). */
  private tenantLabel(tenantId: string): string {
    return getTenantSchemaName(tenantId);
  }

  /**
   * The single INSERT statement for a tenant's `sensor_metrics` (N value rows).
   * Preserves the re-publish-updates-the-row contract via ON CONFLICT DO UPDATE.
   *
   * `schema` is REQUIRED and re-validated here: there is no overload that emits a
   * schema-less or shared-schema metric INSERT, so no future caller can route a
   * tenant's telemetry outside that tenant's schema.
   */
  buildInsertSql(schema: string, rowCount: number): string {
    const safeSchema = validateTenantSchemaName(schema);
    const rows: string[] = [];
    let paramIdx = 1;
    for (let r = 0; r < rowCount; r++) {
      const placeholders: string[] = [];
      for (let i = 0; i < SensorMetricWriterService.PARAMS_PER_ROW; i++) {
        placeholders.push(`$${paramIdx++}`);
      }
      rows.push(`(${placeholders.join(', ')})`);
    }
    return `INSERT INTO "${safeSchema}".sensor_metrics (
         time, sensor_id, channel_id, tenant_id,
         site_id, department_id, system_id, equipment_id, tank_id, pond_id, farm_id,
         raw_value, value, quality_code, quality_bits,
         source_protocol, source_event_id, source_timestamp, source_sequence,
         ingestion_latency_ms, batch_id
       ) VALUES ${rows.join(',\n')}
       ON CONFLICT (time, sensor_id, channel_id) DO UPDATE SET
         value        = EXCLUDED.value,
         raw_value    = EXCLUDED.raw_value,
         quality_code = EXCLUDED.quality_code,
         quality_bits = EXCLUDED.quality_bits,
         source_event_id = EXCLUDED.source_event_id,
         source_timestamp = EXCLUDED.source_timestamp,
         source_sequence = EXCLUDED.source_sequence
       WHERE sensor_metrics.source_event_id IS DISTINCT FROM EXCLUDED.source_event_id
         AND (
           COALESCE(EXCLUDED.source_timestamp, '-infinity'::timestamptz),
           COALESCE(EXCLUDED.source_sequence, '-9223372036854775808'::bigint),
           COALESCE(EXCLUDED.source_event_id, '')
         ) > (
           COALESCE(sensor_metrics.source_timestamp, '-infinity'::timestamptz),
           COALESCE(sensor_metrics.source_sequence, '-9223372036854775808'::bigint),
           COALESCE(sensor_metrics.source_event_id, '')
         )`;
  }

  /** The single 21-column-per-row parameter marshalling for tenant sensor metrics. */
  marshalParams(metrics: SensorMetricInput[]): unknown[] {
    const params: unknown[] = [];
    for (const m of metrics) {
      params.push(
        m.time.toISOString(),
        m.sensorId,
        m.channelId,
        m.tenantId,
        m.siteId || null,
        m.departmentId || null,
        m.systemId || null,
        m.equipmentId || null,
        m.tankId || null,
        m.pondId || null,
        m.farmId || null,
        m.rawValue,
        m.value,
        Number.isInteger(m.qualityCode) ? m.qualityCode : 192,
        Number.isInteger(m.qualityBits) ? m.qualityBits : 0,
        m.sourceProtocol ? m.sourceProtocol.replace(/[^a-zA-Z0-9_-]/g, '') : null,
        m.sourceEventId || null,
        m.sourceTimestamp?.toISOString() || null,
        m.sourceSequence || null,
        m.sourceTimestamp ? Date.now() - m.sourceTimestamp.getTime() : null,
        m.batchId || null,
      );
    }
    return params;
  }

  private filterValid(metrics: SensorMetricInput[]): SensorMetricInput[] {
    const valid: SensorMetricInput[] = [];
    for (const m of metrics) {
      const reason = this.validationFailure(m);
      if (reason !== null) {
        this.logInvalidMetric(m, reason);
        continue;
      }
      valid.push(m);
    }
    return valid;
  }

  private validationFailure(metric: SensorMetricInput): string | null {
    if (!this.isValidUUID(metric.sensorId)) return 'INVALID_SENSOR_ID';
    if (!this.isValidUUID(metric.channelId)) return 'INVALID_CHANNEL_ID';
    if (!this.isValidUUID(metric.tenantId)) return 'INVALID_TENANT_ID';
    if (!Number.isFinite(metric.rawValue) || !Number.isFinite(metric.value)) {
      return 'NON_FINITE_VALUE';
    }
    return null;
  }

  private logInvalidMetric(metric: SensorMetricInput, reason: string): void {
    if (reason === 'INVALID_SENSOR_ID') {
      this.logger.warn(`Invalid sensor UUID dropped: ${metric.sensorId}`);
      return;
    }
    if (reason === 'INVALID_CHANNEL_ID') {
      this.logger.warn(`Invalid channel UUID dropped: ${metric.channelId}`);
      return;
    }
    if (reason === 'INVALID_TENANT_ID') {
      this.logger.warn(`Invalid tenant UUID dropped: ${metric.tenantId}`);
      return;
    }
    this.logger.warn(
      `Non-finite metric dropped — rawValue: ${metric.rawValue}, value: ${metric.value}`,
    );
  }

  private isValidUUID(str: string | null | undefined): boolean {
    if (!str) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }
}
