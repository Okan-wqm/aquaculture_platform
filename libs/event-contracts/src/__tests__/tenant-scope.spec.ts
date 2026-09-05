import { createBaseEvent } from '../base-event';
import {
  InvalidEventTenantScopeError,
  PLATFORM_EVENT_TENANT_ID,
  PLATFORM_SCOPE,
  eventTenantScope,
  requireTenantScope,
  tenantIdForScope,
  tenantScopeOf,
} from '../tenant-scope';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

describe('event tenancy scope (SEC-HIGH-057)', () => {
  it('a nullable principal tenantId becomes a platform scope, a UUID a tenant scope', () => {
    expect(tenantScopeOf(null)).toEqual({ kind: 'platform' });
    expect(tenantScopeOf(undefined)).toEqual({ kind: 'platform' });
    expect(tenantScopeOf(TENANT_ID)).toEqual({ kind: 'tenant', tenantId: TENANT_ID });
  });

  it.each(['system', '', 'tenant-1', 'not-a-uuid'])(
    'a producer cannot route a non-UUID string %p as a tenant',
    (value) => {
      expect(() => tenantScopeOf(value)).toThrow(InvalidEventTenantScopeError);
    },
  );

  it('the platform scope routes on the reserved segment and a tenant on its id', () => {
    expect(tenantIdForScope(PLATFORM_SCOPE)).toBe(PLATFORM_EVENT_TENANT_ID);
    expect(tenantIdForScope({ kind: 'tenant', tenantId: TENANT_ID })).toBe(TENANT_ID);
    expect(PLATFORM_EVENT_TENANT_ID).toBe('system');
  });

  it('createBaseEvent accepts a scope and stamps its routing segment', () => {
    expect(createBaseEvent('PasswordResetRequested', tenantScopeOf(null)).tenantId).toBe('system');
    expect(createBaseEvent('PasswordResetRequested', tenantScopeOf(TENANT_ID)).tenantId).toBe(
      TENANT_ID,
    );
    expect(createBaseEvent('PasswordResetRequested', TENANT_ID).tenantId).toBe(TENANT_ID);
  });

  it('a consumer parses the wire segment back into a scope', () => {
    expect(eventTenantScope({ eventType: 'X', tenantId: 'system' })).toEqual({ kind: 'platform' });
    expect(eventTenantScope({ eventType: 'X', tenantId: TENANT_ID })).toEqual({
      kind: 'tenant',
      tenantId: TENANT_ID,
    });
    expect(eventTenantScope({ eventType: 'X', tenantId: TENANT_ID.toUpperCase() })).toEqual({
      kind: 'tenant',
      tenantId: TENANT_ID.toUpperCase(),
    });
  });

  it.each(['', 'platform', 'SYSTEM', 'tenant-1', undefined])(
    'a consumer rejects a malformed wire segment %p instead of dropping the event',
    (value) => {
      expect(() =>
        eventTenantScope({ eventType: 'UserLoggedIn', tenantId: value as string }),
      ).toThrow(InvalidEventTenantScopeError);
    },
  );

  it('requireTenantScope admits a tenant and rejects the platform segment', () => {
    expect(requireTenantScope({ eventType: 'UserInvited', tenantId: TENANT_ID })).toEqual({
      kind: 'tenant',
      tenantId: TENANT_ID,
    });
    expect(() => requireTenantScope({ eventType: 'UserInvited', tenantId: 'system' })).toThrow(
      InvalidEventTenantScopeError,
    );
  });
});
