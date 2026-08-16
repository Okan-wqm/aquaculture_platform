import {
  createWireJsonDocumentV1,
  defineMobileCommandIdentityV1,
  mobileCommandPayloadSha256V1,
  type CanonicalJsonValue,
} from '@aquaculture/shared-contracts';

/** Closed wire vocabulary shared by GraphQL admission, commands, entities and replay codecs. */
export const FEEDING_METHOD = Object.freeze({
  MANUAL: 'manual',
  AUTOMATIC: 'automatic',
  DEMAND: 'demand',
  BROADCAST: 'broadcast',
  SPOT: 'spot',
} as const);

/** GraphQL enum-name projection for the canonical lower-case domain values. */
export const FEEDING_METHOD_GRAPHQL_NAME_V1 = Object.freeze({
  [FEEDING_METHOD.MANUAL]: 'MANUAL',
  [FEEDING_METHOD.AUTOMATIC]: 'AUTOMATIC',
  [FEEDING_METHOD.DEMAND]: 'DEMAND',
  [FEEDING_METHOD.BROADCAST]: 'BROADCAST',
  [FEEDING_METHOD.SPOT]: 'SPOT',
} as const);

export const FEEDING_FISH_APPETITE = Object.freeze({
  EXCELLENT: 'excellent',
  GOOD: 'good',
  MODERATE: 'moderate',
  POOR: 'poor',
  NONE: 'none',
} as const);

export const FEEDING_WEATHER = Object.freeze({
  SUNNY: 'sunny',
  CLOUDY: 'cloudy',
  RAINY: 'rainy',
  STORMY: 'stormy',
} as const);

export const FEEDING_WIND_LEVEL = Object.freeze({
  CALM: 'calm',
  LIGHT: 'light',
  MODERATE: 'moderate',
  STRONG: 'strong',
} as const);

export const FEEDING_VISIBILITY = Object.freeze({
  CLEAR: 'clear',
  TURBID: 'turbid',
  VERY_TURBID: 'very_turbid',
} as const);

export const FEEDING_SURFACE_ACTIVITY = Object.freeze({
  NORMAL: 'normal',
  HIGH: 'high',
  LOW: 'low',
  NONE: 'none',
} as const);

export const FEEDING_SCHOOLING_BEHAVIOR = Object.freeze({
  NORMAL: 'normal',
  SCATTERED: 'scattered',
  TIGHT: 'tight',
} as const);

export const FEEDING_INTENSITY_RANGE = Object.freeze({ minimum: 1, maximum: 10 });
export const FEEDING_WATER_TEMPERATURE_RANGE = Object.freeze({ minimum: -5, maximum: 45 });
export const FEEDING_DISSOLVED_OXYGEN_RANGE = Object.freeze({ minimum: 0, maximum: 20 });

/** Exact client-wire identity of the only mobile meal mutation. */
export const FEEDING_MEAL_MOBILE_COMMAND_V1 = defineMobileCommandIdentityV1('recordMealFeeding');

const FEEDING_MEAL_QUANTITY_DECIMAL_PLACES_V1 = 3;
const FEEDING_MEAL_QUANTITY_SCALE_FACTOR_V1 = 10 ** FEEDING_MEAL_QUANTITY_DECIMAL_PLACES_V1;

/**
 * Versioned meal-quantity authority shared by storage, admission and both UIs.
 * The minimum/step are derived from the persisted numeric scale so those
 * constraints cannot drift independently.
 */
export const FEEDING_MEAL_QUANTITY_POLICY_V1 = Object.freeze({
  schemaVersion: 'feeding-meal-quantity-policy/v1',
  unit: 'kg',
  minimumKg: 1 / FEEDING_MEAL_QUANTITY_SCALE_FACTOR_V1,
  maximumKg: 10_000,
  inputStepKg: 1 / FEEDING_MEAL_QUANTITY_SCALE_FACTOR_V1,
  decimalPlaces: FEEDING_MEAL_QUANTITY_DECIMAL_PLACES_V1,
  storagePrecision: 12,
  storageScale: FEEDING_MEAL_QUANTITY_DECIMAL_PLACES_V1,
} as const);

/** Strict trust-boundary decoder; never silently rounds beyond storage scale. */
export function decodeFeedingMealQuantityKgV1(value: unknown, label = 'meal quantity'): number {
  const policy = FEEDING_MEAL_QUANTITY_POLICY_V1;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < policy.minimumKg ||
    value > policy.maximumKg ||
    Number(value.toFixed(policy.decimalPlaces)) !== value
  ) {
    throw new TypeError(
      `${label} must be between ${policy.minimumKg} and ${policy.maximumKg} kilograms ` +
        `in ${policy.inputStepKg} kilogram increments`,
    );
  }
  return value;
}

type ValueOf<T> = T[keyof T];

export type FeedingMethodValue = ValueOf<typeof FEEDING_METHOD>;
export type FeedingMethodGraphqlNameV1 = ValueOf<typeof FEEDING_METHOD_GRAPHQL_NAME_V1>;
export type FeedingFishAppetite = ValueOf<typeof FEEDING_FISH_APPETITE>;
export type FeedingWeather = ValueOf<typeof FEEDING_WEATHER>;
export type FeedingWindLevel = ValueOf<typeof FEEDING_WIND_LEVEL>;
export type FeedingVisibility = ValueOf<typeof FEEDING_VISIBILITY>;
export type FeedingSurfaceActivity = ValueOf<typeof FEEDING_SURFACE_ACTIVITY>;
export type FeedingSchoolingBehavior = ValueOf<typeof FEEDING_SCHOOLING_BEHAVIOR>;

export interface FeedingRecordEnvironment {
  readonly waterTemp?: number;
  readonly dissolvedOxygen?: number;
  readonly weather?: FeedingWeather;
  readonly windLevel?: FeedingWindLevel;
  readonly visibility?: FeedingVisibility;
}

export interface FeedingRecordFishBehavior {
  readonly appetite: FeedingFishAppetite;
  readonly feedingIntensity: number;
  readonly surfaceActivity?: FeedingSurfaceActivity;
  readonly schoolingBehavior?: FeedingSchoolingBehavior;
  readonly abnormalBehavior?: string;
}

export interface FeedingMealMobilePayloadV1 {
  readonly mealId: string;
  readonly pourKg: number;
  readonly finalize: boolean;
  readonly feedingMethod?: FeedingMethodValue;
  readonly notes?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} is missing a required field`);
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
}

function optionalNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  authority: Record<string, T>,
  label: string,
): T {
  for (const candidate of Object.values(authority)) {
    if (value === candidate) return candidate;
  }
  throw new TypeError(`${label} is invalid`);
}

function optionalEnumValue<T extends string>(
  value: unknown,
  authority: Record<string, T>,
  label: string,
): T | undefined {
  return value === undefined ? undefined : enumValue(value, authority, label);
}

function optionalBoundedString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}

/** Civil-time decoder shared by command admission and result replay. */
export function decodeFeedingRecordTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    throw new TypeError('feedingTime must use HH:mm or HH:mm:ss');
  }
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  const seconds = value.length === 8 ? Number(value.slice(6, 8)) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new TypeError('feedingTime is outside the civil-time range');
  }
  return value;
}

/** ISO-style currency decoder shared by command admission and result replay. */
export function decodeOptionalFeedingCurrency(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new TypeError('currency must be an uppercase ISO-style three-letter code');
  }
  return value;
}

export function feedingMethodGraphqlNameV1(value: FeedingMethodValue): FeedingMethodGraphqlNameV1 {
  return FEEDING_METHOD_GRAPHQL_NAME_V1[value];
}

/**
 * Compiles the exact pre-envelope payload hashed by both browser clients.
 * GraphQL maps enum names to lower-case domain values, so this authority owns
 * the reverse projection instead of duplicating it at every trust boundary.
 */
export function compileFeedingMealMobilePayloadV1(
  input: FeedingMealMobilePayloadV1,
): CanonicalJsonValue {
  return createWireJsonDocumentV1({
    mealId: input.mealId,
    pourKg: decodeFeedingMealQuantityKgV1(input.pourKg, 'mobile meal pourKg'),
    finalize: input.finalize,
    ...(input.feedingMethod === undefined
      ? {}
      : { feedingMethod: feedingMethodGraphqlNameV1(input.feedingMethod) }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  }).value;
}

export function feedingMealMobilePayloadSha256V1(input: FeedingMealMobilePayloadV1): string {
  return mobileCommandPayloadSha256V1(compileFeedingMealMobilePayloadV1(input));
}

export function decodeFeedingRecordEnvironment(
  value: unknown,
): FeedingRecordEnvironment | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError('environment must be an object');
  exactKeys(
    value,
    [],
    ['waterTemp', 'dissolvedOxygen', 'weather', 'windLevel', 'visibility'],
    'environment',
  );
  const waterTemp = optionalNumberInRange(
    value['waterTemp'],
    FEEDING_WATER_TEMPERATURE_RANGE.minimum,
    FEEDING_WATER_TEMPERATURE_RANGE.maximum,
    'environment.waterTemp',
  );
  const dissolvedOxygen = optionalNumberInRange(
    value['dissolvedOxygen'],
    FEEDING_DISSOLVED_OXYGEN_RANGE.minimum,
    FEEDING_DISSOLVED_OXYGEN_RANGE.maximum,
    'environment.dissolvedOxygen',
  );
  const weather = optionalEnumValue(value['weather'], FEEDING_WEATHER, 'environment.weather');
  const windLevel = optionalEnumValue(
    value['windLevel'],
    FEEDING_WIND_LEVEL,
    'environment.windLevel',
  );
  const visibility = optionalEnumValue(
    value['visibility'],
    FEEDING_VISIBILITY,
    'environment.visibility',
  );
  return Object.freeze({
    ...(waterTemp === undefined ? {} : { waterTemp }),
    ...(dissolvedOxygen === undefined ? {} : { dissolvedOxygen }),
    ...(weather === undefined ? {} : { weather }),
    ...(windLevel === undefined ? {} : { windLevel }),
    ...(visibility === undefined ? {} : { visibility }),
  });
}

export function decodeFeedingRecordFishBehavior(
  value: unknown,
): FeedingRecordFishBehavior | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError('fishBehavior must be an object');
  exactKeys(
    value,
    ['appetite', 'feedingIntensity'],
    ['surfaceActivity', 'schoolingBehavior', 'abnormalBehavior'],
    'fishBehavior',
  );
  const appetite = enumValue(value['appetite'], FEEDING_FISH_APPETITE, 'fishBehavior.appetite');
  const feedingIntensity = optionalNumberInRange(
    value['feedingIntensity'],
    FEEDING_INTENSITY_RANGE.minimum,
    FEEDING_INTENSITY_RANGE.maximum,
    'fishBehavior.feedingIntensity',
  );
  if (feedingIntensity === undefined) {
    throw new TypeError('fishBehavior.feedingIntensity is required');
  }
  const surfaceActivity = optionalEnumValue(
    value['surfaceActivity'],
    FEEDING_SURFACE_ACTIVITY,
    'fishBehavior.surfaceActivity',
  );
  const schoolingBehavior = optionalEnumValue(
    value['schoolingBehavior'],
    FEEDING_SCHOOLING_BEHAVIOR,
    'fishBehavior.schoolingBehavior',
  );
  const abnormalBehavior = optionalBoundedString(
    value['abnormalBehavior'],
    'fishBehavior.abnormalBehavior',
  );
  return Object.freeze({
    appetite,
    feedingIntensity,
    ...(surfaceActivity === undefined ? {} : { surfaceActivity }),
    ...(schoolingBehavior === undefined ? {} : { schoolingBehavior }),
    ...(abnormalBehavior === undefined ? {} : { abnormalBehavior }),
  });
}
