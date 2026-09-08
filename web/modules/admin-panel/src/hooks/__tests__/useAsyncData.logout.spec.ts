/**
 * The admin-panel's own cache is cleared by the platform's logout authority
 * (ADMIN-HIGH-105).
 *
 * `useAsyncData` holds CROSS-TENANT SUPER_ADMIN data in a module-scoped Map:
 * billing metrics, audit logs with their tenant list, usage rollups, messaging
 * compliance counts — 17 cached slices across 8 pages. It used to wait on an
 * `aquaculture:logout` window event that nothing in the repository dispatches,
 * so nothing ever cleared it: log out, log in as someone else on the same tab,
 * and the previous principal's platform data was served from cache for the
 * rest of its TTL.
 *
 * This spec is behavioural, not structural. It captures the callback the module
 * hands `registerLogoutCleanup` at import time, drives a real cached fetch,
 * fires the callback, and asserts the next fetch reaches the fetcher again. A
 * grep for the identifier would pass on a callback that closed over the wrong
 * Map; this fails unless the cache the pages read is the cache logout clears.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const logoutCallbacks: Array<() => void> = [];

vi.mock('@aquaculture/shared-ui', () => ({
  registerLogoutCleanup: (callback: () => void) => {
    logoutCallbacks.push(callback);
    return () => {
      const index = logoutCallbacks.indexOf(callback);
      if (index >= 0) logoutCallbacks.splice(index, 1);
    };
  },
}));

const { useAsyncData, clearAsyncCache } = await import('../useAsyncData');

describe('useAsyncData cache ↔ logout authority (ADMIN-HIGH-105)', () => {
  beforeEach(() => {
    clearAsyncCache();
  });

  it('registers exactly one cleanup callback with the platform logout authority', () => {
    expect(logoutCallbacks).toHaveLength(1);
  });

  it('serves a second mount from cache — and stops doing so once logout fires', async () => {
    const fetcher = vi.fn().mockResolvedValue('platform-wide invoice totals');
    const options = { cacheKey: 'admin-cache-boundary', cacheTTL: 60_000 };

    const first = renderHook(() => useAsyncData(fetcher, options));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Same key inside the TTL: the cache answers, the fetcher is not called.
    const second = renderHook(() => useAsyncData(fetcher, options));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.data).toBe('platform-wide invoice totals');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The principal logs out. logoutCleanup() drains the registry.
    for (const callback of logoutCallbacks) callback();

    // The next principal on this tab must NOT be served the previous one's row.
    const third = renderHook(() => useAsyncData(fetcher, options));
    await waitFor(() => expect(third.result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
