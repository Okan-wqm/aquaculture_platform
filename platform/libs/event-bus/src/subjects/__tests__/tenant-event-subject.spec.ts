import {
  PLATFORM_EVENT_TENANT_ID,
  PLATFORM_SCOPE,
  createBaseEvent,
} from '@platform/event-contracts';

import { deriveEventSubject } from '../../nats/event-route-registry';
import {
  assertSubjectMatchesEvent,
  buildSystemEventSubject,
  buildTenantEventSubject,
  buildTenantWildcardSubject,
  buildWildcardEventSubject,
  eventSubjectTenantSegment,
  parseTenantEventSubject,
} from '../tenant-event-subject';

describe('tenant event subjects', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  it('builds canonical tenant, system, and wildcard subjects', () => {
    expect(buildTenantEventSubject(tenantId, 'MessageSent')).toBe(`events.${tenantId}.MessageSent`);
    expect(buildSystemEventSubject('SchemaMigrationStarted')).toBe(
      'events.system.SchemaMigrationStarted',
    );
    expect(buildWildcardEventSubject('MessageSent')).toBe('events.*.MessageSent');
    expect(buildTenantWildcardSubject(tenantId)).toBe(`events.${tenantId}.>`);
  });

  it('parses only canonical three-segment event subjects', () => {
    expect(parseTenantEventSubject(`events.${tenantId}.MessageSent`)).toEqual({
      tenantId,
      eventType: 'MessageSent',
      isSystem: false,
    });
    expect(parseTenantEventSubject('events.system.MessageSent')).toEqual({
      tenantId: 'system',
      eventType: 'MessageSent',
      isSystem: true,
    });
    expect(parseTenantEventSubject('events.MessageSent')).toBeNull();
    expect(parseTenantEventSubject('messaging.tenant.MessageSent')).toBeNull();
    expect(parseTenantEventSubject('events.*.MessageSent')).toBeNull();
  });

  it('rejects subject-injection characters', () => {
    expect(() => buildTenantEventSubject('tenant.foo', 'MessageSent')).toThrow(
      /forbidden NATS subject characters/,
    );
    expect(() => buildTenantEventSubject('tenant*', 'MessageSent')).toThrow(
      /forbidden NATS subject characters/,
    );
    expect(() => buildTenantEventSubject(tenantId, 'message.sent')).toThrow(/PascalCase/);
  });

  it('requires subject tenant and eventType to match the payload', () => {
    expect(() =>
      assertSubjectMatchesEvent(`events.${tenantId}.MessageSent`, {
        tenantId,
        eventType: 'MessageSent',
      }),
    ).not.toThrow();

    expect(() =>
      assertSubjectMatchesEvent(`events.${tenantId}.MessageSent`, {
        tenantId,
        eventType: 'MessageRead',
      }),
    ).toThrow(/type mismatch/);

    expect(() =>
      assertSubjectMatchesEvent(`events.${tenantId}.MessageSent`, {
        tenantId: '11111111-1111-4111-8111-111111111111',
        eventType: 'MessageSent',
      }),
    ).toThrow(/tenant mismatch/);
  });

  /**
   * OBS-HIGH-009: a platform-level fact has ONE tenant sentinel, and the
   * envelope, the subject builder and the subject assertion agree on it. The
   * builder used to read `''` as platform while the assertion read it as a
   * tenant named '', so every `''` publish was built for `events.system.*` and
   * refused by its own assertion — production's admin.error_groups stayed
   * empty behind 39 "subject=system, payload=" refusals.
   */
  describe('the platform sentinel (OBS-HIGH-009)', () => {
    it('is the contract segment: the envelope, the builder and the assertion all spell it once', () => {
      const envelope = createBaseEvent('ServiceErrorCaptured', PLATFORM_SCOPE);

      expect(envelope.tenantId).toBe(PLATFORM_EVENT_TENANT_ID);
      expect(eventSubjectTenantSegment(envelope)).toBe(PLATFORM_EVENT_TENANT_ID);
      expect(deriveEventSubject(envelope)).toBe('events.system.ServiceErrorCaptured');
      expect(() => assertSubjectMatchesEvent(deriveEventSubject(envelope), envelope)).not.toThrow();
    });

    it.each([
      ['the platform segment', PLATFORM_EVENT_TENANT_ID],
      ['an absent tenantId', undefined],
      ['a null tenantId', null],
    ])('accepts %s on events.system.*', (_label, payloadTenant) => {
      const event = { eventType: 'ServiceErrorCaptured', tenantId: payloadTenant };

      expect(eventSubjectTenantSegment(event)).toBe('system');
      expect(deriveEventSubject(event)).toBe('events.system.ServiceErrorCaptured');
      expect(() =>
        assertSubjectMatchesEvent('events.system.ServiceErrorCaptured', event),
      ).not.toThrow();
    });

    it("refuses '' in the builder and the assertion alike, naming the one sentinel", () => {
      // Before: the builder produced events.system.ServiceErrorCaptured for this
      // payload and the assertion then refused it as a tenant mismatch.
      const event = { eventType: 'ServiceErrorCaptured', tenantId: '' };

      expect(() => deriveEventSubject(event)).toThrow(/tenantId '' is not a tenancy scope/);
      expect(() => assertSubjectMatchesEvent('events.system.ServiceErrorCaptured', event)).toThrow(
        /carries "system"/,
      );
    });

    it('still refuses a real tenant mismatch in either direction', () => {
      // A tenant event must never ride the cross-tenant platform subject, and a
      // platform event must never ride a tenant's subject.
      expect(() =>
        assertSubjectMatchesEvent('events.system.ServiceErrorCaptured', {
          eventType: 'ServiceErrorCaptured',
          tenantId,
        }),
      ).toThrow(/tenant mismatch: subject=system, payload=550e8400/);
      expect(() =>
        assertSubjectMatchesEvent(`events.${tenantId}.ServiceErrorCaptured`, {
          eventType: 'ServiceErrorCaptured',
          tenantId: PLATFORM_EVENT_TENANT_ID,
        }),
      ).toThrow(/tenant mismatch: subject=550e8400-e29b-41d4-a716-446655440000, payload=system/);
    });

    it('routes every subject the builder derives through the assertion unchanged', () => {
      // The property the finding broke: anything deriveEventSubject builds, the
      // publish-time assertion accepts.
      for (const payloadTenant of [tenantId, PLATFORM_EVENT_TENANT_ID, undefined, null]) {
        const event = { eventType: 'BatchCreated', tenantId: payloadTenant };
        expect(() => assertSubjectMatchesEvent(deriveEventSubject(event), event)).not.toThrow();
      }
    });
  });
});
