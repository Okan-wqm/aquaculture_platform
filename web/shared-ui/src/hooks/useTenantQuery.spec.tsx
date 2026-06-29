import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Controllable auth — useTenantQuery reads token/tenantId from useAuth.
const auth = vi.hoisted(() => ({
  token: 'tok' as string | null,
  tenantId: 'tenant-A' as string | null,
}));
vi.mock('./useAuth', () => ({
  useAuth: () => ({ token: auth.token, tenantId: auth.tenantId }),
}));

import { useTenantQuery, useTenantMutation } from './useTenantQuery';

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe('useTenantQuery', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    auth.token = 'tok';
    auth.tenantId = 'tenant-A';
  });

  it('runs the query under a tenant-scoped key when token + tenant are present', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: 1 });
    const { result } = renderHook(() => useTenantQuery(['dash', 'stats'], fn), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ ok: 1 });

    const key = qc.getQueryCache().getAll()[0].queryKey as readonly unknown[];
    expect(key[0]).toBe('tenant');
    expect(key[1]).toBe('tenant-A'); // tenant prefix isolates the cache
    expect(key).toContain('dash');
  });

  it('does NOT fire without a tenant context (enabled gate)', () => {
    auth.tenantId = null;
    const fn = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() => useTenantQuery(['x'], fn), {
      wrapper: makeWrapper(qc),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(fn).not.toHaveBeenCalled();
  });

  it('ANDs a caller-provided enabled:false', () => {
    const fn = vi.fn().mockResolvedValue({});
    const { result } = renderHook(
      () => useTenantQuery(['x'], fn, { enabled: false }),
      { wrapper: makeWrapper(qc) },
    );
    expect(result.current.fetchStatus).toBe('idle');
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps last-good data across a refetch by default (A5 placeholderData)', async () => {
    let n = 0;
    const fn = vi.fn().mockImplementation(() => Promise.resolve(++n));
    const { result } = renderHook(() => useTenantQuery(['n'], fn, { staleTime: 0 }), {
      wrapper: makeWrapper(qc),
    });
    await waitFor(() => expect(result.current.data).toBe(1));
    // A keepPreviousData query is configured with a placeholderData function.
    const q = qc.getQueryCache().getAll()[0];
    expect(typeof q.options.placeholderData).toBe('function');
  });
});

describe('useTenantMutation', () => {
  it('invalidates the declared key-segments, tenant-prefixed, on success', async () => {
    auth.tenantId = 'tenant-A';
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const onSuccess = vi.fn();

    const { result } = renderHook(
      () =>
        useTenantMutation(async (v: number) => v * 2, {
          invalidate: [
            ['equipment', 'list'],
            ['equipment', 'types'],
          ],
          onSuccess,
        }),
      { wrapper: makeWrapper(qc) },
    );

    const out = await result.current.mutateAsync(21);
    expect(out).toBe(42);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: expect.arrayContaining(['tenant', 'tenant-A', 'equipment', 'list']),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: expect.arrayContaining(['tenant', 'tenant-A', 'equipment', 'types']),
    });
    expect(onSuccess).toHaveBeenCalledTimes(1); // caller onSuccess still runs
  });
});
