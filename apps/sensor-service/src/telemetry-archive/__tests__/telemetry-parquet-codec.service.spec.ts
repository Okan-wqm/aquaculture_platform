import { TelemetryParquetCodecService } from '../telemetry-parquet-codec.service';
import type { TelemetryRawRow } from '../telemetry-archive-coordinator.service';

const ROWS: readonly TelemetryRawRow[] = [
  {
    time: '2026-01-01T00:00:01.000Z',
    sensorId: '33333333-3333-4333-8333-333333333333',
    channelId: '44444444-4444-4444-8444-444444444444',
    tenantId: '22222222-2222-4222-8222-222222222222',
    rawValue: 12.5,
    value: 12.4,
    qualityCode: 192,
    qualityBits: 0,
    sourceEventId: 'edge-1',
    sourceTimestamp: '2026-01-01T00:00:00.900Z',
    sourceSequence: '1',
    sourceProtocol: 'mqtt',
  },
  {
    time: '2026-01-01T00:00:02.000Z',
    sensorId: '33333333-3333-4333-8333-333333333333',
    channelId: '44444444-4444-4444-8444-444444444444',
    tenantId: '22222222-2222-4222-8222-222222222222',
    rawValue: 12.6,
    value: 12.5,
    qualityCode: 192,
    qualityBits: 0,
    sourceEventId: 'edge-2',
    sourceTimestamp: '2026-01-01T00:00:01.900Z',
    sourceSequence: '2',
  },
] as const;

async function* rows(): AsyncGenerator<TelemetryRawRow> {
  for (const row of ROWS) yield row;
}

describe('TelemetryParquetCodecService', () => {
  it('round-trips raw telemetry as a genuine Parquet object', async () => {
    const service = new TelemetryParquetCodecService();

    const encoded = await service.encode(rows());
    try {
      const decoded: TelemetryRawRow[] = [];
      for await (const row of service.decode(encoded)) decoded.push(row);

      expect(encoded.path).toMatch(/telemetry\.parquet$/);
      expect(encoded.byteLength).toBeGreaterThan(8);
      expect(encoded.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(encoded.rowCount).toBe(2);
      expect(encoded.minTime).toBe(ROWS[0]?.time);
      expect(encoded.maxTime).toBe(ROWS[1]?.time);
      expect(decoded).toEqual(ROWS);
    } finally {
      await encoded.cleanup();
    }
  });

  it('derives count, bounds, and SHA-256 by reading the object again', async () => {
    const service = new TelemetryParquetCodecService();
    const encoded = await service.encode(rows());

    try {
      const inspection = await service.inspect(encoded);

      expect(inspection.rowCount).toBe(2);
      expect(inspection.minTime).toBe(ROWS[0]?.time);
      expect(inspection.maxTime).toBe(ROWS[1]?.time);
      expect(inspection.sha256).toBe(encoded.sha256);
      expect(inspection.format).toBe('raw-v1');
      expect(inspection.schemaVersion).toBe(1);
    } finally {
      await encoded.cleanup();
    }
  });
});
