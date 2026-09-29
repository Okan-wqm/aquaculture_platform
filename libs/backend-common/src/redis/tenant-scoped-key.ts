import { isValidUUID } from '../database/tenant-schema.utils';

/** A key family: lowercase segments joined by ':' (e.g. `ai:tokens`, `msg:ai-trigger`). */
const FAMILY_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;

/**
 * Build a tenant-scoped cache/counter key: `<family>:<tenantId>[:<part>…]`
 * (K10 layer 5 / MT-HIGH-062).
 *
 * WHY the tenant is the FIRST variable segment: two tenants can never share a
 * key, whatever the remaining parts are (ids that happen to collide, a part
 * the caller forgot). The family is a fixed literal, so every key of one
 * family sorts by tenant and `SCAN <family>:<tenant>:*` reaches one tenant.
 *
 * WHY throw on a non-UUID tenant: an empty or malformed tenant would collapse
 * every tenant's key into one shared key — fail closed instead.
 *
 * INVARIANT: AI key families are built only through this function, inside the
 * registered key modules (tests/invariants/ai-tenant-boundary.spec.ts); if
 * violated → an AI cache or counter can be shared across tenants.
 */
export function tenantScopedKey(
  family: string,
  tenantId: string,
  ...parts: ReadonlyArray<string | number>
): string {
  if (!FAMILY_RE.test(family)) {
    throw new Error(`tenantScopedKey: invalid key family "${family}"`);
  }
  if (!isValidUUID(tenantId)) {
    throw new Error('tenantScopedKey: a tenant-scoped key requires a tenant UUID');
  }
  return [family, tenantId, ...parts.map(String)].join(':');
}
