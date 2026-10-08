import {
  MEASURED_QUANTITIES,
  QUANTITY_FAMILIES,
  measuredQuantity,
  type ChannelKeyMeaning,
  type QuantityFamily,
  type QuantityId,
} from '@aquaculture/shared-contracts';

/**
 * Which measured quantity a farm water-quality parameter code records.
 *
 * The farm's parameter codes are its own vocabulary (they key operator-edited
 * parameter configs), but what they measure, in which unit and on which basis,
 * is the measured-quantity registry's. A code listed here takes its unit from
 * there, so a template or seed cannot spell it differently from a sensor
 * channel measuring the same thing — they had: pH as `''` beside `pH`, and
 * `mg/L CaCO₃` beside `mg/L CaCO3`.
 *
 * A code names a quantity, or a family whose member its config declares — the
 * same two shapes a channel key has (`ChannelKeyMeaning`). `ammonia`,
 * `nitrite` and `nitrate` are families: the farm records them without a basis
 * (labels say NH₃ / NO₂ / NO₃, thresholds fit either the molecule or the N
 * basis, which differ 1.2× to 4.4×), and an undeclared basis must not feed the
 * chemistry. Codes absent here (transparency, BOD, counts, custom ones) keep
 * their own unit and record no quantity until one is declared.
 *
 * A config's effective quantity is persisted (`effectiveQuantity`, so the
 * database keeps one active config per quantity): changing what a listed code
 * means needs a migration re-deriving that column for existing configs, which
 * the pinned table in parameter-quantities.spec.ts reminds.
 */
export const PARAMETER_CODES = {
  temperature: { quantity: 'temperature' },
  ph: { quantity: 'ph' },
  dissolved_oxygen: { quantity: 'dissolvedOxygen' },
  oxygen_saturation: { quantity: 'oxygenSaturation' },
  salinity: { quantity: 'salinity' },
  conductivity: { quantity: 'conductivity', alternates: ['specificConductance'] },
  total_ammonia_nitrogen: { quantity: 'tan' },
  ammonia: { family: 'ammonia' },
  nitrite: { family: 'nitrite' },
  nitrate: { family: 'nitrate' },
  h2s: { quantity: 'h2s' },
  alkalinity: { quantity: 'alkalinity' },
  calcium: { quantity: 'calcium' },
  hardness: { quantity: 'hardness' },
  co2: { quantity: 'co2' },
  turbidity: { quantity: 'turbidity' },
  chlorine: { quantity: 'chlorine' },
  ozone: { quantity: 'ozone' },
} as const satisfies Record<string, ChannelKeyMeaning>;

type ParameterCode = keyof typeof PARAMETER_CODES;

function isParameterCode(code: string): code is ParameterCode {
  return Object.prototype.hasOwnProperty.call(PARAMETER_CODES, code);
}

/** What a parameter code names, or undefined for a code outside the table. */
export function parameterCodeMeaning(code: string): ChannelKeyMeaning | undefined {
  return isParameterCode(code) ? PARAMETER_CODES[code] : undefined;
}

/** The quantity a parameter code names by itself, or null (a family, or a code no channel measures). */
export function quantityOfParameterCode(code: string): QuantityId | null {
  return parameterCodeMeaning(code)?.quantity ?? null;
}

/** The family a code names without saying which member, or null. */
export function parameterCodeFamily(code: string): QuantityFamily | null {
  return parameterCodeMeaning(code)?.family ?? null;
}

/** The registry unit of a code that records a measured quantity. */
export function unitOfParameterCode(code: string): string {
  const quantity = quantityOfParameterCode(code);
  if (quantity === null) {
    throw new Error(`Parameter code ${code} records no measured quantity; give its unit`);
  }
  return measuredQuantity(quantity).unit;
}

/**
 * The quantities a config with this code may be declared to record: the
 * family's members, the code's quantity and its alternates, or — for a code
 * outside the table — any quantity.
 */
export function declarableQuantitiesOfParameter(code: string): readonly QuantityId[] {
  const meaning = parameterCodeMeaning(code);
  if (meaning === undefined) {
    return MEASURED_QUANTITIES.map((quantity) => quantity.id);
  }
  if (meaning.family !== undefined) {
    return QUANTITY_FAMILIES[meaning.family].members;
  }
  return [meaning.quantity, ...(meaning.alternates ?? [])];
}

/**
 * The quantity a config records: its declaration when the code allows it,
 * else what the code names. Null for a family nobody declared and for a code
 * outside the table with no declaration — such a parameter takes no channel.
 */
export function parameterQuantity(code: string, declared: QuantityId | null): QuantityId | null {
  if (declared !== null) {
    return declarableQuantitiesOfParameter(code).includes(declared) ? declared : null;
  }
  return quantityOfParameterCode(code);
}
