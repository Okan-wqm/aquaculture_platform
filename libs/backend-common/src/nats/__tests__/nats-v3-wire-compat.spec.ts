/**
 * Golden wire-compatibility parity test for the PR-B NATS v3 codec.
 *
 * The platform-owned v3 transport (nats-v3-server.strategy.ts /
 * nats-v3-client.proxy.ts) replaces @nestjs/microservices' built-in
 * Transport.NATS, which serializes with nats v2's `JSONCodec`. For a rolling
 * deploy to run mixed v2/v3 services, the v3 codec MUST put byte-identical
 * payloads on the wire (PLAT-HIGH-003).
 *
 * Proof: static fixtures — the exact JSON string each packet must encode to.
 * `JSONCodec().encode(x)` is `new TextEncoder().encode(JSON.stringify(x))`, so these
 * fixtures pin the byte contract without a nats dependency. (The original live
 * `JSONCodec` cross-check that anchored this equivalence was removed in PR-C together
 * with the nats v2 dependency, after PR-B proved it byte-identical.)
 */
import {
  NatsV3RequestSerializer,
  NatsV3ResponseSerializer,
  NatsV3RequestDeserializer,
  NatsV3ResponseDeserializer,
  decodeNatsJson,
  encodeNatsJson,
} from '../nats-v3-codec';

const decoder = new TextDecoder();

interface GoldenCase {
  readonly name: string;
  readonly packet: Record<string, unknown>;
  readonly json: string;
}

// The four representative envelope shapes that cross the wire. `json` is the
// exact serialization @nestjs/microservices produces (JSONCodec → JSON.stringify,
// key order = insertion order of the packet object).
const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    name: 'request with string pattern',
    packet: { pattern: 'cmd.user.create', data: { id: 1, name: 'a' }, id: 'req-1' },
    json: '{"pattern":"cmd.user.create","data":{"id":1,"name":"a"},"id":"req-1"}',
  },
  {
    name: 'request with object pattern',
    packet: { pattern: { cmd: 'verify', svc: 'auth' }, data: [1, 2, 3], id: 'req-2' },
    json: '{"pattern":{"cmd":"verify","svc":"auth"},"data":[1,2,3],"id":"req-2"}',
  },
  {
    name: 'event without id',
    packet: { pattern: 'evt.user.created', data: { id: 7 } },
    json: '{"pattern":"evt.user.created","data":{"id":7}}',
  },
  {
    name: 'response envelope',
    packet: { id: 'req-1', response: { ok: true }, isDisposed: true },
    json: '{"id":"req-1","response":{"ok":true},"isDisposed":true}',
  },
];

describe('NATS v3 wire codec — byte parity', () => {
  describe.each(GOLDEN_CASES)('$name', ({ packet, json }) => {
    it('encodeNatsJson produces the exact JSON UTF-8 bytes', () => {
      const bytes = encodeNatsJson(packet);
      expect(decoder.decode(bytes)).toBe(json);
      expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(json)));
    });

    it('round-trips back to the original packet', () => {
      expect(decodeNatsJson(encodeNatsJson(packet))).toEqual(packet);
    });
  });

  it('request serializer emits the wire payload under `.data`', () => {
    const packet = { pattern: 'cmd.x', data: { a: 1 }, id: 'i' };
    const serialized = new NatsV3RequestSerializer().serialize(packet);
    expect(decoder.decode(serialized.data)).toBe('{"pattern":"cmd.x","data":{"a":1},"id":"i"}');
    expect(serialized.headers).toBeUndefined();
  });

  it('response serializer emits the wire payload under `.data`', () => {
    const response = { id: 'i', response: { ok: true }, isDisposed: true };
    const serialized = new NatsV3ResponseSerializer().serialize(response);
    expect(decoder.decode(serialized.data)).toBe('{"id":"i","response":{"ok":true},"isDisposed":true}');
  });

  it('request deserializer reconstructs the incoming request', () => {
    const bytes = encodeNatsJson({ pattern: 'cmd.x', data: { a: 1 }, id: 'i' });
    expect(new NatsV3RequestDeserializer().deserialize(bytes)).toEqual({
      pattern: 'cmd.x',
      data: { a: 1 },
      id: 'i',
    });
  });

  it('response deserializer reconstructs the incoming response', () => {
    const bytes = encodeNatsJson({ id: 'i', response: { ok: true }, isDisposed: true });
    expect(new NatsV3ResponseDeserializer().deserialize(bytes)).toEqual({
      id: 'i',
      response: { ok: true },
      isDisposed: true,
    });
  });
});
