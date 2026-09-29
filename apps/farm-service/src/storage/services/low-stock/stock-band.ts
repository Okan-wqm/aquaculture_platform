/**
 * Stock bands — the pure decision rules of the two-tier stock model (plan K8).
 *
 * WHY a separate pure module: the band rule is the one thing every consumer
 * (ledger sink, warehouse summary, the AutoRule reconciler in PR-B1a-2) must
 * agree on. Keeping it free of I/O makes it exhaustively testable and leaves
 * no second copy to drift.
 */

export type StockBand = 'ok' | 'low_stock' | 'out_of_stock';

const BAND_RANK: Readonly<Record<StockBand, number>> = Object.freeze({
  ok: 0,
  low_stock: 1,
  out_of_stock: 2,
});

/**
 * Site tier (distribution): physical on-hand at the site's locations vs the
 * site policy minimum.
 * INVARIANT: `minStock > 0` (the table's CHECK). At or below the minimum is
 * low; zero on-hand is out of stock.
 */
export function siteStockBand(onHand: number, minStock: number): StockBand {
  if (onHand <= 0) return 'out_of_stock';
  return onHand <= minStock ? 'low_stock' : 'ok';
}

/**
 * Pool tier (procurement): the reorder decision uses the INVENTORY POSITION
 * (on-hand across every site + open purchase-order remainder, FARM-3), so a
 * shortfall already covered by an order does not ask for a second purchase.
 * Physical stock-out is judged on on-hand alone: fish cannot eat an order.
 * A threshold of 0 means the item is not reorder-controlled.
 */
export function poolStockBand(
  onHand: number,
  onOrder: number,
  reorderThreshold: number,
): StockBand {
  if (onHand <= 0) return 'out_of_stock';
  if (reorderThreshold > 0 && onHand + onOrder <= reorderThreshold) return 'low_stock';
  return 'ok';
}

/**
 * Edge trigger: true only when the band got WORSE (ok → low, ok → out,
 * low → out). A movement that leaves stock already low emits nothing, and a
 * recovery emits nothing (clearing is the reconciler's job).
 */
export function bandWorsened(before: StockBand, after: StockBand): boolean {
  return BAND_RANK[after] > BAND_RANK[before];
}

/** A band that calls for action. */
export type LowStockSeverity = Exclude<StockBand, 'ok'>;

/**
 * The severity a movement pushed a tier into, or null when the band did not
 * worsen. WHY: the event's `severity` can never be 'ok'; returning the narrowed
 * type makes that impossible rather than asserted.
 */
export function worsenedSeverity(before: StockBand, after: StockBand): LowStockSeverity | null {
  if (after === 'ok' || !bandWorsened(before, after)) return null;
  return after;
}

/**
 * Urgency for ordering lists: 0 = out of stock, then the covered fraction of
 * the threshold (lower = more urgent).
 */
export function stockUrgency(compared: number, threshold: number): number {
  if (compared <= 0) return 0;
  return threshold > 0 ? compared / threshold : Number.POSITIVE_INFINITY;
}
