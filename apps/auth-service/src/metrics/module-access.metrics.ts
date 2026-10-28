import * as client from 'prom-client';

import {
  MODULE_ACCESS_DROP_REASONS,
  type ModuleAccessDrops,
} from '../modules/authentication/services/module-access-reader';

/**
 * The counters of the module-access reader at token mint (RBAC-MEDIUM-029; ADR-051 §2: codes the
 * claim leaves out are "dropped and counted").
 *
 * WHY a registry of its own: the reader is a function the mint calls, not an injectable, and the
 * count must not depend on how a TokenService was constructed. AuthMetricsModule contributes
 * this registry to /metrics, as it does the auth-domain registry. No tenant or user label: the
 * scrape surface is unauthenticated (see AuthDomainMetricsService).
 */
export const MODULE_ACCESS_METRICS_REGISTRY = new client.Registry();

const droppedGrants = new client.Counter({
  name: 'auth_module_access_dropped_total',
  help:
    'Module rows a minted moduleAccess claim left out, by reason: not_owner_module (alert, ai), ' +
    'unknown_code, role_missing (a row written without a role, backfilled in release R3)',
  labelNames: ['reason'] as const,
  registers: [MODULE_ACCESS_METRICS_REGISTRY],
});

/** Counts what one mint's claim left out. */
export function recordModuleAccessDrops(dropped: ModuleAccessDrops): void {
  for (const reason of MODULE_ACCESS_DROP_REASONS) {
    if (dropped[reason] > 0) droppedGrants.inc({ reason }, dropped[reason]);
  }
}
