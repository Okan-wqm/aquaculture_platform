/**
 * SensorReading projection — the ONE way a producer turns persisted metric
 * rows into a `SensorReadingEvent` (SENSOR-CRITICAL-111).
 *
 * WHY THIS EXISTS
 *
 * Two of the four producers used to publish the RAW MQTT wire payload as the
 * event body (`readings: data`, `version: 1`) while writing something else to
 * `sensor_metrics`. The stored row and the published event disagreed on two
 * axes at once:
 *
 *   - SCOPE. The row carries `farmId`/`pondId`/`tankId` from the sensor; the
 *     event carried none. The alert engine's rule query is fail-closed on an
 *     absent farm (`rule.farmId IS NULL`), so EVERY farm- or pond-scoped rule
 *     was excluded — in SQL, silently, with a truthful "Found N applicable
 *     rules" log over the wrong set.
 *   - VALUE. The row carries `channel.applyCalibration(raw)`; the event
 *     carried the raw wire number. An alarm therefore fired (or did not) on a
 *     value the platform had never stored.
 *
 * The fix is structural rather than a patch at each publish site: a producer
 * cannot mint a reading event from anything except rows it has already
 * persisted, because that is the only input this function accepts.
 *
 * WHY THE CHANNEL KEY AND NOT THE CHANNEL ID
 *
 * `parameterForChannelKey` is the alias table that knows a device may spell
 * dissolved oxygen `do`, `o2`, `dissolved_oxygen` or `oxygen`. Callers hold the
 * channel while they build the row, so they can supply the key; asking them for
 * the id would force this module to reach for a repository it must not have.
 *
 * WHY AN EMPTY PROJECTION IS NOT AN EVENT
 *
 * `mappedCount === 0` means no persisted row resolved to a field the flat event
 * shape can carry — every channel was out of vocabulary (`flow_rate`, `orp`,
 * `co2`). Publishing that produced an event whose readings were `{}`, which the
 * alert engine reads as "nothing is wrong" and uses to auto-resolve open
 * INFO/LOW incidents as "returned to normal". The reading is still in
 * `sensor_metrics`; what must not happen is announcing an absence of readings
 * as if it were a measurement. Callers check `mappedCount` and skip the publish.
 */
import { type SensorReadingParameter } from './sensor-events';
import {
  parameterForChannelKey,
  readingFieldForParameter,
  type SensorReadingField,
} from './sensor-reading-parameters';

/**
 * A row the producer has ALREADY written to `sensor_metrics`, reduced to the
 * fields the flat event shape needs. Deliberately not `SensorMetricInput`: this
 * library must not depend on the persistence type, and the narrower shape makes
 * "did this come from a stored row" checkable at the call site.
 */
export interface PersistedReadingMetric {
  /** The channel's device-facing key, resolved through the alias table. */
  readonly channelKey: string;
  /** The CALIBRATED value, exactly as stored. Never the raw wire number. */
  readonly value: number;
  readonly farmId?: string | null;
  readonly pondId?: string | null;
  readonly tankId?: string | null;
}

/** The flat `readingXxx` fields of a `SensorReadingEvent`, and its scope. */
export interface SensorReadingProjection {
  readonly fields: Readonly<Partial<Record<SensorReadingField, number>>>;
  readonly farmId?: string;
  readonly pondId?: string;
  readonly tankId?: string;
  /**
   * Set only when the batch resolves to exactly one parameter — the event's
   * `parameter` field means "this reading is about X", which a multi-channel
   * message cannot answer. Consumers then read every populated field instead.
   */
  readonly parameter?: SensorReadingParameter;
  /** How many rows resolved to a field. Zero means: do not publish. */
  readonly mappedCount: number;
}

/** `null` and `''` both mean "no scope" on a metric row; `undefined` on the event. */
function scopeOf(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}

/**
 * Project persisted metric rows onto the flat event shape.
 *
 * Scope is taken from the first row that carries it. Every row in one call
 * comes from one sensor at one instant, so they agree by construction; taking
 * the first present value rather than requiring all of them to match keeps a
 * partially-populated row (a sensor mounted on a pond but no tank) from
 * dropping the scope it does have.
 */
export function projectPersistedReadings(
  metrics: readonly PersistedReadingMetric[],
): SensorReadingProjection {
  const fields: Partial<Record<SensorReadingField, number>> = {};
  const parameters = new Set<SensorReadingParameter>();
  let farmId: string | undefined;
  let pondId: string | undefined;
  let tankId: string | undefined;

  for (const metric of metrics) {
    farmId ??= scopeOf(metric.farmId);
    pondId ??= scopeOf(metric.pondId);
    tankId ??= scopeOf(metric.tankId);

    if (!Number.isFinite(metric.value)) continue;
    const parameter = parameterForChannelKey(metric.channelKey);
    if (parameter === undefined) continue;

    fields[readingFieldForParameter(parameter)] = metric.value;
    parameters.add(parameter);
  }

  const only = parameters.size === 1 ? [...parameters][0] : undefined;

  return {
    fields,
    ...(farmId !== undefined ? { farmId } : {}),
    ...(pondId !== undefined ? { pondId } : {}),
    ...(tankId !== undefined ? { tankId } : {}),
    ...(only !== undefined ? { parameter: only } : {}),
    mappedCount: Object.keys(fields).length,
  };
}
