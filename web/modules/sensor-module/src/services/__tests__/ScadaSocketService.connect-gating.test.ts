/**
 * ScadaSocketService — connect tenant-gating (PR-B2 / B3).
 *
 * The /scada socket previously connected on token-only. It must ALSO require a
 * tenant context before opening — it is a tenant-scoped stream, and opening it
 * without a tenant to bind it to risks a cross-tenant connect during the cold-start
 * window before AuthContext resolves the session. Mirrors socketFactory + the
 * sibling sensor sockets.
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

const ten = vi.hoisted(() => ({
  token: 'test-token' as string | null,
  tenantId: null as string | null,
}));
vi.mock('@aquaculture/shared-ui', () => ({
  getAccessToken: () => ten.token,
  getTenantId: () => ten.tenantId,
  onTenantChange: () => () => {},
  registerLogoutCleanup: () => () => {},
}));

import { getScadaSocketService } from '../ScadaSocketService';

describe('ScadaSocketService connect tenant-gating (B3)', () => {
  beforeEach(() => {
    sio.ioMock.mockClear();
    sio.fakeSocket.connected = false;
    ten.token = 'test-token';
    ten.tenantId = null;
    getScadaSocketService().disconnect();
  });

  it('does NOT open the socket with a token but NO tenant', () => {
    ten.token = 'test-token';
    ten.tenantId = null;
    getScadaSocketService().connect();
    expect(sio.ioMock).not.toHaveBeenCalled();
  });

  it('does NOT open the socket with no token', () => {
    ten.token = null;
    ten.tenantId = 'tenant-A';
    getScadaSocketService().connect();
    expect(sio.ioMock).not.toHaveBeenCalled();
  });

  it('opens the socket once BOTH a token and a tenant are present', () => {
    ten.token = 'test-token';
    ten.tenantId = 'tenant-A';
    getScadaSocketService().connect();
    expect(sio.ioMock).toHaveBeenCalledTimes(1);
  });
});
