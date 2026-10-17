/**
 * Electricity booked to one site this month — the real figure of the
 * facility node's cost-share card on a site.
 *
 * WHY: farm-service seeds a system ELECTRICITY expense category
 * (DEFAULT_FARM_FINANCE_CATEGORIES, finance-category-seed.service.ts) and a
 * manual expense carries its site, so what a site booked for electricity this
 * month is read from the finance ledger, not shown as sample data.
 * FARM-MEDIUM-440 covers only what has no record: the tariff, and the split of
 * a site's electricity below it.
 *
 * WHAT: resolves the ELECTRICITY category — archived included, since lines
 * booked to it still count — and totals the site's manual ledger lines in it
 * from the first of the local month to today. A tenant without that category
 * cannot have booked electricity, so it reads as nothing booked, without a
 * ledger read. The caller gates the hook to roles that may read finance.
 */
import { useFinanceCategories } from '../../../hooks/useFinance';
import { useFinanceLedgerTotal, type CurrencyTotal } from '../../../hooks/useFinanceLedgerTotal';

/** Code of the seeded system category every electricity expense is booked to. */
const ELECTRICITY_CODE = 'ELECTRICITY';

export type SiteElectricityState =
  | { status: 'loading' | 'error' }
  /** More lines are booked than one read can total (beyond the ledger's paging cap). */
  | { status: 'too-many' }
  /** One total per currency booked; empty when nothing is booked this month. */
  | { status: 'ready'; totals: readonly CurrencyTotal[] };

/** `yyyy-mm-dd` of a local calendar date. */
function localIsoDate(year: number, monthIndex: number, day: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The first of `now`'s local month through `now`'s local date, as ledger bounds. */
export function monthToDate(now: Date): { from: string; to: string } {
  return {
    from: localIsoDate(now.getFullYear(), now.getMonth(), 1),
    to: localIsoDate(now.getFullYear(), now.getMonth(), now.getDate()),
  };
}

export function useSiteElectricity(siteId: string): SiteElectricityState {
  const categories = useFinanceCategories('FARM_OPEX', true);
  const electricity = (categories.data ?? []).find(
    (category) => category.code === ELECTRICITY_CODE,
  );
  const { from, to } = monthToDate(new Date());
  const total = useFinanceLedgerTotal(
    electricity === undefined
      ? null
      : { from, to, siteId, categoryId: electricity.id, includeDerived: false },
  );

  if (categories.isError) return { status: 'error' };
  if (categories.data === undefined) return { status: 'loading' };
  if (electricity === undefined) return { status: 'ready', totals: [] };
  if (total.isError) return { status: 'error' };
  if (total.data === undefined) return { status: 'loading' };
  if (!total.data.complete) return { status: 'too-many' };
  return { status: 'ready', totals: total.data.totals };
}
