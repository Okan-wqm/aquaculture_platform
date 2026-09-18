/**
 * Decimal rounding SSoT for farm-service (FARM-LOW-295).
 *
 * ## Why this lives in `common/utils/` and not in a domain directory
 *
 * The same 3-decimal rounding was copied across the codebase. The first attempt
 * at consolidating it created the util inside `feeding-protocol/services/` and
 * folded in the four copies the finding happened to name — but a `git grep`
 * showed SIX declaration sites at that commit, and a SEVENTH appeared afterwards
 * in `update-feeding-record.handler.ts`. The copies that survived were the ones
 * in OTHER bounded contexts (`batch/`, `feeding/`), because importing a
 * `feeding-protocol/services/` internal from those directories would cross
 * domain boundaries — so the util's own location is what kept the duplication
 * alive. Hoisting it here removes that reason.
 *
 * ## Why one implementation matters
 *
 * These values enter the same reconciliation equations. `plannedTotalKg` is
 * produced by the meal-plan generator and re-derived by the intra-day recalc;
 * biomass shares are written by the growth applier and summed by the rollup. If
 * two of those rounded through separately-editable functions, the quantities
 * would drift apart silently — no error, just totals that stop reconciling.
 *
 * 3 decimals matches the column precision these fields are stored at
 * (`numeric(12,3)` / `numeric(10,3)`), so rounding here and rounding in Postgres
 * agree.
 *
 * Guarded by `tests/invariants/rounding-ssot.spec.ts`: a local redeclaration
 * fails the build, because a docblock claiming single-source-of-truth is not the
 * same thing as the code having one.
 *
 * @module Common/Utils
 */

/** Canonical 3-decimal rounding for kg / gram fields. */
export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/**
 * Canonical 2-decimal rounding for `numeric(_,2)` quantities.
 *
 * The `Number.EPSILON` term is deliberate and is the reason a shared version
 * matters: without it, a value whose binary representation sits a hair below a
 * .005 boundary rounds down, so two call sites — one with the term, one without
 * — disagree on exactly the inputs that land on a boundary. Four of the five
 * copies this replaced omitted it.
 *
 * NOT for money. Currency is rounded through `Decimal` in the finance module,
 * because float arithmetic must never touch a ledger amount; that operation is
 * named `toMoneyAmount` so it cannot be mistaken for this one.
 */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
