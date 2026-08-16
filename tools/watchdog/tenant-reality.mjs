/**
 * The judgement half of the tenant-reality probe, separated from the query.
 *
 * WHY SEPARATE: the probe's value is entirely in what it CALLS a defect, and
 * that judgement was unreachable by any test while it lived inside a script
 * that opens a database connection on import. An adversarial review of the
 * first version found exactly this: the alert rules were verified, the SQL was
 * run by hand, and the classification — the part that decides whether anyone
 * gets paged — had no regression guard at all. An edit inverting the ACTIVE
 * and retired branches would have stayed green.
 */

/**
 * Statuses whose tenants are SUPPOSED to have no schema.
 *
 * Source of truth: `TenantStatus` in
 * libs/event-contracts/src/enums/tenant-status.enum.ts — PURGED is the
 * terminal GDPR Art-17 state; ARCHIVED and CANCELLED precede it. Counting
 * these as "provisioning never finished" would turn a successful erasure into
 * an alarm nobody can silence honestly, and an alarm like that is one
 * everybody learns to ignore.
 */
export const RETIRED_TENANT_STATUSES = new Set(['CANCELLED', 'ARCHIVED', 'PURGED', 'DELETED']);

/**
 * Compare what each tenant DECLARES against what the database physically has.
 *
 * @param {Array<{status: string, schemaExists: boolean, tableCount: number}>} tenants
 * @returns {{ok: boolean, critical: boolean, detail: string, counts: Record<string, number>}}
 */
export function classifyTenantReality(tenants) {
  let consistent = 0;
  let activeWithoutUsableSchema = 0;
  let unprovisionedPending = 0;
  let retiredAsExpected = 0;
  let schemaOutlivedTenant = 0;

  for (const tenant of tenants) {
    // A schema that exists but holds no table counts as missing: an empty
    // shell cannot store tenant data either, and it is the shape a
    // half-completed provisioning run leaves behind.
    const hasUsableSchema = tenant.schemaExists === true && Number(tenant.tableCount) > 0;

    if (RETIRED_TENANT_STATUSES.has(tenant.status)) {
      // For a retired tenant the ABSENCE of a schema is the correct state and
      // its presence is the defect — data that should be gone is still on disk.
      if (hasUsableSchema) schemaOutlivedTenant += 1;
      else retiredAsExpected += 1;
      continue;
    }

    if (hasUsableSchema) {
      consistent += 1;
    } else if (tenant.status === 'ACTIVE') {
      // The sinister half: the platform serves this tenant as fully
      // provisioned while it has nowhere to put a row.
      activeWithoutUsableSchema += 1;
    } else {
      // Declared not-yet-live and physically absent — provisioning stopped
      // partway rather than lying about having finished.
      unprovisionedPending += 1;
    }
  }

  return {
    ok: activeWithoutUsableSchema === 0 && unprovisionedPending === 0 && schemaOutlivedTenant === 0,
    critical: activeWithoutUsableSchema > 0 || schemaOutlivedTenant > 0,
    detail:
      `tenants=${tenants.length} consistent=${consistent} ` +
      `active-without-usable-schema=${activeWithoutUsableSchema} ` +
      `unprovisioned-pending=${unprovisionedPending} ` +
      `retired-as-expected=${retiredAsExpected} ` +
      `schema-outlived-tenant=${schemaOutlivedTenant}`,
    counts: {
      active_without_usable_schema: activeWithoutUsableSchema,
      unprovisioned_pending: unprovisionedPending,
      schema_outlived_tenant: schemaOutlivedTenant,
    },
  };
}

/**
 * Parse the probe's psql output (`status|schema_exists|table_count` per line).
 *
 * Kept here with the classifier so the wire format and the judgement that
 * reads it cannot drift apart unnoticed.
 *
 * @param {string} raw
 */
export function parseTenantRealityRows(raw) {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, schemaExists, tableCount] = line.split('|');
      return {
        status: status ?? '',
        schemaExists: schemaExists === 't',
        tableCount: Number(tableCount ?? 0),
      };
    });
}
