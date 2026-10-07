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
 * One asked-about key. Every field past `presence` is null unless the part it
 * describes was found: sensor fields need the sensor, channel fields the
 * channel, `latest*` a sample inside the sensor service's freshness window.
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
  latestValue: number | null;
  latestAt: string | null;
  latestQualityCode: number | null;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullable =
  (type: 'string' | 'number' | 'boolean') =>
  (value: unknown): boolean =>
    value === null || typeof value === type;

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

const DESCRIPTION_FIELDS: ReadonlyArray<[keyof SensorChannelDescription, (v: unknown) => boolean]> =
  [
    ['sensorId', (v) => typeof v === 'string'],
    ['channelKey', (v) => typeof v === 'string'],
    ['presence', (v) => typeof v === 'string' && PRESENCES.has(v)],
    ['sensorActive', isNullable('boolean')],
    ['siteId', isNullable('string')],
    ['systemId', isNullable('string')],
    ['tankId', isNullable('string')],
    ['channelId', isNullable('string')],
    ['enabled', isNullable('boolean')],
    ['quantity', isNullable('string')],
    ['quantityFamily', isNullable('string')],
    ['unit', isNullable('string')],
    ['calibrationDueAt', isNullable('string')],
    ['latestValue', isNullable('number')],
    ['latestAt', isNullable('string')],
    ['latestQualityCode', isNullable('number')],
  ];

/**
 * Runtime trust-boundary validation for the NATS reply. Every documented field
 * must be present with its type; fields this version does not know are
 * tolerated, so the owner can add one without breaking a caller still on the
 * older contract.
 */
export function isDescribeSensorChannelsResponse(
  value: unknown,
): value is DescribeSensorChannelsResponse {
  return (
    isRecord(value) &&
    Array.isArray(value['channels']) &&
    value['channels'].every(
      (entry: unknown) =>
        isRecord(entry) && DESCRIPTION_FIELDS.every(([field, valid]) => valid(entry[field])),
    )
  );
}
