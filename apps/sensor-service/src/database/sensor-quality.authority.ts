/**
 * Pure OPC-UA quality-code authority.
 *
 * Kept outside the TypeORM entity graph so query services, ingestion paths,
 * and readiness projections can share the exact thresholds without loading
 * decorators or relation metadata as a side effect.
 */
export enum QualityCategory {
  GOOD = 'good',
  UNCERTAIN = 'uncertain',
  BAD = 'bad',
}

/** First code in the OPC-UA DA uncertain band. */
export const QUALITY_UNCERTAIN_MIN = 64;

/** First code in the OPC-UA DA good band and the database column default. */
export const QUALITY_GOOD_MIN = 192;

export function qualityCategoryOf(code: number): QualityCategory {
  if (code >= QUALITY_GOOD_MIN) return QualityCategory.GOOD;
  if (code >= QUALITY_UNCERTAIN_MIN) return QualityCategory.UNCERTAIN;
  return QualityCategory.BAD;
}

export const QualityCodes = Object.freeze({
  GOOD: 192,
  GOOD_LOCAL_OVERRIDE: 193,
  UNCERTAIN: 64,
  UNCERTAIN_LAST_USABLE: 65,
  UNCERTAIN_SENSOR_NOT_ACCURATE: 66,
  UNCERTAIN_EU_EXCEEDED: 67,
  UNCERTAIN_SUBNORMAL: 68,
  BAD: 0,
  BAD_CONFIG_ERROR: 1,
  BAD_NOT_CONNECTED: 2,
  BAD_DEVICE_FAILURE: 3,
  BAD_SENSOR_FAILURE: 4,
  BAD_COMM_FAILURE: 5,
  BAD_OUT_OF_SERVICE: 6,
  BAD_WAITING_INITIAL: 7,
} as const);
