import { FARM_AI_QUERY_LIMITS } from '@platform/event-contracts';

/** JSON-schema fragments shared by the farm read tools (model-facing hints; the responder guard is the trust boundary). */
export const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export const ISO_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export const UUID_SCHEMA = { type: 'string', pattern: UUID_PATTERN } as const;
export const ISO_DATE_SCHEMA = { type: 'string', pattern: ISO_DATE_PATTERN } as const;
export const LIST_LIMIT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT,
  description: `Max rows to return (default ${FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT}, max ${FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT}). If the reply says truncated, narrow the window.`,
} as const;

export const ALL_TIERS = ['operator', 'manager', 'expert', 'supervisor'] as const;
/** Tiers above operator — finance and other management-only reads. */
export const MANAGER_UP = ['manager', 'expert', 'supervisor'] as const;

/** Trailing-window length for statistics tools, bounded by the contract's MAX_STAT_DAYS. */
export const STAT_DAYS_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: FARM_AI_QUERY_LIMITS.MAX_STAT_DAYS,
} as const;

/** Look-ahead length for upcoming/overdue plan listings, bounded by MAX_UPCOMING_DAYS. */
export const UPCOMING_DAYS_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: FARM_AI_QUERY_LIMITS.MAX_UPCOMING_DAYS,
} as const;
