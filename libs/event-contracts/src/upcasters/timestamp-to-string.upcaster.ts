import { EventUpcaster } from './event-upcaster';

/**
 * Generic timestamp Date → string upcaster factory.
 *
 * v1 format: `timestamp: Date` (object or ISO string from JSON parse)
 * v2 format: `timestamp: string` (ISO 8601)
 *
 * WHY: BaseEvent.timestamp was declared as Date but JSONB serialization
 * converts to ISO 8601 string. The interface lied about the wire type.
 * Now the interface declares `string`, and this upcaster normalizes
 * any v1 events that might have a Date object in memory.
 *
 * This factory creates an upcaster for any eventType that needs the
 * version bumped from 1→2 (or N→N+1) with timestamp normalization.
 */
export function createTimestampUpcaster(
  eventType: string,
  fromVersion: number,
  toVersion: number,
): EventUpcaster {
  return {
    eventType,
    fromVersion,
    toVersion,
    upcast(event: Record<string, unknown>): Record<string, unknown> {
      const result: Record<string, unknown> = { ...event, version: toVersion };

      // Normalize timestamp to ISO 8601 string
      const ts = event['timestamp'];
      if (ts instanceof Date) {
        result['timestamp'] = ts.toISOString();
      } else if (typeof ts === 'number') {
        result['timestamp'] = new Date(ts).toISOString();
      }
      // If already a string, leave as-is

      return result;
    },
  };
}
