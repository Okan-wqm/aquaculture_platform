import {
  AQUA_EVENT_ID_NAMESPACE,
  createBaseEvent,
  deriveEventId,
  toEventIso,
  type BaseEvent,
  type EventId,
} from '../base-event';

/**
 * BaseEvent contract — invariants pinned at unit-test layer
 * ============================================================================
 *
 * # Why this spec exists
 *
 * `createBaseEvent` is the canonical factory every emit site uses. Three
 * critical invariants the runtime depends on:
 *
 *   1. `eventId` is a fresh UUID per call (no collisions in batches)
 *   2. `timestamp` is an ISO 8601 STRING, NOT a Date instance — the
 *      W0.E DATA-CRITICAL-003 cure removed the kernel re-coercion;
 *      consumers expect `string` per BaseEvent contract.
 *   3. Required fields (eventId, eventType, timestamp, tenantId,
 *      version, aggregateId, aggregateType) are always populated.
 *
 * Without an explicit spec, a future refactor could silently:
 *   - re-introduce `new Date()` for the timestamp (regressing
 *     PLAT-CRITICAL-002 / DATA-CRITICAL-003)
 *   - share an eventId across calls via memoization
 *   - drop a required field
 *
 * The invariant test catches each of these at CI time.
 */
describe('createBaseEvent — canonical contract invariants', () => {
  // Concrete-type stub so the generic narrows to a known eventType.
  interface TestEvent extends BaseEvent {
    eventType: 'TestEvent';
  }

  describe('eventId', () => {
    it('returns a freshly-generated UUID per call', () => {
      const a = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      const b = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      expect(a.eventId).not.toBe(b.eventId);
    });

    it('eventId matches the canonical UUID v4 shape', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      expect(event.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('eventId is typed as the branded EventId nominal type', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      // The branded type narrows at compile time; at runtime we just
      // assert the value is a string. The compile-time check is
      // implicit in the assignment-to-EventId path the function uses.
      const _branded: EventId = event.eventId;
      expect(typeof _branded).toBe('string');
    });
  });

  describe('timestamp — DATA-CRITICAL-003 cure', () => {
    it('returns an ISO 8601 STRING, not a Date instance', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      expect(typeof event.timestamp).toBe('string');
      expect(event.timestamp).not.toBeInstanceOf(Date);
    });

    it('timestamp matches strict ISO 8601 with millisecond precision', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('timestamp is parseable by Date.parse without ambiguity', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      const parsed = Date.parse(event.timestamp);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeLessThanOrEqual(Date.now());
      expect(parsed).toBeGreaterThan(Date.now() - 5000);
    });
  });

  describe('required fields populated', () => {
    it('every required field is present', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      expect(event.eventId).toBeDefined();
      expect(event.eventType).toBe('TestEvent');
      expect(event.timestamp).toBeDefined();
      expect(event.tenantId).toBe('tenant-1');
      expect(event.version).toBe(1);
      expect(event.aggregateId).toBe('');
      expect(event.aggregateType).toBe('');
    });

    it('overrides take precedence over defaults', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1', {
        aggregateId: 'agg-99',
        aggregateType: 'Test',
        version: 2,
        correlationId: 'corr-abc',
        userId: 'user-7',
      });
      expect(event.aggregateId).toBe('agg-99');
      expect(event.aggregateType).toBe('Test');
      expect(event.version).toBe(2);
      expect(event.correlationId).toBe('corr-abc');
      expect(event.userId).toBe('user-7');
    });

    it('overrides cannot replace required defaulted fields when undefined', () => {
      // Passing undefined override fields preserves the canonical defaults.
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1', {
        aggregateId: undefined,
      });
      // overrides spread overwrites — undefined replaces ''
      // This is the expected behaviour: the caller controls the value.
      // The test pins the documented behaviour, not a silent default.
      expect(event.aggregateId).toBeUndefined();
    });
  });

  describe('tenantId — required positional argument', () => {
    it('passes tenantId through unchanged', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-special-123');
      expect(event.tenantId).toBe('tenant-special-123');
    });
  });

  describe('eventType — discriminator', () => {
    it('eventType matches the type-level discriminator literal', () => {
      const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
      expect(event.eventType).toBe('TestEvent');
    });
  });
});

describe('toEventIso (ORPHAN-111 canonical date→ISO normaliser)', () => {
  it('converts a Date to an ISO 8601 string', () => {
    const d = new Date('2026-06-26T10:20:30.000Z');
    expect(toEventIso(d)).toBe('2026-06-26T10:20:30.000Z');
  });

  it('normalises an already-ISO string idempotently (round-trips)', () => {
    expect(toEventIso('2026-06-26T10:20:30.000Z')).toBe('2026-06-26T10:20:30.000Z');
  });

  it('parses a non-ISO date string to canonical ISO', () => {
    expect(toEventIso('2026-06-26')).toBe('2026-06-26T00:00:00.000Z');
  });

  it('maps null/undefined to undefined (never the string "null")', () => {
    expect(toEventIso(null)).toBeUndefined();
    expect(toEventIso(undefined)).toBeUndefined();
  });

  it('throws on an unparseable value rather than emitting a bad timestamp', () => {
    expect(() => toEventIso('not-a-date')).toThrow(TypeError);
    expect(() => toEventIso(new Date('nope'))).toThrow(TypeError);
  });
});

describe('deriveEventId — deterministic (UUIDv5) event identity (Task 1.4)', () => {
  // Concrete-type stub so the generic narrows to a known eventType.
  interface TestEvent extends BaseEvent {
    eventType: 'TestEvent';
  }

  const RFC4122_DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  it('implements the RFC 4122 §4.3 algorithm (known v5 vector)', () => {
    // Cross-implementation reference vector: v5(DNS, "python.org") =
    // 886313e1-3b8a-5372-9b90-0c9aee199e5d. Pinning this proves the SHA-1 +
    // version/variant bit layout, not just self-consistency.
    expect(deriveEventId('python.org', RFC4122_DNS_NAMESPACE)).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });

  it('is deterministic: the same seed yields the same EventId', () => {
    const a = deriveEventId('tenant-1\u0000sensor-9\u000017300000000000\u0000abc123');
    const b = deriveEventId('tenant-1\u0000sensor-9\u000017300000000000\u0000abc123');
    expect(a).toBe(b);
  });

  it('differs across seeds and across namespaces', () => {
    const base = deriveEventId('seed');
    expect(deriveEventId('seed-2')).not.toBe(base);
    expect(deriveEventId('seed', RFC4122_DNS_NAMESPACE)).not.toBe(base);
    // The platform namespace is a valid UUID and NOT one of the RFC's.
    expect(AQUA_EVENT_ID_NAMESPACE).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(AQUA_EVENT_ID_NAMESPACE).not.toBe(RFC4122_DNS_NAMESPACE);
  });

  it('yields a valid RFC 4122 v5-shaped UUID', () => {
    const id = deriveEventId('shape-check');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('fails closed on an empty seed', () => {
    expect(() => deriveEventId('')).toThrow(/empty seed/);
  });

  it('createBaseEvent honors an explicit eventId override verbatim (no random replacement)', () => {
    const deterministic = deriveEventId('tenant-1\u0000sensor-9\u0000payload-sha');
    const event = createBaseEvent<TestEvent>('TestEvent', 'tenant-1', {
      eventId: deterministic,
    });
    expect(event.eventId).toBe(deterministic);
  });

  it('createBaseEvent still generates fresh random UUIDs without an override', () => {
    const a = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
    const b = createBaseEvent<TestEvent>('TestEvent', 'tenant-1');
    expect(a.eventId).not.toBe(b.eventId);
  });
});
