/**
 * Shared utilities for sensor config tools.
 */

/**
 * Convert a snake_case or camelCase key into a human-readable display label.
 * Example: 'water_temperature' -> 'Water Temperature'
 *          'waterTemperature' -> 'Water Temperature'
 */
export function formatLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
