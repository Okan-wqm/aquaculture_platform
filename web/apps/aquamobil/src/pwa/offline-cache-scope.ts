/**
 * Whose encrypted offline cache entry this is (MOB-MEDIUM-031, PKG-42).
 *
 * WHY: entries were keyed `cache_<tenant>:<domain key>`, with no user and no grants. A worker
 * whose access to a module was withdrawn — a role change, a disabled module, from R4 a revoked
 * module grant — kept reading entries written under access they no longer hold, until each
 * entry's TTL ran out.
 *
 * WHAT: a scope is the tenant, the user and a fingerprint of the `moduleAccess` claim, all
 * read from the access token the server signed (ADR-051 §2), never from a separately carried
 * copy except the tenant, which follows the request lanes' one resolver
 * (resolveRequestTenantId). A token minted after a grant change lands in another scope, so
 * nothing cached under the old grants can be read; offline-cache.ts keeps only the current
 * scope on the device.
 *   - The fingerprint is the plan's hash(moduleAccess), realised injectively: one digit per
 *     owner module of the dictionary (OWNER_MODULE_CODES), 0 for no grant, else 1 + the role's
 *     index in MODULE_ROLES. Two different grant sets can never share a partition — a hash
 *     could only make that likely — and the segment holds no key separator.
 *   - A token without the claim was minted before R1 and holds no grants (ADR-051 §2), the
 *     same scope as `{}`. A malformed claim, or a token without a subject or a tenant, yields
 *     no scope: nothing is read from or written to the cache (fail closed).
 *   - OfflineCacheScope is a class holding its key prefix in an ES private field, exported as a
 *     type: the only way to build one is offlineCacheScopeOf, so no caller keys the cache by
 *     hand.
 */
import {
  MODULE_ROLES,
  OWNER_MODULE_CODES,
  isModuleAccess,
  type ModuleAccess,
} from '@aquaculture/shared-contracts';

import { readAccessTokenClaim, resolveRequestTenantId } from '@/utils/jwt-claims';

class OfflineCacheScope {
  /** ES private fields: no object literal or spread can stand in for a scope. */
  readonly #callerKeyPrefix: string;
  readonly #keyPrefix: string;
  readonly tenantId: string;
  readonly userId: string;

  constructor(tenantId: string, userId: string, grants: ModuleAccess) {
    this.tenantId = tenantId;
    this.userId = userId;
    // Encoded, so an id can never carry the separator and make one scope's prefix the start
    // of another's.
    this.#callerKeyPrefix = `${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}:`;
    this.#keyPrefix = `${this.#callerKeyPrefix}${moduleAccessFingerprint(grants)}:`;
    Object.freeze(this);
  }

  /** `<tenant>:<user>:` — every entry of this caller starts with it, under any grants. */
  get callerKeyPrefix(): string {
    return this.#callerKeyPrefix;
  }

  /** `<tenant>:<user>:<grants fingerprint>:` — every entry key of this scope starts with it. */
  get keyPrefix(): string {
    return this.#keyPrefix;
  }
}

export type { OfflineCacheScope };

/** One digit per owner module: 0 for no grant, else 1 + the role's index in MODULE_ROLES. */
export function moduleAccessFingerprint(grants: ModuleAccess): string {
  return OWNER_MODULE_CODES.map((code) => {
    const role = grants[code];
    return role === undefined ? '0' : String(MODULE_ROLES.indexOf(role) + 1);
  }).join('');
}

/**
 * The cache scope of the session holding `accessToken`; null when the token cannot name one
 * (no token, no subject, no tenant, a malformed grant claim), and then nothing is cached.
 */
export function offlineCacheScopeOf(
  accessToken: string | null | undefined,
  carriedTenantId: string | null | undefined,
): OfflineCacheScope | null {
  const userId = readAccessTokenClaim(accessToken, 'sub');
  if (typeof userId !== 'string' || userId.length === 0) return null;
  const tenantId = resolveRequestTenantId(accessToken, carriedTenantId);
  if (tenantId === null) return null;
  const grants = readAccessTokenClaim(accessToken, 'moduleAccess');
  if (grants === undefined) return new OfflineCacheScope(tenantId, userId, {});
  return isModuleAccess(grants) ? new OfflineCacheScope(tenantId, userId, grants) : null;
}
