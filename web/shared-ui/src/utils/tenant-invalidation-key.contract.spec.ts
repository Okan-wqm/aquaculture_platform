import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createTenantQueryKey, createTenantInvalidationKey } from './tenant-query-keys';

/**
 * Contract: invalidateQueries/removeQueries MUST use createTenantInvalidationKey
 * (the epoch-LESS prefix), NOT createTenantQueryKey — which appends a
 * `{__sessionEpoch}` segment (the #687 cache-generation token). For a LIST query
 * that has extra filter segments, that epoch segment lands at the same index as the
 * filter, so a createTenantQueryKey-based invalidation prefix no longer matches the
 * query and silently invalidates NOTHING. This is the regression guard for #687.
 */
const tid = 'tenant-A';
const filter = { status: 'active' };

async function seedListQuery(qc: QueryClient) {
  await qc.prefetchQuery({
    queryKey: createTenantQueryKey(tid, 'edgeDevices', filter),
    queryFn: async () => 'data',
  });
  return qc.getQueryCache().getAll()[0];
}

describe('tenant invalidation-key contract (epoch-safe)', () => {
  it('createTenantInvalidationKey DOES invalidate the LIST query (correct)', async () => {
    const qc = new QueryClient();
    const q = await seedListQuery(qc);
    await qc.invalidateQueries({ queryKey: createTenantInvalidationKey(tid, 'edgeDevices') });
    expect(q.state.isInvalidated).toBe(true);
  });

  it('createTenantQueryKey does NOT invalidate the LIST query (the epoch trap)', async () => {
    const qc = new QueryClient();
    const q = await seedListQuery(qc);
    await qc.invalidateQueries({ queryKey: createTenantQueryKey(tid, 'edgeDevices') });
    expect(q.state.isInvalidated).toBe(false); // epoch index clash → no match
  });
});
