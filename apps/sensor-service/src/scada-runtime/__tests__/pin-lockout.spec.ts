/**
 * M3 — server-side PIN lockout with exponential backoff.
 *
 * The brute-force budget is keyed by (tenantId, packageId) SERVER-SIDE —
 * reconnecting (a new socket.id) does NOT reset it. Five consecutive
 * failures engage a 60 s lockout; each subsequent lockout doubles, capped at
 * 15 minutes. Every engagement is audit-logged. A success clears the budget.
 *
 * The gateway is instantiated directly with mocked collaborators; a fake
 * socket is registered in the (private) client registry the way
 * handleConnection would.
 */
import { ScadaRuntimeGateway } from '../scada-runtime.gateway';
import type { TagManagerService } from '../services/tag-manager.service';
import type { TagResolutionService } from '../../process/services/tag-resolution.service';
import type { DaqStorageService } from '../services/daq-storage.service';
import type { ScadaPackageService } from '../../process/services/scada-package.service';
import { ScadaSocketEvent, type HmiRole } from '../scada-types';
import type { Socket } from 'socket.io';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';

const TENANT = 'tenant-uuid-1';
const PKG = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function mockOf<T>(impl: DeepPartial<T>): T {
  return impl as T;
}

interface FakeSocket {
  id: string;
  emitted: Array<{ event: string; payload: unknown }>;
  emit: (event: string, payload: unknown) => void;
}

function fakeSocket(id: string): FakeSocket {
  const s: FakeSocket = {
    id,
    emitted: [],
    emit: (event, payload) => {
      s.emitted.push({ event, payload });
    },
  };
  return s;
}

interface Harness {
  gateway: ScadaRuntimeGateway;
  verifyPackagePin: jest.Mock;
  socket: FakeSocket;
  register: (id: string) => FakeSocket;
}

function build(verifyImpl?: jest.Mock): Harness {
  const verifyPackagePin = verifyImpl ?? jest.fn().mockResolvedValue(false);
  const gateway = new ScadaRuntimeGateway(
    mockOf<JwtService>({}),
    mockOf<TagManagerService>({ removeSocket: jest.fn() }),
    mockOf<ConfigService>({ get: jest.fn().mockReturnValue(undefined) }),
    mockOf<TagResolutionService>({}),
    mockOf<EventEmitter2>({ emit: jest.fn() }),
    mockOf<DaqStorageService>({}),
    mockOf<ScadaPackageService>({ verifyPackagePin }),
  );

  const clients = (gateway as unknown as {
    clients: Map<string, { socket: Socket; tenantId: string; userId: string; role: HmiRole }>;
  }).clients;

  const register = (id: string): FakeSocket => {
    const sock = fakeSocket(id);
    clients.set(id, { socket: sock as unknown as Socket, tenantId: TENANT, userId: `user-${id}`, role: 'operator' });
    return sock;
  };

  const socket = register('sock-1');
  return { gateway, verifyPackagePin, socket, register };
}

function lastPinResult(socket: FakeSocket): { valid: boolean; lockedUntil?: number; expiresAt?: number } {
  const pins = socket.emitted.filter((e) => e.event === ScadaSocketEvent.PIN_RESULT);
  return pins[pins.length - 1]!.payload as { valid: boolean; lockedUntil?: number; expiresAt?: number };
}

async function attempt(h: Harness, socket: FakeSocket, pin = '000000'): Promise<void> {
  await h.gateway.handlePinVerify(socket as unknown as Socket, {
    packageId: PKG,
    pin,
  } as never);
}

describe('ScadaRuntimeGateway — PIN lockout (M3)', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockRestore();
  });

  it('5 consecutive failures engage a 60 s lockout keyed tenant+package, not socket', async () => {
    const h = build();

    for (let i = 0; i < 4; i++) {
      await attempt(h, h.socket);
      expect(lastPinResult(h.socket).valid).toBe(false);
      expect(lastPinResult(h.socket).lockedUntil).toBeUndefined();
    }

    // 5th failure → locked for 60 s.
    await attempt(h, h.socket);
    const locked = lastPinResult(h.socket);
    expect(locked.valid).toBe(false);
    expect(locked.lockedUntil).toBeGreaterThan(Date.now());
    expect(locked.lockedUntil! - Date.now()).toBeLessThanOrEqual(60_000);
    expect(locked.lockedUntil! - Date.now()).toBeGreaterThan(59_000);

    // A DIFFERENT socket (fresh socket.id) for the same tenant+package is
    // still locked out — reconnecting does not reset the budget.
    const second = h.register('sock-2');
    await attempt(h, second);
    expect(h.verifyPackagePin).toHaveBeenCalledTimes(5); // the 6th attempt never verified
    expect(lastPinResult(second).lockedUntil).toBe(locked.lockedUntil);
  });

  it('each subsequent lockout doubles the duration, capped at 15 minutes', async () => {
    const h = build();
    const durations: number[] = [];
    let now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');

    for (let lockout = 0; lockout < 10; lockout++) {
      nowSpy.mockReturnValue(now);
      // Burn the 5-attempt budget → engage lockout #lockout+1.
      for (let i = 0; i < 5; i++) {
        await attempt(h, h.socket);
      }
      const locked = lastPinResult(h.socket);
      durations.push(locked.lockedUntil! - now);
      // Jump past the lockout window, then fail again.
      now += locked.lockedUntil! - now + 1000;
    }
    nowSpy.mockRestore();

    // 60s, 2m, 4m, 8m, 15m (cap), 15m, … — durations expressed in minutes.
    const expectedMinutes = [1, 2, 4, 8, 15, 15, 15, 15, 15, 15];
    expect(durations.map((d) => Math.round(d / 60_000))).toEqual(expectedMinutes);
  });

  it('a successful verify clears the budget (5 fresh failures needed afterwards)', async () => {
    let valid = false;
    const h = build(jest.fn().mockImplementation(async () => valid));

    for (let i = 0; i < 4; i++) await attempt(h, h.socket);

    valid = true;
    await attempt(h, h.socket, '904321');
    const ok = lastPinResult(h.socket);
    expect(ok.valid).toBe(true);
    expect(ok.expiresAt).toBeGreaterThan(Date.now());

    // Budget was cleared: 4 failures do NOT lock out…
    valid = false;
    for (let i = 0; i < 4; i++) await attempt(h, h.socket);
    expect(lastPinResult(h.socket).lockedUntil).toBeUndefined();
    // …the 5th does.
    await attempt(h, h.socket);
    expect(lastPinResult(h.socket).lockedUntil).toBeDefined();
  });

  it('lockout state is per (tenant, package) — a different package is unaffected', async () => {
    const h = build();
    for (let i = 0; i < 5; i++) {
      await h.gateway.handlePinVerify(h.socket as unknown as Socket, {
        packageId: PKG,
        pin: '000000',
      } as never);
    }
    expect(lastPinResult(h.socket).lockedUntil).toBeDefined();

    // Another package id on the same socket: not locked.
    await h.gateway.handlePinVerify(h.socket as unknown as Socket, {
      packageId: '99d1c2b3-4e5f-4a6b-8c7d-9e0f1a2b3c4e',
      pin: '000000',
    } as never);
    const res = lastPinResult(h.socket);
    expect(res.lockedUntil).toBeUndefined();
    expect(h.verifyPackagePin).toHaveBeenCalledTimes(6);
  });
});
