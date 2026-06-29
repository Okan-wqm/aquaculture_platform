/**
 * socketFactory — tenant-switch teardown (PR-B2 / B2a).
 *
 * The pooled Socket.IO connections are keyed `${url}::${tenantId}`. On a tenant
 * switch the LEAVING tenant's sockets must be disconnected + evicted immediately
 * (onTenantChange), not linger refcounted until the next logout — otherwise tenant
 * A's realtime stream bleeds into the tenant-B session on the same browser. These
 * tests pin that wiring. Unique tenant ids per test avoid cross-test pool state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Fake socket.io client: each io() call yields a fresh tracked socket ────────
const sio = vi.hoisted(() => {
  const sockets: Array<{
    connected: boolean;
    disconnected: boolean;
    auth: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
  }> = [];
  const ioMock = vi.fn(() => {
    const s = {
      connected: false,
      disconnected: false,
      auth: {} as Record<string, unknown>,
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    sockets.push(s);
    return s;
  });
  return { sockets, ioMock };
});
vi.mock('socket.io-client', () => ({ io: sio.ioMock }));

// ── Tenant primitives: capture the registered onTenantChange callback ─────────
const ten = vi.hoisted(() => ({
  tenantId: null as string | null,
  tenantChangeCbs: new Set<(oldTenantId: string) => void>(),
}));
vi.mock('@aquaculture/shared-ui', () => ({
  getAccessToken: () => 'test-token',
  getTenantId: () => ten.tenantId,
  getSessionSnapshot: () => ({
    accessToken: 'test-token',
    effectiveTenantId: ten.tenantId,
    sessionEpoch: 0,
    tokenState: 'READY',
    ready: !!ten.tenantId,
  }),
  onTenantChange: (fn: (oldTenantId: string) => void) => {
    ten.tenantChangeCbs.add(fn);
    return () => ten.tenantChangeCbs.delete(fn);
  },
  registerLogoutCleanup: () => () => {},
}));

import { getSocket, releaseSocket } from '../socketFactory';

function fireTenantChange(oldTenantId: string): void {
  for (const cb of ten.tenantChangeCbs) cb(oldTenantId);
}

describe('socketFactory tenant-switch teardown (B2a)', () => {
  beforeEach(() => {
    sio.ioMock.mockClear();
    sio.sockets.length = 0;
  });

  it('disconnects + evicts the leaving tenant\'s pooled socket on onTenantChange', () => {
    ten.tenantId = 'tenantA1';
    const sockA = getSocket('wss://host/scada');
    expect(sio.ioMock).toHaveBeenCalledTimes(1);
    expect(sockA).toBe(sio.sockets[0]);

    // Tenant switches A → B; the leaving tenant id is A.
    ten.tenantId = 'tenantB1';
    fireTenantChange('tenantA1');

    expect(sio.sockets[0].disconnect).toHaveBeenCalled();
    expect(sio.sockets[0].removeAllListeners).toHaveBeenCalled();

    // Re-acquiring under A must create a BRAND-NEW socket (the entry was evicted),
    // not hand back the torn-down one.
    ten.tenantId = 'tenantA1';
    const sockA2 = getSocket('wss://host/scada');
    expect(sio.ioMock).toHaveBeenCalledTimes(2);
    expect(sockA2).toBe(sio.sockets[1]);
    expect(sockA2).not.toBe(sockA);
  });

  it('leaves OTHER tenants\' pooled sockets untouched', () => {
    ten.tenantId = 'tenantA2';
    getSocket('wss://host/scada'); // sockets[0] = A
    ten.tenantId = 'tenantB2';
    getSocket('wss://host/scada'); // sockets[1] = B

    // Switch away from A only.
    fireTenantChange('tenantA2');

    expect(sio.sockets[0].disconnect).toHaveBeenCalled(); // A torn down
    expect(sio.sockets[1].disconnect).not.toHaveBeenCalled(); // B untouched
  });

  it('releaseSocket(socket) releases the ACQUIRED entry by identity, immune to a switch (B2b)', () => {
    ten.tenantId = 'tenantA3';
    const sockA = getSocket('wss://host/io'); // ::A3, refCount 1
    ten.tenantId = 'tenantB3';
    const sockB = getSocket('wss://host/io'); // ::B3, refCount 1

    // Release A's socket while the ambient tenant is now B. The old tenant-derived
    // releaseSocket(url) would have keyed ::B3 and torn down B's socket; identity
    // release must tear down A's and leave B untouched (ORPHAN-MEDIUM-213).
    releaseSocket(sockA);

    expect(sockA?.disconnect).toHaveBeenCalled();
    expect(sockB?.disconnect).not.toHaveBeenCalled();
  });

  it('releaseSocket(null) is a no-op (getSocket returned null → nothing acquired)', () => {
    expect(() => releaseSocket(null)).not.toThrow();
  });
});
