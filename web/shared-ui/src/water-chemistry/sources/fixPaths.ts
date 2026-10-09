/**
 * Where each kind of fix is made, as a shell path — the one map both
 * water-chemistry views link through (the farm Sources tab and the sensor
 * monitoring view live in different remotes and cannot import each other):
 *
 * - parameter: the farm Parameters tab (declare the quantity, fix the unit);
 * - source:    the farm Sources tab at the point (bind, replace, unbind);
 * - channel:   the sensor's channel manager, on the channel (declare what it
 *              measures, enable it);
 * - sensor:    the sensor's page (activate it, check its samples, place it);
 * - system:    the farm setup (the system's type and volume).
 *
 * Null when the fix needs a sensor the problem does not name.
 */
import { formatPointRef, type PointRef } from './pointRef';
import type { ProblemFix } from './problems';

export interface FixContext {
  /** The point the problem was seen at. */
  readonly point: PointRef | null;
  /** The source's sensor and channel, when the problem is a channel source's. */
  readonly sensorId: string | null;
  readonly channelKey: string | null;
}

export const WATER_CHEMISTRY_PATH = '/sites/water-chemistry';

export function problemFixPath(fix: ProblemFix, context: FixContext): string | null {
  switch (fix) {
    case 'parameter':
      return `${WATER_CHEMISTRY_PATH}?tab=parameters`;
    case 'source':
      return context.point === null
        ? `${WATER_CHEMISTRY_PATH}?tab=sources`
        : `${WATER_CHEMISTRY_PATH}?tab=sources&point=${formatPointRef(context.point)}`;
    case 'channel':
      if (context.sensorId === null) return null;
      return context.channelKey === null
        ? `/sensor/devices/${context.sensorId}?tab=channels`
        : `/sensor/devices/${context.sensorId}?tab=channels&channel=${encodeURIComponent(context.channelKey)}`;
    case 'sensor':
      return context.sensorId === null ? null : `/sensor/devices/${context.sensorId}`;
    case 'system':
      return '/sites/setup';
  }
}
