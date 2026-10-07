/**
 * Measured quantities — ONE owner for what a sensor channel measures, in which
 * unit and on which basis, and which device spellings name it.
 *
 * WHY: the same vocabulary was kept in five places that had drifted apart —
 * the reading-parameter alias map (event-contracts), the sensor parameter
 * catalog (units and ranges), the farm water-quality templates, the farm
 * measurement columns and the water-chemistry mock. They disagreed on spellings
 * (`mg/L CaCO₃` vs `mg/L CaCO3`, pH as `''` vs `pH`), on which keys exist
 * (`waterlevel` was readable but not registrable), and on basis: hydrogen
 * sulfide was µg/L in one place and mg/L in another, a factor of 1000.
 *
 * Basis matters as much as unit. 1 mg/L "ammonia" can mean un-ionized NH3-N,
 * NH4-N or total ammonia nitrogen (TAN) — and a probe vendor's "NH3-N" is often
 * TAN by method. A channel whose key does not say which (`ammonia`, `nh3`)
 * belongs to a family, not a quantity: the operator declares the basis before
 * the channel can feed a calculation that depends on it.
 *
 * Every other copy derives from these tables: event-contracts' channel-key →
 * reading-parameter map, the sensor catalog's units, the farm templates' units.
 * Zero dependencies, `as const` tables (shared-contracts declares no enums).
 */

/** Every quantity a channel can measure, with its canonical unit and accepted spellings. */
export const MEASURED_QUANTITIES = [
  { id: 'temperature', unit: '°C', spellings: ['°C', 'C', 'degC', '℃'], basis: null },
  { id: 'ph', unit: 'pH', spellings: ['pH', 'ph', ''], basis: 'NBS scale' },
  { id: 'dissolvedOxygen', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: 'as O2' },
  { id: 'oxygenSaturation', unit: '%', spellings: ['%'], basis: 'of air saturation' },
  { id: 'salinity', unit: 'ppt', spellings: ['ppt', '‰', 'g/kg', 'psu', 'PSU'], basis: null },
  {
    id: 'conductivity',
    unit: 'µS/cm',
    spellings: ['µS/cm', 'μS/cm', 'uS/cm'],
    basis: 'not temperature-compensated unless the device says so',
  },
  { id: 'tan', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: 'total ammonia as N' },
  { id: 'nh3', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: 'un-ionized ammonia as N' },
  { id: 'nh4', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: 'ammonium as N' },
  { id: 'nitrite', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: null },
  { id: 'nitrate', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: null },
  { id: 'h2s', unit: 'µg/L', spellings: ['µg/L', 'μg/L', 'ug/L', 'ppb'], basis: 'as H2S' },
  {
    id: 'totalSulfide',
    unit: 'µg/L',
    spellings: ['µg/L', 'μg/L', 'ug/L', 'ppb'],
    basis: 'total sulfide as H2S',
  },
  {
    id: 'alkalinity',
    unit: 'mg/L CaCO3',
    spellings: ['mg/L CaCO3', 'mg/L CaCO₃', 'mg/L as CaCO3'],
    basis: 'as CaCO3',
  },
  { id: 'calcium', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: 'as Ca' },
  {
    id: 'hardness',
    unit: 'mg/L CaCO3',
    spellings: ['mg/L CaCO3', 'mg/L CaCO₃', 'mg/L as CaCO3'],
    basis: 'total hardness as CaCO3',
  },
  { id: 'co2', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: 'as CO2' },
  { id: 'turbidity', unit: 'NTU', spellings: ['NTU'], basis: null },
  { id: 'waterLevel', unit: 'cm', spellings: ['cm'], basis: null },
  { id: 'flowRate', unit: 'L/min', spellings: ['L/min', 'l/min'], basis: null },
  { id: 'pressure', unit: 'bar', spellings: ['bar'], basis: null },
  { id: 'orp', unit: 'mV', spellings: ['mV'], basis: null },
  { id: 'tds', unit: 'ppm', spellings: ['ppm', 'mg/L', 'mg/l'], basis: null },
  { id: 'chlorine', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: 'as Cl2' },
  { id: 'ozone', unit: 'mg/L', spellings: ['mg/L', 'mg/l', 'ppm'], basis: 'as O3' },
  { id: 'humidity', unit: '%', spellings: ['%'], basis: 'relative humidity' },
  { id: 'batteryLevel', unit: '%', spellings: ['%'], basis: null },
  { id: 'signalStrength', unit: 'dBm', spellings: ['dBm'], basis: null },
] as const;

export type QuantityId = (typeof MEASURED_QUANTITIES)[number]['id'];
export type MeasuredQuantity = (typeof MEASURED_QUANTITIES)[number];

/**
 * A family of quantities a channel key can name without saying which: the
 * operator declares the member before the channel feeds a basis-dependent
 * calculation.
 */
export const QUANTITY_FAMILIES = {
  ammonia: ['tan', 'nh3', 'nh4'],
} as const satisfies Record<string, readonly QuantityId[]>;

export type QuantityFamily = keyof typeof QUANTITY_FAMILIES;

/** The nine parameters the flat SensorReading event carries (its wire vocabulary). */
export type ReadingParameter =
  | 'temperature'
  | 'ph'
  | 'dissolvedOxygen'
  | 'salinity'
  | 'ammonia'
  | 'nitrite'
  | 'nitrate'
  | 'turbidity'
  | 'waterLevel';

/**
 * What a (lowercased) channel key names: a quantity, or a family whose member
 * the operator declares; and, for keys the flat reading event carries, that
 * reading parameter. Devices name the same thing many ways, so several keys
 * name one quantity.
 */
export type ChannelKeyMeaning =
  | {
      readonly quantity: QuantityId;
      readonly family?: never;
      readonly readingParameter?: ReadingParameter;
    }
  | {
      readonly quantity?: never;
      readonly family: QuantityFamily;
      readonly readingParameter?: ReadingParameter;
    };

export const CHANNEL_KEYS = {
  temperature: { quantity: 'temperature', readingParameter: 'temperature' },
  temp: { quantity: 'temperature', readingParameter: 'temperature' },
  water_temperature: { quantity: 'temperature', readingParameter: 'temperature' },
  water_temp: { quantity: 'temperature', readingParameter: 'temperature' },
  ph: { quantity: 'ph', readingParameter: 'ph' },
  ph_level: { quantity: 'ph', readingParameter: 'ph' },
  dissolved_oxygen: { quantity: 'dissolvedOxygen', readingParameter: 'dissolvedOxygen' },
  dissolvedoxygen: { quantity: 'dissolvedOxygen', readingParameter: 'dissolvedOxygen' },
  do: { quantity: 'dissolvedOxygen', readingParameter: 'dissolvedOxygen' },
  do_level: { quantity: 'dissolvedOxygen', readingParameter: 'dissolvedOxygen' },
  oxygen: { quantity: 'dissolvedOxygen', readingParameter: 'dissolvedOxygen' },
  o2: { quantity: 'dissolvedOxygen', readingParameter: 'dissolvedOxygen' },
  oxygen_saturation: { quantity: 'oxygenSaturation' },
  salinity: { quantity: 'salinity', readingParameter: 'salinity' },
  salt: { quantity: 'salinity', readingParameter: 'salinity' },
  // The reading event has one "ammonia" field; which ammonia a key means is
  // not in the key, so these two belong to the family and are declared.
  ammonia: { family: 'ammonia', readingParameter: 'ammonia' },
  nh3: { family: 'ammonia', readingParameter: 'ammonia' },
  nh4: { quantity: 'nh4' },
  total_ammonia: { quantity: 'tan' },
  total_ammonia_nitrogen: { quantity: 'tan' },
  tan: { quantity: 'tan' },
  nitrite: { quantity: 'nitrite', readingParameter: 'nitrite' },
  no2: { quantity: 'nitrite', readingParameter: 'nitrite' },
  nitrate: { quantity: 'nitrate', readingParameter: 'nitrate' },
  no3: { quantity: 'nitrate', readingParameter: 'nitrate' },
  h2s: { quantity: 'h2s' },
  hydrogen_sulfide: { quantity: 'h2s' },
  total_sulfide: { quantity: 'totalSulfide' },
  sulfide: { quantity: 'totalSulfide' },
  alkalinity: { quantity: 'alkalinity' },
  calcium: { quantity: 'calcium' },
  ca: { quantity: 'calcium' },
  hardness: { quantity: 'hardness' },
  co2: { quantity: 'co2' },
  carbon_dioxide: { quantity: 'co2' },
  turbidity: { quantity: 'turbidity', readingParameter: 'turbidity' },
  ntu: { quantity: 'turbidity', readingParameter: 'turbidity' },
  water_level: { quantity: 'waterLevel', readingParameter: 'waterLevel' },
  waterlevel: { quantity: 'waterLevel', readingParameter: 'waterLevel' },
  level: { quantity: 'waterLevel', readingParameter: 'waterLevel' },
  flow_rate: { quantity: 'flowRate' },
  flow: { quantity: 'flowRate' },
  pressure: { quantity: 'pressure' },
  conductivity: { quantity: 'conductivity' },
  ec: { quantity: 'conductivity' },
  orp: { quantity: 'orp' },
  redox: { quantity: 'orp' },
  tds: { quantity: 'tds' },
  chlorine: { quantity: 'chlorine' },
  cl: { quantity: 'chlorine' },
  ozone: { quantity: 'ozone' },
  humidity: { quantity: 'humidity' },
  battery: { quantity: 'batteryLevel' },
  battery_level: { quantity: 'batteryLevel' },
  rssi: { quantity: 'signalStrength' },
  signal: { quantity: 'signalStrength' },
} as const satisfies Record<string, ChannelKeyMeaning>;

export type KnownChannelKey = keyof typeof CHANNEL_KEYS;

/** A quantity by id; the table is the whole of the lookup. */
export function measuredQuantity(id: QuantityId): MeasuredQuantity {
  const quantity = MEASURED_QUANTITIES.find((candidate) => candidate.id === id);
  if (quantity === undefined) {
    throw new Error(`Unknown measured quantity: ${id}`);
  }
  return quantity;
}

/** A quantity id from untrusted input (a stored declaration, a GraphQL string), or null. */
export function parseQuantityId(value: unknown): QuantityId | null {
  return MEASURED_QUANTITIES.find((candidate) => candidate.id === value)?.id ?? null;
}

function isKnownChannelKey(key: string): key is KnownChannelKey {
  return Object.prototype.hasOwnProperty.call(CHANNEL_KEYS, key);
}

/** What a channel key names, or undefined for a key outside the vocabulary. */
export function channelKeyMeaning(channelKey: string): ChannelKeyMeaning | undefined {
  const key = channelKey.toLowerCase();
  return isKnownChannelKey(key) ? CHANNEL_KEYS[key] : undefined;
}

/**
 * The quantity a channel measures: what its operator declared, else what its
 * key names. Null when the key names a family and nothing was declared, or a
 * declaration is not a member of the key's family, or the key is unknown and
 * nothing was declared — such a channel cannot feed a basis-dependent input.
 */
export function effectiveQuantity(
  channelKey: string,
  declared?: QuantityId | null,
): QuantityId | null {
  const meaning = channelKeyMeaning(channelKey);
  if (declared) {
    if (meaning?.family === undefined) {
      return meaning?.quantity === undefined || meaning.quantity === declared ? declared : null;
    }
    const members: readonly QuantityId[] = QUANTITY_FAMILIES[meaning.family];
    return members.includes(declared) ? declared : null;
  }
  return meaning?.quantity ?? null;
}

/**
 * The unit a channel key reads in: its quantity's unit, or for a family the
 * unit every member shares (a family whose members disagree on unit cannot be
 * named by one key, and the registry spec refuses one).
 */
export function channelKeyUnit(channelKey: string): string | undefined {
  const meaning = channelKeyMeaning(channelKey);
  if (meaning === undefined) {
    return undefined;
  }
  if (meaning.family === undefined) {
    return measuredQuantity(meaning.quantity).unit;
  }
  return measuredQuantity(QUANTITY_FAMILIES[meaning.family][0]).unit;
}

/** Whether `unit` is an accepted spelling of the quantity's unit. */
export function isAcceptedUnit(id: QuantityId, unit: string): boolean {
  const spellings: readonly string[] = measuredQuantity(id).spellings;
  return spellings.includes(unit.trim());
}
