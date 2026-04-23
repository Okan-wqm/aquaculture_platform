/**
 * Shared NATS message pattern constants.
 *
 * Centralises all NATS request-reply and event subject strings so that
 * publishers and consumers reference the same constant instead of
 * duplicating magic strings. Typos in a string literal are silent at
 * compile time; a missing or renamed constant causes an immediate build
 * error.
 *
 * @example
 * // In a controller:
 * import { NATS_PATTERNS } from '@aquaculture/backend-common/nats-patterns.ts';
 * @MessagePattern(NATS_PATTERNS.SENSOR.VERIFY_DEVICE_OWNERSHIP)
 *
 * // In a client:
 * this.natsClient.send(NATS_PATTERNS.SENSOR.VERIFY_DEVICE_OWNERSHIP, payload);
 */

export const NATS_PATTERNS = {
  SENSOR: {
    /** Request-reply: verify that an edge device belongs to a specific tenant. */
    VERIFY_DEVICE_OWNERSHIP: 'request.sensor.verifyDeviceOwnership',
  },
} as const;
