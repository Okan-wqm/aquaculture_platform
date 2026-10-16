/**
 * totalLedgerLines — the total of every finance-ledger line one filter
 * selects, read page after page (FARM-MEDIUM-440 review: a site's real
 * electricity cost).
 *
 * financeLedger serves one page at a time; summing the first page alone
 * understates any filter that matches more lines than a page holds, and an
 * offset past the server's cap is clamped back to the cap, so reading on
 * would count the same lines twice. The spec pins: every page is read, the
 * sum is exact in minor units and kept per currency, and a filter that runs
 * past the deepest readable offset yields no total rather than a wrong one.
 * The page size and offset cap mirror farm-service's resolver, and the
 * mirror is checked against its source here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { FinanceLineItem } from '../useFinance';
import { LEDGER_MAX_OFFSET, LEDGER_PAGE_SIZE, totalLedgerLines } from '../useFinanceLedgerTotal';

function line(amountDecimal: string, currency = 'TRY'): FinanceLineItem {
  return {
    id: `${amountDecimal}-${currency}`,
    origin: 'MANUAL',
    categoryName: 'Electricity',
    kind: 'EXPENSE',
    amount: Number(amountDecimal),
    amountDecimal,
    currency,
    entryDate: '2026-10-02',
    estimated: false,
    editable: true,
  };
}

function pages(...sizes: number[]): (offset: number, limit: number) => Promise<FinanceLineItem[]> {
  return vi.fn(async (offset: number, limit: number) => {
    const index = offset / limit;
    return Array.from({ length: sizes[index] ?? 0 }, () => line('0.10'));
  });
}

describe('totalLedgerLines', () => {
  it('reads every page at the server page size and stops on a short page', async () => {
    const fetchPage = pages(LEDGER_PAGE_SIZE, 3);
    const total = await totalLedgerLines(fetchPage);

    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, LEDGER_PAGE_SIZE);
    expect(fetchPage).toHaveBeenNthCalledWith(2, LEDGER_PAGE_SIZE, LEDGER_PAGE_SIZE);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // 203 × 0.10 summed in cents is exactly 20.30 (a float sum drifts).
    expect(total).toEqual({
      complete: true,
      lines: LEDGER_PAGE_SIZE + 3,
      totals: [{ currency: 'TRY', amount: 20.3 }],
    });
  });

  it('keeps a total per currency instead of adding amounts of different currencies', async () => {
    const total = await totalLedgerLines(async () => [
      line('1200.50', 'TRY'),
      line('99.99', 'EUR'),
      line('0.50', 'TRY'),
    ]);
    expect(total).toEqual({
      complete: true,
      lines: 3,
      totals: [
        { currency: 'EUR', amount: 99.99 },
        { currency: 'TRY', amount: 1201 },
      ],
    });
  });

  it('reports an empty ledger as complete with no totals', async () => {
    expect(await totalLedgerLines(async () => [])).toEqual({
      complete: true,
      lines: 0,
      totals: [],
    });
  });

  it('yields no total when the lines run past the deepest offset the server serves', async () => {
    const fetchPage = vi.fn(async (_offset: number, limit: number) =>
      Array.from({ length: limit }, () => line('1.00')),
    );
    expect(await totalLedgerLines(fetchPage)).toEqual({ complete: false });
    // The last read is at the cap itself; nothing past it is requested.
    expect(fetchPage).toHaveBeenLastCalledWith(LEDGER_MAX_OFFSET, LEDGER_PAGE_SIZE);
    expect(fetchPage).toHaveBeenCalledTimes(LEDGER_MAX_OFFSET / LEDGER_PAGE_SIZE + 1);
  });
});

describe('the financeLedger paging contract', () => {
  it('mirrors the page size and offset cap of farm-service’s financeLedger resolver', () => {
    const resolver = readFileSync(
      resolve(
        __dirname,
        '../../../../../../apps/farm-service/src/finance/resolvers/finance.resolver.ts',
      ),
      'utf8',
    );
    const constant = (name: string): number => {
      const match = new RegExp(`const ${name} = ([\\d_]+);`).exec(resolver);
      if (match === null) throw new Error(`${name} is not declared in finance.resolver.ts`);
      return Number(match[1].replace(/_/g, ''));
    };
    expect(constant('MAX_LEDGER_PAGE')).toBe(LEDGER_PAGE_SIZE);
    expect(constant('MAX_LEDGER_OFFSET')).toBe(LEDGER_MAX_OFFSET);
  });
});
