import {
  getTenantSchemaName,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { SensorMetricInput } from '../database/entities/sensor-metric.entity';

/**
 * The durable outcome of one enqueued metric's batch, settled per owning
 * tenant: a row's promise resolves ONLY after its tenant's batch committed
 * (ack-after-commit), and rejects when its tenant failed both the write and
 * the single bounded retry — source redelivery then owns later attempts
 * (SENSOR-CRITICAL-087, plan Task 1 Step 1.3).
 */
export interface WriteOutcome {
  tenantId: string;
  committedRows: number;
}

/** A pending enqueue() promise, settled by the flush that owns its row. */
interface FlushWaiter {
  tenantId: string;
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

  private readonly buffer: SensorMetricInput[] = [];
  private readonly waiters: FlushWaiter[] = [];
  /** Serializes flushes so the timer and eager size-trigger never overlap. */
  private flushChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly MAX_BUFFER_SIZE = 500;
  private static readonly PARAMS_PER_ROW = 19;
  private static readonly MAX_PG_PARAMS = 65535;
  // floor(65535 / 19) ≈ 3449, capped to 1000 for plan-cache friendliness.
  private static readonly SAFE_CHUNK = Math.min(
    Math.floor(SensorMetricWriterService.MAX_PG_PARAMS / SensorMetricWriterService.PARAMS_PER_ROW),
    1000,
  );
  /**
   * Transaction-scoped server timeouts for every buffered/immediate tenant
   * batch (plan Task 1 Step 1.3): a hung statement must fail fast so the
   * bounded retry (and then source redelivery) can take over instead of
   * stalling the flush loop past any sane ack_wait. Simple-protocol
   * multi-statement string — no parameters.
   */
  private static readonly TX_TIMEOUT_SQL =
    "SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '1s'";

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
    // Final flush on shutdown so buffered rows are not lost. Waiters are
    // settled inside the flush; a failing tenant must not break the rest of
    // shutdown, so the error is surfaced as a log (each affected waiter has
    // already been rejected with the same error).
    try {
      await this.flush();
    } catch (error) {
      this.logger.error(
        `Final metric flush failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.logger.log('SensorMetricWriterService stopped');
  }

  /**
   * Enqueue a metric for buffered batch insertion and return its durable
   * outcome. The promise resolves only after the row's tenant batch COMMITTED
   * (so a caller may safely ack its source afterwards), or rejects once that
   * tenant failed the write and the single bounded retry — the source's
   * redelivery then owns later attempts. A structurally invalid row is a
   * poison skip: it settles immediately as a zero-row discard, never buffers,
   * and never blocks the rest of the batch. If the buffer reaches
   * MAX_BUFFER_SIZE the flush is triggered immediately.
   */
  enqueue(metric: SensorMetricInput): Promise<WriteOutcome> {
    if (this.filterValid([metric]).length === 0) {
      return Promise.resolve({ tenantId: metric.tenantId, committedRows: 0 });
    }
    return new Promise<WriteOutcome>((resolve, reject) => {
      this.waiters.push({ tenantId: metric.tenantId, resolve, reject });
      this.buffer.push(metric);
      if (this.buffer.length >= SensorMetricWriterService.MAX_BUFFER_SIZE) {
        this.flush().catch((err) =>
          this.logger.error(
            `Eager metric flush failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  /** Enqueue multiple metrics at once; resolves when every row settled. */
  enqueueBatch(metrics: SensorMetricInput[]): Promise<WriteOutcome[]> {
    return Promise.all(metrics.map((m) => this.enqueue(m)));
  }

  /**
   * Drain the buffer. Flushes are serialized: concurrent calls (timer,
   * eager size trigger, shutdown) chain onto the same in-flight drain, and
   * each call's promise reflects its own drain's outcome.
   */
  flush(): Promise<void> {
    const run = this.flushChain.then(() => this.drainBuffer());
    this.flushChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async drainBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const waiters = this.waiters.splice(0, this.waiters.length);
    await this.writeBuffered(batch, waiters);
  }

  /**
   * Write one drained buffer snapshot. Per owning tenant: one write attempt
   * plus a single bounded retry; on success that tenant's waiters resolve
   * with their WriteOutcome, on failure they reject — nobody's waiter is ever
   * silently dropped (the old splice-and-log behavior lost exactly these
   * rows, SENSOR-CRITICAL-087).
   */
  private async writeBuffered(metrics: SensorMetricInput[], waiters: FlushWaiter[]): Promise<void> {
    const valid = this.filterValid(metrics);
    if (valid.length === 0) return;

    const byTenant = this.groupByTenant(valid);
    const failures: string[] = [];
    let written = 0;
    for (const [tenantId, rows] of byTenant) {
      let committed = false;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2 && !committed; attempt++) {
        try {
          await this.insertTenantRows(tenantId, rows);
          committed = true;
        } catch (error) {
          lastError = error;
        }
      }
      if (committed) {
        written += rows.length;
        this.settleTenant(waiters, tenantId, { tenantId, committedRows: rows.length });
      } else {
        const message = `${this.tenantLabel(tenantId)}: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`;
        failures.push(message);
        this.rejectTenant(
          waiters,
          tenantId,
          new Error(`sensor_metrics write failed for ${message}`),
        );
      }
    }

    this.logger.debug(`Wrote ${written} metrics across ${byTenant.size} tenant(s)`);

    if (failures.length > 0) {
      throw new Error(
        `sensor_metrics write failed for ${failures.length} tenant(s): ${failures.join('; ')}`,
      );
    }
  }

  /**
   * Write metrics now on the service's own connection (background paths that do
   * not participate in a caller transaction). Each tenant batch runs inside a
   * transaction bounded by statement/lock timeouts and is chunked to stay
   * within PostgreSQL's 65 535 parameter limit.
   */
  async writeImmediate(metrics: SensorMetricInput[]): Promise<void> {
    const valid = this.filterValid(metrics);
    if (valid.length === 0) return;

    // Background path: attempt EVERY tenant even if one fails, so a single bad
    // tenant cannot discard other tenants' telemetry — then surface every
    // failure. Failures are never swallowed; the caller sees an aggregate error.
    const byTenant = this.groupByTenant(valid);
    const failures: string[] = [];
    let written = 0;
    for (const [tenantId, rows] of byTenant) {
      try {
        await this.insertTenantRows(tenantId, rows);
        written += rows.length;
      } catch (error) {
        failures.push(
          `${this.tenantLabel(tenantId)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.debug(`Wrote ${written} metrics across ${byTenant.size} tenant(s)`);

    if (failures.length > 0) {
      throw new Error(
        `sensor_metrics write failed for ${failures.length} tenant(s): ${failures.join('; ')}`,
      );
    }
  }

  /**
   * One tenant's rows, in one timeout-bounded transaction on the service's
   * own connection: SET LOCAL timeouts (transaction-scoped, auto-reverted,
   * never leaking onto other pool users) then the chunked INSERTs.
   */
  private async insertTenantRows(tenantId: string, rows: SensorMetricInput[]): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(SensorMetricWriterService.TX_TIMEOUT_SQL);
      await this.insertForTenant(tenantId, rows, (sql, params) => manager.query(sql, params));
    });
  }

  /**
   * Write metrics on the caller's transaction manager. Used by the transactional
   * saveReading paths so the metric rows commit atomically with the outbox event
   * in one transaction — do NOT change this atomicity: any failure propagates so
   * the whole transaction rolls back.
   */
  async writeManaged(metrics: SensorMetricInput[], manager: EntityManager): Promise<void> {
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

  /** Resolve exactly the waiters belonging to a committed tenant. */
  private settleTenant(waiters: FlushWaiter[], tenantId: string, outcome: WriteOutcome): void {
    for (const waiter of waiters) {
      if (waiter.tenantId === tenantId) {
        waiter.resolve(outcome);
      }
    }
  }

  /** Reject exactly the waiters belonging to a failed tenant. */
  private rejectTenant(waiters: FlushWaiter[], tenantId: string, error: Error): void {
    for (const waiter of waiters) {
      if (waiter.tenantId === tenantId) {
        waiter.reject(error);
      }
    }
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
         source_protocol, source_timestamp, ingestion_latency_ms, batch_id
       ) VALUES ${rows.join(',\n')}
       ON CONFLICT (time, sensor_id, channel_id) DO UPDATE SET
         value        = EXCLUDED.value,
         raw_value    = EXCLUDED.raw_value,
         quality_code = EXCLUDED.quality_code
       WHERE COALESCE(EXCLUDED.source_timestamp, EXCLUDED.time)
           >= COALESCE(sensor_metrics.source_timestamp, sensor_metrics.time)`;
  }

  /** The single 19-column-per-row parameter marshalling for `sensor.sensor_metrics`. */
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
        m.sourceTimestamp?.toISOString() || null,
        m.sourceTimestamp ? Date.now() - m.sourceTimestamp.getTime() : null,
        m.batchId || null,
      );
    }
    return params;
  }

  private filterValid(metrics: SensorMetricInput[]): SensorMetricInput[] {
    const valid: SensorMetricInput[] = [];
    for (const m of metrics) {
      if (!this.isValidUUID(m.sensorId)) {
        this.logger.warn(`Invalid sensor UUID dropped: ${m.sensorId}`);
        continue;
      }
      if (!this.isValidUUID(m.channelId)) {
        this.logger.warn(`Invalid channel UUID dropped: ${m.channelId}`);
        continue;
      }
      if (!this.isValidUUID(m.tenantId)) {
        this.logger.warn(`Invalid tenant UUID dropped: ${m.tenantId}`);
        continue;
      }
      if (!Number.isFinite(m.rawValue) || !Number.isFinite(m.value)) {
        this.logger.warn(`Non-finite metric dropped — rawValue: ${m.rawValue}, value: ${m.value}`);
        continue;
      }
      valid.push(m);
    }
    return valid;
  }

  private isValidUUID(str: string | null | undefined): boolean {
    if (!str) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }
}
