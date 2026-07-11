/**
 * Cross-site transfer roll-up for a site + period (regulatory "flytting").
 *
 * Only movements that CROSS the site boundary count — tank-to-tank moves
 * inside the same site are internal logistics, not reportable transfers.
 */
import { IQuery } from '@platform/cqrs';

export interface TransferSummaryRecord {
  /** ISO date (yyyy-mm-dd). */
  date: string;
  direction: 'IN' | 'OUT';
  /** Internal species catalog code (official FDIR mapping lands in Phase 2). */
  speciesCode: string;
  fishCount: number;
  biomassKg: number;
  /** The other side of the move (site name today; external org in Phase 2). */
  counterparty?: string;
}

export interface TransfersSummaryResult {
  records: TransferSummaryRecord[];
  /** Number of tank_operations rows aggregated (provenance). */
  recordCount: number;
}

export class GetTransfersSummaryQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId: string,
    /** Inclusive ISO date (yyyy-mm-dd). */
    public readonly fromDate: string,
    /** Inclusive ISO date (yyyy-mm-dd). */
    public readonly toDate: string,
  ) {}
}
