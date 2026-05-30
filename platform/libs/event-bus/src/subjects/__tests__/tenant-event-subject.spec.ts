import {
  assertSubjectMatchesEvent,
  buildSystemEventSubject,
  buildTenantEventSubject,
  buildTenantWildcardSubject,
  buildWildcardEventSubject,
  parseTenantEventSubject,
} from '../tenant-event-subject';

describe('tenant event subjects', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  it('builds canonical tenant, system, and wildcard subjects', () => {
    expect(buildTenantEventSubject(tenantId, 'MessageSent')).toBe(
      `events.${tenantId}.MessageSent`,
    );
    expect(buildSystemEventSubject('SchemaMigrationStarted')).toBe(
      'events.system.SchemaMigrationStarted',
    );
    expect(buildWildcardEventSubject('MessageSent')).toBe(
      'events.*.MessageSent',
    );
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
    expect(() => buildTenantEventSubject(tenantId, 'message.sent')).toThrow(
      /PascalCase/,
    );
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
});
