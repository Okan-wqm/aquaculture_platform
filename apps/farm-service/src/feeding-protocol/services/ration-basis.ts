/**
 * RationBasisKg — the biomass a day's ration is priced from.
 *
 * WHY this is a nominal type instead of a plain number: the day's ration used to
 * be recomputed from `TankBatch.totalBiomassKg` on every intra-day recalculation.
 * In `per_meal` growth mode finalising a meal writes FCR-projected growth into
 * that very column, so the next recalculation priced the day from a biomass the
 * day's own feed had just inflated: the morning meal enlarged the noon meal,
 * which enlarged the evening meal, and the day's total silently exceeded the rate
 * the protocol prescribed at 06:00 — every day, once per meal. It is also
 * biologically false; a fish does not convert feed to flesh at the moment of
 * eating.
 *
 * WHAT the basis means: the ration is anchored to the biomass at the START of the
 * day and moves ONLY for reasons that are not the day's own feed —
 *   • fish physically entering or leaving the unit (stocking, mortality, cull,
 *     transfer, harvest and its reversal, ledger reconciliation) shift it by the
 *     signed biomass they carry, and
 *   • a weighing re-baselines it, because a measurement supersedes the model.
 * FCR-projected growth has NO constructor here, so it cannot reach the basis:
 * `dailyRationKg` accepts nothing but a `RationBasisKg`, and a bare
 * `tankBatch.totalBiomassKg` is a compile error at that call. That is the whole
 * enforcement — the compounding is not merely "not done", it is unsayable.
 *
 * The same brand discipline as `BandWeightG` in `protocol-rate.service`.
 *
 * @module FeedingProtocol/Services
 */

/** Biomass (kg) a day's ration is priced from. Constructors below only. */
export type RationBasisKg = number & { readonly __brand: 'RationBasisKg' };

/**
 * The basis a freshly generated day plan starts from: the unit's production
 * biomass at generation time (06:00, or an on-demand regenerate). Identical to
 * `DayPlanSnapshot.biomassKg` by construction — the snapshot records what was
 * read, this column records what the ration is priced from, and they part ways
 * only once the day's stock actually moves.
 */
export function initialRationBasisKg(startOfDayBiomassKg: number): RationBasisKg {
  return round3(Math.max(0, startOfDayBiomassKg)) as RationBasisKg;
}

/**
 * Fish entered or left the unit: the basis moves by the biomass they carried.
 * The signed delta comes from `TankBatchService.applyStockChange` — the single
 * stock writer — so a stock movement can never be double-counted or missed.
 */
export function shiftRationBasisKg(
  basis: RationBasisKg,
  stockBiomassDeltaKg: number,
): RationBasisKg {
  return round3(Math.max(0, basis + stockBiomassDeltaKg)) as RationBasisKg;
}

/**
 * A weighing landed: the measured biomass replaces the basis outright.
 *
 * WHY a measurement is allowed to move the ration while projected growth is not:
 * a weighing is evidence, the FCR projection is the model's own guess. Pricing
 * the rest of the day from a measured weight is exactly the behaviour
 * `reconcileMeasuredWeight` exists for (the tartım→plan link); pricing it from
 * the model's guess is the compounding this module exists to prevent.
 */
export function measuredRationBasisKg(measuredBiomassKg: number): RationBasisKg {
  return round3(Math.max(0, measuredBiomassKg)) as RationBasisKg;
}

/**
 * The basis of a persisted day plan. Plans written before the column existed
 * carry `null` and are anchored to their generation snapshot — the identical
 * value the writer now persists at generation, so the two agree by definition.
 * The migration backfills every existing row from that same expression.
 */
export function dayPlanRationBasisKg(dayPlan: {
  rationBasisKg?: number | string | null;
  snapshot: { biomassKg: number };
}): RationBasisKg {
  const stored = dayPlan.rationBasisKg;
  if (stored === null || stored === undefined) {
    return initialRationBasisKg(Number(dayPlan.snapshot.biomassKg));
  }
  return initialRationBasisKg(Number(stored));
}

/**
 * The day's prescribed ration (kg) — the ONLY place biomass becomes feed.
 *
 * The parameter is `RationBasisKg`, not `number`: pricing a day from a live
 * biomass column (which the day's own feed inflates) does not type-check.
 */
export function dailyRationKg(basis: RationBasisKg, effectiveRatePercent: number): number {
  return round3((basis * effectiveRatePercent) / 100);
}

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
