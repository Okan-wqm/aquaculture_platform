/**
 * useScadaLiveData — cross-tenant live-data residency tests.
 *
 * SECURITY (PRODUCT-REALTIME-CRITICAL-001): the SCADA live-value/alarm maps were
 * keyed by bare deviceCode, so with a SCADA view mounted across a tenant switch
 * (SUPER_ADMIN impersonation) and an overlapping deviceCode, tenant A's live
 * values could surface in tenant B's view. These tests pin the fix: the maps are
 * tenant-partitioned, reads are tenant-scoped, and a tenant switch / logout purges
 * the departed tenant's data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Controllable fake /sensors socket (replaces socketFactory) ────────────────
const sock = vi.hoisted(() => {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const fakeSocket = {
    connected: true,
    on: (event: string, cb: (payload: unknown) => void) => {
      handlers[event] = cb;
    },
    off: (event: string) => {
      delete handlers[event];
    },
    emit: () => {},
  };
  return { handlers, fakeSocket };
});

vi.mock('../socketFactory', () => ({
  getSocket: () => sock.fakeSocket,
  releaseSocket: () => {},
}));

// ── Tenant primitives (replaces @aquaculture/shared-ui) ───────────────────────
const ten = vi.hoisted(() => {
  const state = { currentTenant: 'tenant-A' as string | null };
  const tenantChangeCbs = new Set<(oldTenantId: string) => void>();
  const logoutCbs = new Set<() => void>();
  return { state, tenantChangeCbs, logoutCbs };
});

vi.mock('@aquaculture/shared-ui', () => ({
  getTenantId: () => ten.state.currentTenant,
  onTenantChange: (fn: (oldTenantId: string) => void) => {
    ten.tenantChangeCbs.add(fn);
    return () => ten.tenantChangeCbs.delete(fn);
  },
  registerLogoutCleanup: (fn: () => void) => {
    ten.logoutCbs.add(fn);
    return () => ten.logoutCbs.delete(fn);
  },
}));

// Import AFTER mocks are registered.
import { useScadaLiveData } from '../useScadaLiveData';

function emitIoData(deviceCode: string, tags: Record<string, unknown>): void {
  sock.handlers['edgeIoData']?.({ deviceCode, tags, timestamp: '2026-01-01T00:00:00Z' });
}

/** Mirror api-client.setTenantId: update state, then notify on a real change. */
function switchTenant(next: string | null): void {
  const prev = ten.state.currentTenant;
  ten.state.currentTenant = next;
  if (prev && prev !== next) {
    ten.tenantChangeCbs.forEach((cb) => cb(prev));
  }
}

describe('useScadaLiveData tenant isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ten.state.currentTenant = 'tenant-A';
    ten.tenantChangeCbs.clear();
    ten.logoutCbs.clear();
    Object.keys(sock.handlers).forEach((k) => delete sock.handlers[k]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and reads a live value within a single tenant', () => {
    const { result } = renderHook(() =>
      useScadaLiveData({ deviceCodes: ['dev-1'], debounceMs: 0 }),
    );

    act(() => {
      vi.advanceTimersByTime(1); // flush debounced subscribe
      emitIoData('dev-1', { temp: { value: 42 } });
    });

    expect(result.current.getTagValue('dev-1', 'temp')).toBe(42);
    expect(result.current.values['dev-1']).toEqual({ temp: { value: 42 } });
  });

  it('does NOT surface tenant A live values after switching to tenant B', () => {
    const { result, rerender } = renderHook(() =>
      useScadaLiveData({ deviceCodes: ['dev-1'], debounceMs: 0 }),
    );

    // Tenant A receives a value for the (cross-tenant-overlapping) deviceCode.
    act(() => {
      vi.advanceTimersByTime(1);
      emitIoData('dev-1', { temp: { value: 42 } });
    });
    expect(result.current.getTagValue('dev-1', 'temp')).toBe(42);

    // Switch to tenant B (fires the purge for tenant A) and re-render.
    act(() => {
      switchTenant('tenant-B');
    });
    rerender();

    // Tenant B must never see tenant A's value — same deviceCode, different tenant.
    expect(result.current.getTagValue('dev-1', 'temp')).toBeUndefined();
    expect(result.current.values['dev-1']).toBeUndefined();
  });

  it('purges departed-tenant data so it cannot resurrect on switch-back', () => {
    const { result, rerender } = renderHook(() =>
      useScadaLiveData({ deviceCodes: ['dev-1'], debounceMs: 0 }),
    );

    act(() => {
      vi.advanceTimersByTime(1);
      emitIoData('dev-1', { temp: { value: 42 } });
    });

    act(() => {
      switchTenant('tenant-B');
    });
    rerender();

    // Switch back to A without delivering any new data: the value was purged on
    // the A→B switch, so it must be gone (not merely hidden by projection).
    act(() => {
      switchTenant('tenant-A');
    });
    rerender();

    expect(result.current.getTagValue('dev-1', 'temp')).toBeUndefined();
    expect(result.current.values['dev-1']).toBeUndefined();
  });

  it('wipes all live data on logout', () => {
    const { result } = renderHook(() =>
      useScadaLiveData({ deviceCodes: ['dev-1'], debounceMs: 0 }),
    );

    act(() => {
      vi.advanceTimersByTime(1);
      emitIoData('dev-1', { temp: { value: 42 } });
    });
    expect(result.current.getTagValue('dev-1', 'temp')).toBe(42);

    act(() => {
      ten.logoutCbs.forEach((cb) => cb());
    });

    expect(result.current.getTagValue('dev-1', 'temp')).toBeUndefined();
    expect(result.current.values['dev-1']).toBeUndefined();
  });
});
