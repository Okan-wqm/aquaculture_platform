/**
 * Shared validation regex patterns.
 *
 * Centralises frequently-used input validation patterns so that every
 * consumer applies the exact same rules. Duplicating regex literals
 * across services risks silent divergence when one copy is updated but
 * the other is not.
 *
 * All patterns are pre-compiled RegExp objects for optimal performance
 * when used in hot paths (e.g. WebSocket message handlers).
 *
 * @example
 * import { VALIDATION_PATTERNS } from '@aquaculture/backend-common';
 * if (!VALIDATION_PATTERNS.DEVICE_CODE.test(input)) { ... }
 */

/**
 * Strict validation regex for device codes.
 * Only alphanumeric characters, hyphens, and underscores are accepted
 * (maximum 128 characters). Prevents injection of special characters
 * (e.g. colons, slashes) into room names or NATS subjects.
 */
export const DEVICE_CODE_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Strict validation regex for tenant IDs.
 * Only lowercase UUID v4 format is accepted to prevent injection
 * in database queries and NATS subjects.
 */
export const TENANT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validation regex for UUID format (case-insensitive).
 * Accepts UUID v1 through v5. Used for sensor IDs and other entity
 * identifiers at system boundaries.
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Convenience namespace grouping all validation patterns. */
export const VALIDATION_PATTERNS = {
  DEVICE_CODE: DEVICE_CODE_REGEX,
  TENANT_ID: TENANT_ID_REGEX,
  UUID: UUID_REGEX,
} as const;
