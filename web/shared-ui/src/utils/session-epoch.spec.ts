import { describe, it, expect } from 'vitest';

import { getSessionEpoch, bumpSessionEpoch } from './session-epoch';
import { createTenantQueryKey } from './tenant-query-keys';

describe('session epoch in tenant query keys', () => {
  it('appends the current session epoch as the LAST key segment, keeping domain at index 2', () => {
    const key = createTenantQueryKey('tenant-A', 'dashboard', 'stats');
    expect(key[0]).toBe('tenant');
    expect(key[1]).toBe('tenant-A');
    // Appended (not inserted) → domain segment stays at index 2, so resolveStaleTime
    // and prefix invalidations are unaffected.
    expect(key[2]).toBe('dashboard');
    expect(key[3]).toBe('stats');
    expect(key[key.length - 1]).toEqual({ __sessionEpoch: getSessionEpoch() });
  });

  it('a tenant re-entry (epoch bump) yields a FRESH generation key for the same tenant+segments', () => {
    const before = createTenantQueryKey('tenant-A', 'dashboard');
    bumpSessionEpoch();
    const after = createTenantQueryKey('tenant-A', 'dashboard');

    // Same tenant + domain, but the trailing epoch differs → React Query treats
    // them as distinct queries → the stale (pre-switch) generation is orphaned.
    expect(after).not.toEqual(before);
    expect(after[after.length - 1]).not.toEqual(before[before.length - 1]);

    // The ['tenant', tenantId, domain] prefix is unchanged, so a prefix-based
    // removeQueries({ queryKey: ['tenant', 'tenant-A'] }) still matches both gens.
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
  });

  it('bumpSessionEpoch monotonically advances the generation', () => {
    const start = getSessionEpoch();
    bumpSessionEpoch();
    bumpSessionEpoch();
    expect(getSessionEpoch()).toBe(start + 2);
  });
});
