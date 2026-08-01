import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  createTenantInvalidationKey,
  createTenantQueryKey,
  hasSameTenantSessionBoundary,
} from './tenant-query-keys';
import { bumpSessionEpoch } from './session-epoch';

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

  it('recognises only matching tenant and session boundaries', () => {
    const firstPage = createTenantQueryKey(TENANT, 'sites', { page: 1 });
    const secondPage = createTenantQueryKey(TENANT, 'sites', { page: 2 });
    const otherTenant = createTenantQueryKey('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'sites');

    expect(hasSameTenantSessionBoundary(firstPage, secondPage)).toBe(true);
    expect(hasSameTenantSessionBoundary(firstPage, otherTenant)).toBe(false);

    bumpSessionEpoch();
    const nextSession = createTenantQueryKey(TENANT, 'sites', { page: 1 });
    expect(hasSameTenantSessionBoundary(firstPage, nextSession)).toBe(false);
  });

  it('fails closed for anonymous, epoch-less, and malformed keys', () => {
    const valid = createTenantQueryKey(TENANT, 'sites');

    expect(
      hasSameTenantSessionBoundary(['tenant', null, 'sites', { __sessionEpoch: 0 }], valid),
    ).toBe(false);
    expect(hasSameTenantSessionBoundary(['tenant', TENANT, 'sites'], valid)).toBe(false);
    expect(
      hasSameTenantSessionBoundary(
        ['tenant', TENANT, 'sites', { __sessionEpoch: 'invalid' }],
        valid,
      ),
    ).toBe(false);
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
