import { SensorReadingParameter } from './sensor-events';

/**
 * SENSOR-MEDIUM-066/068 (convergence phase 1): the SINGLE source of truth for the
 * sensor-reading parameter vocabulary and the mappings between its three
 * representations. These mappings were previously duplicated across the NATS
 * ingestion consumer's channelKey switch, SensorIngestionService's event builder,
 * the alert-engine handler's READING_FIELD_MAP, and the v1→v2 upcaster — and had
 * to be kept in lock-step by hand. They now live here, on the event-contract
 * boundary that every producer and consumer already depends on.
 *
 * Three representations of one parameter:
 *   - parameter      — camelCase (`dissolvedOxygen`), the SensorReadings JSONB key
 *   - reading field  — flat event field (`readingDissolvedOxygen`) on SensorReadingEvent
 *   - channel key    — device/channel naming (`dissolved_oxygen`, `do`, `o2`, …)
 */

/** The nine canonical reading parameters (SensorReadings keys + event vocabulary). */
export const SENSOR_READING_PARAMETERS: readonly SensorReadingParameter[] = [
  'temperature',
  'ph',
  'dissolvedOxygen',
  'salinity',
  'ammonia',
  'nitrite',
  'nitrate',
  'turbidity',
  'waterLevel',
] as const;

/** The flat `readingXxx` field on SensorReadingEvent carrying a parameter's value. */
export type SensorReadingField =
  | 'readingTemperature'
  | 'readingPh'
  | 'readingDissolvedOxygen'
  | 'readingSalinity'
  | 'readingAmmonia'
  | 'readingNitrite'
  | 'readingNitrate'
  | 'readingTurbidity'
  | 'readingWaterLevel';

/**
 * The flat event field for a parameter: `reading` + Capitalized(parameter). This is
 * the exact convention the SensorReadingEvent docblock documents
 * (`event['reading' + capitalise(parameter)]`).
 */
export function readingFieldForParameter(parameter: SensorReadingParameter): SensorReadingField {
  return `reading${parameter.charAt(0).toUpperCase()}${parameter.slice(1)}` as SensorReadingField;
}

/** Inverse of readingFieldForParameter — which parameter a flat field carries. */
export const PARAMETER_BY_READING_FIELD: Readonly<
  Record<SensorReadingField, SensorReadingParameter>
> = Object.freeze(
  Object.fromEntries(
    SENSOR_READING_PARAMETERS.map((p) => [readingFieldForParameter(p), p]),
  ) as Record<SensorReadingField, SensorReadingParameter>,
);

/**
 * channelKey (and its device-naming aliases) → canonical parameter. Keys are
 * lowercased. Consolidates the alias sets previously spread across the NATS
 * consumer switch and the sensor-parameter catalog.
 */
const PARAMETER_BY_CHANNEL_KEY: Readonly<Record<string, SensorReadingParameter>> = Object.freeze({
  temperature: 'temperature',
  temp: 'temperature',
  water_temperature: 'temperature',
  water_temp: 'temperature',
  ph: 'ph',
  ph_level: 'ph',
  dissolved_oxygen: 'dissolvedOxygen',
  dissolvedoxygen: 'dissolvedOxygen',
  do: 'dissolvedOxygen',
  do_level: 'dissolvedOxygen',
  oxygen: 'dissolvedOxygen',
  o2: 'dissolvedOxygen',
  salinity: 'salinity',
  salt: 'salinity',
  ammonia: 'ammonia',
  nh3: 'ammonia',
  nitrite: 'nitrite',
  no2: 'nitrite',
  nitrate: 'nitrate',
  no3: 'nitrate',
  turbidity: 'turbidity',
  ntu: 'turbidity',
  water_level: 'waterLevel',
  waterlevel: 'waterLevel',
  level: 'waterLevel',
});

/**
 * Resolve a device/channel key to its canonical reading parameter, or undefined
 * when the channel is outside the nine-parameter vocabulary (e.g. flow_rate, orp,
 * co2 — the types the flat event shape cannot yet carry; convergence phase ≥3
 * gives them a channel-keyed representation).
 */
export function parameterForChannelKey(channelKey: string): SensorReadingParameter | undefined {
  return PARAMETER_BY_CHANNEL_KEY[channelKey.toLowerCase()];
}

/**
 * The channel key to MINT for a parameter — the inverse this SSoT was missing.
 *
 * `PARAMETER_BY_CHANNEL_KEY` maps many device spellings onto one parameter,
 * which is right for reading whatever a device calls its channel. But when the
 * platform itself creates a channel — auto-provisioning one for a reported
 * parameter that had none — it has to pick a spelling, and picking it at the
 * callsite is how a tenant ends up with `dissolvedOxygen` next to a device's
 * `dissolved_oxygen`: two channels, one parameter, and an ordering-dependent
 * winner in the as-of projection.
 *
 * The canonical spelling is the snake_case device-naming form this module's
 * docblock already documents, so a platform-minted channel is indistinguishable
 * from the one a device would have registered — and the
 * `(tenant_id, sensor_id, channel_key)` unique constraint then makes
 * auto-provisioning a true no-op when the real channel already exists.
 */
export function canonicalChannelKeyForParameter(parameter: SensorReadingParameter): string {
  return parameter.replace(/([A-Z])/g, (upper) => `_${upper.toLowerCase()}`);
}
