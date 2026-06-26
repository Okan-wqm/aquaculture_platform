/**
 * ScadaSocketService — tenant-isolation teardown tests.
 *
 * SECURITY: the /scada socket is a process-wide singleton bound to the tenant
 * session it connected with. It must disconnect on a tenant switch (so the
 * previous tenant's TAG_VALUES stream stops) and on logout (so the next user on
 * the same browser cannot reuse the still-open socket). These tests pin that the
 * module-level onTenantChange / registerLogoutCleanup wiring disconnects it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Fake socket.io client ─────────────────────────────────────────────────────
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

// ── Tenant primitives — capture the service's registered callbacks ────────────
const ten = vi.hoisted(() => {
  const tenantChangeCbs = new Set<(oldTenantId: string) => void>();
  const logoutCbs = new Set<() => void>();
  return { tenantChangeCbs, logoutCbs };
});

vi.mock('@aquaculture/shared-ui', () => ({
  getAccessToken: () => 'test-token',
  onTenantChange: (fn: (oldTenantId: string) => void) => {
    ten.tenantChangeCbs.add(fn);
    return () => ten.tenantChangeCbs.delete(fn);
  },
  registerLogoutCleanup: (fn: () => void) => {
    ten.logoutCbs.add(fn);
    return () => ten.logoutCbs.delete(fn);
  },
}));

// Import AFTER mocks — module load registers the teardown callbacks.
import { ScadaSocketService } from '../ScadaSocketService';

describe('ScadaSocketService tenant-isolation teardown', () => {
  beforeEach(() => {
    sio.fakeSocket.disconnect.mockClear();
  });

  it('registers a tenant-change and a logout teardown callback at module load', () => {
    expect(ten.tenantChangeCbs.size).toBeGreaterThanOrEqual(1);
    expect(ten.logoutCbs.size).toBeGreaterThanOrEqual(1);
  });

  it('disconnects the singleton socket on tenant change', () => {
    const svc = ScadaSocketService.getInstance();
    svc.connect(); // creates the underlying socket via io()
    sio.fakeSocket.disconnect.mockClear();

    ten.tenantChangeCbs.forEach((cb) => cb('tenant-A'));

    expect(sio.fakeSocket.disconnect).toHaveBeenCalled();
  });

  it('disconnects the singleton socket on logout', () => {
    const svc = ScadaSocketService.getInstance();
    svc.connect();
    sio.fakeSocket.disconnect.mockClear();

    ten.logoutCbs.forEach((cb) => cb());

    expect(sio.fakeSocket.disconnect).toHaveBeenCalled();
  });
});
