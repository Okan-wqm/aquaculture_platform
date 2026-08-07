/**
 * The farm's shape, from the inventory snapshot — one implementation, two screens.
 *
 * WHY THIS FILE EXISTS. The phone's Reports screen and the cabin board's Reports
 * view answer the same four questions: what does an average fish weigh, how much
 * biomass is standing, how many units are past the watch line, and which pens are
 * closest to consent. A manager reads one of those screens on the handheld
 * walking back from the pens and the other on the wall five minutes later. If the
 * two carried their own copy of the arithmetic they would eventually disagree
 * about the same farm on the same afternoon — the exact failure src/utils/
 * unit-display.ts was written to stop for unit STATUS, one level up at the farm
 * aggregate.
 *
 * So the maths lives here, as a pure function over the tanks the phone already
 * fetches, and both screens render it. No query is issued from this file: the
 * caller passes data it has already decided is real (see the note on `stocked`).
 *
 * WHAT IS DELIBERATELY ABSENT: anything with a time axis. This is a SNAPSHOT —
 * `farmStockInventory` returns today's containers and nothing else. There is no
 * history query on this client, so average weight over 30 days, mortality per
 * bucket and the design's two trend charts cannot be computed from it. Deriving
 * a "trend" from one snapshot would be inventing the history, so both screens say
 * the series is missing rather than drawing one (ORPHAN-MEDIUM-580).
 */
import type { Tank } from '@/types';

/**
 * The ADVISORY watch line, in percent of consent capacity.
 *
 * It is NOT the consent limit. The backend owns that, as
 * `batchMetrics.isOverCapacity`, which fires on density, status AND biomass axes
 * — so a pen blocked on biomass at 60% is over consent while a pen at 92%
 * density may not be. A hardcoded 90 here once meant "at consent limit", which
 * made Reports and Today disagree about the same pen. This constant now only
 * labels the advisory band; `isOverCapacity` is the single definition of at/over.
 */
export const WATCH_AT = 70;

/** How many densest units either screen lists under "Closest to consent". */
const DENSEST_COUNT = 5;

export interface FarmSummary {
  /** Units holding a batch. The farm figures below describe only these. */
  stockedCount: number;
  /** Every unit in the tenant, stocked or not. */
  totalCount: number;
  /** Fish across every batch in every stocked unit. */
  fish: number;
  /** Standing biomass in kilograms. */
  biomassKg: number;
  /**
   * Grams per fish, BIOMASS-WEIGHTED — computed from the two totals rather than
   * averaged per pen. A mean of per-pen means lets a 5k-fish pen pull the farm
   * average as hard as a 100k-fish pen, which is not the number a manager is
   * asking for. Zero when nothing is stocked; callers gate on `stockedCount`.
   */
  avgWeightG: number;
  /** Stocked units at or past the advisory watch line. */
  atWatch: number;
  /** Stocked units the FARM SERVICE flags as over consent. Not a local threshold. */
  atLimit: number;
  /** The five densest stocked units, most-used capacity first. */
  densest: Tank[];
}

/**
 * Summarise the farm from an inventory snapshot.
 *
 * PRECONDITION, and the reason this takes `Tank[]` rather than a query result:
 * the caller must already have established that these tanks are REAL DATA. A
 * failed fetch handed in as `[]` would come back as a summary of zeroes, and a
 * screen rendering "0 units past the watch line" from an outage is the
 * all-clear-nobody-checked defect this app has now found seven times
 * (src/utils/loadable.ts). Both callers therefore reach this only from the
 * `ready` arm of a Loadable.
 *
 * Unit totals (`currentQuantity` / `currentBiomass`) are used throughout, NOT
 * the primary batch's own figures: a mixed pen holds more fish than its primary
 * batch reports, which is what made the farm aggregates too low
 * (ORPHAN-HIGH-585).
 */
export function farmSummary(tanks: readonly Tank[]): FarmSummary {
  const stocked = tanks.filter((tank) => tank.batchMetrics?.batchId);
  const fish = stocked.reduce((total, tank) => total + tank.currentQuantity, 0);
  const biomassKg = stocked.reduce((total, tank) => total + tank.currentBiomass, 0);

  return {
    stockedCount: stocked.length,
    totalCount: tanks.length,
    fish,
    biomassKg,
    avgWeightG: fish > 0 ? (biomassKg * 1000) / fish : 0,
    atWatch: stocked.filter((tank) => capacityOf(tank) >= WATCH_AT).length,
    // The backend flag, the same one Today uses.
    atLimit: stocked.filter((tank) => tank.batchMetrics?.isOverCapacity === true).length,
    densest: stocked
      .slice()
      .sort((a, b) => capacityOf(b) - capacityOf(a))
      .slice(0, DENSEST_COUNT),
  };
}

/**
 * A unit's consent usage for RANKING purposes only.
 *
 * The `?? 0` is a sort key, not a displayed value: `capacityUsedPercent` is null
 * when a unit has no configured consent capacity, and such a unit sorts last
 * rather than being dropped from the list. Neither screen ever PRINTS this
 * fallback — both render the nullable figure through `fixedOrNone()`, which
 * shows an em dash instead of a 0% the farm never stated.
 */
function capacityOf(tank: Tank): number {
  return tank.batchMetrics?.capacityUsedPercent ?? 0;
}
