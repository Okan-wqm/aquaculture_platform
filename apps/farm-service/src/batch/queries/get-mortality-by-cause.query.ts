/**
 * Mortality-by-cause aggregation for a site + period.
 *
 * Regulatory reporting reads (biomass report "losses by cause", settefisk
 * mortality splits) — the GROUP BY that the indexed
 * mortality_records (tenantId, cause) column was built for.
 */
import { IQuery } from '@platform/cqrs';

export interface MortalityCauseBreakdown {
  cause: string;
  count: number;
}

export interface MortalityByCauseDetail {
  /** ISO date (yyyy-mm-dd) of the mortality record. */
  date: string;
  cause: string;
  /** Internal species catalog code (official FDIR mapping lands in Phase 2). */
  speciesCode: string;
  count: number;
  biomassLossKg?: number;
}

export interface MortalityByCauseResult {
  totalCount: number;
  byCause: MortalityCauseBreakdown[];
  details: MortalityByCauseDetail[];
  /** Number of mortality_records rows aggregated (provenance). */
  recordCount: number;
}

export class GetMortalityByCauseQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId: string,
    /** Inclusive ISO date (yyyy-mm-dd). */
    public readonly fromDate: string,
    /** Inclusive ISO date (yyyy-mm-dd). */
    public readonly toDate: string,
  ) {}
}
