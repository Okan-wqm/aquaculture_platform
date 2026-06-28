import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { createTenantInvalidationKey, createTenantQueryKey } from './tenant-query-keys';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('tenant query keys', () => {
  it('createTenantQueryKey appends the session epoch as the trailing segment', () => {
    const key = createTenantQueryKey(TENANT, 'systems', 'list');
    expect(key.slice(0, 4)).toEqual(['tenant', TENANT, 'systems', 'list']);
    expect(key[key.length - 1]).toHaveProperty('__sessionEpoch');
  });

  it('createTenantInvalidationKey is a clean epoch-less domain prefix', () => {
    expect(createTenantInvalidationKey(TENANT, 'systems', 'list')).toEqual([
      'tenant',
      TENANT,
      'systems',
      'list',
    ]);
  });

  it('invalidation prefix matches a stored key carrying filter args; the full-key builder does NOT', () => {
    const qc = new QueryClient();

    // A list query stored WITH a filter arg after the domain segments, as the
    // farm-module hooks do: ['tenant', t, 'systems', 'list', {search}, {epoch}].
    const storedKey = createTenantQueryKey(TENANT, 'systems', 'list', { search: 'x' });
    qc.setQueryData(storedKey, { ok: true });

    // OLD (buggy) pattern — using the full-key builder for invalidation. Its
    // trailing {epoch} sits where the stored key holds `filter`, so the
    // left-prefix match MISSES.
    const buggyFilter = createTenantQueryKey(TENANT, 'systems', 'list');
    expect(qc.getQueryCache().findAll({ queryKey: buggyFilter })).toHaveLength(0);

    // NEW pattern — the epoch-less invalidation prefix MATCHES the stored key.
    const correctFilter = createTenantInvalidationKey(TENANT, 'systems', 'list');
    expect(qc.getQueryCache().findAll({ queryKey: correctFilter })).toHaveLength(1);

    qc.clear();
  });
});
