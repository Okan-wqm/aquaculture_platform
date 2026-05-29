import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';

export const VERIFIED_USER_ASSERTION_HEADER = 'X-Verified-User-Assertion';
export const SERVICE_USER_ASSERTION_HASH_HEADER = 'X-Service-User-Assertion-Hash';

export interface VerifiedUserAssertionUser {
  sub: string;
  tenantId?: string;
  email?: string;
  roles?: string[];
  role?: string;
  mfaVerified?: boolean;
}

export interface VerifiedUserAssertionPayload {
  iss: string;
  aud: string;
  sub: string;
  actorTenantId?: string;
  effectiveTenantId?: string;
  tenantId?: string;
  email?: string;
  roles: string[];
  mfaVerified?: boolean;
  iat: number;
  exp: number;
  jti: string;
}

export type VerifiedUserAssertionOutcome =
  | { valid: true; payload: VerifiedUserAssertionPayload }
  | {
      valid: false;
      reason:
        | 'missing-assertion'
        | 'malformed-assertion'
        | 'unsupported-algorithm'
        | 'invalid-signature'
        | 'invalid-issuer'
        | 'invalid-audience'
        | 'invalid-payload'
        | 'expired'
        | 'not-yet-valid'
        | 'excessive-ttl';
    };

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signHs256(input: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(input).digest());
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function hasValidPayloadShape(payload: VerifiedUserAssertionPayload): boolean {
  return (
    typeof payload.iss === 'string' &&
    typeof payload.aud === 'string' &&
    typeof payload.sub === 'string' &&
    Array.isArray(payload.roles) &&
    payload.roles.every((role) => typeof role === 'string') &&
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number' &&
    payload.exp > payload.iat &&
    typeof payload.jti === 'string' &&
    isOptionalString(payload.actorTenantId) &&
    isOptionalString(payload.effectiveTenantId) &&
    isOptionalString(payload.tenantId) &&
    isOptionalString(payload.email) &&
    (payload.mfaVerified === undefined || typeof payload.mfaVerified === 'boolean')
  );
}

export function hashVerifiedUserAssertion(assertion?: string): string {
  return createHash('sha256')
    .update(assertion ?? '')
    .digest('hex');
}

export function generateVerifiedUserAssertion(args: {
  user: VerifiedUserAssertionUser;
  secret: string;
  audience: string;
  issuer?: string;
  ttlSeconds?: number;
  effectiveTenantId?: string;
  jti?: string;
  now?: Date;
}): string {
  const nowSeconds = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const ttlSeconds = args.ttlSeconds ?? 60;
  const roles = args.user.roles ?? (args.user.role ? [args.user.role] : []);
  const payload: VerifiedUserAssertionPayload = {
    iss: args.issuer ?? 'gateway-api',
    aud: args.audience,
    sub: args.user.sub,
    actorTenantId: args.user.tenantId,
    effectiveTenantId: args.effectiveTenantId ?? args.user.tenantId,
    tenantId: args.effectiveTenantId ?? args.user.tenantId,
    email: args.user.email,
    roles,
    mfaVerified: args.user.mfaVerified,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: args.jti ?? randomUUID(),
  };
  const header = { alg: 'HS256', typ: 'JWT', kid: args.issuer ?? 'gateway-api' };
  const signingInput =
    base64UrlEncode(JSON.stringify(header)) + '.' + base64UrlEncode(JSON.stringify(payload));
  return signingInput + '.' + signHs256(signingInput, args.secret);
}

export function verifyVerifiedUserAssertion(args: {
  assertion: string | undefined;
  secret: string;
  audience: string;
  issuer?: string;
  now?: Date;
  maxTtlSeconds?: number;
  clockSkewSeconds?: number;
}): VerifiedUserAssertionOutcome {
  if (!args.assertion) {
    return { valid: false, reason: 'missing-assertion' };
  }

  const parts = args.assertion.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed-assertion' };
  }

  try {
    const header = JSON.parse(base64UrlDecode(parts[0] ?? '').toString('utf8')) as {
      alg?: string;
    };
    if (header.alg !== 'HS256') {
      return { valid: false, reason: 'unsupported-algorithm' };
    }

    const signingInput = (parts[0] ?? '') + '.' + (parts[1] ?? '');
    const expected = signHs256(signingInput, args.secret);
    const actual = parts[2] ?? '';
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'))
    ) {
      return { valid: false, reason: 'invalid-signature' };
    }

    const payload = JSON.parse(
      base64UrlDecode(parts[1] ?? '').toString('utf8'),
    ) as VerifiedUserAssertionPayload;
    if (!hasValidPayloadShape(payload)) {
      return { valid: false, reason: 'invalid-payload' };
    }

    const expectedIssuer = args.issuer ?? 'gateway-api';
    if (payload.iss !== expectedIssuer) {
      return { valid: false, reason: 'invalid-issuer' };
    }
    if (payload.aud !== args.audience) {
      return { valid: false, reason: 'invalid-audience' };
    }

    const nowSeconds = Math.floor((args.now ?? new Date()).getTime() / 1000);
    const skew = args.clockSkewSeconds ?? 30;
    if (payload.exp < nowSeconds - skew) {
      return { valid: false, reason: 'expired' };
    }
    if (payload.iat > nowSeconds + skew) {
      return { valid: false, reason: 'not-yet-valid' };
    }
    if (payload.exp - payload.iat > (args.maxTtlSeconds ?? 300)) {
      return { valid: false, reason: 'excessive-ttl' };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'malformed-assertion' };
  }
}
