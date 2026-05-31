import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const VERIFIED_USER_ASSERTION_HEADER = 'X-Verified-User-Assertion';
export const VERIFIED_USER_ASSERTION_SIGNATURE_HEADER = 'X-Verified-User-Assertion-Signature';

export interface VerifiedUserPayload {
  sub: string;
  email?: string;
  tenantId: string | null;
  role?: string;
  roles: string[];
  permissions?: string[];
  resourcePermissions?: string[];
  modules?: string[];
  mfaVerified: boolean;
  jti?: string;
}

export interface VerifiedUserAssertion {
  v: 1;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  user: VerifiedUserPayload;
}

export interface VerifiedUserAssertionHeaders {
  [VERIFIED_USER_ASSERTION_HEADER]: string;
  [VERIFIED_USER_ASSERTION_SIGNATURE_HEADER]: string;
}

export type VerifiedUserAssertionOutcome =
  | { valid: true; assertion: VerifiedUserAssertion }
  | {
      valid: false;
      reason:
        | 'missing-headers'
        | 'malformed-assertion'
        | 'invalid-signature'
        | 'expired'
        | 'not-yet-valid'
        | 'invalid-subject';
    };

const DEFAULT_ISSUER = 'gateway-api';
const DEFAULT_AUDIENCE = 'aqua-saas-subgraphs';
const DEFAULT_TTL_SECONDS = 60;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const value = headers[name] ?? headers[lower];
  return Array.isArray(value) ? value[0] : value;
}

function signAssertion(assertionHeader: string, secret: string): string {
  return createHmac('sha256', secret).update(assertionHeader).digest('hex');
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUserPayload(input: {
  sub: string;
  email?: string;
  tenantId?: string | null;
  role?: string;
  roles?: string[];
  permissions?: string[];
  resourcePermissions?: string[];
  modules?: string[];
  mfaVerified?: boolean;
  jti?: string;
}): VerifiedUserPayload {
  const roles = normalizeStringArray(input.roles) ?? (input.role ? [input.role] : []);
  const role = input.role ?? roles[0];
  const permissions = normalizeStringArray(input.permissions);
  const resourcePermissions = normalizeStringArray(input.resourcePermissions);
  const modules = normalizeStringArray(input.modules);
  return {
    sub: input.sub,
    ...(input.email ? { email: input.email } : {}),
    tenantId: input.tenantId ?? null,
    ...(role ? { role } : {}),
    roles,
    ...(permissions ? { permissions } : {}),
    ...(resourcePermissions ? { resourcePermissions } : {}),
    ...(modules ? { modules } : {}),
    mfaVerified: input.mfaVerified === true,
    ...(input.jti ? { jti: input.jti } : {}),
  };
}

export function createVerifiedUserAssertionHeaders(args: {
  user: {
    sub: string;
    email?: string;
    tenantId?: string | null;
    role?: string;
    roles?: string[];
    permissions?: string[];
    resourcePermissions?: string[];
    modules?: string[];
    mfaVerified?: boolean;
    jti?: string;
  };
  secret: string;
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
  now?: Date;
}): VerifiedUserAssertionHeaders {
  const nowSeconds = Math.floor((args.now?.getTime() ?? Date.now()) / 1000);
  const assertion: VerifiedUserAssertion = {
    v: 1,
    iss: args.issuer ?? DEFAULT_ISSUER,
    aud: args.audience ?? DEFAULT_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + (args.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    user: normalizeUserPayload(args.user),
  };
  const assertionHeader = base64UrlEncode(stableStringify(assertion));
  return {
    [VERIFIED_USER_ASSERTION_HEADER]: assertionHeader,
    [VERIFIED_USER_ASSERTION_SIGNATURE_HEADER]: signAssertion(assertionHeader, args.secret),
  };
}

export function hashVerifiedUserAssertionPair(
  assertionHeader?: string,
  signatureHeader?: string,
): string {
  if (!assertionHeader && !signatureHeader) {
    return sha256Hex('');
  }
  return sha256Hex(`${assertionHeader ?? ''}.${signatureHeader ?? ''}`);
}

export function hashVerifiedUserAssertionHeaders(
  headers: Record<string, string | string[] | undefined>,
): string {
  return hashVerifiedUserAssertionPair(
    getHeader(headers, VERIFIED_USER_ASSERTION_HEADER),
    getHeader(headers, VERIFIED_USER_ASSERTION_SIGNATURE_HEADER),
  );
}

export function verifyVerifiedUserAssertionHeaders(args: {
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  expectedIssuer?: string;
  expectedAudience?: string;
  now?: Date;
}): VerifiedUserAssertionOutcome {
  const assertionHeader = getHeader(args.headers, VERIFIED_USER_ASSERTION_HEADER);
  const signatureHeader = getHeader(args.headers, VERIFIED_USER_ASSERTION_SIGNATURE_HEADER);
  if (!assertionHeader || !signatureHeader) {
    return { valid: false, reason: 'missing-headers' };
  }

  const expectedSignature = signAssertion(assertionHeader, args.secret);
  if (
    expectedSignature.length !== signatureHeader.length ||
    !timingSafeEqual(Buffer.from(expectedSignature, 'utf8'), Buffer.from(signatureHeader, 'utf8'))
  ) {
    return { valid: false, reason: 'invalid-signature' };
  }

  let assertion: VerifiedUserAssertion;
  try {
    assertion = JSON.parse(base64UrlDecode(assertionHeader)) as VerifiedUserAssertion;
  } catch {
    return { valid: false, reason: 'malformed-assertion' };
  }

  const nowSeconds = Math.floor((args.now?.getTime() ?? Date.now()) / 1000);
  if (
    assertion.v !== 1 ||
    assertion.iss !== (args.expectedIssuer ?? DEFAULT_ISSUER) ||
    assertion.aud !== (args.expectedAudience ?? DEFAULT_AUDIENCE) ||
    typeof assertion.iat !== 'number' ||
    typeof assertion.exp !== 'number'
  ) {
    return { valid: false, reason: 'malformed-assertion' };
  }
  if (assertion.iat > nowSeconds + 30) {
    return { valid: false, reason: 'not-yet-valid' };
  }
  if (assertion.exp < nowSeconds) {
    return { valid: false, reason: 'expired' };
  }
  const user = assertion.user;
  if (
    !user ||
    typeof user.sub !== 'string' ||
    user.sub.length === 0 ||
    !Array.isArray(user.roles) ||
    !user.roles.every((role) => typeof role === 'string') ||
    (user.tenantId !== null && typeof user.tenantId !== 'string')
  ) {
    return { valid: false, reason: 'invalid-subject' };
  }

  return { valid: true, assertion };
}
