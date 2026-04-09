/**
 * RouteAnnouncer Component
 *
 * Announces route changes to screen readers via an aria-live region.
 * Without this, screen reader users have no feedback when SPA navigation
 * changes the page content.
 *
 * FE-HIGH-017: Part of the a11y primitive set that makes accessibility
 * violations structurally impossible rather than relying on individual fixes.
 *
 * @see FE-HIGH-017
 *
 * @example
 * // Place once in the app shell, typically near the root
 * <RouteAnnouncer />
 * // Screen readers will announce: "Navigated to Dashboard"
 * // when the route changes to /dashboard.
 */

import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';

// ============================================================================
// Types
// ============================================================================

export interface RouteAnnouncerProps {
  /**
   * Optional function to derive the announcement message from the pathname.
   * Default implementation converts pathname segments to a human-readable title.
   */
  getAnnouncement?: (pathname: string) => string;
}

// ============================================================================
// Default Announcement Generator
// ============================================================================

/**
 * Convert a pathname like "/sites/farm-detail/123" into "Navigated to Sites Farm Detail"
 */
function defaultGetAnnouncement(pathname: string): string {
  if (pathname === '/') return 'Navigated to Home';

  const segments = pathname
    .split('/')
    .filter(Boolean)
    // Skip UUID-like segments (they're IDs, not page names)
    .filter((s) => !/^[0-9a-f-]{8,}$/i.test(s))
    // Convert kebab-case to Title Case
    .map((s) =>
      s
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' '),
    );

  return `Navigated to ${segments.join(' ')}`;
}

// ============================================================================
// Component
// ============================================================================

export const RouteAnnouncer: React.FC<RouteAnnouncerProps> = ({
  getAnnouncement = defaultGetAnnouncement,
}) => {
  const location = useLocation();
  const [announcement, setAnnouncement] = useState('');
  const prevPathRef = useRef(location.pathname);

  useEffect(() => {
    // Only announce when pathname actually changes (not on hash/search changes)
    if (location.pathname !== prevPathRef.current) {
      prevPathRef.current = location.pathname;
      setAnnouncement(getAnnouncement(location.pathname));
    }
  }, [location.pathname, getAnnouncement]);

  // The visually-hidden aria-live region is read by screen readers
  // whenever its content changes.
  return (
    <div
      role="status"
      aria-live="assertive"
      aria-atomic="true"
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {announcement}
    </div>
  );
};
