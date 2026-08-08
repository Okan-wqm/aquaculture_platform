/**
 * Canary tenant registry — the reason a synthetic write cannot be billed.
 *
 * WHY THIS EXISTS
 * ---------------
 * The data-flow watchdog's write probes need a real account: proving that a
 * write reaches the database and comes back means actually writing. The
 * standing rule is that identities are never invented, so the operator
 * authorised one canary tenant for exactly this purpose.
 *
 * A canary that bills is a canary nobody will keep running. Worse, its
 * usage would silently distort revenue reporting — synthetic traffic
 * indistinguishable from a customer's. So the exemption is not a policy
 * someone remembers to apply; it is a refusal at the single entry point
 * where usage becomes billable.
 *
 * CONFIGURATION
 * -------------
 * `CANARY_TENANT_IDS` — comma-separated tenant UUIDs. Absent or empty means
 * no canary tenants exist, which is the correct default for any environment
 * that has not authorised one.
 *
 * FAIL-CLOSED ON MALFORMED INPUT
 * ------------------------------
 * A typo'd UUID does not silently drop out of the list. If it did, the
 * canary would look exempt in the config and be billed in reality, and the
 * discrepancy would surface as a small unexplained invoice line months
 * later. Malformed entries throw at load time instead.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CANARY_TENANT_IDS_ENV = 'CANARY_TENANT_IDS';

export class CanaryTenantConfigurationError extends Error {}

/**
 * Parse the configured canary tenant ids.
 *
 * Exported separately from the lookup so a service can validate at boot and
 * fail to start, rather than discovering the typo on the first billable
 * event.
 */
export function parseCanaryTenantIds(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') {
    return new Set<string>();
  }
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const malformed = ids.filter((id) => !UUID_RE.test(id));
  if (malformed.length > 0) {
    throw new CanaryTenantConfigurationError(
      `${CANARY_TENANT_IDS_ENV} contains ${malformed.length} malformed tenant id(s): ` +
        `${malformed.join(', ')}. A canary that is not recognised is a canary that gets billed, ` +
        `so this refuses to start rather than silently dropping the entry.`,
    );
  }
  return new Set(ids.map((id) => id.toLowerCase()));
}

/**
 * Is this tenant a canary?
 *
 * Reads the environment on every call on purpose: the set is tiny, and a
 * cached copy would keep exempting a tenant after the operator removed it,
 * or keep billing one they just added, until the next restart.
 */
export function isCanaryTenant(tenantId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') return false;
  return parseCanaryTenantIds(env[CANARY_TENANT_IDS_ENV]).has(tenantId.trim().toLowerCase());
}
