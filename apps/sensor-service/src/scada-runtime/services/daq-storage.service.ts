/**
 * DaqStorageService — Persistent historical data storage for SCADA tags.
 *
 * Responsibilities:
 *   - Write tag value samples for all DAQ-enabled tags.
 *   - Query raw or aggregated historical data for one or more tags.
 *   - Chunked queries that split large time ranges into 6-hour windows
 *     to avoid memory pressure and allow streaming to clients.
 *   - Periodic cleanup of data beyond the configured retention window.
 *
 * Storage model (TimescaleDB / PostgreSQL):
 *   Table: scada_tag_history
 *     tag_id        TEXT        NOT NULL
 *     timestamp     TIMESTAMPTZ NOT NULL
 *     value         DOUBLE PRECISION
 *     quality       TEXT        (good | bad | uncertain)
 *
 *   The table is expected to be a TimescaleDB hypertable partitioned on
 *   `timestamp`.  A standard PostgreSQL table also works — remove the
 *   time_bucket() calls and replace with date_trunc().
 *
 * Aggregation mapping:
 *   DaqAggregation.function: min | max | avg | sum
 *   DaqAggregation.interval: 1min | 5min | 10min | 30min | 1h | 1d
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  runInTenantTransaction,
  runInTenantRead,
  BypassRlsService,
} from '@aquaculture/backend-common/database';

// TODO: Replace with '@aquaculture/scada-types' path alias when monorepo build supports it.
import type {
  TagValueChange,
  HistoricalDataPoint,
  DaqAggregation,
  DaqResultPayload,
} from '../scada-types';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

/** Width of each chunk for queryChunked (ms). */
const CHUNK_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

/** SQL table name — change to match your migration. */
const TABLE_NAME = 'scada_tag_history';

/** Source schema that owns the cross-tenant SCADA tag-history table. */
const SENSOR_SCHEMA = 'sensor';

/** Mapping from DaqAggregation.interval to a SQL interval literal. */
const INTERVAL_SQL: Record<DaqAggregation['interval'], string> = {
  '1min':  '1 minute',
  '5min':  '5 minutes',
  '10min': '10 minutes',
  '30min': '30 minutes',
  '1h':    '1 hour',
  '1d':    '1 day',
};

/** Mapping from DaqAggregation.function to a SQL aggregate function. */
const AGG_FN_SQL: Record<DaqAggregation['function'], string> = {
  min: 'MIN',
  max: 'MAX',
  avg: 'AVG',
  sum: 'SUM',
};

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

interface RawHistoryRow {
  tag_id: string;
  ts: Date;
  value: number | null;
  quality: string;
}

interface AggregatedRow {
  tag_id: string;
  bucket: Date;
  agg_value: number | null;
}

/** Convert query rows into the HistoricalDataPoint format keyed by tagId. */
function rowsToDataMap(
  tagIds: string[],
  rows: RawHistoryRow[],
): Record<string, HistoricalDataPoint[]> {
  const result: Record<string, HistoricalDataPoint[]> = {};
  for (const id of tagIds) result[id] = [];

  for (const row of rows) {
    (result[row.tag_id] ??= []).push({
      timestamp: row.ts instanceof Date ? row.ts.getTime() : Number(row.ts),
      value: row.value ?? 0,
    });
  }

  return result;
}

function aggRowsToDataMap(
  tagIds: string[],
  rows: AggregatedRow[],
): Record<string, HistoricalDataPoint[]> {
  const result: Record<string, HistoricalDataPoint[]> = {};
  for (const id of tagIds) result[id] = [];

  for (const row of rows) {
    (result[row.tag_id] ??= []).push({
      timestamp: row.bucket instanceof Date ? row.bucket.getTime() : Number(row.bucket),
      value: row.agg_value ?? 0,
    });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Service                                                             */
/* ------------------------------------------------------------------ */

@Injectable()
export class DaqStorageService implements OnModuleInit, OnModuleDestroy {
  /**
   * Scheduled retention (SENSOR-HIGH-053): the live fan-out persists every
   * pushed value, so without a running retention pass scada_tag_history grows
   * without bound. Interval + retention window are env-tunable; retention <= 0
   * disables the schedule explicitly.
   */
  private retentionTimer: ReturnType<typeof setInterval> | null = null;

  onModuleInit(): void {
    // Config rides through Nest ConfigService (config-env-access-ratchet);
    // without a ConfigService (slim test modules) the default window applies.
    const configured = this.configService?.get<string>('SCADA_DAQ_RETENTION_DAYS');
    const retentionDays = Number(configured ?? '30');
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      this.logger.warn(
        `DaqStorage: retention DISABLED (SCADA_DAQ_RETENTION_DAYS=${configured ?? 'unset->30 expected'}) — scada_tag_history will grow unbounded`,
      );
      return;
    }
    const run = async (): Promise<void> => {
      try {
        await this.cleanupOldData(retentionDays);
      } catch {
        // cleanupOldData already logged the failure; the next tick retries.
      }
    };
    // Every 6h; the first pass runs shortly after boot so a long-stopped
    // service trims its backlog without waiting a full interval.
    this.retentionTimer = setInterval(run, 6 * 60 * 60 * 1000);
    setTimeout(run, 60_000).unref?.();
    this.logger.log(`DaqStorage: retention scheduled (every 6h, keep ${retentionDays} day(s))`);
  }

  onModuleDestroy(): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  private readonly logger = new Logger(DaqStorageService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly bypassRls: BypassRlsService,
    @Optional()
    @Inject(ConfigService)
    private readonly configService: ConfigService | null,
  ) {}

  /**
   * Fail-closed tenant guard. `scada_tag_history` is a cross-tenant
   * infrastructure table in the shared `sensor` schema (DB-SENSOR-CRITICAL-001),
   * so every read and write MUST carry a tenant discriminator — an unbound
   * tenant would write rows no tenant owns, or read every tenant's history.
   */
  private assertTenant(tenantId: string): void {
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new Error(
        'DaqStorageService: tenantId is required — SCADA tag history is tenant-scoped and refuses an unbound tenant context',
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Write                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Persist a batch of tag value changes for a tenant.
   *
   * Uses a single parameterised INSERT with multiple value rows for
   * efficiency.  On conflict (same tenant_id + tag_id + timestamp) the row is
   * updated so re-ingestion is idempotent.
   */
  async addValues(tenantId: string, deviceId: string, values: TagValueChange[]): Promise<void> {
    this.assertTenant(tenantId);
    if (values.length === 0) return;

    // Build a multi-row VALUES clause.
    // Each row: (tenant_id, tag_id, timestamp, value, quality)
    const rows: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    for (const change of values) {
      const numVal =
        typeof change.value === 'number'
          ? change.value
          : typeof change.value === 'boolean'
          ? (change.value ? 1 : 0)
          : parseFloat(String(change.value));

      rows.push(`($${pi}, $${pi + 1}, $${pi + 2}, $${pi + 3}, $${pi + 4})`);
      params.push(
        tenantId,
        change.tagId,
        new Date(change.timestamp),
        isNaN(numVal) ? null : numVal,
        change.quality ?? 'good',
      );
      pi += 5;
    }

    const sql = `
      INSERT INTO ${TABLE_NAME} (tenant_id, tag_id, timestamp, value, quality)
      VALUES ${rows.join(', ')}
      ON CONFLICT (tenant_id, tag_id, timestamp)
      DO UPDATE SET
        value   = EXCLUDED.value,
        quality = EXCLUDED.quality
    `;

    try {
      // The fan-out already batches per tenant, so ONE tenant-context
      // transaction per batch sets `app.current_tenant` → the FORCED
      // tenant_isolation_policy ENFORCES the multi-row insert (a mis-stamped
      // tenant_id is refused by Postgres — ORPHAN-414, Tier-1). No per-row tx.
      await runInTenantTransaction(this.dataSource, SENSOR_SCHEMA, tenantId, (qr) =>
        qr.query(sql, params),
      );
      this.logger.debug(
        `DaqStorage: wrote ${values.length} values for device ${deviceId}`,
      );
    } catch (err) {
      this.logger.error(
        `DaqStorage: failed to write values for device ${deviceId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Raw query                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Query raw (unaggregated) historical data for one or more tags
   * within the given time range.
   *
   * Results are ordered ascending by timestamp per tag.
   * Maximum 50 000 rows per tag to prevent runaway queries.
   */
  async queryValues(
    tenantId: string,
    tagIds: string[],
    from: Date,
    to: Date,
  ): Promise<Record<string, HistoricalDataPoint[]>> {
    this.assertTenant(tenantId);
    if (tagIds.length === 0) return {};

    // Tenant fence is the first predicate — a history read is confined to the
    // caller's tenant before any tag/time filtering.
    const sql = `
      SELECT
        tag_id,
        timestamp AS ts,
        value,
        quality
      FROM ${TABLE_NAME}
      WHERE tenant_id = $1
        AND tag_id = ANY($2)
        AND timestamp >= $3
        AND timestamp <  $4
      ORDER BY tag_id, timestamp ASC
      LIMIT 50000
    `;

    try {
      // Tenant-context read so the FORCED RLS policy admits exactly this
      // tenant's history (the leading tenant_id predicate is defence-in-depth).
      const rows: RawHistoryRow[] = await runInTenantRead(
        this.dataSource,
        SENSOR_SCHEMA,
        tenantId,
        (qr) => qr.query(sql, [tenantId, tagIds, from, to]),
      );
      return rowsToDataMap(tagIds, rows);
    } catch (err) {
      this.logger.error('DaqStorage: queryValues failed', err instanceof Error ? err.stack : String(err));
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Aggregated query                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Query aggregated historical data.
   *
   * Uses TimescaleDB time_bucket() when available; falls back to
   * date_trunc() for standard PostgreSQL.  The implementation tries
   * time_bucket() first (it's a superset) — the caller should ensure
   * the TimescaleDB extension is loaded if using it.
   *
   * Results are ordered ascending by bucket per tag.
   */
  async queryAggregated(
    tenantId: string,
    tagIds: string[],
    from: Date,
    to: Date,
    aggregation: DaqAggregation,
  ): Promise<Record<string, HistoricalDataPoint[]>> {
    this.assertTenant(tenantId);
    if (tagIds.length === 0) return {};

    const intervalSql = INTERVAL_SQL[aggregation.interval];
    const aggFnSql = AGG_FN_SQL[aggregation.function];

    if (!intervalSql || !aggFnSql) {
      throw new Error(
        `DaqStorage: unsupported aggregation — fn=${aggregation.function} interval=${aggregation.interval}`,
      );
    }

    // Use time_bucket (TimescaleDB). Wrap in try/catch and fall back to
    // date_trunc if the function is not available. Tenant fence is applied
    // in both variants so an aggregate can never span tenants.
    const sql = `
      SELECT
        tag_id,
        time_bucket($1::INTERVAL, timestamp) AS bucket,
        ${aggFnSql}(value)                   AS agg_value
      FROM ${TABLE_NAME}
      WHERE tenant_id = $2
        AND tag_id = ANY($3)
        AND timestamp >= $4
        AND timestamp <  $5
        AND quality = 'good'
      GROUP BY tag_id, bucket
      ORDER BY tag_id, bucket ASC
    `;

    // Plain PostgreSQL fallback: use buildAggregationBucket() which handles
    // sub-hour intervals (5min, 10min, 30min) with floor-to-interval arithmetic
    // instead of date_trunc (which would collapse them all to 1-minute buckets).
    const bucketExpr = this.buildAggregationBucket(aggregation.interval);

    const fallbackSql = `
      SELECT
        tag_id,
        ${bucketExpr} AS bucket,
        ${aggFnSql}(value)        AS agg_value
      FROM ${TABLE_NAME}
      WHERE tenant_id = $1
        AND tag_id = ANY($2)
        AND timestamp >= $3
        AND timestamp <  $4
        AND quality = 'good'
      GROUP BY tag_id, bucket
      ORDER BY tag_id, bucket ASC
    `;

    // Each variant runs in its own tenant-context read transaction so the
    // FORCED RLS policy admits this tenant's rows. Two transactions (not one)
    // because a failed time_bucket query aborts its transaction, so the
    // date_trunc fallback needs a fresh one.
    let rows: AggregatedRow[];
    try {
      rows = await runInTenantRead(this.dataSource, SENSOR_SCHEMA, tenantId, (qr) =>
        qr.query(sql, [intervalSql, tenantId, tagIds, from, to]),
      );
    } catch {
      // time_bucket not available — use date_trunc fallback
      this.logger.warn(
        'DaqStorage: time_bucket unavailable, falling back to date_trunc',
      );
      rows = await runInTenantRead(this.dataSource, SENSOR_SCHEMA, tenantId, (qr) =>
        qr.query(fallbackSql, [tenantId, tagIds, from, to]),
      );
    }

    return aggRowsToDataMap(tagIds, rows);
  }

  /**
   * Build a SQL expression that floors a timestamp to the requested bucket
   * interval using only standard PostgreSQL functions (no TimescaleDB).
   *
   * For 1-minute, 1-hour, and 1-day intervals date_trunc() is exact.
   * For sub-hour multi-minute intervals (5min, 10min, 30min) we use
   * floor-to-interval arithmetic:
   *   date_trunc('hour', timestamp)
   *     + INTERVAL '1 minute' * (EXTRACT(MINUTE FROM timestamp)::int / N * N)
   *
   * This avoids the old bug where all sub-hour intervals collapsed to 1-minute
   * buckets when using date_trunc('minute', ...).
   */
  private buildAggregationBucket(interval: DaqAggregation['interval']): string {
    switch (interval) {
      case '1min':
        return `date_trunc('minute', timestamp)`;
      case '5min':
        return `date_trunc('hour', timestamp) + INTERVAL '1 minute' * (EXTRACT(MINUTE FROM timestamp)::int / 5 * 5)`;
      case '10min':
        return `date_trunc('hour', timestamp) + INTERVAL '1 minute' * (EXTRACT(MINUTE FROM timestamp)::int / 10 * 10)`;
      case '30min':
        return `date_trunc('hour', timestamp) + INTERVAL '1 minute' * (EXTRACT(MINUTE FROM timestamp)::int / 30 * 30)`;
      case '1h':
        return `date_trunc('hour', timestamp)`;
      case '1d':
        return `date_trunc('day', timestamp)`;
      default:
        return `date_trunc('hour', timestamp)`;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Chunked query                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Split a potentially large time range into 6-hour chunks and invoke
   * the callback for each chunk as it resolves.
   *
   * This lets the calling gateway stream partial results to the client
   * without holding a large result set in memory.
   *
   * The callback receives a DaqResultPayload with:
   *   - queryId:    echoed from the caller
   *   - data:       partial data for this chunk
   *   - hasMore:    true if more chunks will follow
   *   - chunkIndex: 0-based index of this chunk
   */
  async queryChunked(
    tenantId: string,
    tagIds: string[],
    from: Date,
    to: Date,
    chunkCallback: (chunk: DaqResultPayload) => void,
    queryId: string = crypto.randomUUID(),
    aggregation?: DaqAggregation,
  ): Promise<void> {
    this.assertTenant(tenantId);
    if (tagIds.length === 0) {
      chunkCallback({ queryId, data: {}, hasMore: false, chunkIndex: 0 });
      return;
    }

    // Build chunk boundaries
    const chunks: Array<{ from: Date; to: Date }> = [];
    let cursor = from.getTime();
    const end = to.getTime();

    while (cursor < end) {
      const chunkEnd = Math.min(cursor + CHUNK_WINDOW_MS, end);
      chunks.push({ from: new Date(cursor), to: new Date(chunkEnd) });
      cursor = chunkEnd;
    }

    if (chunks.length === 0) {
      chunkCallback({ queryId, data: {}, hasMore: false, chunkIndex: 0 });
      return;
    }

    this.logger.debug(
      `DaqStorage: chunked query ${queryId} — ${chunks.length} chunk(s) ` +
        `from ${from.toISOString()} to ${to.toISOString()}`,
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const hasMore = i < chunks.length - 1;

      let data: Record<string, HistoricalDataPoint[]>;
      if (aggregation) {
        data = await this.queryAggregated(tenantId, tagIds, chunk.from, chunk.to, aggregation);
      } else {
        data = await this.queryValues(tenantId, tagIds, chunk.from, chunk.to);
      }

      chunkCallback({
        queryId,
        data,
        hasMore,
        chunkIndex: i,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Cleanup                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Delete all records older than `retentionDays` days across ALL tenants.
   *
   * This is a genuinely cross-tenant retention sweep with no per-row tenant
   * context (the outbox-worker class), so it runs under the audited
   * `BypassRlsService.withBypass` — under the FORCED tenant_isolation_policy a
   * tenant-less DELETE would silently match zero rows and retention would stall.
   * Bypass is logged at WARN with a greppable label. Returns the deleted count.
   */
  async cleanupOldData(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) {
      throw new RangeError('retentionDays must be a positive integer');
    }

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const sql = `
      DELETE FROM ${TABLE_NAME}
      WHERE timestamp < $1
    `;

    try {
      const deleted = await this.bypassRls.withBypass('scada:cleanup-tag-history', async () => {
        // PostgreSQL pg driver returns [rows, affectedCount] for DML statements.
        const result = await this.dataSource.query(sql, [cutoff]);
        return Array.isArray(result) && result.length > 1 ? Number(result[1]) || 0 : 0;
      });
      this.logger.log(
        `DaqStorage: cleanup removed ${deleted} row(s) older than ${cutoff.toISOString()} ` +
          `(retentionDays=${retentionDays})`,
      );
      return deleted;
    } catch (err) {
      this.logger.error('DaqStorage: cleanupOldData failed', err instanceof Error ? err.stack : String(err));
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Returns the approximate row count in the history table.
   * Uses reltuples for speed (acceptable for monitoring dashboards).
   */
  async getApproxRowCount(): Promise<number> {
    const sql = `
      SELECT reltuples::BIGINT AS count
      FROM pg_class
      WHERE relname = $1
    `;
    try {
      const rows: Array<{ count: string }> = await this.dataSource.query(sql, [TABLE_NAME]);
      return parseInt(rows[0]?.count ?? '0', 10);
    } catch {
      return -1;
    }
  }

  /**
   * Returns the oldest and newest timestamps across ALL tenants' history.
   *
   * A cross-tenant infra diagnostic with no per-row tenant, so it reads under
   * the audited `BypassRlsService.withBypass` — the FORCED policy would
   * otherwise return NULL bounds. For a single-tenant bound, callers should use
   * the tenant-scoped read paths instead.
   */
  async getDataBounds(): Promise<{ oldest: Date | null; newest: Date | null }> {
    const sql = `
      SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest
      FROM ${TABLE_NAME}
    `;
    try {
      return await this.bypassRls.withBypass('scada:tag-history-data-bounds', async () => {
        const rows: Array<{ oldest: Date | null; newest: Date | null }> =
          await this.dataSource.query(sql);
        return rows[0] ?? { oldest: null, newest: null };
      });
    } catch {
      return { oldest: null, newest: null };
    }
  }
}
