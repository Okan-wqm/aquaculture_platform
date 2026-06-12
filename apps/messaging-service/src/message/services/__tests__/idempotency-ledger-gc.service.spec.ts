import { createMockDataSource } from '@platform/testing';

import {
  IdempotencyLedgerGcService,
  IDEMPOTENCY_LEDGER_RETENTION_DAYS,
} from '../idempotency-ledger-gc.service';

describe('IdempotencyLedgerGcService', () => {
  it('deletes only rows older than the authoritative retention horizon', async () => {
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query.mockResolvedValue([[], 3]);
    const service = new IdempotencyLedgerGcService(mockDataSource);

    await service.sweep();

    expect(mockDataSource.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM messaging.message_send_idempotency');
    expect(sql).toContain('make_interval(days => $1)');
    expect(params).toEqual([IDEMPOTENCY_LEDGER_RETENTION_DAYS]);
    // The horizon must stay strictly above the 7d Redis fast-path TTL —
    // shrinking it below would re-open duplicates inside the cache window.
    expect(IDEMPOTENCY_LEDGER_RETENTION_DAYS).toBeGreaterThan(7);
  });

  it('logs loud but does not crash the service when the sweep fails (deliberate narrow fail-open)', async () => {
    const { mockDataSource } = createMockDataSource();
    mockDataSource.query.mockRejectedValue(new Error('db gone'));
    const service = new IdempotencyLedgerGcService(mockDataSource);

    await expect(service.sweep()).resolves.toBeUndefined();
    expect(mockDataSource.query).toHaveBeenCalledTimes(1);
  });
});
