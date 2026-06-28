/**
 * socketFactory — identity-based releaseSocket (ORPHAN-MEDIUM-213).
 *
 * releaseSocket() used to re-derive its pool key from `url` + getTenantId() AT
 * RELEASE TIME. After a tenant switch A→B, an A-bound hook's cleanup ran while the
 * ambient tenant was already B, so it decremented — and could prematurely tear down
 * — tenant B's live socket. The fix releases by the Socket INSTANCE the caller
 * acquired, so the ambient tenant is never read and the mis-target is structurally
 * impossible. These tests pin that contract. Unique tenant ids per test isolate the
 * module-level pool between cases.
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

// ── Tenant primitives: ambient tenant is mutable mid-test to simulate a switch ──
const ten = vi.hoisted(() => ({ tenantId: null as string | null }));
vi.mock('@aquaculture/shared-ui', () => ({
  getAccessToken: () => 'test-token',
  getTenantId: () => ten.tenantId,
  onTenantChange: () => () => {},
  registerLogoutCleanup: () => () => {},
}));

import { getSocket, releaseSocket } from '../socketFactory';

describe('socketFactory identity-based releaseSocket (ORPHAN-MEDIUM-213)', () => {
  beforeEach(() => {
    sio.ioMock.mockClear();
    sio.sockets.length = 0;
  });

  it('releases the acquired instance, not the ambient tenant — no cross-tenant teardown', () => {
    ten.tenantId = 'relA';
    const sockA = getSocket('wss://host/scada'); // sockets[0], tenant A, refCount 1
    ten.tenantId = 'relB';
    const sockB = getSocket('wss://host/scada'); // sockets[1], tenant B, refCount 1
    expect(sockA).not.toBe(sockB);

    // Ambient tenant is now B. An A-bound hook's cleanup releases the socket IT holds.
    // The OLD url+getTenantId() path would have decremented B's entry here.
    releaseSocket(sockA);

    expect(sockA!.disconnect).toHaveBeenCalledTimes(1); // A torn down (its refCount hit 0)
    expect(sockB!.disconnect).not.toHaveBeenCalled(); // B untouched
  });

  it('decrements the reference count and only tears down at zero', () => {
    ten.tenantId = 'relC';
    const s1 = getSocket('wss://host/scada'); // refCount 1
    const s2 = getSocket('wss://host/scada'); // refCount 2, same pooled socket
    expect(s2).toBe(s1);
    expect(sio.ioMock).toHaveBeenCalledTimes(1);

    releaseSocket(s1); // 2 → 1: still held, must NOT tear down
    expect(s1!.disconnect).not.toHaveBeenCalled();

    releaseSocket(s1); // 1 → 0: tear down + evict
    expect(s1!.disconnect).toHaveBeenCalledTimes(1);
    expect(s1!.removeAllListeners).toHaveBeenCalledTimes(1);

    const s3 = getSocket('wss://host/scada'); // entry was evicted → brand-new socket
    expect(sio.ioMock).toHaveBeenCalledTimes(2);
    expect(s3).not.toBe(s1);
  });

  it('is a no-op for a null/undefined socket (caller never acquired one)', () => {
    ten.tenantId = 'relD';
    const sockD = getSocket('wss://host/scada');

    expect(() => releaseSocket(null)).not.toThrow();
    expect(() => releaseSocket(undefined)).not.toThrow();

    // The ambient tenant's pooled entry must be left fully intact.
    expect(sockD!.disconnect).not.toHaveBeenCalled();
  });
});
