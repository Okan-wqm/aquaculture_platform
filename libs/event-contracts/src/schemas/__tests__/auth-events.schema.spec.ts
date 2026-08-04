/**
 * Auth-domain event JSON-Schema validator tests (DATA-MEDIUM-001).
 *
 * Completes the tenant-event coverage: every auth event crossing the NATS trust
 * boundary now has a validator. Same posture as tenant-events.schema.spec —
 * maximal fixtures (every declared field) validate (catching a schema missing a
 * real field via additionalProperties:false), full key/fixture coverage, and the
 * reject cases (unknown type, extra field, missing required, bad enum literal).
 */
import { AUTH_EVENT_SCHEMAS, type AuthEventType } from '../auth-events.schema';
import { validateAuthEvent, type AuthEventValidationResult } from '../validator';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
// OPAQUE_REF fixtures: a SHA-256 hex digest and a KMS key UUID.
const ACTION_TOKEN_HASH = 'a'.repeat(64);
const CRYPTO_SHRED_KEY = '66666666-6666-4666-8666-666666666666';

function withBase(
  eventType: AuthEventType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    eventType,
    timestamp: '2026-06-12T12:00:00.000Z',
    tenantId: TENANT_ID,
    version: 1,
    ...payload,
  };
}

const VALID_FIXTURES: Record<AuthEventType, Record<string, unknown>> = {
  UserLoggedIn: withBase('UserLoggedIn', {
    userId: USER_ID,
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (compatible)',
  }),
  InvitationAccepted: withBase('InvitationAccepted', {
    userId: USER_ID,
    invitationId: REQUEST_ID,
    email: 'invitee@acme.example',
  }),
  PasswordResetRequested: withBase('PasswordResetRequested', {
    userId: USER_ID,
    actionTokenId: ACTION_TOKEN_HASH,
    cryptoShredKeyId: CRYPTO_SHRED_KEY,
  }),
  PasswordResetCompleted: withBase('PasswordResetCompleted', { userId: USER_ID }),
  UserAccessTokenInvalidationRequested: withBase('UserAccessTokenInvalidationRequested', {
    targetUserId: USER_ID,
    invalidatedAtEpochSeconds: 1_780_000_000,
    reason: 'refresh_token_reuse',
  }),
  AccessTokenInvalidationRequested: withBase('AccessTokenInvalidationRequested', {
    targetJti: REQUEST_ID,
    expiresAtEpochSeconds: 1_780_000_900,
    reason: 'user_logout',
  }),
  UserDeleted: withBase('UserDeleted', {
    deletedUserId: USER_ID,
    hardDelete: false,
    cascadeRequested: true,
    initiatedBy: 'gdpr-erasure',
    cryptoShredKeyId: CRYPTO_SHRED_KEY,
  }),
  UserDataAnonymized: withBase('UserDataAnonymized', {
    userId: USER_ID,
    method: 'crypto-shredded',
    initiatedBy: 'admin',
    cryptoShredKeyId: CRYPTO_SHRED_KEY,
  }),
  GdprAnonymizeRequested: withBase('GdprAnonymizeRequested', {
    userId: USER_ID,
    requestId: REQUEST_ID,
    fulfilByIso: '2026-07-12T12:00:00.000Z',
    reason: 'user requested erasure',
  }),
  ConsentRecorded: withBase('ConsentRecorded', {
    userId: USER_ID,
    consentType: 'analytics',
    consentVersion: 'v2',
    legalBasis: 'consent',
  }),
  ConsentWithdrawn: withBase('ConsentWithdrawn', {
    userId: USER_ID,
    consentType: 'analytics',
    reason: 'changed my mind',
  }),
  UserInvited: withBase('UserInvited', {
    userId: USER_ID,
    role: 'TENANT_ADMIN',
    invitedBy: ACTOR_ID,
    credentialType: 'reset_token',
    actionTokenId: ACTION_TOKEN_HASH,
    cryptoShredKeyId: CRYPTO_SHRED_KEY,
  }),
};

function expectValid(result: AuthEventValidationResult): void {
  if (!result.valid) {
    throw new Error(`expected valid, got: ${result.errors}`);
  }
  expect(result.valid).toBe(true);
}

describe('validateAuthEvent (DATA-MEDIUM-001)', () => {
  const schemaKeys = Object.keys(AUTH_EVENT_SCHEMAS) as AuthEventType[];

  it('has a validator + fixture for every registered auth event schema', () => {
    expect(schemaKeys.length).toBe(12);
    for (const key of schemaKeys) {
      expect(VALID_FIXTURES[key]).toBeDefined();
    }
    for (const key of Object.keys(VALID_FIXTURES)) {
      expect(schemaKeys).toContain(key as AuthEventType);
    }
  });

  it.each(schemaKeys)('accepts a maximal valid %s event', (eventType) => {
    expectValid(validateAuthEvent(eventType, VALID_FIXTURES[eventType]));
  });

  it('rejects an unknown auth event type', () => {
    expect(validateAuthEvent('NotAnAuthEvent', VALID_FIXTURES.UserLoggedIn).valid).toBe(false);
  });

  it('rejects an extra (unknown) field', () => {
    const result = validateAuthEvent('PasswordResetCompleted', {
      ...VALID_FIXTURES.PasswordResetCompleted,
      injectedField: 'evil',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing required payload field (UserDeleted.deletedUserId)', () => {
    const { deletedUserId: _omitted, ...withoutTarget } = VALID_FIXTURES.UserDeleted as {
      deletedUserId: unknown;
    } & Record<string, unknown>;
    expect(validateAuthEvent('UserDeleted', withoutTarget).valid).toBe(false);
  });

  it('rejects an out-of-set enum literal (UserDeleted.initiatedBy)', () => {
    const result = validateAuthEvent('UserDeleted', {
      ...VALID_FIXTURES.UserDeleted,
      initiatedBy: 'rogue-actor',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(validateAuthEvent('UserLoggedIn', null).valid).toBe(false);
    expect(validateAuthEvent('UserLoggedIn', 42).valid).toBe(false);
  });

  it('admits the exact system routing identity for auth recovery events', () => {
    expectValid(
      validateAuthEvent('UserAccessTokenInvalidationRequested', {
        ...VALID_FIXTURES.UserAccessTokenInvalidationRequested,
        tenantId: 'system',
      }),
    );
    expectValid(
      validateAuthEvent('AccessTokenInvalidationRequested', {
        ...VALID_FIXTURES.AccessTokenInvalidationRequested,
        tenantId: 'system',
      }),
    );
  });

  it('accepts the site-assignment-specific user invalidation reason', () => {
    expectValid(
      validateAuthEvent('UserAccessTokenInvalidationRequested', {
        ...VALID_FIXTURES.UserAccessTokenInvalidationRequested,
        reason: 'site_assignment_changed',
      }),
    );
  });

  it('rejects actor/target ambiguity and invalid recovery epochs', () => {
    expect(
      validateAuthEvent('UserAccessTokenInvalidationRequested', {
        ...VALID_FIXTURES.UserAccessTokenInvalidationRequested,
        targetUserId: undefined,
        userId: USER_ID,
      }).valid,
    ).toBe(false);
    expect(
      validateAuthEvent('AccessTokenInvalidationRequested', {
        ...VALID_FIXTURES.AccessTokenInvalidationRequested,
        expiresAtEpochSeconds: Number.MAX_SAFE_INTEGER,
      }).valid,
    ).toBe(false);
  });
});
