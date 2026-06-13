/**
 * NATS v3 wire codec — byte-compatible replacement for the JSONCodec-based
 * serializers @nestjs/microservices ships for Transport.NATS.
 *
 * WHY (PLAT-HIGH-003): @nestjs/microservices' built-in NATS transport calls
 * `require('nats').JSONCodec()` (serializers/nats-record.serializer.js:11,
 * deserializers/nats-response-json.deserializer.js:15, client/client-nats.js).
 * The @nats-io/* v3 split REMOVED `JSONCodec`, so an npm-alias swap of `nats`
 * crashes every Transport.NATS service at construction. PR-B replaces the
 * transport with a platform-owned strategy/proxy (see nats-v3-server.strategy.ts
 * and nats-v3-client.proxy.ts). This codec is the shared wire layer they use.
 *
 * WHAT: `JSONCodec().encode(x)` is byte-identical to
 * `new TextEncoder().encode(JSON.stringify(x))`, and `JSONCodec().decode(bytes)`
 * to `JSON.parse(new TextDecoder().decode(bytes))`. Reproducing exactly those
 * bytes is what lets a rolling deploy run mixed v2/v3 services: a migrated v3
 * service answers an un-migrated v2 caller and vice-versa, with zero broker
 * migration. The byte-for-byte claim is enforced by the golden parity test
 * (__tests__/nats-v3-wire-compat.spec.ts), which serializes the same packets
 * through the real Nest NatsRecordSerializer and asserts equality.
 *
 * Custom NatsRecord headers are intentionally unsupported: a repo-wide audit
 * (2026-06-13) found zero NatsRecordBuilder/NatsRecord callsites, so the wire
 * payload is always the plain JSON-encoded packet.
 */
import type {
  Deserializer,
  IncomingRequest,
  IncomingResponse,
  OutgoingResponse,
  ReadPacket,
  Serializer,
} from '@nestjs/microservices';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** JSONCodec().encode equivalent — UTF-8 bytes of the JSON serialization. */
export function encodeNatsJson(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

/** JSONCodec().decode equivalent — JSON parse of the UTF-8 payload. */
export function decodeNatsJson<T = unknown>(payload: Uint8Array): T {
  return JSON.parse(textDecoder.decode(payload)) as T;
}

/**
 * The shape Nest's serializers return (`{ data, headers }`); the strategy/proxy
 * read `.data`. `headers` stays `undefined` (no NatsRecord usage in the repo).
 */
export interface SerializedNatsPayload {
  data: Uint8Array;
  headers?: undefined;
}

/**
 * Producer-side serializer (client → server, request + event). Mirrors
 * NatsRecordSerializer for the plain-data case.
 */
export class NatsV3RequestSerializer
  implements Serializer<ReadPacket, SerializedNatsPayload>
{
  serialize(packet: ReadPacket): SerializedNatsPayload {
    return { data: encodeNatsJson(packet), headers: undefined };
  }
}

/**
 * Consumer-side serializer (server → client, response). Same JSON encoding as
 * the request serializer; kept as a distinct class so it satisfies the Nest
 * `ConsumerSerializer = Serializer<OutgoingResponse, ...>` contract on the
 * Server base without an unsafe cast.
 */
export class NatsV3ResponseSerializer
  implements Serializer<OutgoingResponse, SerializedNatsPayload>
{
  serialize(packet: OutgoingResponse): SerializedNatsPayload {
    return { data: encodeNatsJson(packet), headers: undefined };
  }
}

/** Consumer-side deserializer (server reads the incoming request/event). */
export class NatsV3RequestDeserializer
  implements Deserializer<Uint8Array, IncomingRequest>
{
  deserialize(payload: Uint8Array): IncomingRequest {
    return decodeNatsJson<IncomingRequest>(payload);
  }
}

/** Producer-side deserializer (client reads the reply). */
export class NatsV3ResponseDeserializer
  implements Deserializer<Uint8Array, IncomingResponse>
{
  deserialize(payload: Uint8Array): IncomingResponse {
    return decodeNatsJson<IncomingResponse>(payload);
  }
}
