import { EventUpcaster } from './event-upcaster';

/**
 * AlertTriggered v1 → v2 upcaster
 *
 * v1 format: `triggeringData: { sensorId?, farmId?, pondId?, parameter?, value?, threshold?, ... }`
 * v2 format: `triggerSensorId?, triggerFarmId?, triggerPondId?, triggerParameter?, triggerValue?, triggerThreshold?`
 *
 * WHY: Flat-object rule — nested `triggeringData` object with `[key: string]: unknown`
 * violates BaseEvent contract and breaks type safety.
 */
export const alertTriggeredUpcaster: EventUpcaster = {
  eventType: 'AlertTriggered',
  fromVersion: 1,
  toVersion: 2,
  upcast(event: Record<string, unknown>): Record<string, unknown> {
    const triggeringData = event['triggeringData'] as Record<string, unknown> | undefined;
    if (!triggeringData || typeof triggeringData !== 'object') {
      return { ...event, version: 2 };
    }

    const result: Record<string, unknown> = { ...event, version: 2 };
    delete result['triggeringData'];

    if (triggeringData['sensorId'] !== undefined) result['triggerSensorId'] = triggeringData['sensorId'];
    if (triggeringData['farmId'] !== undefined) result['triggerFarmId'] = triggeringData['farmId'];
    if (triggeringData['pondId'] !== undefined) result['triggerPondId'] = triggeringData['pondId'];
    if (triggeringData['parameter'] !== undefined) result['triggerParameter'] = triggeringData['parameter'];
    if (triggeringData['value'] !== undefined) result['triggerValue'] = triggeringData['value'];
    if (triggeringData['threshold'] !== undefined) result['triggerThreshold'] = triggeringData['threshold'];

    return result;
  },
};
