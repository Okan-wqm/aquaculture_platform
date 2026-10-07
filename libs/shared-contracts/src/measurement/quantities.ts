/**
 * Measured quantities — ONE owner for what a sensor channel measures, in which
 * unit and on which basis, and which device spellings name it.
 *
 * WHY: the same vocabulary was kept in several places that had drifted apart —
 * the reading-parameter alias map (event-contracts), the sensor parameter
 * catalog (units and ranges), the AI sensor tool's unit guesses and the farm
 * water-quality templates. They disagreed on spellings (`mg/L CaCO₃` vs
 * `mg/L CaCO3`, pH as `''` vs `pH`), on which keys exist (`waterlevel` was
 * readable but not registrable), and on units (`pressure` hPa vs bar).
 *
 * Basis matters as much as unit. 1 mg/L "ammonia" can be un-ionized NH3-N,
 * ammonium or total ammonia nitrogen; 1 mg/L "nitrite" can be NO2⁻ or NO2-N
 * (3.3×). Two shapes cover what a key can say:
 *
 *   - a key that names a QUANTITY (`tan`, `ph`). If devices commonly report a
 *     different quantity under the same key (an optode's `do` in % saturation,
 *     a lab's `sulfide` as S), those are its `alternates`, and the operator may
 *     declare one of them instead;
 *   - a key that names a FAMILY (`ammonia`, `nitrite`) and does not say which
 *     member: it has no quantity until the operator declares one.
 *
 * The flat SensorReading event carries nine parameters; which one a reading
 * lands on is a property of the quantity or family (`readingParameter`), so
 * two spellings of one quantity cannot disagree on it.
 *
 * Every other copy derives from these tables: event-contracts' channel-key →
 * reading-parameter projection, the sensor catalog's units, the AI tool's unit
 * guesses, the farm templates' units. Zero dependencies, `as const` tables
 * (shared-contracts declares no enums).
 */

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

interface QuantityDefinition {
  readonly id: string;
  readonly unit: string;
  /** Unit strings accepted as input for this quantity; the canonical unit first. */
  readonly spellings: readonly string[];
  readonly basis: string | null;
  /** The flat reading-event parameter a value of this quantity lands on. */
  readonly readingParameter?: ReadingParameter;
}

const MG_L = ['mg/L', 'mg/l', 'ppm'] as const;
const UG_L = ['µg/L', 'μg/L', 'ug/L', 'ppb'] as const;
const CACO3 = ['mg/L CaCO3', 'mg/L CaCO₃', 'mg/L as CaCO3'] as const;
const US_CM = ['µS/cm', 'μS/cm', 'uS/cm'] as const;

/** Every quantity a channel can measure, with its canonical unit and accepted spellings. */
export const MEASURED_QUANTITIES = [
  {
    id: 'temperature',
    unit: '°C',
    spellings: ['°C', 'C', 'degC', '℃'],
    basis: null,
    readingParameter: 'temperature',
  },
  {
    id: 'ph',
    unit: 'pH',
    spellings: ['pH', 'ph', 'NBS', ''],
    basis: 'NBS scale',
    readingParameter: 'ph',
  },
  {
    id: 'dissolvedOxygen',
    unit: 'mg/L',
    spellings: MG_L,
    basis: 'as O2',
    readingParameter: 'dissolvedOxygen',
  },
  { id: 'oxygenSaturation', unit: '%', spellings: ['%'], basis: 'of air saturation' },
  {
    id: 'salinity',
    unit: 'ppt',
    spellings: ['ppt', '‰', 'g/kg', 'psu', 'PSU'],
    basis: null,
    readingParameter: 'salinity',
  },
  { id: 'conductivity', unit: 'µS/cm', spellings: US_CM, basis: 'at sample temperature' },
  {
    id: 'specificConductance',
    unit: 'µS/cm',
    spellings: US_CM,
    basis: 'compensated to 25 °C',
  },
  { id: 'tan', unit: 'mg/L', spellings: MG_L, basis: 'total ammonia as N' },
  { id: 'nh3', unit: 'mg/L', spellings: MG_L, basis: 'un-ionized ammonia as N' },
  { id: 'nh4', unit: 'mg/L', spellings: MG_L, basis: 'ammonium as N' },
  { id: 'nh4Ion', unit: 'mg/L', spellings: MG_L, basis: 'ammonium as NH4+' },
  { id: 'nitriteN', unit: 'mg/L', spellings: MG_L, basis: 'nitrite as N' },
  { id: 'nitriteIon', unit: 'mg/L', spellings: MG_L, basis: 'nitrite as NO2-' },
  { id: 'nitrateN', unit: 'mg/L', spellings: MG_L, basis: 'nitrate as N' },
  { id: 'nitrateIon', unit: 'mg/L', spellings: MG_L, basis: 'nitrate as NO3-' },
  { id: 'h2s', unit: 'µg/L', spellings: UG_L, basis: 'as H2S' },
  { id: 'totalSulfide', unit: 'µg/L', spellings: UG_L, basis: 'total sulfide as H2S' },
  { id: 'totalSulfideAsS', unit: 'µg/L', spellings: UG_L, basis: 'total sulfide as S' },
  { id: 'alkalinity', unit: 'mg/L CaCO3', spellings: CACO3, basis: 'as CaCO3' },
  { id: 'calcium', unit: 'mg/L', spellings: MG_L, basis: 'as Ca' },
  { id: 'hardness', unit: 'mg/L CaCO3', spellings: CACO3, basis: 'total hardness as CaCO3' },
  { id: 'co2', unit: 'mg/L', spellings: MG_L, basis: 'dissolved, as CO2' },
  {
    id: 'turbidity',
    unit: 'NTU',
    spellings: ['NTU'],
    basis: null,
    readingParameter: 'turbidity',
  },
  {
    id: 'waterLevel',
    unit: 'cm',
    spellings: ['cm'],
    basis: null,
    readingParameter: 'waterLevel',
  },
  { id: 'flowRate', unit: 'L/min', spellings: ['L/min', 'l/min'], basis: null },
  { id: 'pressure', unit: 'bar', spellings: ['bar'], basis: 'line pressure' },
  { id: 'barometricPressure', unit: 'hPa', spellings: ['hPa', 'mbar'], basis: 'atmospheric' },
  { id: 'orp', unit: 'mV', spellings: ['mV'], basis: null },
  { id: 'tds', unit: 'ppm', spellings: ['ppm', 'mg/L', 'mg/l'], basis: null },
  { id: 'chlorine', unit: 'mg/L', spellings: MG_L, basis: 'free chlorine as Cl2' },
  { id: 'chloride', unit: 'mg/L', spellings: MG_L, basis: 'as Cl-' },
  { id: 'ozone', unit: 'mg/L', spellings: MG_L, basis: 'as O3' },
  { id: 'humidity', unit: '%', spellings: ['%'], basis: 'relative humidity' },
  { id: 'batteryLevel', unit: '%', spellings: ['%'], basis: null },
  { id: 'signalStrength', unit: 'dBm', spellings: ['dBm'], basis: null },
] as const satisfies readonly QuantityDefinition[];

export type MeasuredQuantity = (typeof MEASURED_QUANTITIES)[number];
export type QuantityId = MeasuredQuantity['id'];

interface FamilyDefinition {
  readonly members: readonly QuantityId[];
  readonly readingParameter?: ReadingParameter;
}

/**
 * Families of quantities a channel key can name without saying which: the
 * operator declares the member before the channel feeds a basis-dependent
 * calculation. Members share one unit, so a family key still has a unit.
 */
export const QUANTITY_FAMILIES = {
  ammonia: { members: ['tan', 'nh3', 'nh4', 'nh4Ion'], readingParameter: 'ammonia' },
  nitrite: { members: ['nitriteN', 'nitriteIon'], readingParameter: 'nitrite' },
  nitrate: { members: ['nitrateN', 'nitrateIon'], readingParameter: 'nitrate' },
} as const satisfies Record<string, FamilyDefinition>;

export type QuantityFamily = keyof typeof QUANTITY_FAMILIES;

/**
 * What a (lowercased) channel key names: a quantity — with the quantities
 * devices also report under that key, which an operator may declare instead —
 * or a family whose member the operator declares.
 */
export type ChannelKeyMeaning =
  | {
      readonly quantity: QuantityId;
      readonly alternates?: readonly QuantityId[];
      readonly family?: never;
    }
  | {
      readonly quantity?: never;
      readonly alternates?: never;
      readonly family: QuantityFamily;
    };

const OXYGEN = { quantity: 'dissolvedOxygen', alternates: ['oxygenSaturation'] } as const;
const CONDUCTIVITY = { quantity: 'conductivity', alternates: ['specificConductance'] } as const;
const SULFIDE = { quantity: 'totalSulfide', alternates: ['totalSulfideAsS'] } as const;

export const CHANNEL_KEYS = {
  temperature: { quantity: 'temperature' },
  temp: { quantity: 'temperature' },
  water_temperature: { quantity: 'temperature' },
  water_temp: { quantity: 'temperature' },
  ph: { quantity: 'ph' },
  ph_level: { quantity: 'ph' },
  dissolved_oxygen: OXYGEN,
  dissolvedoxygen: OXYGEN,
  do: OXYGEN,
  do_level: OXYGEN,
  oxygen: OXYGEN,
  o2: OXYGEN,
  oxygen_saturation: { quantity: 'oxygenSaturation' },
  salinity: { quantity: 'salinity' },
  salt: { quantity: 'salinity' },
  ammonia: { family: 'ammonia' },
  nh3: { family: 'ammonia' },
  nh4: { quantity: 'nh4', alternates: ['nh4Ion'] },
  total_ammonia: { quantity: 'tan' },
  total_ammonia_nitrogen: { quantity: 'tan' },
  tan: { quantity: 'tan' },
  nitrite: { family: 'nitrite' },
  no2: { family: 'nitrite' },
  nitrate: { family: 'nitrate' },
  no3: { family: 'nitrate' },
  h2s: { quantity: 'h2s' },
  hydrogen_sulfide: { quantity: 'h2s' },
  total_sulfide: SULFIDE,
  sulfide: SULFIDE,
  alkalinity: { quantity: 'alkalinity' },
  calcium: { quantity: 'calcium' },
  hardness: { quantity: 'hardness' },
  co2: { quantity: 'co2' },
  carbon_dioxide: { quantity: 'co2' },
  turbidity: { quantity: 'turbidity' },
  ntu: { quantity: 'turbidity' },
  water_level: { quantity: 'waterLevel' },
  waterlevel: { quantity: 'waterLevel' },
  level: { quantity: 'waterLevel' },
  flow_rate: { quantity: 'flowRate' },
  flow: { quantity: 'flowRate' },
  pressure: { quantity: 'pressure', alternates: ['barometricPressure'] },
  conductivity: CONDUCTIVITY,
  ec: CONDUCTIVITY,
  orp: { quantity: 'orp' },
  redox: { quantity: 'orp' },
  tds: { quantity: 'tds' },
  chlorine: { quantity: 'chlorine' },
  cl: { quantity: 'chlorine', alternates: ['chloride'] },
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

/** The quantities an operator may declare for a channel with this key. */
export function declarableQuantities(channelKey: string): readonly QuantityId[] {
  const meaning = channelKeyMeaning(channelKey);
  if (meaning === undefined) {
    return MEASURED_QUANTITIES.map((quantity) => quantity.id);
  }
  if (meaning.family !== undefined) {
    return QUANTITY_FAMILIES[meaning.family].members;
  }
  return [meaning.quantity, ...(meaning.alternates ?? [])];
}

/**
 * The quantity a channel measures: what its operator declared, else what its
 * key names. Null when the key names a family and nothing was declared, when a
 * declaration is not one the key allows, or when the key is unknown and
 * nothing was declared — such a channel cannot feed a basis-dependent input.
 */
export function effectiveQuantity(
  channelKey: string,
  declared?: QuantityId | null,
): QuantityId | null {
  if (declared) {
    return declarableQuantities(channelKey).includes(declared) ? declared : null;
  }
  return channelKeyMeaning(channelKey)?.quantity ?? null;
}

/**
 * The flat reading-event parameter a channel with this key lands on, from its
 * key alone (the event does not carry declarations): its quantity's or its
 * family's. Undefined for keys the event cannot carry.
 */
export function readingParameterOfChannelKey(channelKey: string): ReadingParameter | undefined {
  const meaning = channelKeyMeaning(channelKey);
  if (meaning === undefined) {
    return undefined;
  }
  if (meaning.family !== undefined) {
    return QUANTITY_FAMILIES[meaning.family].readingParameter;
  }
  const quantity: QuantityDefinition = measuredQuantity(meaning.quantity);
  return quantity.readingParameter;
}

/**
 * The unit a channel key reads in: its quantity's unit, or for a family the
 * unit every member shares (the registry spec refuses a family whose members
 * disagree on unit).
 */
export function channelKeyUnit(channelKey: string): string | undefined {
  const meaning = channelKeyMeaning(channelKey);
  if (meaning === undefined) {
    return undefined;
  }
  if (meaning.family === undefined) {
    return measuredQuantity(meaning.quantity).unit;
  }
  return measuredQuantity(QUANTITY_FAMILIES[meaning.family].members[0]).unit;
}

/** Whether `unit` is an accepted spelling of the quantity's unit. */
export function isAcceptedUnit(id: QuantityId, unit: string): boolean {
  const spellings: readonly string[] = measuredQuantity(id).spellings;
  return spellings.includes(unit.trim());
}
