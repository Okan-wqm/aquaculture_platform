/**
 * Site-wide feed consumption by feed type for a period (regulatory
 * "fôrforbruk"). Sums actual fed amounts from feeding_records — the real
 * ledger, not an estimate.
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

export interface SiteFeedTypeConsumption {
  feedName: string;
  brandName?: string;
  quantityKg: number;
}

export interface SiteFeedConsumptionResult {
  totalKg: number;
  byFeedType: SiteFeedTypeConsumption[];
  /** Number of feeding_records rows aggregated (provenance). */
  recordCount: number;
}

export class GetSiteFeedConsumptionQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly siteId: string,
    /** Inclusive ISO date (yyyy-mm-dd). */
    public readonly fromDate: string,
    /** Inclusive ISO date (yyyy-mm-dd). */
    public readonly toDate: string,
  ) {}
}
