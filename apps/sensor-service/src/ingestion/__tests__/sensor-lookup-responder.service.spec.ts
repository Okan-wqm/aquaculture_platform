/**
 * SensorLookupResponderService unit tests — Faz 3 follow-on.
 *
 * Pins the cache-miss responder pair contract that the Rust sidecar
 * (`apps/sensor-ingestion/src/sensor_lookup.rs`) and this NestJS
 * responder share over `sensor.lookup.by-topic`:
 *
 *   - Subject literal MUST match the Rust `LOOKUP_SUBJECT` constant
 *     byte-for-byte (`'sensor.lookup.by-topic'`).
 *   - Reply for unknown sensor → JSON literal `null` (Rust decodes
 *     `Option<SensorMeta>` directly, so `null` → `None`).
 *   - Reply for tenant mismatch → JSON literal `null` + warn log
 *     (SEC-M01 defence-in-depth).
 *   - Reply for happy path → camelCase
 *     `{ sensorId, tenantId, channelIds[] }` shape.
 *   - Bad request bodies (non-JSON, missing fields) → JSON `null`
 *     reply, NEVER throw (would leave the request hanging until the
 *     sidecar's tokio timeout fires).
 */

import type { Msg } from '@nats-io/nats-core';
import { ConfigService } from '@nestjs/config';

import { SensorLookupResponderService } from '../sensor-lookup-responder.service';
import { Sensor } from '../../database/entities/sensor.entity';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID_OTHER = '22222222-2222-2222-2222-222222222222';
const SENSOR_ID = '33333333-3333-3333-3333-333333333333';
const CHANNEL_ID_A = '44444444-4444-4444-4444-444444444444';
const CHANNEL_ID_B = '55555555-5555-5555-5555-555555555555';
const FARM_ID = '66666666-6666-6666-6666-666666666666';
const POND_ID = '77777777-7777-7777-7777-777777777777';

function fakeSensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: SENSOR_ID,
    tenantId: TENANT_ID,
    ...overrides,
  } as unknown as Sensor;
}

function fakeChannel(id: string, overrides: Partial<SensorDataChannel> = {}): SensorDataChannel {
  return {
    id,
    sensorId: SENSOR_ID,
    tenantId: TENANT_ID,
    channelKey: 'temperature',
    isEnabled: true,
    ...overrides,
  } as unknown as SensorDataChannel;
}

interface CacheStub {
  getSensor: jest.Mock;
  getChannels: jest.Mock;
  invalidateSensor: jest.Mock;
  invalidateTenant: jest.Mock;
}

function makeCache(opts?: {
  sensor?: Sensor | null;
  channels?: SensorDataChannel[];
  sensorThrows?: Error;
  channelsThrows?: Error;
}): CacheStub {
  const getSensor = jest.fn();
  if (opts?.sensorThrows) {
    getSensor.mockRejectedValue(opts.sensorThrows);
  } else {
    // Explicit `in opts` check so that `sensor: null` in the test
    // overrides the default fakeSensor() — the `??` shortcut would
    // mask the null and wrong-test the responder's not-found path.
    const resolved = opts && 'sensor' in opts ? (opts.sensor ?? null) : fakeSensor();
    getSensor.mockResolvedValue(resolved);
  }
  const getChannels = jest.fn();
  if (opts?.channelsThrows) {
    getChannels.mockRejectedValue(opts.channelsThrows);
  } else {
    getChannels.mockResolvedValue(opts?.channels ?? [fakeChannel(CHANNEL_ID_A)]);
  }
  return {
    getSensor,
    getChannels,
    invalidateSensor: jest.fn(),
    invalidateTenant: jest.fn(),
  };
}

/**
 * Build a mock NATS Msg with a request body. The mock implements only
 * the surface the responder reaches for: `string()` (decoded UTF-8 body
 * — v3 replaces v2's StringCodec.decode(msg.data)), `reply` (subject the
 * responder publishes the reply to), and `respond` (the call we assert
 * on — v3 respond() accepts a string directly).
 */
function makeMsg(body: unknown, hasReply = true): Msg & { _replies: string[] } {
  const replies: string[] = [];
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    string: jest.fn(() => text),
    reply: hasReply ? '_INBOX.test.0' : '',
    respond: jest.fn((payload: string) => {
      replies.push(payload);
      return true;
    }),
    _replies: replies,
  } as unknown as Msg & { _replies: string[] };
}

function makeService(cache: CacheStub): SensorLookupResponderService {
  const config = {
    get: jest.fn().mockReturnValue('nats://localhost:4222'),
  } as unknown as ConfigService;
  return new SensorLookupResponderService(cache, config);
}

describe('SensorLookupResponderService', () => {
  describe('subject literal — wire contract with Rust sidecar', () => {
    it('Subscribe topic literal is "sensor.lookup.by-topic"', () => {
      // CRITICAL: this literal MUST equal the Rust `LOOKUP_SUBJECT`
      // constant in `apps/sensor-ingestion/src/sensor_lookup.rs`. A
      // drift on either side breaks the responder pair silently in
      // production but is caught by THIS assertion + the mirror test
      // `subject_is_canonical` on the Rust side.
      expect(SensorLookupResponderService.SUBJECT).toBe('sensor.lookup.by-topic');
    });
  });

  describe('handleLookupRequest — happy path', () => {
    it('responds with full sensor + channelIds array (no farm/pond binding)', async () => {
      // Default fakeSensor() has no farmId / pondId — the absent-key
      // shape that the Rust SensorMeta with `farm_id: None, pond_id:
      // None` decodes from. This pins the "operator-owned sentinel
      // device" wire shape: 3 keys, never `null` for absent fields.
      const cache = makeCache({
        sensor: fakeSensor(),
        channels: [fakeChannel(CHANNEL_ID_A), fakeChannel(CHANNEL_ID_B)],
      });
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID });
      await svc.handleLookupRequest(msg);
      expect(msg._replies).toHaveLength(1);
      // Type assertion: replies always has at least 1 element here
      // (asserted above). Index access is safe.
      const reply = msg._replies[0]!;
      const parsed = JSON.parse(reply) as Record<string, unknown>;
      expect(parsed).toEqual({
        sensorId: SENSOR_ID,
        tenantId: TENANT_ID,
        channelIds: [CHANNEL_ID_A, CHANNEL_ID_B],
        channelKeys: {
          [CHANNEL_ID_A]: 'temperature',
          [CHANNEL_ID_B]: 'temperature',
        },
      });
      // Belt-and-braces: the substrings `"farmId"` / `"pondId"` MUST
      // NOT appear anywhere in the wire body when the sensor has no
      // farm/pond binding. A stringify quirk that emitted them as
      // `null` (impossible today, but a future refactor could change
      // this) would fail here before reaching the Rust decoder.
      expect(reply).not.toContain('"farmId"');
      expect(reply).not.toContain('"pondId"');
    });

    it('responds with farmId + pondId when sensor has both bound', async () => {
      // Steady-state happy path: sensor is registered with both farm
      // AND pond. Both keys MUST appear in the wire shape so the Rust
      // sidecar's drain populates the published
      // SensorMetricIngestedEvent.farmId / .pondId from this reply.
      const cache = makeCache({
        sensor: fakeSensor({ farmId: FARM_ID, pondId: POND_ID }),
        channels: [fakeChannel(CHANNEL_ID_A)],
      });
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID });
      await svc.handleLookupRequest(msg);
      const reply = msg._replies[0]!;
      const parsed = JSON.parse(reply) as Record<string, unknown>;
      expect(parsed).toEqual({
        sensorId: SENSOR_ID,
        tenantId: TENANT_ID,
        channelIds: [CHANNEL_ID_A],
        channelKeys: { [CHANNEL_ID_A]: 'temperature' },
        farmId: FARM_ID,
        pondId: POND_ID,
      });
    });

    it('omits farmId / pondId keys (does NOT serialise as null) when sensor has neither', async () => {
      // Same architectural payoff as the equivalent Rust test
      // `sensor_meta_omits_farm_pond_when_none`: the absent-not-null
      // contract pinned at the wire boundary. Rust decoders for
      // `Option<Uuid>` accept either "key absent" or "value null",
      // but an absent key is the SoT — keeping the byte shape
      // canonical means a downstream consumer (or audit log diff)
      // cannot drift on the optional-field encoding.
      const cache = makeCache({
        sensor: fakeSensor({ farmId: undefined, pondId: undefined }),
      });
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID });
      await svc.handleLookupRequest(msg);
      const reply = msg._replies[0]!;
      const parsed = JSON.parse(reply) as Record<string, unknown>;
      // Object.prototype.hasOwnProperty.call avoids any prototype-chain
      // surprise — pure structural check on the parsed object.
      expect(Object.prototype.hasOwnProperty.call(parsed, 'farmId')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(parsed, 'pondId')).toBe(false);
      expect(Object.keys(parsed).sort()).toEqual(
        ['channelIds', 'channelKeys', 'sensorId', 'tenantId'].sort(),
      );
    });

    it('reply shape uses camelCase keys (matches Rust SensorMeta serde shape)', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID });
      await svc.handleLookupRequest(msg);
      const replyText = msg._replies[0]!;
      const parsed = JSON.parse(replyText) as Record<string, unknown>;
      // Pin the exact key set — a future field rename would fail here
      // BEFORE it could deploy alongside a Rust-side mismatch.
      expect(Object.keys(parsed).sort()).toEqual(
        ['channelIds', 'channelKeys', 'sensorId', 'tenantId'].sort(),
      );
    });
  });

  describe('handleLookupRequest — null replies', () => {
    it('getSensor returns null → responder replies with JSON literal null', async () => {
      const cache = makeCache({ sensor: null });
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID });
      await svc.handleLookupRequest(msg);
      expect(msg._replies).toEqual(['null']);
      // getChannels is unreachable when getSensor returns null; the
      // responder MUST NOT pay that cost on a not-found sensor.
      expect(cache.getChannels).not.toHaveBeenCalled();
    });

    it('tenant mismatch → responder replies with null + logs warn', async () => {
      const cache = makeCache({
        sensor: fakeSensor({ tenantId: TENANT_ID_OTHER }),
      });
      const svc = makeService(cache);
      // Spy on Logger.prototype.warn to confirm the warn fired (the
      // log message itself is non-load-bearing; the security-team
      // alarm fires off the structured field set, not the text).
      const warnSpy = jest.spyOn(svc['logger'], 'warn').mockImplementation(() => undefined);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID });
      await svc.handleLookupRequest(msg);
      expect(msg._replies).toEqual(['null']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Channels must NOT be fetched on a tenant mismatch — leaking
      // the channel array to the wrong tenant is the SEC-M01 hazard
      // the cross-check is here to prevent.
      expect(cache.getChannels).not.toHaveBeenCalled();
    });
  });

  describe('handleLookupRequest — degraded request bodies', () => {
    it('non-JSON body → null reply, no throw', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const msg = makeMsg('this is not json', true);
      await expect(svc.handleLookupRequest(msg)).resolves.toBeUndefined();
      expect(msg._replies).toEqual(['null']);
    });

    it('missing tenantId → null reply, no DB access', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const msg = makeMsg({ sensorId: SENSOR_ID });
      await svc.handleLookupRequest(msg);
      expect(msg._replies).toEqual(['null']);
      expect(cache.getSensor).not.toHaveBeenCalled();
    });

    it('missing sensorId → null reply, no DB access', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID });
      await svc.handleLookupRequest(msg);
      expect(msg._replies).toEqual(['null']);
      expect(cache.getSensor).not.toHaveBeenCalled();
    });

    it('non-string tenantId / sensorId → null reply', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: 42, sensorId: { nested: 'object' } });
      await svc.handleLookupRequest(msg);
      expect(msg._replies).toEqual(['null']);
      expect(cache.getSensor).not.toHaveBeenCalled();
    });

    it('cache.getSensor throws → null reply, never throws to caller', async () => {
      const cache = makeCache({ sensorThrows: new Error('db down') });
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID });
      await expect(svc.handleLookupRequest(msg)).resolves.toBeUndefined();
      expect(msg._replies).toEqual(['null']);
    });

    it('cache.getChannels throws → null reply, never throws to caller', async () => {
      const cache = makeCache({ channelsThrows: new Error('db hiccup') });
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID });
      await expect(svc.handleLookupRequest(msg)).resolves.toBeUndefined();
      expect(msg._replies).toEqual(['null']);
    });
  });

  describe('handleLookupRequest — fire-and-forget request', () => {
    it('msg without reply subject → no respond call, no throw', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      const msg = makeMsg({ tenantId: TENANT_ID, sensorId: SENSOR_ID }, false);
      await svc.handleLookupRequest(msg);
      // No reply requested — the responder must not call respond at
      // all. The spec for `respond` records every call into _replies
      // so an empty array is the proof.
      expect(msg._replies).toEqual([]);
    });
  });

  describe('lifecycle', () => {
    it('onModuleInit logs warn (does NOT throw) when broker is unreachable', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      // The unit-test env does not have a NATS broker — connect()
      // will reject. The contract: degrade gracefully.
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
    });

    it('onModuleDestroy is a no-op when not connected', async () => {
      const cache = makeCache();
      const svc = makeService(cache);
      await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
