/**
 * Canonical non-human actor identifier for machine-owned writes to UUID
 * columns. Human actions must use the verified principal id instead.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000' as const;
