import { measuredQuantity, type QuantityId } from '@aquaculture/shared-contracts';

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
 * `ammonia`, `nitrite` and `nitrate` are absent on purpose: the farm records
 * them without a basis (labels say NH₃ / NO₂ / NO₃, thresholds fit either the
 * molecule or the N basis, which differ 1.2× to 4.4×), and an undeclared basis
 * must not feed the chemistry. Their configs carry a declared quantity once
 * the parameter-config binding lands. Codes absent here (transparency, BOD,
 * counts, …) keep their own unit.
 */
export const PARAMETER_CODE_QUANTITY: Readonly<Record<string, QuantityId>> = {
  temperature: 'temperature',
  ph: 'ph',
  dissolved_oxygen: 'dissolvedOxygen',
  oxygen_saturation: 'oxygenSaturation',
  salinity: 'salinity',
  conductivity: 'conductivity',
  total_ammonia_nitrogen: 'tan',
  h2s: 'h2s',
  alkalinity: 'alkalinity',
  hardness: 'hardness',
  co2: 'co2',
  turbidity: 'turbidity',
  chlorine: 'chlorine',
  ozone: 'ozone',
};

/** The quantity a parameter code records, or null for a code no channel can measure. */
export function quantityOfParameterCode(code: string): QuantityId | null {
  return Object.prototype.hasOwnProperty.call(PARAMETER_CODE_QUANTITY, code)
    ? (PARAMETER_CODE_QUANTITY[code] ?? null)
    : null;
}

/** The registry unit of a code that records a measured quantity. */
export function unitOfParameterCode(code: string): string {
  const quantity = quantityOfParameterCode(code);
  if (quantity === null) {
    throw new Error(`Parameter code ${code} records no measured quantity; give its unit`);
  }
  return measuredQuantity(quantity).unit;
}
