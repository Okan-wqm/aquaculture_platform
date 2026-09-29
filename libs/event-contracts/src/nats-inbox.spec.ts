import {
  isServiceInboxGrant,
  isSharedInboxGrant,
  PLATFORM_INBOX_PREFIX_ROOT,
  serviceInboxGrant,
  serviceInboxPrefix,
  SHARED_INBOX_GRANT,
} from './nats-inbox';

describe('per-service NATS reply inbox (ORPHAN-CRITICAL-402)', () => {
  it('derives a distinct FIRST token per identity', () => {
    expect(serviceInboxPrefix('auth_service')).toBe('_INBOX_auth_service');
    expect(serviceInboxPrefix('billing_service')).toBe('_INBOX_billing_service');
    expect(serviceInboxPrefix('sensor-ingestion')).toBe('_INBOX_sensor-ingestion');
  });

  it('never yields the shared `_INBOX` token that every cert could read', () => {
    for (const identity of ['auth_service', 'gateway_service', 'sensor-ingestion']) {
      const prefix = serviceInboxPrefix(identity);
      expect(prefix).not.toBe('_INBOX');
      // The whole cure rests on FIRST-token distinctness: a `_INBOX.>` grant
      // matches only subjects whose first token is exactly `_INBOX`.
      expect(prefix.split('.')[0]).not.toBe('_INBOX');
      expect(prefix.startsWith(PLATFORM_INBOX_PREFIX_ROOT)).toBe(true);
    }
  });

  it('carries no trailing dot (createInbox appends `.<nuid>` itself)', () => {
    expect(serviceInboxPrefix('farm_service').endsWith('.')).toBe(false);
    expect(serviceInboxGrant('farm_service')).toBe('_INBOX_farm_service.>');
  });

  it("one service's grant cannot cover another service's reply subject", () => {
    const authReply = `${serviceInboxPrefix('auth_service')}.abc123`;
    const farmGrant = serviceInboxGrant('farm_service');
    // Segment-exact first-token comparison — the same rule the broker applies.
    expect(authReply.split('.')[0]).not.toBe(farmGrant.split('.')[0]);
  });

  it('refuses identities that would split the prefix into two tokens', () => {
    expect(() => serviceInboxPrefix('auth.service')).toThrow(/single token/);
    expect(() => serviceInboxPrefix('')).toThrow(/single token/);
    expect(() => serviceInboxPrefix('*')).toThrow(/single token/);
    expect(() => serviceInboxPrefix('auth service')).toThrow(/single token/);
  });

  it('classifies shared vs per-service inbox grants for the ACL gates', () => {
    expect(isSharedInboxGrant(SHARED_INBOX_GRANT)).toBe(true);
    expect(isSharedInboxGrant('_INBOX')).toBe(true);
    expect(isSharedInboxGrant('_INBOX_auth_service.>')).toBe(false);
    expect(isServiceInboxGrant('_INBOX_auth_service.>')).toBe(true);
    expect(isServiceInboxGrant('_INBOX.>')).toBe(false);
  });
});
