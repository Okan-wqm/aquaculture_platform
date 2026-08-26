import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdtemp, open, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { ParquetReader, ParquetSchema, ParquetWriter } from '@dsnp/parquetjs';
import { Injectable } from '@nestjs/common';

import type {
  TelemetryParquetInspection,
  TelemetryLocalArchiveObject,
  TelemetryParquetArtifact,
  TelemetryParquetPort,
  TelemetryRawRow,
} from './telemetry-archive-coordinator.service';

const OPTIONAL_UTF8_FIELDS = [
  'sourceEventId',
  'sourceTimestamp',
  'sourceSequence',
  'siteId',
  'departmentId',
  'systemId',
  'equipmentId',
  'tankId',
  'pondId',
  'farmId',
  'sourceProtocol',
  'batchId',
] as const;
const TELEMETRY_PARQUET_FORMAT = 'raw-v1';
const TELEMETRY_PARQUET_SCHEMA_VERSION = 1;

const TELEMETRY_PARQUET_SCHEMA = new ParquetSchema({
  time: { type: 'UTF8' },
  sensorId: { type: 'UTF8' },
  channelId: { type: 'UTF8' },
  tenantId: { type: 'UTF8' },
  rawValue: { type: 'DOUBLE' },
  value: { type: 'DOUBLE' },
  qualityCode: { type: 'INT32' },
  qualityBits: { type: 'INT32' },
  sourceEventId: { type: 'UTF8', optional: true },
  sourceTimestamp: { type: 'UTF8', optional: true },
  sourceSequence: { type: 'UTF8', optional: true },
  siteId: { type: 'UTF8', optional: true },
  departmentId: { type: 'UTF8', optional: true },
  systemId: { type: 'UTF8', optional: true },
  equipmentId: { type: 'UTF8', optional: true },
  tankId: { type: 'UTF8', optional: true },
  pondId: { type: 'UTF8', optional: true },
  farmId: { type: 'UTF8', optional: true },
  sourceProtocol: { type: 'UTF8', optional: true },
  ingestionLatencyMs: { type: 'INT32', optional: true },
  batchId: { type: 'UTF8', optional: true },
});

@Injectable()
export class TelemetryParquetCodecService implements TelemetryParquetPort {
  async encode(rows: AsyncIterable<TelemetryRawRow>): Promise<TelemetryParquetArtifact> {
    const workDirectory = await mkdtemp(join(tmpdir(), 'aqua-telemetry-parquet-'));
    const parquetPath = join(workDirectory, 'telemetry.parquet');
    let complete = false;
    try {
      const writer = await ParquetWriter.openFile(TELEMETRY_PARQUET_SCHEMA, parquetPath);
      writer.setRowGroupSize(8_192);
      writer.setMetadata('aquaculture.telemetry.format', TELEMETRY_PARQUET_FORMAT);
      writer.setMetadata(
        'aquaculture.telemetry.schema-version',
        String(TELEMETRY_PARQUET_SCHEMA_VERSION),
      );
      let rowCount = 0;
      let minTime: string | null = null;
      let maxTime: string | null = null;
      for await (const row of rows) {
        this.assertRow(row);
        await writer.appendRow(this.toParquetRecord(row));
        minTime = earlier(minTime, row.time);
        maxTime = later(maxTime, row.time);
        rowCount += 1;
      }
      await writer.close();
      const fileStat = await stat(parquetPath);
      const sha256 = await sha256File(parquetPath);
      complete = true;
      return {
        path: parquetPath,
        byteLength: fileStat.size,
        sha256,
        rowCount,
        minTime,
        maxTime,
        cleanup: () => rm(workDirectory, { recursive: true, force: true }),
      };
    } finally {
      if (!complete) await rm(workDirectory, { recursive: true, force: true });
    }
  }

  async inspect(object: TelemetryLocalArchiveObject): Promise<TelemetryParquetInspection> {
    await assertParquetMagic(object.path, object.byteLength);
    const reader = await ParquetReader.openFile(object.path);
    let metadata: Record<string, unknown>;
    try {
      metadata = reader.getMetadata();
    } finally {
      await reader.close();
    }
    const format = metadataString(metadata, 'aquaculture.telemetry.format');
    if (format !== TELEMETRY_PARQUET_FORMAT) {
      throw new Error('Telemetry Parquet format metadata is invalid');
    }
    const schemaVersion = Number(metadataString(metadata, 'aquaculture.telemetry.schema-version'));
    if (schemaVersion !== TELEMETRY_PARQUET_SCHEMA_VERSION) {
      throw new Error('Telemetry Parquet schema-version metadata is invalid');
    }
    let rowCount = 0;
    let minTime: string | null = null;
    let maxTime: string | null = null;
    for await (const row of this.decode(object)) {
      rowCount += 1;
      minTime = earlier(minTime, row.time);
      maxTime = later(maxTime, row.time);
    }
    return {
      rowCount,
      minTime,
      maxTime,
      sha256: await sha256File(object.path),
      format,
      schemaVersion,
    };
  }

  async *decode(object: TelemetryLocalArchiveObject): AsyncGenerator<TelemetryRawRow> {
    await assertParquetMagic(object.path, object.byteLength);
    const reader = await ParquetReader.openFile(object.path);
    try {
      const records: AsyncIterable<unknown> = reader;
      for await (const record of records) yield this.fromParquetRecord(record);
    } finally {
      await reader.close();
    }
  }

  private toParquetRecord(row: TelemetryRawRow): Record<string, unknown> {
    const record: Record<string, unknown> = {
      time: row.time,
      sensorId: row.sensorId,
      channelId: row.channelId,
      tenantId: row.tenantId,
      rawValue: row.rawValue,
      value: row.value,
      qualityCode: row.qualityCode,
      qualityBits: row.qualityBits,
    };
    for (const field of OPTIONAL_UTF8_FIELDS) {
      const value = row[field];
      if (value !== null && value !== undefined) record[field] = value;
    }
    if (row.ingestionLatencyMs !== null && row.ingestionLatencyMs !== undefined) {
      record['ingestionLatencyMs'] = row.ingestionLatencyMs;
    }
    return record;
  }

  private fromParquetRecord(value: unknown): TelemetryRawRow {
    if (!isRecord(value)) throw new Error('Parquet telemetry row is not an object');
    const row: TelemetryRawRow = {
      time: requiredString(value, 'time'),
      sensorId: requiredString(value, 'sensorId'),
      channelId: requiredString(value, 'channelId'),
      tenantId: requiredString(value, 'tenantId'),
      rawValue: requiredNumber(value, 'rawValue'),
      value: requiredNumber(value, 'value'),
      qualityCode: requiredInteger(value, 'qualityCode'),
      qualityBits: requiredInteger(value, 'qualityBits'),
      sourceEventId: optionalString(value, 'sourceEventId'),
      sourceTimestamp: optionalString(value, 'sourceTimestamp'),
      sourceSequence: optionalString(value, 'sourceSequence'),
    };
    for (const field of OPTIONAL_UTF8_FIELDS.slice(3)) {
      const fieldValue = optionalString(value, field);
      if (fieldValue !== null) Object.assign(row, { [field]: fieldValue });
    }
    const latency = optionalNumber(value, 'ingestionLatencyMs');
    if (latency !== null) Object.assign(row, { ingestionLatencyMs: latency });
    this.assertRow(row);
    return row;
  }

  private assertRow(row: TelemetryRawRow): void {
    const timestamp = new Date(row.time);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== row.time) {
      throw new Error('Telemetry Parquet row time must be a canonical ISO-8601 timestamp');
    }
    if (!Number.isFinite(row.rawValue) || !Number.isFinite(row.value)) {
      throw new Error('Telemetry Parquet values must be finite numbers');
    }
    if (!Number.isInteger(row.qualityCode) || !Number.isInteger(row.qualityBits)) {
      throw new Error('Telemetry Parquet quality values must be integers');
    }
  }
}

async function assertParquetMagic(path: string, byteLength: number): Promise<void> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 8) {
    throw new Error('Telemetry archive object is not a Parquet file');
  }
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(4);
    const footer = Buffer.alloc(4);
    const headerRead = await handle.read(header, 0, 4, 0);
    const footerRead = await handle.read(footer, 0, 4, byteLength - 4);
    if (
      headerRead.bytesRead !== 4 ||
      footerRead.bytesRead !== 4 ||
      header.toString('ascii') !== 'PAR1' ||
      footer.toString('ascii') !== 'PAR1'
    ) {
      throw new Error('Telemetry archive object is not a Parquet file');
    }
  } finally {
    await handle.close();
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Telemetry Parquet metadata ${key} is missing`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Parquet telemetry field ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`Parquet telemetry field ${field} must be a string or null`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Parquet telemetry field ${field} must be a finite number`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Parquet telemetry field ${field} must be a finite number or null`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, field: string): number {
  const value = requiredNumber(record, field);
  if (!Number.isInteger(value))
    throw new Error(`Parquet telemetry field ${field} must be an integer`);
  return value;
}

function earlier(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function later(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}
