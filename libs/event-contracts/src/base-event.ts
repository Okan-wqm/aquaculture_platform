/**
 * Branded type for event IDs. Can ONLY be produced by `createBaseEvent()`.
 *
 * ARCHITECTURAL INVARIANT: This branded type makes inline event construction
 * a compile-time error. You CANNOT assign a plain `string` to `EventId`:
 *
 *   // COMPILE ERROR — cannot assign string to EventId:
 *   const event = { eventId: crypto.randomUUID(), ... }
 *
 *   // CORRECT — use the factory:
 *   const event = { ...createBaseEvent('EventType', tenantId), ... }
 *
 * This prevents the class of bugs where inline event construction skips
 * required fields (timestamp format, aggregateId, version, etc.).
 */
export type EventId = string & { readonly __brand: unique symbol };

/**
 * Base Event Contract - All events must implement these properties
 * Designed for enterprise multi-tenant aquaculture platform
 *
 * All events MUST be flat objects conforming to this interface.
 * Never wrap business fields inside a nested `payload` or `metadata` object.
 * Use `createBaseEvent()` to construct events with auto-generated fields.
 */
export interface BaseEvent {
  /**
   * Unique event identifier — branded type, only producible by createBaseEvent()
   */
  eventId: EventId;

  /**
   * Event type name for routing (PascalCase, e.g. 'TenantCreated')
   */
  eventType: string;

  /**
   * When the event occurred (ISO 8601 string).
   *
   * WHY string not Date: JSONB serialization converts Date to ISO 8601 string
   * on the wire. Declaring Date here makes the TypeScript interface lie about
   * the runtime type. Consumers that need Date should call `new Date(event.timestamp)`.
   *
   * @example "2026-04-09T14:30:00.000Z"
   */
  timestamp: string;

  /**
   * Tenant identifier for multi-tenancy.
   * MUST be at the top level for NATS subject routing.
   */
  tenantId: string;

  /**
   * ID of the domain aggregate root this event belongs to.
   * Required for event sourcing: enables replaying all events for a specific entity
   * (e.g., all events for subscriptionId='abc-123') and building audit trails per entity.
   *
   * BEFORE this field: events could not be filtered by business entity — only by tenantId.
   * This made event replay and per-aggregate audit trails impossible.
   *
   * Examples: subscriptionId, batchId, sensorId, employeeId, paymentId
   */
  aggregateId?: string;

  /**
   * Type name of the domain aggregate (e.g., 'Subscription', 'Batch', 'Sensor', 'Employee').
   * Paired with aggregateId to enable aggregate-type-aware event routing and replay.
   */
  aggregateType?: string;

  /**
   * Correlation ID for distributed tracing
   */
  correlationId?: string;

  /**
   * Causation ID (ID of the event that caused this one)
   */
  causationId?: string;

  /**
   * User who triggered the event
   */
  userId?: string;

  /**
   * Event schema version for evolution.
   * Bump when fields are renamed or removed.
   */
  version: number;

  /**
   * Number of times this event has been retried after initial delivery failure.
   * Used by consumers and dead-letter processors to implement retry limits.
   * Value is 0 on first delivery; incremented by the retry/DLQ infrastructure.
   */
  retryCount?: number;

  /**
   * Crypto-shred key ID for GDPR erasure support.
   * When set, all PII fields in this event are encrypted with the key identified by
   * this ID. Deleting the key from the key store renders all PII in this event
   * irrecoverable (crypto-shredding).
   *
   * SECURITY: Events containing PII (employeeName, email, nationalId) MUST set this
   * field. Consumers that need PII must decrypt using the key store. If the key is
   * deleted (GDPR erasure), consumers see encrypted gibberish — no replay needed.
   *
   * @see DATA-HIGH-003 (PII in events without crypto-shred support)
   */
  cryptoShredKeyId?: string;
}

/**
 * Canonical PII-class event registry (DATA-LOW-003 cure).
 *
 * # Why this list exists
 *
 * The `cryptoShredKeyId` field on BaseEvent is OPTIONAL (`?:`). The
 * audit-trail invariant requires that EVERY event carrying PII
 * (employee name, email, national ID, billing email, etc.) emit
 * with a non-null `cryptoShredKeyId` so a future GDPR-Art-17
 * erasure can crypto-shred the per-tenant key and render the
 * event payload unrecoverable across every consumer that
 * persisted it.
 *
 * Pre-cure the only event that STRUCTURALLY enforced this was
 * `PasswordResetRequestedEvent` (mandatory `cryptoShredKeyId:
 * string`). Other PII-bearing events relied on per-event author
 * discipline. The systematic policy-by-shape was missing — new
 * events introducing PII without opting in were a slow leak.
 *
 * # How this list works
 *
 * The `PII_BEARING_EVENT_TYPES` array is the canonical
 * declaration: "these eventType strings carry PII; their
 * publishers MUST stamp cryptoShredKeyId." The companion
 * invariant `tests/invariants/pii-events-mandatory-crypto-shred.spec.ts`
 * (added alongside) enforces TWO checks:
 *
 *   1. Every entry in this list resolves to a real event-
 *      contract interface that DECLARES `cryptoShredKeyId:
 *      string` (mandatory; not the optional inherited form).
 *      A new entry without the structural mandatory-ness fails.
 *   2. (Future-extension) Every event interface that mentions
 *      common PII field names (email, name, phoneNumber,
 *      nationalId) is either on this list OR carries an
 *      explicit `// no-pii-event:` marker comment.
 *
 * # How to add a new PII-bearing event
 *
 *   1. Author the interface; declare `cryptoShredKeyId: string`
 *      (mandatory, no `?`).
 *   2. Add the eventType string literal to this array.
 *   3. Update the per-event JSON Schema validator to require
 *      cryptoShredKeyId (if cross-trust-boundary).
 *
 * The architectural-arbiter approves additions; compliance-expert
 * is the CATCHER for the per-event PII categorisation decision.
 */
export const PII_BEARING_EVENT_TYPES: readonly string[] = ['PasswordResetRequested'] as const;

// ==================== Shared Literal Types ====================

/**
 * Canonical plan tier values used across tenant and billing events.
 * All services MUST use these values for tier fields.
 *
 * `free` is a permanent $0 tier (Billing Revival Faz B): a real, non-trial
 * subscription with FREE-plan limits and no Stripe object. It is a first-class
 * tier in the provisioning command so admin-api can no longer silently coerce
 * `free` down to `starter` on the wire.
 */
export type PlanTier = 'free' | 'starter' | 'professional' | 'enterprise';

/**
 * Canonical billing cycle values.
 */
export type BillingCycle = 'monthly' | 'quarterly' | 'semi_annual' | 'annual';

/**
 * Create a base event with auto-generated eventId, timestamp (ISO 8601 string), and version.
 *
 * `aggregateId` and `aggregateType` are required so that every event is properly
 * associated with a domain aggregate for event-sourced replay and per-entity audit trails.
 *
 * Usage:
 * ```typescript
 * const event: TenantCreatedEvent = {
 *   ...createBaseEvent('TenantCreated', tenantId, { aggregateId: tenantId, aggregateType: 'Tenant' }),
 *   name: tenant.name,
 *   slug: tenant.slug,
 * };
 * ```
 */
export function createBaseEvent<T extends BaseEvent>(
  eventType: T['eventType'],
  tenantId: string,
  overrides?: Partial<
    Pick<
      BaseEvent,
      | 'eventId'
      | 'correlationId'
      | 'causationId'
      | 'userId'
      | 'version'
      | 'aggregateId'
      | 'aggregateType'
    >
  >,
): Pick<
  BaseEvent,
  'eventId' | 'timestamp' | 'tenantId' | 'version' | 'aggregateId' | 'aggregateType'
> & { eventType: T['eventType'] } & Partial<BaseEvent> {
  return {
    eventId: crypto.randomUUID() as EventId,
    eventType,
    timestamp: new Date().toISOString(),
    tenantId,
    version: 1,
    aggregateId: '',
    aggregateType: '',
    ...overrides,
  } as Pick<
    BaseEvent,
    'eventId' | 'timestamp' | 'tenantId' | 'version' | 'aggregateId' | 'aggregateType'
  > & { eventType: T['eventType'] } & Partial<BaseEvent>;
}

/**
 * Platform namespace for derived (deterministic) event identities.
 *
 * A fixed, RFC 4122-shaped UUID that is deliberately NOT one of the RFC's
 * own namespaces (DNS/URL/OID/X500): derived platform event ids must never
 * collide with ids minted by generic v5 tooling in other systems.
 */
export const AQUA_EVENT_ID_NAMESPACE = 'a10c35ff-7d3a-4c1e-b2a4-9f60c8d5e7b1';

/**
 * Pure-TS SHA-1 (FIPS 180-1) — 20-byte digest.
 *
 * WHY not node:crypto: this library is written environment-neutral
 * (createBaseEvent already uses the global WebCrypto `crypto.randomUUID`);
 * importing node:crypto would pull the contract library out of any
 * non-Node consumer. SHA-1 here is NOT a security primitive — UUIDv5 uses
 * it purely as the deterministic mixing function RFC 4122 §4.3 prescribes,
 * which is why its cryptographic weakness is irrelevant for this use.
 */
function sha1Digest(bytes: Uint8Array): Uint8Array {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) << 6) + 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  const rotl = (value: number, shift: number): number =>
    ((value << shift) | (value >>> (32 - shift))) >>> 0;

  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const out = new DataView(digest.buffer);
  out.setUint32(0, h0, false);
  out.setUint32(4, h1, false);
  out.setUint32(8, h2, false);
  out.setUint32(12, h3, false);
  out.setUint32(16, h4, false);
  return digest;
}

/**
 * Deterministic EventId factory (plan Task 1.4): RFC 4122 §4.3 UUIDv5 over
 * the platform namespace and the caller's seed.
 *
 * Same seed → same EventId, forever and everywhere. This is the identity
 * that makes redelivery idempotent: the event-bus stamps `Nats-Msg-Id` from
 * `eventId`, so JetStream's duplicate window and downstream uniqueness keys
 * collapse re-emissions of the SAME source reading into one logical event.
 *
 * The caller owns seed construction and MUST fold in every dimension that
 * distinguishes two legitimate events (tenant, sensor, producer timestamp,
 * payload digest — or a parent eventId + discriminator for child events).
 * Join parts with '\u0000' so no delimiter injection can alias two seeds.
 */
export function deriveEventId(seed: string, namespace: string = AQUA_EVENT_ID_NAMESPACE): EventId {
  if (seed.length === 0) {
    throw new Error(
      'deriveEventId: empty seed — a deterministic identity requires the caller to ' +
        'supply the source parts (tenant/sensor/producerTs/payload, or parent eventId)',
    );
  }

  const hexToBytes = (hex: string): Uint8Array => {
    const clean = hex.replace(/-/g, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
  };

  const namespaceBytes = hexToBytes(namespace);
  const seedBytes = new TextEncoder().encode(seed);
  const input = new Uint8Array(namespaceBytes.length + seedBytes.length);
  input.set(namespaceBytes);
  input.set(seedBytes, namespaceBytes.length);

  const digest = sha1Digest(input);

  // RFC 4122 §4.3: version 5, RFC variant.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;

  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}` as EventId;
}

/**
 * Canonical domain-date → event-wire (ISO 8601 string) normaliser — the SINGLE
 * conversion point for every date field on an event contract (ORPHAN-111).
 *
 * Event contracts carry dates as ISO `string` (the wire shape the JSON schemas
 * validate, matching `BaseEvent.timestamp`). Producers, however, hold `Date`
 * objects from TypeORM entities — and TypeORM occasionally hands back a `string`
 * for a date column, which is exactly why ad-hoc producer code grew defensive
 * `x instanceof Date ? x : new Date(x)` checks. Routing every producer through
 * this one helper kills that drift: the conversion is defined once, is idempotent
 * (a valid string round-trips), and fails fast on an unparseable value rather
 * than emitting a malformed timestamp onto the wire.
 *
 * Overloaded so a required field stays `string` and an optional field stays
 * `string | undefined` (a nullish input maps to `undefined`, never `"null"`).
 */
export function toEventIso(value: Date | string): string;
export function toEventIso(value: Date | string | null | undefined): string | undefined;
export function toEventIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`toEventIso: unparseable date value: ${String(value)}`);
  }
  return date.toISOString();
}
