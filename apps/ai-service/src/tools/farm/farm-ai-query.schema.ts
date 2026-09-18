/**
 * Shared JSON-Schema fragments for the farm-AI query tool input schemas
 * (PR-3). Keeping the patterns here means the 13 tools cannot drift on what
 * a "uuid" or an "ISO date" or a "list limit" means on the model wire.
 */

/** Loose UUID shape (any version) — mirrors the contract guard isUuidString. */
export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** ISO-8601 date or date-time — mirrors the contract guard isIsoDateString. */
export const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}([T ].*)?$';

/** Required UUID property schema. */
export const UUID_SCHEMA = {
  type: 'string',
  pattern: UUID_PATTERN,
} as const;

/** Optional UUID property schema. */
export const OPTIONAL_UUID_SCHEMA = {
  type: 'string',
  pattern: UUID_PATTERN,
} as const;

/** Required ISO date property schema. */
export const ISO_DATE_SCHEMA = {
  type: 'string',
  pattern: ISO_DATE_PATTERN,
  description: 'ISO-8601 date or date-time (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ)',
} as const;

/** Optional ISO date property schema. */
export const OPTIONAL_ISO_DATE_SCHEMA = {
  type: 'string',
  pattern: ISO_DATE_PATTERN,
} as const;

/**
 * Bounded list limit — matches FARM_AI_QUERY_LIMITS
 * (DEFAULT_LIST_LIMIT 20 / MAX_LIST_LIMIT 50).
 */
export const LIST_LIMIT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 50,
  default: 20,
  description: 'Max rows to return (1-50, default 20). Narrow the window when truncated.',
} as const;

/** Bounded trailing-window days — matches MAX_STAT_DAYS (90). */
export const STAT_DAYS_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 90,
  default: 7,
  description: 'Trailing window in days (1-90, default 7).',
} as const;
