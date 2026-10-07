/**
 * Sensor-owned channel description: what a sensor channel is, now, by its
 * stable natural key (sensorId, channelKey).
 *
 * Farm binds water-chemistry inputs to channels by that key — channel UUIDs
 * change when a device is rediscovered — and copies nothing about the channel
 * into its own rows. Whenever farm needs to know whether a bound channel still
 * exists, is enabled, where its sensor stands, what quantity it reports in
 * which unit, and its last value, it asks here. The sensor service is the only
 * owner of those answers; the GraphQL `channelsByKey` query reads the same
 * service, so the page and farm cannot see different channels.
 *
 * Dates cross the wire as ISO-8601 strings.
 */
export const SENSOR_CHANNEL_QUERY_SUBJECTS = {
  DESCRIBE: 'request.sensor.describeChannels',
} as const;

/** The most channel keys one request may carry. */
export const MAX_DESCRIBED_CHANNELS = 100;

export interface SensorChannelKey {
  sensorId: string;
  channelKey: string;
}

export interface DescribeSensorChannelsRequest {
  tenantId: string;
  channels: SensorChannelKey[];
}

/** Why a key does not describe a live channel. */
export type SensorChannelPresence = 'FOUND' | 'NO_SENSOR' | 'NO_CHANNEL';

/**
 * The OPC-UA band of a sample's quality code, classified by the sensor
 * service, which owns the scale: callers act on the band and never re-derive
 * it from raw codes.
 */
export type SensorSampleQuality = 'GOOD' | 'UNCERTAIN' | 'BAD';

/**
 * One asked-about key. Every field past `presence` is null unless the part it
 * describes was found: sensor fields need the sensor, channel fields the
 * channel, `latest*` a qualifying sample.
 *
 * - Location (`siteId`/`systemId`/`tankId`) is the device that owns the
 *   channel — for MQTT parent/child devices, the parent, which is also where
 *   ingestion attributes the readings.
 * - `unit` is the unit the channel's values are in; null means the channel
 *   declares none, so its values cannot be converted and must not feed a
 *   calculation. `quantity` + `unit` are what `toCanonicalUnit`
 *   (`@aquaculture/shared-contracts`) converts from.
 * - `calibrationDueAt` null means the channel has no calibration schedule —
 *   not that calibration is not due.
 * - `configuredAt` is when the channel's unit or quantity last changed (null:
 *   not since tracking began). `latest*` is the newest sample taken at or after
 *   it, inside the sensor service's freshness window (`AS_OF_LOOKBACK` in
 *   `@aquaculture/shared-contracts`, 7 days), of any quality — `latestQuality`
 *   says which band. A sample from before the current unit is never paired
 *   with it.
 */
export interface SensorChannelDescription extends SensorChannelKey {
  presence: SensorChannelPresence;
  sensorActive: boolean | null;
  siteId: string | null;
  systemId: string | null;
  tankId: string | null;
  channelId: string | null;
  enabled: boolean | null;
  /** Effective measured quantity (registry id): declared, else named by the key. */
  quantity: string | null;
  /** The family the key names without saying which member, e.g. `ammonia`. */
  quantityFamily: string | null;
  unit: string | null;
  calibrationDueAt: string | null;
  configuredAt: string | null;
  latestValue: number | null;
  latestAt: string | null;
  latestQuality: SensorSampleQuality | null;
}

export interface DescribeSensorChannelsResponse {
  /** One entry per asked-about key, in request order. */
  channels: SensorChannelDescription[];
}

const PRESENCES: ReadonlySet<string> = new Set<SensorChannelPresence>([
  'FOUND',
  'NO_SENSOR',
  'NO_CHANNEL',
]);
const QUALITIES: ReadonlySet<string> = new Set<SensorSampleQuality>(['GOOD', 'UNCERTAIN', 'BAD']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Validator = (value: unknown) => boolean;

const nullable =
  (valid: Validator): Validator =>
  (value) =>
    value === null || valid(value);
const isString: Validator = (value) => typeof value === 'string';
const isNumber: Validator = (value) => typeof value === 'number' && Number.isFinite(value);
const isBoolean: Validator = (value) => typeof value === 'boolean';
/** An ISO-8601 instant with an explicit zone, as the wire carries dates. */
const isIsoInstant: Validator = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
  !Number.isNaN(Date.parse(value));

const isKey = (value: unknown): value is SensorChannelKey =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value['sensorId'] === 'string' &&
  typeof value['channelKey'] === 'string';

/** Runtime trust-boundary validation for the NATS request envelope (exact shape). */
export function isDescribeSensorChannelsRequest(
  value: unknown,
): value is DescribeSensorChannelsRequest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value['tenantId'] === 'string' &&
    Array.isArray(value['channels']) &&
    value['channels'].length <= MAX_DESCRIBED_CHANNELS &&
    value['channels'].every(isKey)
  );
}

/** One validator per field of the description; a field added to the type must be added here. */
const DESCRIPTION_FIELDS = {
  sensorId: isString,
  channelKey: isString,
  presence: (value) => typeof value === 'string' && PRESENCES.has(value),
  sensorActive: nullable(isBoolean),
  siteId: nullable(isString),
  systemId: nullable(isString),
  tankId: nullable(isString),
  channelId: nullable(isString),
  enabled: nullable(isBoolean),
  quantity: nullable(isString),
  quantityFamily: nullable(isString),
  unit: nullable(isString),
  calibrationDueAt: nullable(isIsoInstant),
  configuredAt: nullable(isIsoInstant),
  latestValue: nullable(isNumber),
  latestAt: nullable(isIsoInstant),
  latestQuality: nullable((value) => typeof value === 'string' && QUALITIES.has(value)),
} satisfies Record<keyof SensorChannelDescription, Validator>;

/**
 * Runtime trust-boundary validation for the NATS reply. Every documented field
 * must be present with its type; fields this version does not know are
 * tolerated, so the owner can add a field without breaking a caller still on
 * the older contract. A new `presence` or `latestQuality` value is a contract
 * change: an older caller refuses it rather than guess what it means.
 */
export function isDescribeSensorChannelsResponse(
  value: unknown,
): value is DescribeSensorChannelsResponse {
  return (
    isRecord(value) &&
    Array.isArray(value['channels']) &&
    value['channels'].every(
      (entry: unknown) =>
        isRecord(entry) &&
        Object.entries(DESCRIPTION_FIELDS).every(([field, valid]) => valid(entry[field])),
    )
  );
}

/** Whether a reply describes exactly the request's keys, one each, in order. */
export function describesRequest(
  request: DescribeSensorChannelsRequest,
  response: DescribeSensorChannelsResponse,
): boolean {
  return (
    response.channels.length === request.channels.length &&
    request.channels.every(
      (key, index) =>
        response.channels[index]?.sensorId === key.sensorId &&
        response.channels[index]?.channelKey === key.channelKey,
    )
  );
}
