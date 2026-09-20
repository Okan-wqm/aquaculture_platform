/**
 * ScadaSocketService — shared ownership and observable connection state.
 *
 * Two defects compounded on an operator screen. The bootstrap's cleanup called
 * disconnect() unconditionally while the live data providers were still reading
 * through the same singleton, so unmounting one killed the other's feed; and
 * `_connectionState` had no subscription surface, so nothing in React could
 * learn the link was gone. The screen froze on its last values and said
 * nothing.
 *
 * These are the two contracts that fix it, and they are the ones that would
 * regress silently: a refcount whose owners are wired back to disconnect(),
 * and a subscription a late subscriber can trust without polling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sio = vi.hoisted(() => {
  const fakeSocket = {
    connected: false,
    auth: {} as Record<string, unknown>,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  return { fakeSocket, ioMock: vi.fn(() => fakeSocket) };
});
vi.mock('socket.io-client', () => ({ io: sio.ioMock }));

vi.mock('@aquaculture/shared-ui', () => ({
  getAccessToken: () => 'test-token',
  getTenantId: () => 'tenant-A',
  onTenantChange: () => () => {},
  registerLogoutCleanup: () => () => {},
}));

import { getScadaSocketService } from '../ScadaSocketService';

describe('ScadaSocketService shared ownership (refcount)', () => {
  beforeEach(() => {
    sio.ioMock.mockClear();
    sio.fakeSocket.connected = false;
    sio.fakeSocket.disconnect.mockClear();
    // Drain any ownership a previous test left behind.
    const service = getScadaSocketService();
    for (let i = 0; i < 8; i += 1) service.release();
    sio.fakeSocket.disconnect.mockClear();
  });

  it('keeps the socket up while another owner still holds it', () => {
    const service = getScadaSocketService();
    service.connect();
    service.acquire();
    service.acquire();

    service.release();
    expect(sio.fakeSocket.disconnect).not.toHaveBeenCalled();

    service.release();
    expect(sio.fakeSocket.disconnect).toHaveBeenCalled();
  });

  it('does not go negative when released more often than acquired', () => {
    const service = getScadaSocketService();
    service.connect();
    service.acquire();
    service.release();
    service.release();
    sio.fakeSocket.disconnect.mockClear();

    // A stray release must not leave the count below zero, or the NEXT owner's
    // release would fail to disconnect.
    service.acquire();
    service.release();
    expect(sio.fakeSocket.disconnect).toHaveBeenCalled();
  });
});

describe('ScadaSocketService connection-state subscription', () => {
  it('calls a late subscriber immediately with the current state', () => {
    const service = getScadaSocketService();
    const seen: string[] = [];
    const unsubscribe = service.onConnectionStateChange((state) => seen.push(state));

    expect(seen).toEqual([service.connectionState]);
    unsubscribe();
  });

  it('reports a transition, and stops after unsubscribe', () => {
    const service = getScadaSocketService();
    service.disconnect();

    const seen: string[] = [];
    const unsubscribe = service.onConnectionStateChange((state) => seen.push(state));
    seen.length = 0;

    service.connect(); // disconnected -> connecting
    expect(seen).toContain('connecting');

    unsubscribe();
    const after = seen.length;
    service.disconnect();
    expect(seen.length).toBe(after);
  });
});
