/**
 * M7 — DAQ query safety at the socket boundary.
 *
 *  - span clamps: raw queries ≤ 7 days (longer needs an aggregation),
 *    aggregated ≤ 365 days;
 *  - total-point cap (~200k = tags × buckets) with guidance to aggregate;
 *  - per-socket token bucket: 5 req/s sustained, burst 10 — an 11-query
 *    burst inside the same second is rejected with RATE_LIMITED.
 *
 * The gateway is instantiated directly with mocked collaborators; a fake
 * socket is registered the way handleConnection would.
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

function build(queryChunked = jest.fn().mockResolvedValue(undefined)): {
  gateway: ScadaRuntimeGateway;
  socket: FakeSocket;
  queryChunked: jest.Mock;
} {
  const gateway = new ScadaRuntimeGateway(
    mockOf<JwtService>({}),
    mockOf<TagManagerService>({ removeSocket: jest.fn() }),
    mockOf<ConfigService>({ get: jest.fn().mockReturnValue(undefined) }),
    mockOf<TagResolutionService>({}),
    mockOf<EventEmitter2>({ emit: jest.fn() }),
    mockOf<DaqStorageService>({ queryChunked }),
    mockOf<ScadaPackageService>({}),
  );

  const socket = fakeSocket('sock-daq');
  (gateway as unknown as {
    clients: Map<string, { socket: Socket; tenantId: string; userId: string; role: HmiRole }>;
  }).clients.set('sock-daq', {
    socket: socket as unknown as Socket,
    tenantId: TENANT,
    userId: 'user-1',
    role: 'operator',
  });

  return { gateway, socket, queryChunked };
}

interface DaqPayload {
  queryId: string;
  tagIds: string[];
  from: number;
  to: number;
  aggregation?: { function: 'min' | 'max' | 'avg' | 'sum'; interval: '1min' | '5min' | '10min' | '30min' | '1h' | '1d' };
}

function errors(socket: FakeSocket): Array<{ code: string; message: string; event: string }> {
  return socket.emitted
    .filter((e) => e.event === 'scada:error')
    .map((e) => e.payload as { code: string; message: string; event: string });
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('ScadaRuntimeGateway — DAQ query safety (M7)', () => {
  describe('span clamps', () => {
    it('rejects a raw span over 7 days with guidance to aggregate', async () => {
      const { gateway, socket, queryChunked } = build();
      const payload: DaqPayload = {
        queryId: 'q1',
        tagIds: ['tank1.temp'],
        from: Date.now() - 8 * DAY,
        to: Date.now(),
      };
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);

      expect(queryChunked).not.toHaveBeenCalled();
      const errs = errors(socket);
      expect(errs[0]!.code).toBe('VALIDATION_ERROR');
      expect(errs[0]!.message).toMatch(/limited to 7 days/i);
      expect(errs[0]!.message).toMatch(/aggregation/i);
    });

    it('rejects an aggregated span over 365 days', async () => {
      const { gateway, socket, queryChunked } = build();
      const payload: DaqPayload = {
        queryId: 'q2',
        tagIds: ['tank1.temp'],
        from: Date.now() - 366 * DAY,
        to: Date.now(),
        aggregation: { function: 'avg', interval: '1d' },
      };
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);

      expect(queryChunked).not.toHaveBeenCalled();
      expect(errors(socket)[0]!.message).toMatch(/365 days/);
    });

    it('rejects an inverted / zero span', async () => {
      const { gateway, socket, queryChunked } = build();
      const payload: DaqPayload = {
        queryId: 'q3',
        tagIds: ['tank1.temp'],
        from: Date.now(),
        to: Date.now() - HOUR,
      };
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);
      expect(errors(socket)[0]!.message).toMatch(/greater than 'from'/);
    });
  });

  describe('total-point cap', () => {
    it('rejects a raw query whose estimated points exceed the cap, with guidance', async () => {
      const { gateway, socket, queryChunked } = build();
      // 7 days at 1 sample / 10 s per tag = 60_480 points/tag; 4 tags ≈ 242k > 200k.
      const payload: DaqPayload = {
        queryId: 'q4',
        tagIds: ['t1', 't2', 't3', 't4'],
        from: Date.now() - 7 * DAY,
        to: Date.now(),
      };
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);

      expect(queryChunked).not.toHaveBeenCalled();
      const errs = errors(socket);
      expect(errs[0]!.code).toBe('VALIDATION_ERROR');
      expect(errs[0]!.message).toMatch(/too large/i);
      expect(errs[0]!.message).toMatch(/aggregation|interval|range/i);
    });

    it('rejects an aggregated query over the cap and suggests a wider interval', async () => {
      const { gateway, socket, queryChunked } = build();
      // 1min buckets over 200 days ≈ 288k points for ONE tag.
      const payload: DaqPayload = {
        queryId: 'q5',
        tagIds: ['t1'],
        from: Date.now() - 200 * DAY,
        to: Date.now(),
        aggregation: { function: 'avg', interval: '1min' },
      };
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);

      expect(queryChunked).not.toHaveBeenCalled();
      expect(errors(socket)[0]!.message).toMatch(/too large/i);
    });

    it('admits a bounded query through to the storage layer', async () => {
      const { gateway, socket, queryChunked } = build();
      const payload: DaqPayload = {
        queryId: 'q6',
        tagIds: ['t1'],
        from: Date.now() - 24 * HOUR,
        to: Date.now(),
      };
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);

      expect(queryChunked).toHaveBeenCalledTimes(1);
      expect(errors(socket)).toHaveLength(0);
    });
  });

  describe('per-socket rate limit', () => {
    it('blocks an 11-query burst within the same second (5/s burst 10)', async () => {
      const { gateway, socket, queryChunked } = build();
      const payload: DaqPayload = {
        queryId: 'q-rate',
        tagIds: ['t1'],
        from: Date.now() - HOUR,
        to: Date.now(),
      };

      for (let i = 0; i < 10; i++) {
        await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);
      }
      expect(queryChunked).toHaveBeenCalledTimes(10);
      expect(errors(socket)).toHaveLength(0);

      // 11th inside the burst window → RATE_LIMITED, storage untouched.
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);
      expect(queryChunked).toHaveBeenCalledTimes(10);
      const errs = errors(socket);
      expect(errs[0]!.code).toBe('RATE_LIMITED');
      expect(errs[0]!.message).toMatch(/rate limit/i);
    });

    it('the bucket refills over time (5/s sustained)', async () => {
      const { gateway, socket, queryChunked } = build();
      const payload: DaqPayload = {
        queryId: 'q-refill',
        tagIds: ['t1'],
        from: Date.now() - HOUR,
        to: Date.now(),
      };

      const nowSpy = jest.spyOn(Date, 'now');
      let now = Date.now();
      nowSpy.mockImplementation(() => now);

      for (let i = 0; i < 10; i++) {
        await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);
      }
      // 11th rejected in the same instant…
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);
      expect(errors(socket)).toHaveLength(1);

      // …but one second later (5 tokens refilled) it is admitted again.
      now += 1100;
      await gateway.handleDaqQuery(socket as unknown as Socket, payload as never);
      expect(queryChunked).toHaveBeenCalledTimes(11);
      nowSpy.mockRestore();
    });

    it('disconnecting frees the socket bucket (per-socket, not per-tenant)', async () => {
      const { gateway, socket } = build();
      gateway.handleDisconnect(socket as unknown as Socket);

      const buckets = (gateway as unknown as { daqRateBuckets: Map<string, unknown> }).daqRateBuckets;
      expect(buckets.has('sock-daq')).toBe(false);
    });
  });
});
