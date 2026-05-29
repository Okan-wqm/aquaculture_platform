import { createHmac } from 'crypto';

import {
  generateVerifiedUserAssertion,
  hashVerifiedUserAssertion,
  verifyVerifiedUserAssertion,
} from '../verified-user-assertion.util';

const SECRET = 'verified-user-assertion-test-secret';
const AUDIENCE = 'farm-service';
const NOW = new Date('2026-05-29T00:00:00.000Z');

function base64Url(input: unknown): string {
  return Buffer.from(JSON.stringify(input))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signPayload(payload: Record<string, unknown>): string {
  const signingInput =
    base64Url({ alg: 'HS256', typ: 'JWT', kid: 'gateway-api' }) + '.' + base64Url(payload);
  const signature = Buffer.from(createHmac('sha256', SECRET).update(signingInput).digest())
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return signingInput + '.' + signature;
}

describe('verified user assertion', () => {
  it('round-trips a gateway assertion with effective tenant metadata', () => {
    const assertion = generateVerifiedUserAssertion({
      user: {
        sub: 'user-1',
        tenantId: '11111111-1111-4111-8111-111111111111',
        roles: ['SUPER_ADMIN'],
        email: 'admin@example.test',
        mfaVerified: true,
      },
      secret: SECRET,
      audience: AUDIENCE,
      effectiveTenantId: '22222222-2222-4222-8222-222222222222',
      jti: 'assertion-1',
      now: NOW,
    });

    const outcome = verifyVerifiedUserAssertion({
      assertion,
      secret: SECRET,
      audience: AUDIENCE,
      now: new Date('2026-05-29T00:00:10.000Z'),
    });

    expect(outcome.valid).toBe(true);
    if (outcome.valid) {
      expect(outcome.payload.sub).toBe('user-1');
      expect(outcome.payload.actorTenantId).toBe('11111111-1111-4111-8111-111111111111');
      expect(outcome.payload.effectiveTenantId).toBe('22222222-2222-4222-8222-222222222222');
      expect(outcome.payload.jti).toBe('assertion-1');
    }
  });

  it('rejects assertions for the wrong audience', () => {
    const assertion = generateVerifiedUserAssertion({
      user: { sub: 'user-1', tenantId: '11111111-1111-4111-8111-111111111111' },
      secret: SECRET,
      audience: 'gateway-api',
      now: NOW,
    });

    expect(
      verifyVerifiedUserAssertion({ assertion, secret: SECRET, audience: AUDIENCE, now: NOW }),
    ).toEqual({ valid: false, reason: 'invalid-audience' });
  });

  it('rejects signed assertions with invalid payload shape', () => {
    const assertion = signPayload({
      iss: 'gateway-api',
      aud: AUDIENCE,
      sub: 'user-1',
      roles: 'SUPER_ADMIN',
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 60,
      jti: 'assertion-1',
    });

    expect(
      verifyVerifiedUserAssertion({ assertion, secret: SECRET, audience: AUDIENCE, now: NOW }),
    ).toEqual({ valid: false, reason: 'invalid-payload' });
  });

  it('produces a stable hash for HMAC canonical binding', () => {
    const assertion = 'header.payload.signature';
    expect(hashVerifiedUserAssertion(assertion)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVerifiedUserAssertion(assertion)).toBe(hashVerifiedUserAssertion(assertion));
  });
});
