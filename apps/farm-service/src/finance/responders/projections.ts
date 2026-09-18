/**
 * PURE projections for the finance farm-AI responder (PR-4, Production
 * specialist). Covers the ledger summary and per-batch totals.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO entity metadata and NO operator PII (finance rows carry none — the
 *    ledger aggregates money, never people).
 *  - Dates → ISO strings; lists capped at the contract ceiling.
 */
import {
  BatchTotalShape,
  CategoryTotalShape,
  FinanceSummaryShape,
  TimeBucketShape,
} from '../services/finance-ledger-query.service';
import { isoOrNull } from '../../common/nats/ai-query-responder';
import { FARM_AI_QUERY_LIMITS } from '@platform/event-contracts';

/** Cap any embedded reply list to the contract's hard ceiling. */
function capList<T>(rows: readonly T[]): { items: T[]; truncated: boolean } {
  const bounded = rows.slice(0, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
  return { items: bounded, truncated: rows.length > bounded.length };
}

function projectCategoryTotal(entry: CategoryTotalShape): CategoryTotalShape {
  return { ...entry };
}

function projectTimeBucket(entry: TimeBucketShape): {
  bucketStart: string | null;
  totalExpense: number;
  totalRevenue: number;
} {
  return {
    bucketStart: isoOrNull(entry.bucketStart),
    totalExpense: entry.totalExpense,
    totalRevenue: entry.totalRevenue,
  };
}

/** Ledger summary DTO (categories + time series capped at 50 each). */
export interface FinanceSummaryDto {
  currency: string;
  totalExpense: number;
  totalRevenue: number;
  netResult: number;
  byCategory: CategoryTotalShape[];
  byCategoryTruncated: boolean;
  series: { bucketStart: string | null; totalExpense: number; totalRevenue: number }[];
  seriesTruncated: boolean;
}

/**
 * Project the finance ledger summary. A bucket count beyond the contract
 * cap flags `seriesTruncated` — the caller narrows the window/granularity.
 */
export function projectFinanceSummary(result: FinanceSummaryShape): FinanceSummaryDto {
  const categories = capList(result.byCategory);
  const series = capList(result.series);
  return {
    currency: result.currency,
    totalExpense: result.totalExpense,
    totalRevenue: result.totalRevenue,
    netResult: result.netResult,
    byCategory: categories.items.map(projectCategoryTotal),
    byCategoryTruncated: categories.truncated,
    series: series.items.map(projectTimeBucket),
    seriesTruncated: series.truncated,
  };
}

/** Per-batch finance totals row. */
export interface FinanceBatchTotalDto {
  batchId: string;
  totalExpense: number;
  totalRevenue: number;
}

/** Project the per-batch finance totals (capped at 50). */
export function projectFinanceBatchTotals(
  rows: BatchTotalShape[],
): { items: FinanceBatchTotalDto[]; truncated: boolean; total: number } {
  const bounded = capList(rows);
  return {
    items: bounded.items.map((row) => ({ ...row })),
    truncated: bounded.truncated,
    total: rows.length,
  };
}
