/**
 * System Constants for Feeding Module
 *
 * Contains constants used across the feeding module services.
 */

/**
 * System user ID for cron-generated records
 * Used when creating DailyFeedingExecution records via scheduled jobs
 * where there is no user context available.
 *
 * This UUID is reserved for system operations and should not be assigned
 * to any real user account.
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
