/**
 * Caller-visible low-stock rows for list surfaces (warehouse hub, storage
 * overview), plan K8.
 *
 * WHY here and not in each handler: both summaries show the same readings and
 * must apply the same visibility rule. SITE rows reveal one site's stock, so a
 * caller below MODULE_MANAGER sees them only for their assigned sites
 * (SEC-HIGH-051 vocabulary); POOL rows are tenant aggregates and stay visible
 * to every role that reads the summary, as the catalog-based rows were.
 */
import { EntityManager, In } from 'typeorm';
import {
  SiteAuthorizationService,
  type SiteScopeCaller,
} from '@aquaculture/backend-common/security';

import { Site } from '../../../site/entities/site.entity';
import { LowStockEvaluator } from './low-stock-evaluator.service';
import type { DescribedStockReading } from './low-stock.types';

export interface VisibleLowStockRow {
  reading: DescribedStockReading;
  /** Site name for SITE rows; null for POOL rows. */
  siteName: string | null;
}

/**
 * WHY: one visibility + naming rule for every low-stock list; WHAT: evaluator
 * readings (most urgent first) filtered to the caller's site scope, each SITE
 * row labelled with its site name.
 */
export async function listVisibleLowStock(
  evaluator: LowStockEvaluator,
  siteAuth: SiteAuthorizationService,
  manager: EntityManager,
  tenantId: string,
  caller: SiteScopeCaller,
): Promise<VisibleLowStockRow[]> {
  const scope = siteAuth.resolveSiteScope(caller);
  const readings = (await evaluator.listBelowThreshold(manager, tenantId)).filter(
    (reading) =>
      reading.level === 'pool' || scope.kind === 'TENANT' || scope.siteIds.includes(reading.siteId),
  );

  const siteIds = [
    ...new Set(readings.flatMap((reading) => (reading.level === 'site' ? [reading.siteId] : []))),
  ];
  const sites =
    siteIds.length === 0
      ? []
      : await manager.find(Site, {
          where: { tenantId, id: In(siteIds) },
          select: ['id', 'name'],
        });
  const siteNames = new Map(sites.map((site) => [site.id, site.name]));

  return readings.map((reading) => ({
    reading,
    siteName: reading.level === 'site' ? (siteNames.get(reading.siteId) ?? null) : null,
  }));
}
