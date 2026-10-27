import { Logger } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

import {
  listActiveTenantSchemaIdentities,
  listRetainedTenantSchemaIdentities,
} from './tenant-schema.utils';
import { runInTenantTransaction } from './tenant-transaction';

/**
 * Which tenants does a cross-tenant worker care about?
 *
 * WHY: every tenant table carries FORCED row-level security whose policy is
 * `tenantId = app.current_tenant` (or the audited bypass). A cron tick has no
 * request, so the pool is deny-by-default and a probe that queries a tenant
 * table on a bare QueryRunner sees ZERO rows for every tenant — the worker
 * concludes "nobody to serve" and goes silent, with no error to notice. That
 * is how the feeding engine's hourly tick never processed a single tenant
 * (FARM-CRITICAL-479: `farm.feeding_job_runs` empty since the engine shipped).
 *
 * WHAT: the tenant list comes from the platform ledger
 * (`platform.list_active_tenant_schema_mappings()`, the only least-privilege
 * source of verified `{schema, tenantId}` pairs), and each tenant is probed
 * inside `runInTenantTransaction`, i.e. under that tenant's own RLS context
 * and pinned search_path. The probe states the tenant-local question in SQL
 * ("does this tenant have a live assignment?") and never mentions a tenantId:
 * RLS is what scopes it.
 *
 * A probe that throws for one tenant is logged and skipped so one broken
 * tenant cannot hide the rest; a ledger failure is NOT swallowed — "cannot
 * list tenants" must never read as "no tenants".
 *
 * Related: `forEachVerifiedTenantSchema` fans work out with bounded
 * concurrency but does not establish the RLS context, so it fits work that
 * already binds its own context; this helper is for discovery.
 */
export type TenantDiscoveryScope = 'active' | 'retained';

export interface TenantDiscoveryOptions {
  /**
   * `active` (default): tenants the platform serves. `retained`: every tenant
   * that still holds data — suspended, migrating, pending deletion — for
   * retention and erasure work that must outlive the tenant's activity.
   */
  readonly scope?: TenantDiscoveryScope;
}

const logger = new Logger('TenantDiscovery');

export async function findTenantsMatching(
  dataSource: DataSource,
  sourceSchema: string,
  probe: (queryRunner: QueryRunner) => Promise<boolean>,
  options: TenantDiscoveryOptions = {},
): Promise<string[]> {
  const identities =
    options.scope === 'retained'
      ? await listRetainedTenantSchemaIdentities(dataSource)
      : await listActiveTenantSchemaIdentities(dataSource);

  const matching: string[] = [];
  for (const { schemaName, tenantId } of identities) {
    try {
      if (await runInTenantTransaction(dataSource, sourceSchema, tenantId, probe)) {
        matching.push(tenantId);
      }
    } catch (error) {
      logger.warn(`Tenant discovery failed for schema ${schemaName}: ${(error as Error).message}`);
    }
  }
  return matching;
}
