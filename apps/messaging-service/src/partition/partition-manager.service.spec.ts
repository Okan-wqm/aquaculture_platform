import { createMockDataSource } from '@platform/testing';
import { DataSource } from 'typeorm';

import { PartitionManagerService } from './partition-manager.service';

describe('PartitionManagerService', () => {
  it('fails closed when partition DDL fails unexpectedly', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(
          new Error('"messaging"."messages" is not partitioned'),
        ),
    } as unknown as DataSource;

    await expect(
      new PartitionManagerService(dataSource).onApplicationBootstrap(),
    ).rejects.toThrow('"messaging"."messages" is not partitioned');
  });

  // DATA-HIGH-006: the runtime role's entire DDL surface is EXECUTE on
  // platform.create_messaging_partition — raw partition DDL from the
  // service is the regression this test makes impossible to reintroduce
  // silently. pg16 requires parent-table OWNERSHIP for PARTITION OF (not
  // just schema CREATE), so a raw statement here would crash the first
  // genuinely new monthly partition in production.
  it('delegates partition DDL to the SECURITY DEFINER primitive, never raw DDL', async () => {
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query.mockResolvedValue([]);
    // First call resolves the tenant-schema list.
    mockDataSource.query.mockResolvedValueOnce([
      { schema_name: 'tenant_0123456789abcdef' },
    ]);

    await new PartitionManagerService(mockDataSource).onApplicationBootstrap();

    const calls = mockDataSource.query.mock.calls.slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const [sql, params] of calls) {
      expect(sql).toBe('SELECT platform.create_messaging_partition($1, $2, $3, $4)');
      expect(sql).not.toContain('CREATE TABLE');
      expect(params).toHaveLength(4);
      expect(['messaging', 'tenant_0123456789abcdef']).toContain(
        (params as unknown[])[0],
      );
      expect(['messages', 'message_receipts']).toContain((params as unknown[])[1]);
    }
    // 2 schemas × 2 tables × 3 months (startup window: current + next 2)
    expect(calls).toHaveLength(12);
  });
});
