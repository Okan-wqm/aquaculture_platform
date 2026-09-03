import {
  getTenantSchemaName,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';

import { MinioClientService } from '@platform/storage';

import { TelemetryRetentionOrchestratorService } from '../telemetry-retention-orchestrator.service';
import {
  type ArchiveHeader,
  type ArchiveManifest,
  type ArchiveRow,
  encodeHeader,
  encodeRow,
  encodeTrailer,
} from './telemetry-archive-codec';

/**
 * Task 6 (SENSOR-HIGH-095): the export half of the verify-then-drop chain.
 *
 * exportTenantDay() snapshots one tenant's raw telemetry for one UTC day
 * inside a REPEATABLE READ transaction, captures the snapshot identity
 * (txid_current_snapshot + WAL LSN) as provenance, serializes the rows in
 * the table's PK order through the deterministic codec, uploads the
 * artifact to the tenant's object-storage prefix, and appends the
 * EXPORT_STARTED → EXPORTED transitions (with the manifest) to the Task 4
 * ledger. VERIFIED is NOT written here — only the independent verifier
 * (separate service, separate read path) may append it.
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
    // comparison is provably against this exact view of the data.
    const manifest = await this.dataSource.transaction(
      'REPEATABLE READ',
      async (manager) => {
        const provenance = await manager.query(
          `SELECT txid_current_snapshot()::text AS snapshot, pg_current_wal_lsn()::text AS lsn`,
        );
        const snapshot: string = provenance[0]?.snapshot ?? '';
        const lsn: string | null = provenance[0]?.lsn ?? null;

        const stats = await manager.query(
          `SELECT COUNT(*)::bigint AS count, MIN(time)::text AS min, MAX(time)::text AS max
             FROM "${tenantSchema}".sensor_metrics
            WHERE time >= $1 AND time < $2`,
          [rangeStart, rangeEnd],
        );
        const sourceRowCount = Number(stats[0]?.count ?? 0);
        const minTime: string | null = stats[0]?.min ?? null;
        const maxTime: string | null = stats[0]?.max ?? null;

        const header = encodeHeader({ tenantId, tenantSchema, day });
        const parts: string[] = [header, '\n'];
        let rowCount = 0;
        const BATCH = 5000;
        // PK-order streaming: (time, sensor_id, channel_id) — deterministic,
        // resumable, and the order the verifier re-reads in.
        for (let offset = 0; ; offset += BATCH) {
          const rows: Array<Record<string, unknown>> = await manager.query(
            `SELECT time::text AS time, sensor_id::text AS "sensorId",
                    channel_id::text AS "channelId", tenant_id::text AS "tenantId",
                    raw_value AS "rawValue", value AS "value",
                    quality_code AS "qualityCode", quality_bits AS "qualityBits",
                    source_protocol AS "sourceProtocol", source_timestamp::text AS "sourceTimestamp"
               FROM "${tenantSchema}".sensor_metrics
              WHERE time >= $1 AND time < $2
              ORDER BY time, sensor_id, channel_id
              LIMIT $3 OFFSET $4`,
            [rangeStart, rangeEnd, BATCH, offset],
          );
          if (rows.length === 0) break;
          for (const r of rows) {
            parts.push(encodeRow(toArchiveRow(r)), '\n');
            rowCount++;
          }
          if (rows.length < BATCH) break;
        }
        parts.push(encodeTrailer(rowCount), '\n');

        if (rowCount !== sourceRowCount) {
          // The REPEATABLE READ snapshot makes this unreachable in theory;
          // the guard exists so a future refactor cannot silently export a
          // partial day with a manifest claiming the full count.
          throw new Error(
            `Export row drift for ${tenantSchema} ${day}: streamed ${rowCount}, ` +
              `COUNT(*) said ${sourceRowCount}`,
          );
        }

        const buffer = Buffer.from(parts.join(''), 'utf8');
        const sha256 = createHash('sha256').update(buffer).digest('hex');

        const manifest: ArchiveManifest = {
          format: 'aqua-telemetry-archive/1',
          codec: 'columnar-jsonl',
          objectKey,
          sourceRowCount,
          sourceSnapshot: snapshot,
          sourceWalLsn: lsn,
          minTime,
          maxTime,
          sha256,
          bytes: buffer.length,
        };
        return { manifest, buffer } as { manifest: ArchiveManifest; buffer: Buffer };
      },
    );

    await this.storage.uploadFile(
      tenantId,
      'telemetry-archive',
      day,
      `raw.${day}.columnar-jsonl`,
      manifest.buffer,
      { contentType: 'application/x-ndjson' },
    );
    // The ledger stores the identity, not the payload.
    const result = manifest as { manifest: ArchiveManifest; buffer: Buffer };
    const ledgerManifest: ArchiveManifest = result.manifest;

    await this.ledger.append({
      operationId,
      tenantId,
      tenantSchema,
      rangeStart,
      rangeEnd,
      state: 'EXPORTED',
      objectKey,
      sourceRowCount: String(ledgerManifest.sourceRowCount),
      sourceSnapshot: ledgerManifest.sourceSnapshot,
      parquetSha256: ledgerManifest.sha256,
      actor,
    });

    this.logger.log(
      `Exported ${tenantSchema} ${day}: ${ledgerManifest.sourceRowCount} rows, ` +
        `sha256=${ledgerManifest.sha256.slice(0, 12)}…`,
    );
    return ledgerManifest;
  }

  /** The storage-lib path layout for a tenant-day artifact. */
  objectKeyFor(tenantId: string, day: string): string {
    return this.storage.generateFilePath(
      tenantId,
      'telemetry-archive',
      day,
      `raw.${day}.columnar-jsonl`,
    );
  }
}

/**
 * Map a raw PG row (snake_case columns, text-cast UUIDs/dates) onto the
 * codec's fixed ArchiveRow shape — explicit field-by-field, no cast.
 */
function toArchiveRow(r: Record<string, unknown>): ArchiveRow {
  return {
    time: String(r['time']),
    sensorId: String(r['sensorId']),
    channelId: String(r['channelId']),
    tenantId: String(r['tenantId']),
    rawValue: Number(r['rawValue']),
    value: Number(r['value']),
    qualityCode: Number(r['qualityCode']),
    qualityBits: Number(r['qualityBits']),
    sourceProtocol: r['sourceProtocol'] === null ? null : String(r['sourceProtocol']),
    sourceTimestamp: r['sourceTimestamp'] === null ? null : String(r['sourceTimestamp']),
  };
}
