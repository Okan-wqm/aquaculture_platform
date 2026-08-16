import { isPlatformRole, type Role } from '@platform/identity';

import {
  canonicalJsonStringify,
  compareUtf16CodeUnits,
  containsAsciiControlCharacter,
  createCanonicalJsonDocumentV1,
} from '../canonical-json';

import {
  compileImpersonationPermissionsV1,
  decodeCanonicalImpersonationPermissionsV1,
  isImpersonationContextId,
  type ImpersonationPermissionsContract,
} from './impersonation-policy';

const REQUIRED_FIELDS = Object.freeze([
  'issuer',
  'subject',
  'tenantId',
  'effectiveTenantId',
  'roles',
  'email',
  'mfaVerified',
  'issuedAt',
  'assertionId',
] as const);

const OPTIONAL_FIELDS = Object.freeze([
  'assignedSiteIds',
  'mobileFeatures',
  'planLevel',
  'resourcePermissions',
  'clientIp',
  'clientUserAgent',
  'impersonationSessionId',
  'impersonationPermissions',
] as const);

export const GATEWAY_VERIFIED_USER_ASSERTION_FIELDS_V1 = Object.freeze([
  ...REQUIRED_FIELDS,
  ...OPTIONAL_FIELDS,
] as const);

export const GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1 = Object.freeze({
  maxEncodedBytes: 32 * 1024,
  maxDecodedBytes: 24 * 1024,
  maxAgeMs: 5 * 60 * 1000,
  maxRoles: 32,
  maxAssignedSiteIds: 256,
  maxMobileFeatures: 128,
  maxResourcePermissions: 512,
});

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface GatewayVerifiedUserAssertionV1 {
  readonly issuer: 'gateway-api';
  readonly subject: string;
  readonly tenantId: string | null;
  readonly effectiveTenantId: string | null;
  readonly roles: readonly Role[];
  readonly email: string | null;
  readonly mfaVerified: boolean;
  readonly issuedAt: string;
  readonly assertionId: string;
  readonly assignedSiteIds?: readonly string[];
  readonly mobileFeatures?: readonly string[];
  readonly planLevel?: number;
  readonly resourcePermissions?: readonly string[];
  readonly clientIp?: string | null;
  readonly clientUserAgent?: string | null;
  readonly impersonationSessionId?: string;
  readonly impersonationPermissions?: ImpersonationPermissionsContract;
}

export interface DecodeGatewayVerifiedUserAssertionOptionsV1 {
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
}

type AssertionMode = 'compile' | 'decode';

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isBoundedString(value: unknown, maxLength: number, allowSpaces: boolean): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !containsAsciiControlCharacter(value) &&
    (allowSpaces || !/\s/.test(value))
  );
}

function compileStringArray(
  value: unknown,
  maxItems: number,
  maxMemberLength: number,
  mode: AssertionMode,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const members: string[] = [];
  for (const member of value) {
    if (!isBoundedString(member, maxMemberLength, false) || members.includes(member)) {
      return undefined;
    }
    members.push(member);
  }
  const canonical = [...members].sort(compareUtf16CodeUnits);
  if (mode === 'decode' && members.some((member, index) => member !== canonical[index])) {
    return undefined;
  }
  return Object.freeze(canonical);
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT_PATTERN.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isNullableContextId(value: unknown): value is string | null {
  return value === null || isImpersonationContextId(value);
}

function buildAssertion(
  value: unknown,
  mode: AssertionMode,
): GatewayVerifiedUserAssertionV1 | undefined {
  if (!isPlainRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (
    REQUIRED_FIELDS.some((field) => !hasOwn(value, field)) ||
    keys.some(
      (field) => !(GATEWAY_VERIFIED_USER_ASSERTION_FIELDS_V1 as readonly string[]).includes(field),
    ) ||
    OPTIONAL_FIELDS.some((field) => hasOwn(value, field) && value[field] === undefined)
  ) {
    return undefined;
  }
  if (
    value.issuer !== 'gateway-api' ||
    !isBoundedString(value.subject, 128, false) ||
    !isNullableContextId(value.tenantId) ||
    !isNullableContextId(value.effectiveTenantId) ||
    !isCanonicalInstant(value.issuedAt) ||
    !isImpersonationContextId(value.assertionId) ||
    typeof value.mfaVerified !== 'boolean' ||
    !(
      value.email === null ||
      (isBoundedString(value.email, 254, false) && value.email.includes('@'))
    )
  ) {
    return undefined;
  }

  const roleMembers = compileStringArray(
    value.roles,
    GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxRoles,
    64,
    mode,
  );
  if (!roleMembers) return undefined;
  const roles = Object.freeze(roleMembers.filter(isPlatformRole));
  if (roles.length !== roleMembers.length) return undefined;

  const assignedSiteIds = hasOwn(value, 'assignedSiteIds')
    ? compileStringArray(
        value.assignedSiteIds,
        GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxAssignedSiteIds,
        128,
        mode,
      )
    : undefined;
  const mobileFeatures = hasOwn(value, 'mobileFeatures')
    ? compileStringArray(
        value.mobileFeatures,
        GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxMobileFeatures,
        128,
        mode,
      )
    : undefined;
  const resourcePermissions = hasOwn(value, 'resourcePermissions')
    ? compileStringArray(
        value.resourcePermissions,
        GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxResourcePermissions,
        256,
        mode,
      )
    : undefined;
  if (
    (hasOwn(value, 'assignedSiteIds') && !assignedSiteIds) ||
    (hasOwn(value, 'mobileFeatures') && !mobileFeatures) ||
    (hasOwn(value, 'resourcePermissions') && !resourcePermissions)
  ) {
    return undefined;
  }
  if (
    hasOwn(value, 'planLevel') &&
    (!Number.isInteger(value.planLevel) ||
      (value.planLevel as number) < 0 ||
      (value.planLevel as number) > 3)
  ) {
    return undefined;
  }
  if (
    hasOwn(value, 'clientIp') &&
    !(value.clientIp === null || isBoundedString(value.clientIp, 64, false))
  ) {
    return undefined;
  }
  if (
    hasOwn(value, 'clientUserAgent') &&
    !(value.clientUserAgent === null || isBoundedString(value.clientUserAgent, 1024, true))
  ) {
    return undefined;
  }

  const hasImpersonationSession = hasOwn(value, 'impersonationSessionId');
  const hasImpersonationPermissions = hasOwn(value, 'impersonationPermissions');
  if (hasImpersonationSession !== hasImpersonationPermissions) return undefined;
  const impersonationPermissions = hasImpersonationPermissions
    ? mode === 'compile'
      ? compileImpersonationPermissionsV1(value.impersonationPermissions)
      : decodeCanonicalImpersonationPermissionsV1(value.impersonationPermissions)
    : undefined;
  let impersonationClaims:
    | Pick<GatewayVerifiedUserAssertionV1, 'impersonationSessionId' | 'impersonationPermissions'>
    | undefined;
  if (hasImpersonationSession) {
    if (
      !isImpersonationContextId(value.impersonationSessionId) ||
      !impersonationPermissions ||
      !roles.includes('SUPER_ADMIN') ||
      value.effectiveTenantId === null
    ) {
      return undefined;
    }
    impersonationClaims = {
      impersonationSessionId: value.impersonationSessionId,
      impersonationPermissions,
    };
  }
  if (value.effectiveTenantId !== value.tenantId && !hasImpersonationSession) {
    return undefined;
  }

  return Object.freeze({
    issuer: 'gateway-api' as const,
    subject: value.subject,
    tenantId: value.tenantId,
    effectiveTenantId: value.effectiveTenantId,
    roles,
    email: value.email,
    mfaVerified: value.mfaVerified,
    issuedAt: value.issuedAt,
    assertionId: value.assertionId,
    ...(assignedSiteIds !== undefined ? { assignedSiteIds } : {}),
    ...(mobileFeatures !== undefined ? { mobileFeatures } : {}),
    ...(hasOwn(value, 'planLevel') ? { planLevel: value.planLevel as number } : {}),
    ...(resourcePermissions !== undefined ? { resourcePermissions } : {}),
    ...(hasOwn(value, 'clientIp') ? { clientIp: value.clientIp as string | null } : {}),
    ...(hasOwn(value, 'clientUserAgent')
      ? { clientUserAgent: value.clientUserAgent as string | null }
      : {}),
    ...(impersonationClaims ?? {}),
  });
}

/** Producer authority: normalize set-like arrays and permission module order. */
export function compileGatewayVerifiedUserAssertionV1(
  value: unknown,
): GatewayVerifiedUserAssertionV1 | undefined {
  try {
    const document = createCanonicalJsonDocumentV1(value, {
      maxDepth: 16,
      maxNodes: 4_096,
      maxBytes: GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxDecodedBytes,
    });
    return buildAssertion(document.value, 'compile');
  } catch {
    return undefined;
  }
}

/** Decoder authority: the wire value must already have canonical set/module order. */
export function decodeCanonicalGatewayVerifiedUserAssertionV1(
  value: unknown,
): GatewayVerifiedUserAssertionV1 | undefined {
  try {
    const document = createCanonicalJsonDocumentV1(value, {
      maxDepth: 16,
      maxNodes: 4_096,
      maxBytes: GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxDecodedBytes,
    });
    return buildAssertion(document.value, 'decode');
  } catch {
    return undefined;
  }
}

function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let offset = 0; offset < value.length; offset += 1) {
    const first = value.charCodeAt(offset);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(offset + 1);
      if (second < 0xdc00 || second > 0xdfff) throw new TypeError('ASSERTION_INVALID_UNICODE');
      codePoint = 0x1_0000 + ((first - 0xd800) << 10) + (second - 0xdc00);
      offset += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new TypeError('ASSERTION_INVALID_UNICODE');
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function utf8Decode(bytes: Uint8Array): string {
  const codePoints: number[] = [];
  const continuation = (index: number): number => {
    const byte = bytes[index];
    if (byte === undefined || (byte & 0xc0) !== 0x80) throw new TypeError('ASSERTION_INVALID_UTF8');
    return byte;
  };
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index];
    if (first === undefined) throw new TypeError('ASSERTION_INVALID_UTF8');
    if (first <= 0x7f) {
      codePoints.push(first);
      index += 1;
      continue;
    }
    if (first >= 0xc2 && first <= 0xdf) {
      const second = continuation(index + 1);
      codePoints.push(((first & 0x1f) << 6) | (second & 0x3f));
      index += 2;
      continue;
    }
    if (first >= 0xe0 && first <= 0xef) {
      const second = continuation(index + 1);
      const third = continuation(index + 2);
      if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f)) {
        throw new TypeError('ASSERTION_INVALID_UTF8');
      }
      codePoints.push(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
      index += 3;
      continue;
    }
    if (first >= 0xf0 && first <= 0xf4) {
      const second = continuation(index + 1);
      const third = continuation(index + 2);
      const fourth = continuation(index + 3);
      if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) {
        throw new TypeError('ASSERTION_INVALID_UTF8');
      }
      codePoints.push(
        ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f),
      );
      index += 4;
      continue;
    }
    throw new TypeError('ASSERTION_INVALID_UTF8');
  }
  let result = '';
  for (let index = 0; index < codePoints.length; index += 0x1000) {
    result += String.fromCodePoint(...codePoints.slice(index, index + 0x1000));
  }
  return result;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    if (first === undefined) throw new TypeError('ASSERTION_INVALID_BASE64URL');
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += BASE64URL_ALPHABET[first >>> 2];
    result += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) {
      result += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)];
    }
    if (third !== undefined) result += BASE64URL_ALPHABET[third & 0x3f];
  }
  return result;
}

function decodeBase64Url(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length > GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxEncodedBytes ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new TypeError('ASSERTION_INVALID_BASE64URL');
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) throw new TypeError('ASSERTION_INVALID_BASE64URL');
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new TypeError('ASSERTION_NON_CANONICAL_BASE64URL');
  const decoded = Uint8Array.from(bytes);
  if (
    decoded.byteLength > GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxDecodedBytes ||
    encodeBase64Url(decoded) !== value
  ) {
    throw new TypeError('ASSERTION_NON_CANONICAL_BASE64URL');
  }
  return decoded;
}

export function encodeGatewayVerifiedUserAssertionV1(value: unknown): string {
  const assertion = compileGatewayVerifiedUserAssertionV1(value);
  if (!assertion) throw new TypeError('ASSERTION_INVALID_SHAPE');
  const json = canonicalJsonStringify(
    createCanonicalJsonDocumentV1(assertion, {
      maxDepth: 16,
      maxNodes: 4_096,
      maxBytes: GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxDecodedBytes,
    }),
  );
  return encodeBase64Url(utf8Encode(json));
}

export function decodeGatewayVerifiedUserAssertionHeaderV1(
  value: string,
  options: DecodeGatewayVerifiedUserAssertionOptionsV1 = {},
): GatewayVerifiedUserAssertionV1 {
  const decodedBytes = decodeBase64Url(value);
  const decodedJson = utf8Decode(decodedBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedJson);
  } catch {
    throw new TypeError('ASSERTION_INVALID_JSON');
  }
  const canonicalJson = canonicalJsonStringify(
    createCanonicalJsonDocumentV1(parsed, {
      maxDepth: 16,
      maxNodes: 4_096,
      maxBytes: GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxDecodedBytes,
    }),
  );
  if (canonicalJson !== decodedJson) throw new TypeError('ASSERTION_NON_CANONICAL_JSON');
  const assertion = decodeCanonicalGatewayVerifiedUserAssertionV1(parsed);
  if (!assertion) throw new TypeError('ASSERTION_INVALID_SHAPE');
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxAgeMs;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    maxAgeMs > GATEWAY_VERIFIED_USER_ASSERTION_LIMITS_V1.maxAgeMs ||
    Math.abs(nowMs - Date.parse(assertion.issuedAt)) > maxAgeMs
  ) {
    throw new TypeError('ASSERTION_EXPIRED_OR_NOT_YET_VALID');
  }
  return assertion;
}
