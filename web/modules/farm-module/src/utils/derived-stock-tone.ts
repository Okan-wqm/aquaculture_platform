/**
 * Stock-cell tone from a backend-DERIVED stock status (FARM-HIGH-335 / FARM-HIGH-338).
 *
 * WHY: the backend derives every stock status from the storage ledger with ONE
 * rule, `poolStockBand` over on-hand + open purchase-order remainder: the
 * catalog projection for feed, chemicals and consumables compares that
 * position with `minStock` (CatalogStockProjector), `deriveSparePartStatus`
 * with the reorder point. A table that re-compares `quantity` with `minStock`
 * or `reorderPoint` on the client is a second rule, and it disagrees with the
 * first (open orders, lifecycle statuses). Tables colour stock from the status
 * alone.
 * WHAT: OUT_OF_STOCK → out, LOW_STOCK → low, every other status → neutral.
 */

/** How urgent a stock cell reads. */
export type StockTone = 'out' | 'low' | 'neutral';

/** The tone of a derived stock status (any catalog or spare-part status enum). */
export function derivedStockTone(status: string): StockTone {
  if (status === 'OUT_OF_STOCK') return 'out';
  if (status === 'LOW_STOCK') return 'low';
  return 'neutral';
}

/** Text colour of each tone: red = nothing left, amber = at/below threshold. */
export const STOCK_TONE_TEXT_CLASS: Readonly<Record<StockTone, string>> = Object.freeze({
  out: 'text-error-600 dark:text-error-400',
  low: 'text-warning-600 dark:text-warning-400',
  neutral: 'text-gray-900 dark:text-gray-100',
});
