import { isValidUUID } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { TelemetryArchiveManifest } from './telemetry-archive-coordinator.service';

export type TelemetryArchiveState =
  | 'EXPORT_STARTED'
  | 'EXPORTED'
  | 'VERIFIED'
  | 'DROPPED'
  | 'FAILED';

export interface AppendTelemetryArchiveEvent {
  readonly operationId: string;
  readonly tenantId: string;
  readonly state: TelemetryArchiveState;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly supersedesOperationId?: string;
  readonly objectKey?: string;
  readonly rowCount?: number;
  readonly sha256?: string;
  readonly schemaVersion?: number;
  readonly snapshotId?: string;
  readonly walLsn?: string;
  readonly errorMessage?: string;
  readonly bucketName?: string;
  readonly objectVersionId?: string;
  readonly archiveFormat?: 'PARQUET';
  readonly minTime?: string;
  readonly maxTime?: string;
}

@Injectable()
export class TelemetryArchiveLifecycleService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async append(event: AppendTelemetryArchiveEvent): Promise<string> {
    if (!isValidUUID(event.operationId) || !isValidUUID(event.tenantId)) {
      throw new Error('Archive operationId and tenantId must be UUIDs');
    }
    if (event.supersedesOperationId !== undefined && !isValidUUID(event.supersedesOperationId)) {
      throw new Error('Archive supersedesOperationId must be a UUID');
    }
    const rangeStart = new Date(event.rangeStart);
    const rangeEnd = new Date(event.rangeEnd);
    if (
      !Number.isFinite(rangeStart.getTime()) ||
      !Number.isFinite(rangeEnd.getTime()) ||
      rangeStart >= rangeEnd
    ) {
      throw new Error('Archive range must contain valid timestamps with rangeStart < rangeEnd');
    }
    if (event.state === 'DROPPED') {
      throw new Error('Raw telemetry drop is disabled until LEGAL-001 is approved');
    }

    const rows: Array<{ event_id: string }> = await this.dataSource.query(
      `SELECT sensor.append_telemetry_archive_event_v2(
         $1::uuid, $2::uuid, $3::text, $4::timestamptz, $5::timestamptz,
         $6::uuid, $7::text, $8::bigint, $9::text, $10::integer,
         $11::text, $12::text, $13::text, $14::text, $15::text,
         $16::text, $17::timestamptz, $18::timestamptz
       ) AS event_id`,
      [
        event.operationId,
        event.tenantId,
        event.state,
        rangeStart.toISOString(),
        rangeEnd.toISOString(),
        event.supersedesOperationId ?? null,
        event.objectKey ?? null,
        event.rowCount ?? null,
        event.sha256 ?? null,
        event.schemaVersion ?? null,
        event.snapshotId ?? null,
        event.walLsn ?? null,
        event.errorMessage ?? null,
        event.bucketName ?? null,
        event.objectVersionId ?? null,
        event.archiveFormat ?? null,
        event.minTime ?? null,
        event.maxTime ?? null,
      ],
    );
    const eventId = rows[0]?.event_id;
    if (!eventId) {
      throw new Error('Archive lifecycle function returned no event id');
    }
    return eventId;
  }

  async getManifest(
    operationId: string,
    state: 'EXPORTED' | 'VERIFIED',
  ): Promise<TelemetryArchiveManifest> {
    if (!isValidUUID(operationId)) throw new Error('Archive operationId must be a UUID');
    const rows: Array<{
      operationId: string;
      tenantId: string;
      bucket: string;
      objectKey: string;
      objectVersionId: string;
      rangeStart: Date;
      rangeEnd: Date;
      rowCount: string;
      minTime: Date | null;
      maxTime: Date | null;
      schemaVersion: number;
      snapshotId: string;
      walLsn: string;
      sha256: string;
      createdAt: Date;
    }> = await this.dataSource.query(
      `SELECT operation_id AS "operationId",
              tenant_id AS "tenantId",
              bucket_name AS bucket,
              object_key AS "objectKey",
              object_version_id AS "objectVersionId",
              range_start AS "rangeStart",
              range_end AS "rangeEnd",
              row_count::text AS "rowCount",
              min_time AS "minTime",
              max_time AS "maxTime",
              schema_version AS "schemaVersion",
              snapshot_id AS "snapshotId",
              wal_lsn AS "walLsn",
              sha256,
              recorded_at AS "createdAt"
         FROM sensor.telemetry_archive_events
        WHERE operation_id = $1::uuid AND state = $2::text`,
      [operationId, state],
    );
    const row = rows[0];
    if (row === undefined || rows.length !== 1) {
      throw new Error(`Authoritative ${state} telemetry archive manifest was not found`);
    }
    const rowCount = Number(row.rowCount);
    if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
      throw new Error('Authoritative telemetry archive manifest has an invalid row count');
    }
    return {
      operationId: row.operationId,
      tenantId: row.tenantId,
      bucket: row.bucket,
      objectKey: row.objectKey,
      objectVersionId: row.objectVersionId,
      format: 'PARQUET',
      rangeStart: row.rangeStart.toISOString(),
      rangeEnd: row.rangeEnd.toISOString(),
      rowCount,
      minTime: row.minTime === null ? null : row.minTime.toISOString(),
      maxTime: row.maxTime === null ? null : row.maxTime.toISOString(),
      schemaVersion: row.schemaVersion,
      snapshotId: row.snapshotId,
      walLsn: row.walLsn,
      sha256: row.sha256,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
