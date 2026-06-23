// ─── Shared Aquaculture Formulas ─────────────────────────────
// DRY: Weiss DO saturation and O2 consumption from a single source.
//
// REFERENCES:
//   - DO saturation: Weiss (1970) — Deep-Sea Research 17:721-735
//   - Unit conversion: Benson & Krause (1984), USGS
//   - O2 consumption coefficients: Colt (2006), Timmons & Ebeling (2013)
//   - Nitrification stoichiometry: EPA Design Manual (1993)
// ─────────────────────────────────────────────────────────────

/**
 * Weiss (1970) DO Saturation Calculation.
 *
 * Formula:
 *   T = tempC + 273.15 (Kelvin)
 *   ln(DO_sat) = A1 + A2*(100/T) + A3*ln(T/100) + A4*(T/100)
 *              + S * [B1 + B2*(T/100) + B3*(T/100)^2]
 *
 * Weiss (1970) coefficients (Table 1):
 *   A1=-173.4292, A2=249.6339, A3=143.3483, A4=-21.8492
 *   B1=-0.033096, B2=0.014259, B3=-0.001700
 *
 * Unit conversion: x 1.42903 (mL(STP)/L -> mg/L, O2 STP density)
 *
 * @param tempC - Temperature (C)
 * @param salinity - Salinity (ppt), default: 0
 * @returns DO saturation (mg/L)
 */
export function calcDOSaturation(tempC: number, salinity = 0): number {
  const T = tempC + 273.15;
  const T100 = T / 100;

  const lnDOsat =
    -173.4292 +
    249.6339 * (100 / T) +
    143.3483 * Math.log(T100) +
    -21.8492 * T100 +
    salinity * (-0.033096 + 0.014259 * T100 + -0.001700 * T100 * T100);

  // Weiss formula yields mL(STP)/L; multiply by 1.42903 for mg/L
  return Math.exp(lnDOsat) * 1.42903;
}

export interface O2ConsumptionParams {
  dailyFeedKg: number;
  tanKg?: number;
  hasBiofilter?: boolean;
}

export interface O2ConsumptionResult {
  fishO2: number;
  biofilterO2: number;
  organicO2: number;
  totalO2: number;
}

/**
 * O2 Consumption Calculation.
 *
 * Three sources of oxygen demand:
 *   A) Fish respiration:         dailyFeedKg * 0.35 kg O2
 *   B) Biofilter nitrification:  tanKg * 4.57 kg O2 (if hasBiofilter)
 *   C) Organic decomposition:    dailyFeedKg * 0.10 kg O2
 *
 * When tanKg is not provided, it defaults to dailyFeedKg * 0.01
 * (general TAN coefficient for biofilter O2 calculation).
 *
 * @returns O2 demands (kg/day): fishO2, biofilterO2, organicO2, totalO2
 */
export function calcO2Consumption(params: O2ConsumptionParams): O2ConsumptionResult {
  const { dailyFeedKg, hasBiofilter = false } = params;

  const fishO2 = dailyFeedKg * 0.35;
  const organicO2 = dailyFeedKg * 0.10;

  const tanKg = params.tanKg ?? dailyFeedKg * 0.01;
  const biofilterO2 = hasBiofilter ? tanKg * 4.57 : 0;

  const totalO2 = fishO2 + biofilterO2 + organicO2;

  return { fishO2, biofilterO2, organicO2, totalO2 };
}
