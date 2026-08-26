import { DataSource } from 'typeorm';

import { HypertableService } from '../hypertable.service';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_SCHEMA = 'tenant_3333333333334333';

describe('HypertableService — tenant isolation and measured chunk sizing', () => {
  const query = jest.fn();
  const dataSource: Partial<DataSource> = {
    query: query as DataSource['query'],
  };
  const service = new HypertableService(dataSource as DataSource);

  beforeEach(() => query.mockReset());

  it('filters chunk introspection by the tenant schema and fixed raw hypertable', async () => {
    query.mockResolvedValue([{ cnt: '7' }]);

    await expect(service.getChunkCount(TENANT_ID)).resolves.toBe(7);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('hypertable_schema = $1'), [
      TENANT_SCHEMA,
      'sensor_metrics',
    ]);
  });

  it('schema-qualifies size introspection instead of accepting a caller-supplied relation', async () => {
    query.mockResolvedValue([{ total_bytes: '1024', compressed_total_bytes: '256' }]);

    await expect(service.getSize(TENANT_ID)).resolves.toEqual({
      totalBytes: 1024,
      compressedBytes: 256,
      uncompressedBytes: 768,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('hypertable_schema = $2'), [
      `${TENANT_SCHEMA}.sensor_metrics`,
      TENANT_SCHEMA,
      'sensor_metrics',
    ]);
  });

  it('filters chunk interval introspection by tenant schema', async () => {
    query.mockResolvedValue([{ time_interval: '06:00:00' }]);

    await expect(service.getChunkInterval(TENANT_ID)).resolves.toBe('06:00:00');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('hypertable_schema = $1'), [
      TENANT_SCHEMA,
      'sensor_metrics',
    ]);
  });

  it('rejects a non-UUID tenant identity before Timescale introspection', async () => {
    await expect(service.getChunkCount('3333333333334333')).rejects.toThrow(/tenant id/i);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    [300 * 1024 * 1024, '1 hour'],
    [70 * 1024 * 1024, '6 hours'],
    [15 * 1024 * 1024, '24 hours'],
  ])('chooses only 1h/6h/24h candidates for %i measured bytes/hour', (bytesPerHour, expected) => {
    expect(service.recommendChunkInterval(bytesPerHour)).toBe(expected);
  });

  it('rejects missing or invalid measurements instead of guessing a chunk interval', () => {
    expect(() => service.recommendChunkInterval(0)).toThrow(/measured bytes per hour/i);
    expect(() => service.recommendChunkInterval(Number.NaN)).toThrow(/measured bytes per hour/i);
  });
});
