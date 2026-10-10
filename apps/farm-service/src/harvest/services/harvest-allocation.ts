/**
 * Split of a harvest plan's counted quantity across the tanks holding its
 * batch (FARM-MEDIUM-397).
 *
 * WHY: #1670 split `actualQuantity` in proportion to each tank's stock without
 * bounding it by the total book stock, so a count above the book stock gave a
 * tank a share larger than its own stock. The SSoT writer refuses that
 * overdraft, so the completion failed — and, because every retry recomputed
 * the same split, failed forever.
 *
 * RULE: the plan can harvest at most the batch's book stock in those tanks.
 * A count above it is refused with the exact figures: the farm has no fish
 * count-variance ledger, so an unexplained surplus has nowhere truthful to
 * go, and inventing stock to absorb it would falsify the batch's ledger. The
 * operator records the missing stock first (or corrects the count).
 * Within the book stock the quantity is split in proportion to each tank's
 * stock by the largest-remainder method: every tank gets
 * floor(q × stockᵢ / total), and the units the floors leave over go one each to
 * the tanks with the largest fractional parts. A tank with a non-zero
 * fraction has floor < q × stockᵢ / total ≤ stockᵢ, so the extra unit never
 * exceeds its stock, and the shares always sum to exactly q.
 *
 * @module Harvest/Services
 */
import { BadRequestException } from '@nestjs/common';

export interface TankStock {
  tankId: string;
  /** Fish of the plan's batch in this tank (book stock, > 0). */
  quantity: number;
}

export interface TankHarvestShare {
  tankId: string;
  quantity: number;
}

/**
 * Split `requested` fish across `stocks`. Returns only tanks with a non-zero
 * share, in the order of `stocks`. Throws when `requested` exceeds the total
 * book stock or no tank holds the batch.
 */
export function allocateHarvestAcrossTanks(
  stocks: readonly TankStock[],
  requested: number,
): TankHarvestShare[] {
  const total = stocks.reduce((sum, stock) => sum + stock.quantity, 0);
  if (total <= 0) {
    throw new BadRequestException(
      'The batch has no fish in any tank, so there is nothing to harvest against this plan.',
    );
  }
  if (requested > total) {
    throw new BadRequestException(
      `Counted harvest quantity ${requested} exceeds the batch's book stock of ${total} ` +
        `across ${stocks.length} tank(s). Record the missing stock or correct the count before ` +
        'completing the plan.',
    );
  }

  const entries = stocks.map((stock, index) => {
    const exactShare = (requested * stock.quantity) / total;
    const quantity = Math.floor(exactShare);
    return { index, tankId: stock.tankId, quantity, fraction: exactShare - quantity };
  });
  let leftover = requested - entries.reduce((sum, entry) => sum + entry.quantity, 0);
  const byFraction = [...entries].sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const entry of byFraction) {
    if (leftover <= 0) break;
    if (entry.fraction <= 0) continue;
    entry.quantity += 1;
    leftover -= 1;
  }

  return entries
    .filter((entry) => entry.quantity > 0)
    .map((entry) => ({ tankId: entry.tankId, quantity: entry.quantity }));
}
