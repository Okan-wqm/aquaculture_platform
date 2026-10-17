/**
 * Total of every finance-ledger line one filter selects.
 *
 * WHY: financeLedger serves one page at a time and financeSummary has no site
 * filter, so a figure such as "the electricity booked to this site this
 * month" is the sum over every page of the filtered ledger. The first page
 * alone would understate it as soon as a filter matches more lines than a
 * page holds. farm-service clamps a page to MAX_LEDGER_PAGE lines and the
 * offset to MAX_LEDGER_OFFSET (finance.resolver.ts); an offset past the cap
 * is clamped back to it, so reading on would count the same lines twice.
 *
 * WHAT: `totalLedgerLines` reads page after page at the server's page size
 * until a short page, sums `amountDecimal` per currency in whole minor units
 * (the ledger stores numeric(15,2), so cents add exactly where a float sum
 * drifts), and yields `complete: false` instead of a total when the lines run
 * past the deepest offset the server serves. `useFinanceLedgerTotal` runs it
 * under the tenant-scoped ['finance', 'ledger', …] key, so every entry
 * mutation that invalidates the ledger refreshes the total too. The page size
 * and offset cap are checked against the resolver by
 * hooks/__tests__/useFinanceLedgerTotal.spec.ts.
 */
import { graphqlClient, parseMoney, useTenantQuery } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';

import { GET_FINANCE_LEDGER } from '../graphql/finance.operations';

import type { FinanceLedgerFilter, FinanceLineItem } from './useFinance';

/** farm-service's MAX_LEDGER_PAGE: the most lines one financeLedger read returns. */
export const LEDGER_PAGE_SIZE = 200;
/** farm-service's MAX_LEDGER_OFFSET: the deepest offset financeLedger serves. */
export const LEDGER_MAX_OFFSET = 5_000;

export interface CurrencyTotal {
  /** ISO 4217 code the lines were booked in. */
  readonly currency: string;
  readonly amount: number;
}

export type LedgerTotal =
  | {
      readonly complete: true;
      /** How many lines the filter selected. */
      readonly lines: number;
      /** One total per currency booked, by currency code; empty when no line matched. */
      readonly totals: readonly CurrencyTotal[];
    }
  /** More lines match than the server lets a reader page through. */
  | { readonly complete: false };

/** A total is asked for a whole selection, so paging is the hook's, not the caller's. */
export type LedgerTotalFilter = Omit<FinanceLedgerFilter, 'limit' | 'offset' | 'includeDerived'> & {
  /** Whether derived cost lines (feed, fingerlings, …) count — always a deliberate choice. */
  readonly includeDerived: boolean;
};

export type LedgerPageReader = (offset: number, limit: number) => Promise<FinanceLineItem[]>;

export async function totalLedgerLines(readPage: LedgerPageReader): Promise<LedgerTotal> {
  const cents = new Map<string, number>();
  let lines = 0;
  for (let offset = 0; offset <= LEDGER_MAX_OFFSET; offset += LEDGER_PAGE_SIZE) {
    // Pages are read in order: whether the next one exists depends on this one being full.
    const page = await readPage(offset, LEDGER_PAGE_SIZE);
    for (const line of page) {
      const amount = Math.round(parseMoney(line.amountDecimal) * 100);
      cents.set(line.currency, (cents.get(line.currency) ?? 0) + amount);
    }
    lines += page.length;
    if (page.length < LEDGER_PAGE_SIZE) {
      const totals = [...cents.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, minor]): CurrencyTotal => ({ currency, amount: minor / 100 }));
      return { complete: true, lines, totals };
    }
  }
  return { complete: false };
}

/** `filter` is null until the caller knows what to total (no read until then). */
export function useFinanceLedgerTotal(
  filter: LedgerTotalFilter | null,
): UseQueryResult<LedgerTotal> {
  return useTenantQuery(
    ['finance', 'ledger', 'total', filter],
    () =>
      totalLedgerLines(async (offset, limit) => {
        const data = await graphqlClient.request<{ financeLedger: FinanceLineItem[] }>(
          GET_FINANCE_LEDGER,
          { ...filter, limit, offset },
        );
        return data.financeLedger;
      }),
    // A total of another filter (the previously selected site) must never
    // stand in for this one while it loads.
    { enabled: filter !== null, keepPreviousData: false },
  );
}
