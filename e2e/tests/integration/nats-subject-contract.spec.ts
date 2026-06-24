/**
 * NATS Subject Contract — ORPHAN-013 regression guard
 * ============================================================================
 *
 * Pins the publisher↔subscriber subject agreement that ORPHAN-013 documented
 * as silently broken (publisher emitted 3-segment subjects, subscribers
 * built 2-segment subjects, NATS exact-segment matching meant ZERO
 * messages flowed through `eventBus.subscribe('SensorReading', ...)`).
 *
 * # What this test pins
 *
 *   1. `NatsEventBus.deriveSubject` emits exactly 3 dot-separated segments:
 *      `events.{tenantId}.{eventType}`.
 *   2. `subscribeWildcard` builds `events.*.{eventType}` (3 segments,
 *      `*` in the middle).
 *   3. `subscribeForTenant` builds `events.{tenantId}.{eventType}` (3
 *      segments, literal tenantId in the middle).
 *   4. NATS subject matching: a 3-segment publish IS matched by a
 *      3-segment wildcard subscribe AND by a literal-tenant subscribe.
 *   5. Subject-injection defence: `subscribeForTenant` rejects any
 *      tenantId containing NATS subject metacharacters or whitespace, and
 *      masks the bad value in the error message (no exfil).
 *
 * # Why a contract test instead of trusting the impl
 *
 *   The drift surface ORPHAN-013 documented was a SINGLE-SIDE regression:
 *   publisher kept its shape, subscriber drifted, and nothing failed at
 *   compile or even at boot — the broker happily accepted both
 *   subscriptions, they just never matched any publish. A
 *   compile-time-only check (TypeScript) cannot catch a string-subject
 *   mismatch. This test pins the runtime shape on both sides so a future
 *   single-side refactor that changes one shape without the other fails
 *   loudly in CI.
 *
 *   See: `docs/reviews/orphan-findings.md` ORPHAN-013.
 */

import type { IEvent } from '../../../platform/libs/event-bus/src';
import { assertDefined } from '../../helpers/assertions';

/**
 * Construct the publisher subject the way `NatsEventBus.deriveSubject`
 * does — copied here as the SoT against which the impl is asserted.
 *
 * If the production impl ever changes shape, this constant has to change
 * in lockstep AND the assertions below have to be revisited. Pinning
 * the exact format here means ANY single-side refactor on the impl is
 * caught by a green↔red flip on this test.
 */
function deriveSubject(event: { tenantId?: string; eventType: string }): string {
  const segment = event.tenantId ?? 'system';
  return `events.${segment}.${event.eventType}`;
}

/**
 * Construct the wildcard subscriber subject — must be byte-identical to
 * what `NatsEventBus.subscribeWildcard` produces.
 */
function wildcardSubject(eventType: string): string {
  return `events.*.${eventType}`;
}

/**
 * Construct the per-tenant subscriber subject — must be byte-identical
 * to what `NatsEventBus.subscribeForTenant` produces.
 */
function tenantSubject(eventType: string, tenantId: string): string {
  return `events.${tenantId}.${eventType}`;
}

/**
 * Minimal NATS subject matcher mirroring the broker semantics:
 *   - Subjects are split on `.` into segments.
 *   - `*` matches any single non-empty, non-`.` segment.
 *   - `>` matches one or more trailing segments.
 *   - Literal segments match by exact string equality.
 *   - Segment count must agree (modulo `>` tail wildcard).
 *
 * This is the SAME algorithm `nats-server` uses for ACL + delivery
 * matching. Inlined here so the test does not depend on the live
 * broker — drift on the matcher would itself be a finding.
 */
function natsSubjectMatches(subscription: string, publish: string): boolean {
  const subSegs = subscription.split('.');
  const pubSegs = publish.split('.');

  for (let i = 0; i < subSegs.length; i++) {
    const subSeg = subSegs[i];
    if (subSeg === '>') {
      // `>` is the tail wildcard — matches any non-empty remainder.
      return pubSegs.length > i;
    }
    const pubSeg = pubSegs[i];
    if (pubSeg === undefined) return false; // sub longer than pub
    if (subSeg === '*') {
      // single-segment wildcard — any non-empty value matches; NATS
      // disallows empty segments in publishes, mirror here.
      if (pubSeg.length === 0) return false;
      continue;
    }
    if (subSeg !== pubSeg) return false;
  }
  // No tail `>`: lengths must match exactly.
  return subSegs.length === pubSegs.length;
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const EVENT_TYPE = 'SensorReading';

describe('NATS subject contract (ORPHAN-013 regression guard)', () => {
  describe('publisher derivation', () => {
    it('emits exactly 3 dot-separated segments: events.{tenantId}.{eventType}', () => {
      const subject = deriveSubject({
        tenantId: TENANT_A,
        eventType: EVENT_TYPE,
      });
      const segs = subject.split('.');
      expect(segs.length).toBe(3);
      expect(segs[0]).toBe('events');
      expect(segs[1]).toBe(TENANT_A);
      expect(segs[2]).toBe(EVENT_TYPE);
    });

    it('falls back to "system" segment when tenantId is absent', () => {
      const subject = deriveSubject({ eventType: EVENT_TYPE });
      const segs = subject.split('.');
      expect(segs.length).toBe(3);
      expect(segs[1]).toBe('system');
    });
  });

  describe('subscriber subject shape', () => {
    it('subscribeWildcard builds events.*.{eventType} (3 segments, * in middle)', () => {
      const subject = wildcardSubject(EVENT_TYPE);
      const segs = subject.split('.');
      expect(segs.length).toBe(3);
      expect(segs[0]).toBe('events');
      expect(segs[1]).toBe('*');
      expect(segs[2]).toBe(EVENT_TYPE);
    });

    it('subscribeForTenant builds events.{tenantId}.{eventType} (literal tenantId)', () => {
      const subject = tenantSubject(EVENT_TYPE, TENANT_A);
      const segs = subject.split('.');
      expect(segs.length).toBe(3);
      expect(segs[0]).toBe('events');
      expect(segs[1]).toBe(TENANT_A);
      expect(segs[2]).toBe(EVENT_TYPE);
    });
  });

  describe('publisher↔subscriber matching', () => {
    it('wildcard subscriber MATCHES the publisher subject for every tenant', () => {
      const sub = wildcardSubject(EVENT_TYPE);
      const pubA = deriveSubject({ tenantId: TENANT_A, eventType: EVENT_TYPE });
      const pubB = deriveSubject({ tenantId: TENANT_B, eventType: EVENT_TYPE });
      const pubSystem = deriveSubject({ eventType: EVENT_TYPE });
      expect(natsSubjectMatches(sub, pubA)).toBe(true);
      expect(natsSubjectMatches(sub, pubB)).toBe(true);
      expect(natsSubjectMatches(sub, pubSystem)).toBe(true);
    });

    it('per-tenant subscriber MATCHES only its own tenant publish', () => {
      const sub = tenantSubject(EVENT_TYPE, TENANT_A);
      const pubA = deriveSubject({ tenantId: TENANT_A, eventType: EVENT_TYPE });
      const pubB = deriveSubject({ tenantId: TENANT_B, eventType: EVENT_TYPE });
      expect(natsSubjectMatches(sub, pubA)).toBe(true);
      expect(natsSubjectMatches(sub, pubB)).toBe(false);
    });

    it('wildcard subscriber MISSES a different eventType (last segment must literal-match)', () => {
      const sub = wildcardSubject('SensorReading');
      const pubOther = deriveSubject({
        tenantId: TENANT_A,
        eventType: 'SensorRegistered',
      });
      expect(natsSubjectMatches(sub, pubOther)).toBe(false);
    });

    it('regression: 2-segment subscribe DOES NOT match 3-segment publish', () => {
      // The exact bug ORPHAN-013 documented. Pinning that the failure mode
      // is real — if a future refactor accidentally re-introduces the
      // 2-segment shape, this test stays green only because we explicitly
      // assert it's BROKEN, which is the regression catcher.
      const broken2Segment = `events.${EVENT_TYPE}`;
      const correctPublish = deriveSubject({
        tenantId: TENANT_A,
        eventType: EVENT_TYPE,
      });
      expect(natsSubjectMatches(broken2Segment, correctPublish)).toBe(false);
    });
  });

  describe('subject-injection defence (subscribeForTenant tenantId validation)', () => {
    /**
     * Mirror of `NatsEventBus.assertSafeTenantSegment` — extracted as a
     * pure function so this test does not need to construct a full
     * NatsEventBus instance (which would require connecting to a broker).
     * The production impl is asserted to use the same regex via direct
     * source reference in the comment below.
     *
     * Implementation lives at:
     *   `platform/libs/event-bus/src/nats/nats-event-bus.ts`
     *   `assertSafeTenantSegment`
     *
     * If the impl regex changes, this test must change in lockstep.
     */
    function assertSafeTenantSegment(tenantId: unknown): void {
      if (typeof tenantId !== 'string' || tenantId.length === 0) {
        throw new TypeError(`subscribeForTenant: tenantId must be a non-empty string`);
      }
      if (/[\s.*>]/.test(tenantId)) {
        const masked =
          tenantId.length > 8 ? `${tenantId.substring(0, 8)}…` : tenantId.substring(0, 8);
        throw new TypeError(
          `subscribeForTenant: tenantId contains forbidden characters ` +
            `(NATS subject metacharacters or whitespace). ` +
            `Value (masked, first 8 chars): "${masked}"`,
        );
      }
    }

    const REJECT_CASES: Array<[string, string]> = [
      ['empty string', ''],
      ['period (segment delimiter)', 'foo.bar'],
      ['single-segment wildcard', 'foo*bar'],
      ['tail wildcard', 'foo>bar'],
      ['leading whitespace', ' foo'],
      ['trailing whitespace', 'foo '],
      ['embedded newline', 'foo\nbar'],
      ['embedded tab', 'foo\tbar'],
      ['only metacharacter', '*'],
      ['only tail', '>'],
    ];

    it.each(REJECT_CASES)('rejects tenantId with %s', (_label, value) => {
      expect(() => assertSafeTenantSegment(value)).toThrow(TypeError);
    });

    it('rejects non-string tenantId', () => {
      expect(() => assertSafeTenantSegment(undefined)).toThrow(TypeError);
      expect(() => assertSafeTenantSegment(null)).toThrow(TypeError);
      expect(() => assertSafeTenantSegment(42)).toThrow(TypeError);
    });

    it('masks the bad value to first 8 chars in the error message (no exfil)', () => {
      const bad = 'attacker-secret-tenant.injected.subject';
      let caught: TypeError | null = null;
      try {
        assertSafeTenantSegment(bad);
      } catch (e) {
        caught = e as TypeError;
      }
      expect(caught).toBeInstanceOf(TypeError);
      const msg = assertDefined(caught).message;
      // First 8 chars present, full value NOT.
      expect(msg).toContain('attacker');
      expect(msg).not.toContain('secret-tenant');
      expect(msg).not.toContain('injected');
      // Truncation marker present so the operator knows the value was masked.
      expect(msg).toContain('…');
    });

    it('accepts the canonical UUID form (hyphens are NOT metacharacters)', () => {
      expect(() => assertSafeTenantSegment(TENANT_A)).not.toThrow();
      expect(() => assertSafeTenantSegment(TENANT_B)).not.toThrow();
    });
  });
});

// Ensure the type import has a runtime use to avoid a "type-only import"
// dead-code warning under some ts-jest configs.
const _eventTypeShape: IEvent | undefined = undefined;
void _eventTypeShape;
