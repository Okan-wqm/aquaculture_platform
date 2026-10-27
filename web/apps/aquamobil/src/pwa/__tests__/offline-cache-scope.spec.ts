/**
 * The offline cache scope (MOB-MEDIUM-031, PKG-42): who an encrypted cache entry belongs to.
 *
 * The cache was keyed by tenant and domain key only, so a user whose module grant was withdrawn
 * kept reading entries written under the grant they no longer hold. The scope is the tenant,
 * the user and a fingerprint of the `moduleAccess` claim, all read from the signed access token:
 * a token minted after a grant change lands in another scope, and nothing written under the old
 * one can be read.
 */
import {
  MODULE_ROLES,
  OWNER_MODULE_CODES,
  type ModuleAccess,
  type ModuleRole,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import { describe, expect, it } from 'vitest';

import { moduleAccessFingerprint, offlineCacheScopeOf } from '../offline-cache-scope';

/** An unsigned JWT-shaped string whose payload is `claims`, base64url-encoded. */
function tokenWith(claims: unknown): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

const FARM_MANAGER = { farm: 'MODULE_MANAGER' } as const;

/** Every well-formed claim: each owner module absent or holding one module role. */
function everyModuleAccess(): ModuleAccess[] {
  let claims: Partial<Record<OwnerModuleCode, ModuleRole>>[] = [{}];
  for (const code of OWNER_MODULE_CODES) {
    claims = claims.flatMap((claim) => [
      claim,
      ...MODULE_ROLES.map((role) => {
        const granted: Partial<Record<OwnerModuleCode, ModuleRole>> = { ...claim };
        granted[code] = role;
        return granted;
      }),
    ]);
  }
  return claims;
}

describe('offlineCacheScopeOf', () => {
  it('reads tenant, user and grants from the signed token', () => {
    const scope = offlineCacheScopeOf(
      tokenWith({ sub: 'user-1', tenantId: 'tenant-1', moduleAccess: FARM_MANAGER }),
      null,
    );
    expect(scope).not.toBeNull();
    expect(scope?.tenantId).toBe('tenant-1');
    expect(scope?.userId).toBe('user-1');
    expect(scope?.keyPrefix).toBe(`tenant-1:user-1:${moduleAccessFingerprint(FARM_MANAGER)}:`);
  });

  it('takes the carried tenant only for a token that names none, like every request lane', () => {
    const scope = offlineCacheScopeOf(
      tokenWith({ sub: 'user-1', moduleAccess: {} }),
      'tenant-carried',
    );
    expect(scope?.tenantId).toBe('tenant-carried');
  });

  it('reads a token minted before the claim existed as holding no grants (ADR-051 §2)', () => {
    const legacy = offlineCacheScopeOf(tokenWith({ sub: 'user-1', tenantId: 'tenant-1' }), null);
    const none = offlineCacheScopeOf(
      tokenWith({ sub: 'user-1', tenantId: 'tenant-1', moduleAccess: {} }),
      null,
    );
    expect(legacy?.keyPrefix).toBe(none?.keyPrefix);
  });

  it.each([
    ['no token', null],
    ['a token that is not a JWT', 'opaque-token'],
    ['a token without a subject', tokenWith({ tenantId: 'tenant-1', moduleAccess: {} })],
    ['a token with an empty subject', tokenWith({ sub: '', tenantId: 'tenant-1' })],
    ['a token naming no tenant, with none carried', tokenWith({ sub: 'user-1' })],
    [
      'a malformed grant (alert is no owner module)',
      tokenWith({ sub: 'u', tenantId: 't', moduleAccess: { alert: 'MODULE_USER' } }),
    ],
    [
      'a malformed grant (an account role)',
      tokenWith({ sub: 'u', tenantId: 't', moduleAccess: { farm: 'TENANT_ADMIN' } }),
    ],
    [
      'a grant claim that is a list',
      tokenWith({ sub: 'u', tenantId: 't', moduleAccess: ['farm'] }),
    ],
  ])('fails closed to no scope, so nothing is cached, for %s', (_label, token) => {
    expect(offlineCacheScopeOf(token, null)).toBeNull();
  });

  it('moves the scope when a grant changes and keeps it when only the token is re-minted', () => {
    const before = offlineCacheScopeOf(
      tokenWith({ sub: 'user-1', tenantId: 'tenant-1', moduleAccess: FARM_MANAGER, iat: 1 }),
      null,
    );
    const reminted = offlineCacheScopeOf(
      tokenWith({ sub: 'user-1', tenantId: 'tenant-1', moduleAccess: FARM_MANAGER, iat: 2 }),
      null,
    );
    const revoked = offlineCacheScopeOf(
      tokenWith({ sub: 'user-1', tenantId: 'tenant-1', moduleAccess: {}, iat: 3 }),
      null,
    );
    expect(reminted?.keyPrefix).toBe(before?.keyPrefix);
    expect(revoked?.keyPrefix).not.toBe(before?.keyPrefix);
  });

  it('gives two users of one tenant different scopes', () => {
    const a = offlineCacheScopeOf(
      tokenWith({ sub: 'user-a', tenantId: 't', moduleAccess: {} }),
      null,
    );
    const b = offlineCacheScopeOf(
      tokenWith({ sub: 'user-b', tenantId: 't', moduleAccess: {} }),
      null,
    );
    expect(a?.keyPrefix).not.toBe(b?.keyPrefix);
  });
});

describe('moduleAccessFingerprint', () => {
  it('gives every well-formed claim its own fingerprint, so two grant sets never share a cache', () => {
    const claims = everyModuleAccess();
    expect(claims).toHaveLength((MODULE_ROLES.length + 1) ** OWNER_MODULE_CODES.length);
    const fingerprints = new Set(claims.map(moduleAccessFingerprint));
    expect(fingerprints.size).toBe(claims.length);
  });

  it('does not depend on the order the claim lists its modules in', () => {
    expect(moduleAccessFingerprint({ farm: 'MODULE_USER', hr: 'MODULE_MANAGER' })).toBe(
      moduleAccessFingerprint({ hr: 'MODULE_MANAGER', farm: 'MODULE_USER' }),
    );
  });

  it('is a key segment: no separator the cache key uses', () => {
    for (const claim of everyModuleAccess()) {
      expect(moduleAccessFingerprint(claim)).toMatch(/^[0-9]+$/);
    }
  });
});
