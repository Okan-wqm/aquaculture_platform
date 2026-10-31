/**
 * Publishers of plain sensors that still connect with the `sensor_service`
 * account, by the client ID they present (ADR-047 §7, SENSOR-HIGH-207,
 * docs/reviews/claude/2026-10-30-sensor-mqtt-legacy-publishers.md).
 *
 * The broker's client-ID binding reserves these to `sensor_service` until each
 * publisher moves to its own issued principal; then its entry leaves this list.
 * An empty list is the signal to drop the legacy namespaces from the listener
 * and from `sensor_service`'s grants.
 */
export const LEGACY_SENSOR_SERVICE_PUBLISHERS: readonly string[] = [
  // Production codex simulator (Node-RED, /var/lib/aqua/simulators).
  'nodered-codex-sim-01',
];
