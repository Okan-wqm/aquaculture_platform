import {
  getTenantSchemaName,
  queryRowsNormalized,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, QueryRunner } from 'typeorm';

import type {
  TelemetryArchiveRangeRequest,
  TelemetryArchiveSnapshot,
  TelemetryArchiveSourcePort,
  TelemetryRawRow,
} from './telemetry-archive-coordinator.service';

interface SnapshotRow {
  readonly snapshotId: string;
  readonly walLsn: string;
}

@Injectable()
export class PostgresTelemetryArchiveSourceService implements TelemetryArchiveSourcePort {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async capture<T>(
    request: TelemetryArchiveRangeRequest,
    consume: (
      snapshot: TelemetryArchiveSnapshot,
      rows: AsyncIterable<TelemetryRawRow>,
    ) => Promise<T>,
  ): Promise<T> {
    const schema = validateTenantSchemaName(getTenantSchemaName(request.tenantId));
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction('REPEATABLE READ');
      await runner.query('SET TRANSACTION READ ONLY');
      await runner.query(
        `SELECT set_config('app.current_tenant', $1, true),
                set_config('search_path', 'pg_catalog', true)`,
        [request.tenantId],
      );
      const snapshotRows = queryRowsNormalized<SnapshotRow>(
        await runner.query(
          `SELECT pg_export_snapshot() AS "snapshotId",
                  pg_current_wal_lsn()::text AS "walLsn"`,
        ),
      );
      const snapshot = snapshotRows[0];
      if (!snapshot?.snapshotId || !snapshot.walLsn) {
        throw new Error('Telemetry archive snapshot did not return snapshotId and WAL LSN');
      }

      const result = await consume(snapshot, this.streamRows(runner, schema, request));
      await runner.commitTransaction();
      return result;
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async *streamRows(
    runner: QueryRunner,
    schema: string,
    request: TelemetryArchiveRangeRequest,
  ): AsyncGenerator<TelemetryRawRow> {
    const stream = await runner.stream(
      `SELECT time AS "time",
              sensor_id AS "sensorId",
              channel_id AS "channelId",
              tenant_id AS "tenantId",
              raw_value AS "rawValue",
              value AS "value",
              quality_code AS "qualityCode",
              quality_bits AS "qualityBits",
              source_event_id AS "sourceEventId",
              source_timestamp AS "sourceTimestamp",
              source_sequence::text AS "sourceSequence",
              site_id AS "siteId",
              department_id AS "departmentId",
              system_id AS "systemId",
              equipment_id AS "equipmentId",
              tank_id AS "tankId",
              pond_id AS "pondId",
              farm_id AS "farmId",
              source_protocol AS "sourceProtocol",
              ingestion_latency_ms AS "ingestionLatencyMs",
              batch_id AS "batchId"
         FROM "${schema}".sensor_metrics
        WHERE time >= $1::timestamptz
          AND time < $2::timestamptz
          AND tenant_id = $3::uuid
        ORDER BY time, sensor_id, channel_id`,
      [request.rangeStart, request.rangeEnd, request.tenantId],
    );
    const unknownRows: AsyncIterable<unknown> = stream;
    for await (const row of unknownRows) yield parseTelemetryRow(row, request.tenantId);
  }
}

function parseTelemetryRow(value: unknown, expectedTenantId: string): TelemetryRawRow {
  if (!isRecord(value)) throw new Error('Telemetry archive source returned a non-object row');
  const tenantId = requiredString(value, 'tenantId');
  if (tenantId !== expectedTenantId) {
    throw new Error('Telemetry archive source returned a row from another tenant');
  }
  return {
    time: requiredTimestamp(value, 'time'),
    sensorId: requiredString(value, 'sensorId'),
    channelId: requiredString(value, 'channelId'),
    tenantId,
    rawValue: requiredNumber(value, 'rawValue'),
    value: requiredNumber(value, 'value'),
    qualityCode: requiredInteger(value, 'qualityCode'),
    qualityBits: requiredInteger(value, 'qualityBits'),
    sourceEventId: optionalString(value, 'sourceEventId'),
    sourceTimestamp: optionalTimestamp(value, 'sourceTimestamp'),
    sourceSequence: optionalString(value, 'sourceSequence'),
    siteId: optionalString(value, 'siteId'),
    departmentId: optionalString(value, 'departmentId'),
    systemId: optionalString(value, 'systemId'),
    equipmentId: optionalString(value, 'equipmentId'),
    tankId: optionalString(value, 'tankId'),
    pondId: optionalString(value, 'pondId'),
    farmId: optionalString(value, 'farmId'),
    sourceProtocol: optionalString(value, 'sourceProtocol'),
    ingestionLatencyMs: optionalInteger(value, 'ingestionLatencyMs'),
    batchId: optionalString(value, 'batchId'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Telemetry archive source field ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`Telemetry archive source field ${field} must be a string or null`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Telemetry archive source field ${field} must be a finite number`);
}

function requiredInteger(record: Record<string, unknown>, field: string): number {
  const value = requiredNumber(record, field);
  if (!Number.isInteger(value))
    throw new Error(`Telemetry archive source field ${field} must be an integer`);
  return value;
}

function optionalInteger(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  return requiredInteger(record, field);
}

function requiredTimestamp(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (value instanceof Date) return value.toISOString();
  const text = requiredString(record, field);
  const timestamp = new Date(text);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`Telemetry archive source field ${field} must be a timestamp`);
  }
  return timestamp.toISOString();
}

function optionalTimestamp(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  return requiredTimestamp(record, field);
}
