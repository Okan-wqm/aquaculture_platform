import {
  getTenantSchemaName,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { MinioClientService } from '@platform/storage';

import { TelemetryRetentionOrchestratorService } from '../telemetry-retention-orchestrator.service';
import {
  ARCHIVE_CODEC_ID_V2,
  ARCHIVE_FILE_EXTENSION_V2,
  ARCHIVE_FORMAT_VERSION_V2,
  type ArchiveManifest,
  type ArchiveRow,
  encodeParquetArchive,
} from './telemetry-archive-codec';

/** Rows fetched per round trip while streaming a tenant-day into the writer. */
const EXPORT_PAGE_SIZE = 5_000;

/**
 * Task 6 (SENSOR-HIGH-095, SENSOR-HIGH-105): the export half of the
 * verify-then-drop chain.
 *
 * exportTenantDay() snapshots one tenant's raw telemetry for one UTC day
 * inside a REPEATABLE READ transaction, captures the snapshot identity
 * (txid_current_snapshot + WAL LSN) as provenance, streams the rows in the
 * table's PK order into a version-2 Parquet artifact, uploads it to the
 * tenant's object-storage prefix, and appends the EXPORT_STARTED → EXPORTED
 * transitions (with the manifest) to the Task 4 ledger. VERIFIED is NOT
 * written here — only the independent verifier (separate service, separate
 * read path) may append it.
 */
@Injectable()
export class TelemetryParquetExporterService {
  private readonly logger = new Logger(TelemetryParquetExporterService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly storage: MinioClientService,
    private readonly ledger: TelemetryRetentionOrchestratorService,
  ) {}

  /**
   * Export one tenant-day. Returns the manifest recorded on the EXPORTED
   * ledger event.
   */
  async exportTenantDay(tenantId: string, day: string): Promise<ArchiveManifest> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error(`day must be YYYY-MM-DD; got ${JSON.stringify(day)}`);
    }
    const tenantSchema = validateTenantSchemaName(getTenantSchemaName(tenantId));
    const rangeStart = new Date(`${day}T00:00:00.000Z`);
    const rangeEnd = new Date(rangeStart.getTime() + 24 * 60 * 60 * 1000);
    const operationId = crypto.randomUUID();
    const objectKey = this.objectKeyFor(tenantId, day);
    const actor = 'telemetry-parquet-exporter';

    await this.ledger.append({
      operationId,
      tenantId,
      tenantSchema,
      rangeStart,
      rangeEnd,
      state: 'EXPORT_STARTED',
      objectKey,
      actor,
    });

    // REPEATABLE READ: the row set, COUNT(*) and min/max all read the SAME
    // snapshot; the snapshot identity is recorded so the verifier's manifest
    // comparison is provably against this exact view of the data. The Parquet
    // encode runs INSIDE the transaction because it is what consumes the row
    // stream — the snapshot has to outlive the last page.
    const exported = await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const provenance: Array<Record<string, unknown>> = await manager.query(
        `SELECT txid_current_snapshot()::text AS snapshot, pg_current_wal_lsn()::text AS lsn`,
      );
      const snapshot = String(provenance[0]?.['snapshot'] ?? '');
      const lsnValue = provenance[0]?.['lsn'];
      const lsn = lsnValue === null || lsnValue === undefined ? null : String(lsnValue);

      const stats: Array<Record<string, unknown>> = await manager.query(
        `SELECT COUNT(*)::bigint AS count, MIN(time) AS min, MAX(time) AS max
           FROM "${tenantSchema}".sensor_metrics
          WHERE time >= $1 AND time < $2`,
        [rangeStart, rangeEnd],
      );
      const sourceRowCount = Number(stats[0]?.['count'] ?? 0);
      const minTime = toIsoTimestampOrNull(stats[0]?.['min']);
      const maxTime = toIsoTimestampOrNull(stats[0]?.['max']);

      const archive = await encodeParquetArchive(
        { tenantId, tenantSchema, day },
        this.streamTenantDay(manager, tenantSchema, rangeStart, rangeEnd),
      );

      if (archive.rowCount !== sourceRowCount) {
        // The REPEATABLE READ snapshot makes this unreachable in theory; the
        // guard exists so a future refactor cannot silently export a partial
        // day with a manifest claiming the full count.
        throw new Error(
          `Export row drift for ${tenantSchema} ${day}: streamed ${archive.rowCount}, ` +
            `COUNT(*) said ${sourceRowCount}`,
        );
      }
      if (archive.minTime !== minTime || archive.maxTime !== maxTime) {
        // Same reasoning one level deeper: the encoded range must be the range
        // the aggregate reported, or the manifest describes a different day
        // than the file holds.
        throw new Error(
          `Export range drift for ${tenantSchema} ${day}: encoded ` +
            `${String(archive.minTime)}..${String(archive.maxTime)}, aggregate said ` +
            `${String(minTime)}..${String(maxTime)}`,
        );
      }

      const manifest: ArchiveManifest = {
        format: ARCHIVE_FORMAT_VERSION_V2,
        codec: ARCHIVE_CODEC_ID_V2,
        objectKey,
        sourceRowCount,
        sourceSnapshot: snapshot,
        sourceWalLsn: lsn,
        minTime,
        maxTime,
        sha256: archive.sha256,
        bytes: archive.bytes.length,
      };
      return { manifest, bytes: archive.bytes };
    });

    await this.storage.uploadFile(
      tenantId,
      'telemetry-archive',
      day,
      this.fileNameFor(day),
      exported.bytes,
      { contentType: 'application/vnd.apache.parquet' },
    );

    // The ledger stores the identity, not the payload.
    const manifest = exported.manifest;
    await this.ledger.append({
      operationId,
      tenantId,
      tenantSchema,
      rangeStart,
      rangeEnd,
      state: 'EXPORTED',
      objectKey,
      sourceRowCount: String(manifest.sourceRowCount),
      sourceSnapshot: manifest.sourceSnapshot,
      parquetSha256: manifest.sha256,
      actor,
    });

    this.logger.log(
      `Exported ${tenantSchema} ${day}: ${manifest.sourceRowCount} rows, ` +
        `sha256=${manifest.sha256.slice(0, 12)}…`,
    );
    return manifest;
  }

  /** The storage-lib path layout for a tenant-day artifact. */
  objectKeyFor(tenantId: string, day: string): string {
    return this.storage.generateFilePath(tenantId, 'telemetry-archive', day, this.fileNameFor(day));
  }

  private fileNameFor(day: string): string {
    return `raw.${day}.${ARCHIVE_FILE_EXTENSION_V2}`;
  }

  /**
   * PK-order streaming: (time, sensor_id, channel_id) — deterministic,
   * resumable, and the order the verifier re-reads in. Pages rather than
   * materializing the day so a large tenant-day never has to fit in memory as
   * rows; only the encoded Parquet bytes do.
   */
  private async *streamTenantDay(
    manager: EntityManager,
    tenantSchema: string,
    rangeStart: Date,
    rangeEnd: Date,
  ): AsyncGenerator<ArchiveRow> {
    for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
      const rows: Array<Record<string, unknown>> = await manager.query(
        `SELECT time AS time, sensor_id::text AS "sensorId",
                channel_id::text AS "channelId", tenant_id::text AS "tenantId",
                raw_value AS "rawValue", value AS "value",
                quality_code AS "qualityCode", quality_bits AS "qualityBits",
                source_protocol AS "sourceProtocol", source_timestamp AS "sourceTimestamp"
           FROM "${tenantSchema}".sensor_metrics
          WHERE time >= $1 AND time < $2
          ORDER BY time, sensor_id, channel_id
          LIMIT $3 OFFSET $4`,
        [rangeStart, rangeEnd, EXPORT_PAGE_SIZE, offset],
      );
      if (rows.length === 0) return;
      for (const row of rows) yield toArchiveRow(row);
      if (rows.length < EXPORT_PAGE_SIZE) return;
    }
  }
}

/**
 * Map a raw PG row (snake_case columns, driver-typed timestamps) onto the
 * codec's fixed ArchiveRow shape — explicit field-by-field, no cast.
 */
function toArchiveRow(row: Record<string, unknown>): ArchiveRow {
  return {
    time: toIsoTimestamp(row['time'], 'time'),
    sensorId: String(row['sensorId']),
    channelId: String(row['channelId']),
    tenantId: String(row['tenantId']),
    rawValue: Number(row['rawValue']),
    value: Number(row['value']),
    qualityCode: Number(row['qualityCode']),
    qualityBits: Number(row['qualityBits']),
    sourceProtocol: row['sourceProtocol'] === null ? null : String(row['sourceProtocol']),
    sourceTimestamp: toIsoTimestampOrNull(row['sourceTimestamp']),
  };
}

/**
 * Timestamps land in the archive as canonical ISO-8601 UTC, never as whatever
 * the driver or the session timezone happened to render. A `timestamptz`
 * arrives as a Date; a text-cast value arrives as a string in PostgreSQL's own
 * output format, which is not ISO-8601 and not timezone-portable.
 */
function toIsoTimestamp(value: unknown, field: string): string {
  const iso = toIsoTimestampOrNull(value);
  if (iso === null) throw new Error(`Telemetry archive column ${field} must be a timestamp`);
  return iso;
}

function toIsoTimestampOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const timestamp = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`Telemetry archive timestamp ${JSON.stringify(String(value))} is unreadable`);
  }
  return timestamp.toISOString();
}
