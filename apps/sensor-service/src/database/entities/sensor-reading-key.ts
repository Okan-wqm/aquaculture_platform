/**
 * Canonical reading-key codec (SENSOR-MEDIUM-067).
 *
 * Two representations of the same channel coexist:
 *   - a `sensor_data_channels.channelKey` is snake_case, produced by
 *     `normalizeChannelKey` at discovery (e.g. `dissolved_oxygen`, `water_level`);
 *   - a `SensorReadings` field is camelCase (e.g. `dissolvedOxygen`, `waterLevel`),
 *     produced by the reading mappers.
 *
 * Calibration joins a channel to its stored reading by key. Before this codec the
 * join did `channel.channelKey as keyof SensorReadings`, so every MULTI-WORD
 * metric looked up `readings['dissolved_oxygen']` — a key that never exists —
 * `undefined`, and calibration was silently skipped. Single-word metrics (`ph`,
 * `temperature`) happened to match, making the defect intermittent: an operator
 * enabling calibration on a dissolved-oxygen or water-level channel kept storing
 * UNCALIBRATED values, a fish-stock hazard.
 *
 * `canonicalReadingKey` is the single SSoT that reconciles the two: any
 * channel-key casing (snake_case, kebab, spaces) maps to the one canonical
 * camelCase reading key, and it is idempotent on an already-camelCase key. The 9
 * `SensorReadings` fields are exactly the camelCase of their snake_case channel
 * keys, so the round-trip is exact (enforced by
 * `sensor-reading-key.spec.ts`). Applying it at the calibration join makes the
 * casing mismatch structurally impossible — no channelKey rewrite, so the
 * snake_case representation the FE and the sensor_metrics EAV path rely on is
 * untouched, and existing rows calibrate correctly with no migration.
 */
export function canonicalReadingKey(channelKey: string): string {
  return channelKey
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/_+([a-z0-9])/gi, (_match, char: string) => char.toUpperCase())
    .replace(/^([A-Z])/, (_match, char: string) => char.toLowerCase());
}
