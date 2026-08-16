import { canonicalJsonStringify, createCanonicalJsonDocumentV1 } from '../canonical-json';
import {
  compileGatewayVerifiedUserAssertionV1,
  decodeGatewayVerifiedUserAssertionHeaderV1,
  encodeGatewayVerifiedUserAssertionV1,
} from '../http/gateway-verified-user-assertion-v1';

const ISSUED_AT = '2026-08-09T12:00:00.000Z';
const NOW_MS = Date.parse(ISSUED_AT);

function baseAssertion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: 'gateway-api',
    subject: 'admin-user-id',
    tenantId: '11111111-1111-4111-8111-111111111111',
    effectiveTenantId: '11111111-1111-4111-8111-111111111111',
    roles: ['SUPER_ADMIN'],
    email: 'admin@example.test',
    mfaVerified: true,
    issuedAt: ISSUED_AT,
    assertionId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

function encodeRawJson(value: unknown, canonical: boolean): string {
  const json = canonical
    ? canonicalJsonStringify(createCanonicalJsonDocumentV1(value))
    : JSON.stringify(value);
  return Buffer.from(json, 'utf8').toString('base64url');
}

describe('GatewayVerifiedUserAssertionV1 closed protocol', () => {
  it('normalizes equivalent producer sets and permissions to identical bytes', () => {
    const permissions = {
      canViewData: true,
      canModifyData: false,
      canAccessSettings: true,
      canManageUsers: false,
      canViewBilling: true,
      canExportData: false,
    };
    const first = baseAssertion({
      roles: ['SUPER_ADMIN', 'MODULE_MANAGER'],
      assignedSiteIds: ['site-z', 'site-a'],
      impersonationSessionId: '44444444-4444-4444-8444-444444444444',
      impersonationPermissions: {
        ...permissions,
        allowedModules: ['billing', 'farm'],
        restrictedModules: ['ai', 'sensor'],
      },
    });
    const second = baseAssertion({
      roles: ['MODULE_MANAGER', 'SUPER_ADMIN'],
      assignedSiteIds: ['site-a', 'site-z'],
      impersonationSessionId: '44444444-4444-4444-8444-444444444444',
      impersonationPermissions: {
        restrictedModules: ['sensor', 'ai'],
        allowedModules: ['farm', 'billing'],
        ...permissions,
      },
    });

    const encoded = encodeGatewayVerifiedUserAssertionV1(first);
    expect(encodeGatewayVerifiedUserAssertionV1(second)).toBe(encoded);
    const decoded = decodeGatewayVerifiedUserAssertionHeaderV1(encoded, { nowMs: NOW_MS });
    expect(decoded.roles).toEqual(['MODULE_MANAGER', 'SUPER_ADMIN']);
    expect(decoded.assignedSiteIds).toEqual(['site-a', 'site-z']);
    expect(decoded.impersonationPermissions).toMatchObject({
      allowedModules: ['farm', 'billing'],
      restrictedModules: ['sensor', 'ai'],
    });
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.roles)).toBe(true);
    expect(Object.isFrozen(decoded.impersonationPermissions?.allowedModules)).toBe(true);
  });

  it('rejects unknown, missing, mistyped and unbounded top-level claims', () => {
    const invalid = [
      baseAssertion({ unknownGrant: true }),
      (() => {
        const value = baseAssertion();
        Reflect.deleteProperty(value, 'assertionId');
        return value;
      })(),
      baseAssertion({ mfaVerified: 'yes' }),
      baseAssertion({ subject: '' }),
      baseAssertion({ roles: Array.from({ length: 33 }, (_, index) => `ROLE_${index}`) }),
      baseAssertion({ assertionId: 'not-a-uuid' }),
      baseAssertion({ roles: ['FARM_MANAGER'] }),
      baseAssertion({ assertionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }),
    ];

    for (const value of invalid) {
      expect(compileGatewayVerifiedUserAssertionV1(value)).toBeUndefined();
      expect(() =>
        decodeGatewayVerifiedUserAssertionHeaderV1(encodeRawJson(value, true), {
          nowMs: NOW_MS,
        }),
      ).toThrow('ASSERTION_INVALID_SHAPE');
    }
  });

  it('requires canonical RFC3339 milliseconds and enforces the freshness window', () => {
    expect(
      compileGatewayVerifiedUserAssertionV1(baseAssertion({ issuedAt: '2026-08-09 12:00:00Z' })),
    ).toBeUndefined();

    const encoded = encodeGatewayVerifiedUserAssertionV1(baseAssertion());
    expect(() =>
      decodeGatewayVerifiedUserAssertionHeaderV1(encoded, {
        nowMs: NOW_MS + 5 * 60 * 1000 + 1,
      }),
    ).toThrow('ASSERTION_EXPIRED_OR_NOT_YET_VALID');
  });

  it('requires cross-tenant effective context to carry canonical impersonation provenance', () => {
    const unsignedContext = baseAssertion({
      effectiveTenantId: '22222222-2222-4222-8222-222222222222',
    });

    expect(compileGatewayVerifiedUserAssertionV1(unsignedContext)).toBeUndefined();
    expect(() =>
      decodeGatewayVerifiedUserAssertionHeaderV1(encodeRawJson(unsignedContext, true), {
        nowMs: NOW_MS,
      }),
    ).toThrow('ASSERTION_INVALID_SHAPE');
  });

  it('rejects non-canonical JSON bytes and non-canonical base64url encodings', () => {
    expect(() =>
      decodeGatewayVerifiedUserAssertionHeaderV1(encodeRawJson(baseAssertion(), false), {
        nowMs: NOW_MS,
      }),
    ).toThrow('ASSERTION_NON_CANONICAL_JSON');
    expect(() => decodeGatewayVerifiedUserAssertionHeaderV1('Zh', { nowMs: NOW_MS })).toThrow(
      'ASSERTION_NON_CANONICAL_BASE64URL',
    );
    expect(() =>
      decodeGatewayVerifiedUserAssertionHeaderV1('not+base64', { nowMs: NOW_MS }),
    ).toThrow('ASSERTION_INVALID_BASE64URL');
  });

  it('does not repair reordered permission arrays at the wire decoder', () => {
    const raw = baseAssertion({
      roles: ['SUPER_ADMIN'],
      impersonationSessionId: '44444444-4444-4444-8444-444444444444',
      impersonationPermissions: {
        canViewData: true,
        canModifyData: false,
        canAccessSettings: true,
        canManageUsers: false,
        canViewBilling: true,
        canExportData: false,
        allowedModules: ['billing', 'farm'],
      },
    });

    expect(() =>
      decodeGatewayVerifiedUserAssertionHeaderV1(encodeRawJson(raw, true), {
        nowMs: NOW_MS,
      }),
    ).toThrow('ASSERTION_INVALID_SHAPE');
  });
});
