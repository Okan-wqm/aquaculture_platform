/**
 * Farm quantity rounding authority.
 *
 * Kilogram, gram and percentage projections that later reconcile in the same
 * aggregate must use one implementation. These helpers mirror the decimal
 * precision of the governed PostgreSQL numeric columns. Currency remains owned
 * by the finance decimal authority and must never use these float helpers.
 */
export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
