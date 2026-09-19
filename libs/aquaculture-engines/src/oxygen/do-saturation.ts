/**
 * Dissolved-oxygen saturation and oxygen demand — the shared formulas behind
 * the oxygen budget, carrying capacity and feeding-impact engines.
 *
 * REFERENCES
 *   - DO saturation: Weiss (1970), Deep-Sea Research 17:721-735
 *   - Unit conversion: Benson & Krause (1984), USGS
 *   - O2 demand coefficients: Colt (2006), Timmons & Ebeling (2013)
 *   - Nitrification stoichiometry: EPA Design Manual (1993)
 */

/**
 * Weiss (1970) DO saturation (mg/L) at 1 atm.
 *
 *   T = tempC + 273.15
 *   ln(DO_sat) = A1 + A2·(100/T) + A3·ln(T/100) + A4·(T/100)
 *              + S·[B1 + B2·(T/100) + B3·(T/100)²]
 *
 * Coefficients (Weiss 1970, Table 1): A1=-173.4292, A2=249.6339,
 * A3=143.3483, A4=-21.8492, B1=-0.033096, B2=0.014259, B3=-0.001700.
 * The equation yields mL(STP)/L; ×1.42903 converts to mg/L.
 */
export function doSaturationWeiss(tempC: number, salinityPpt = 0): number {
  const T = tempC + 273.15;
  const T100 = T / 100;
  const lnDoSat =
    -173.4292 +
    249.6339 * (100 / T) +
    143.3483 * Math.log(T100) +
    -21.8492 * T100 +
    salinityPpt * (-0.033096 + 0.014259 * T100 + -0.0017 * T100 * T100);
  return Math.exp(lnDoSat) * 1.42903;
}

/** kg O2 consumed per kg of feed (fish respiration, organic decomposition) and per kg TAN nitrified. */
export const O2_DEMAND_COEFFICIENTS = Object.freeze({
  /** Fish respiration: kg O2 per kg feed. */
  fishPerKgFeed: 0.35,
  /** Organic decomposition of uneaten feed / faeces: kg O2 per kg feed. */
  organicPerKgFeed: 0.1,
  /** Nitrification: kg O2 per kg TAN oxidised (4.57 stoichiometric). */
  nitrificationPerKgTan: 4.57,
  /** Fallback TAN yield when none is supplied: kg TAN per kg feed. */
  defaultTanPerKgFeed: 0.01,
});

export interface O2DemandInput {
  dailyFeedKg: number;
  /** TAN load to the biofilter (kg/day); defaults to `defaultTanPerKgFeed × feed`. */
  tanKg?: number;
  hasBiofilter?: boolean;
}

export interface O2Demand {
  fishKgPerDay: number;
  biofilterKgPerDay: number;
  organicKgPerDay: number;
  totalKgPerDay: number;
}

/** Daily oxygen demand (kg O2/day) split by source. */
export function o2Demand(input: O2DemandInput): O2Demand {
  const { dailyFeedKg, hasBiofilter = false } = input;
  const c = O2_DEMAND_COEFFICIENTS;
  const fishKgPerDay = dailyFeedKg * c.fishPerKgFeed;
  const organicKgPerDay = dailyFeedKg * c.organicPerKgFeed;
  const tanKg = input.tanKg ?? dailyFeedKg * c.defaultTanPerKgFeed;
  const biofilterKgPerDay = hasBiofilter ? tanKg * c.nitrificationPerKgTan : 0;
  return {
    fishKgPerDay,
    biofilterKgPerDay,
    organicKgPerDay,
    totalKgPerDay: fishKgPerDay + biofilterKgPerDay + organicKgPerDay,
  };
}

/** Uniform consumption rate (mg/L/h) of a daily demand in a tank volume. */
export function o2ConsumptionRateMgLPerHour(totalKgPerDay: number, tankVolumeM3: number): number {
  return (totalKgPerDay * 1_000_000) / (24 * tankVolumeM3 * 1000);
}
