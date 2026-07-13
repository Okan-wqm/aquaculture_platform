/**
 * Resolver-boundary mappers that populate the `*Decimal` fields (ADR-0004 /
 * DATA-MEDIUM-009 additive coexistence) from the existing numeric fields.
 *
 * The `Decimal` scalar serialises a JS number to an exact decimal string, so the
 * `*Decimal` field carries the SAME value as its deprecated `Float` sibling — no
 * recomputation, no precision change. Applied once at the resolver (and thus
 * captured by the @Cacheable snapshot) so no query handler needs to know about
 * the wire representation.
 */
import {
  FinanceBatchTotal,
  FinanceLineItem,
  FinanceSummary,
} from '../dto/finance-outputs.dto';

/** Add `amountDecimal` to each unified ledger line. */
export function withLineItemDecimals(items: FinanceLineItem[]): FinanceLineItem[] {
  return items.map((i) => ({ ...i, amountDecimal: i.amount }));
}

/** Add the `*Decimal` fields to a finance summary (totals + per-category + series). */
export function withSummaryDecimals(s: FinanceSummary): FinanceSummary {
  return {
    ...s,
    totalExpenseDecimal: s.totalExpense,
    totalRevenueDecimal: s.totalRevenue,
    netResultDecimal: s.netResult,
    byCategory: s.byCategory.map((c) => ({ ...c, totalDecimal: c.total })),
    series: s.series.map((b) => ({
      ...b,
      totalExpenseDecimal: b.totalExpense,
      totalRevenueDecimal: b.totalRevenue,
    })),
  };
}

/** Add the `*Decimal` fields to each per-batch total. */
export function withBatchTotalDecimals(totals: FinanceBatchTotal[]): FinanceBatchTotal[] {
  return totals.map((t) => ({
    ...t,
    totalExpenseDecimal: t.totalExpense,
    totalRevenueDecimal: t.totalRevenue,
  }));
}
