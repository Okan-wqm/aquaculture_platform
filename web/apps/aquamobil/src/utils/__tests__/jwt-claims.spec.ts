// The PWA reads two claims from its access token: `resourcePermissions` for UI
// visibility and `tenantId` for the X-Tenant-Id header. Both decoders share one
// fail-closed payload decoder, so a malformed token yields "no claim" (never a
// guessed value) for each.

import { describe, it, expect } from 'vitest';

import { decodeResourcePermissions, decodeTenantId } from '../jwt-claims';

/** Build an unsigned JWT-shaped string whose payload is `claims`, base64url-encoded. */
function tokenWith(claims: unknown): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

describe('decodeTenantId', () => {
  it('returns the tenantId claim the server signed', () => {
    expect(decodeTenantId(tokenWith({ sub: 'u1', tenantId: 'tenant-42' }))).toBe('tenant-42');
  });

  it('decodes base64url payloads whose standard form would need "-"/"_" substitution', () => {
    // A claim value chosen so the encoded payload contains '-' or '_'.
    const tenantId = 'ÿþ-tenant>>?';
    expect(decodeTenantId(tokenWith({ tenantId }))).toBe(tenantId);
  });

  it.each([
    ['an absent token', null],
    ['an empty token', ''],
    ['a token that is not three segments', 'opaque-token'],
    ['a payload that is not JSON', 'a.!!!.c'],
    ['a payload that is an array', tokenWith(['tenant-1'])],
    ['a missing claim', tokenWith({ sub: 'u1' })],
    ['an empty claim', tokenWith({ tenantId: '' })],
    ['a non-string claim', tokenWith({ tenantId: 42 })],
  ])('fails closed to null for %s', (_label, token) => {
    expect(decodeTenantId(token)).toBeNull();
  });
});

describe('decodeResourcePermissions', () => {
  it('returns the capability strings', () => {
    const token = tokenWith({ resourcePermissions: ['farm:read', 'farm:write'] });
    expect(decodeResourcePermissions(token)).toEqual(['farm:read', 'farm:write']);
  });

  it.each([
    ['an absent token', null],
    ['a malformed token', 'opaque-token'],
    ['a missing claim', tokenWith({ tenantId: 't' })],
    ['a claim with a non-string member', tokenWith({ resourcePermissions: ['farm:read', 7] })],
  ])('fails closed to [] for %s', (_label, token) => {
    expect(decodeResourcePermissions(token)).toEqual([]);
  });
});
