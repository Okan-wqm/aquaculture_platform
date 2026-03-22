/**
 * Date utility functions for Tenant Admin module.
 *
 * Centralizes relative-time formatting that was previously duplicated
 * across TenantUsers, TenantDashboard, and TenantActivityPage.
 *
 * Uses `undefined` locale (browser default) instead of hardcoded 'tr-TR'.
 */

/**
 * Format a date string (or Date) as a human-readable relative time.
 *
 * Returns:
 *  - "Never"          when input is null / undefined
 *  - "Just now"       when < 1 minute ago
 *  - "Xm ago"         when < 60 minutes
 *  - "Xh ago"         when < 24 hours
 *  - "Xd ago"         when < 7 days
 *  - medium date      otherwise (browser locale)
 */
export function formatRelativeTime(date: string | Date | null): string {
  if (!date) return 'Never';

  const then = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(then);
}

/**
 * Format a date for display using the browser's locale.
 * Shorthand for Intl.DateTimeFormat with dateStyle: 'medium'.
 */
export function formatDate(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d);
}

/**
 * Format a date-time for display using the browser's locale.
 * Shorthand for Intl.DateTimeFormat with dateStyle: 'medium', timeStyle: 'short'.
 */
export function formatDateTime(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}
