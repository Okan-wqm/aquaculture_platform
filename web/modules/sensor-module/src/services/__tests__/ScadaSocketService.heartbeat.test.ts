/**
 * ScadaSocketService — heartbeat / liveness watchdog (SENSOR-HIGH-038).
 *
 * The 35 s watchdog previously reset ONLY on a HEARTBEAT frame, which the
 * server never pushes on its own, so a healthy socket streaming TAG_VALUES
 * still tripped to 'error' after 35 s and blocked tag writes. The fix: reset
 * on ANY inbound frame, and emit a periodic client heartbeat the server echoes
 * so idle-but-connected sockets stay healthy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ScadaSocketEvent } from '../../types/scada-runtime.types';

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
  tenantId: 'tenant-A' as string | null,
}));
vi.mock('@aquaculture/shared-ui', () => ({
  getAccessToken: () => ten.token,
  getTenantId: () => ten.tenantId,
  onTenantChange: () => () => {},
  registerLogoutCleanup: () => () => {},
}));

import { getScadaSocketService } from '../ScadaSocketService';

function handlerFor(event: string): (payload?: unknown) => void {
  const call = [...sio.fakeSocket.on.mock.calls].reverse().find(([e]) => e === event);
  if (!call) throw new Error(`no handler registered for ${event}`);
  return call[1] as (payload?: unknown) => void;
}

describe('ScadaSocketService heartbeat watchdog (SENSOR-HIGH-038)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // NB: do NOT clear fakeSocket.on — connect() attaches listeners only on the
    // first socket creation and reuses the instance thereafter, so the handler
    // record must persist across tests (the singleton keeps one socket).
    sio.fakeSocket.emit.mockClear();
    sio.fakeSocket.connected = false;
    ten.token = 'test-token';
    ten.tenantId = 'tenant-A';
    getScadaSocketService().connect();
    sio.fakeSocket.connected = true;
    handlerFor('connect')();
  });

  afterEach(() => {
    getScadaSocketService().disconnect();
    vi.useRealTimers();
  });

  it('emits a periodic client heartbeat the server echoes', () => {
    sio.fakeSocket.emit.mockClear();
    vi.advanceTimersByTime(15_000);
    expect(sio.fakeSocket.emit).toHaveBeenCalledWith(ScadaSocketEvent.HEARTBEAT);
  });

  it('keeps the connection healthy when any inbound frame arrives before the timeout', () => {
    // 30 s in (< 35 s): still connected.
    vi.advanceTimersByTime(30_000);
    expect(getScadaSocketService().connectionState).toBe('connected');
    // A non-HEARTBEAT server frame must reset the watchdog...
    handlerFor(ScadaSocketEvent.TAG_VALUES)({ values: [] });
    // ...so 30 s more (64 s total, but < 35 s since the frame) stays connected.
    vi.advanceTimersByTime(30_000);
    expect(getScadaSocketService().connectionState).toBe('connected');
  });
});
