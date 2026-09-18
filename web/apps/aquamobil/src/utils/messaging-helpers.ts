// ============================================================================
// Messaging Helpers — Shared utility functions for messaging UI
// ============================================================================

/**
 * WHY: Consolidates helper functions used across multiple messaging pages
 * and components. Eliminates duplication of getInitials() (was in 5 files)
 * and formatRelativeTime() (was in 3 files). Single source of truth for
 * formatting logic ensures consistency across the messaging feature.
 */

/**
 * Get initials from a name string for avatar fallback display.
 * "John Doe" => "JD", "Admin" => "A", "" => "?".
 *
 * @param name - The display name to extract initials from
 * @returns 1-2 character string of uppercase initials
 */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  const first = parts[0].charAt(0).toUpperCase();
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0).toUpperCase() ?? '') : '';
  return first + last;
}

/**
 * Format a timestamp into a short relative label for the channel list.
 * Shows "Just now", "5m", "2h", "Yesterday", or a short date.
 *
 * @param isoString - ISO 8601 timestamp string
 * @returns Human-readable relative time label
 */
export function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const date = new Date(isoString).getTime();
  if (isNaN(date)) return '';

  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHour = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d`;

  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format a message timestamp to a short time string (HH:MM).
 *
 * @param isoString - ISO 8601 timestamp string
 * @returns Time in HH:MM format (24h)
 */
export function formatMessageTime(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Determine the date group label for a message timestamp.
 * Returns "Today", "Yesterday", or a formatted date string.
 *
 * @param isoString - ISO 8601 timestamp string
 * @returns Date label for message grouping
 */
export function getDateLabel(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDate.getTime() === today.getTime()) return 'Today';
  if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: now.getFullYear() !== date.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Compute a display name from a MessageUser-like object.
 * Handles the multiple shapes (firstName/lastName vs displayName).
 *
 * @param user - Object with optional firstName, lastName, displayName, email
 * @returns Best available display name string
 */
export function getUserDisplayName(user: {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
}): string {
  if (user.displayName) return user.displayName;
  const parts = [user.firstName, user.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  // email is not available on a PublicUserProfile (never crosses federation).
  return 'Unknown';
}

/**
 * Validate a URL protocol for safe rendering in href/src attributes.
 * Prevents javascript: and data: URI injection attacks.
 *
 * @param url - The URL to validate
 * @returns true if the URL uses a safe protocol (http/https)
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
