/**
 * NotificationPanel Component
 *
 * Desktop notification center dropdown panel.
 * Renders as a positioned dropdown anchored to the bell icon in the Header.
 *
 * Features:
 * - Unread count badge on bell icon
 * - Dropdown panel with notification list
 * - Mark individual notifications as read on click
 * - "Mark all as read" button
 * - Navigation to relevant page based on notification type/data
 * - Empty state when no notifications
 * - Click-outside to close
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { validateNavigationUrl } from '@aquaculture/shared-ui';
import {
  useNotifications,
  type InAppNotification,
  type NotificationData,
} from '@/hooks/useNotifications';

// ============================================================================
// Pagination Constants
// ============================================================================

/**
 * FE-HIGH-034: Limit initial render to prevent unbounded DOM growth.
 * Additional notifications are loaded via "Load more" button.
 */
const PAGE_SIZE = 50;

// ============================================================================
// Route Mapping
// ============================================================================

/**
 * Resolve the navigation route for a notification based on its parsed data.
 * Falls back to null (no navigation) for unknown types.
 */
function resolveNotificationRoute(data: NotificationData | null): string | null {
  if (!data) return null;

  // Explicit route in data payload
  if (data.route && typeof data.route === 'string') {
    return data.route;
  }

  // Type-based routing
  switch (data.type) {
    case 'ALERT':
    case 'alert':
      return data.entityId ? `/sensor/alerts` : '/sensor/alerts';
    case 'TASK':
    case 'task':
      return data.entityId ? `/sites/tasks` : '/sites/tasks';
    case 'SENSOR':
    case 'sensor':
      return '/sensor';
    case 'LEAVE_REQUEST':
    case 'leave':
      return '/hr/leaves';
    case 'ATTENDANCE':
    case 'attendance':
      return '/hr/attendance';
    case 'HARVEST':
    case 'harvest':
      return '/sites/harvest';
    case 'FEEDING':
    case 'feeding':
      return '/sites/feeding';
    case 'BILLING':
    case 'billing':
      return '/tenant/billing';
    case 'SUPPORT':
    case 'support':
      return '/tenant/support';
    case 'SYSTEM':
    case 'system':
      return '/admin/system/maintenance';
    default:
      return null;
  }
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Format a timestamp into a human-readable relative time.
 *
 * FE-HIGH-022: Uses Intl.DateTimeFormat with explicit timezone instead of
 * bare toLocaleDateString() which shows server UTC times as local times.
 */
function formatTimeAgo(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  // FE-HIGH-022: Always include timezone to prevent UTC/local mismatch
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'Europe/Istanbul',
  }).format(date);
}

/** Notification type icon/color indicator */
function getNotificationIndicator(data: NotificationData | null): {
  color: string;
  icon: string;
} {
  if (!data?.type) return { color: 'bg-blue-500', icon: 'info' };

  const type = data.type.toLowerCase();
  if (type.includes('alert') || type.includes('sensor'))
    return { color: 'bg-red-500', icon: 'alert' };
  if (type.includes('task'))
    return { color: 'bg-amber-500', icon: 'task' };
  if (type.includes('leave') || type.includes('attendance') || type.includes('hr'))
    return { color: 'bg-purple-500', icon: 'hr' };
  if (type.includes('harvest') || type.includes('feeding') || type.includes('farm'))
    return { color: 'bg-emerald-500', icon: 'farm' };
  if (type.includes('billing'))
    return { color: 'bg-orange-500', icon: 'billing' };
  if (type.includes('system'))
    return { color: 'bg-gray-500', icon: 'system' };

  return { color: 'bg-blue-500', icon: 'info' };
}

/** Single notification item */
const NotificationItem: React.FC<{
  notification: InAppNotification;
  data: NotificationData | null;
  onClick: () => void;
}> = ({ notification, data, onClick }) => {
  const indicator = getNotificationIndicator(data);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        w-full text-left px-4 py-3 flex items-start gap-3
        hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-b-0
        ${notification.isRead ? 'opacity-70' : ''}
      `}
    >
      {/* Indicator dot */}
      <div className="flex-shrink-0 mt-1">
        <div className={`w-2.5 h-2.5 rounded-full ${indicator.color} ${notification.isRead ? 'opacity-40' : ''}`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate ${notification.isRead ? 'text-gray-500 font-normal' : 'text-gray-900 font-semibold'}`}>
          {notification.title}
        </p>
        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
          {notification.body}
        </p>
        <p className="text-xs text-gray-400 mt-1">
          {formatTimeAgo(notification.createdAt)}
        </p>
      </div>

      {/* Unread indicator */}
      {!notification.isRead && (
        <div className="flex-shrink-0 mt-2">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
        </div>
      )}
    </button>
  );
};

/** Empty state */
const EmptyState: React.FC = () => (
  <div className="py-12 px-4 text-center">
    <svg
      className="w-12 h-12 mx-auto text-gray-300 mb-3"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
      />
    </svg>
    <p className="text-sm font-medium text-gray-500">No notifications</p>
    <p className="text-xs text-gray-400 mt-1">You're all caught up!</p>
  </div>
);

/** Loading skeleton */
const LoadingSkeleton: React.FC = () => (
  <div className="py-2">
    {[1, 2, 3].map((i) => (
      <div key={i} className="px-4 py-3 flex items-start gap-3 animate-pulse">
        <div className="w-2.5 h-2.5 rounded-full bg-gray-200 mt-1" />
        <div className="flex-1">
          <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
          <div className="h-3 bg-gray-100 rounded w-full mb-1" />
          <div className="h-3 bg-gray-100 rounded w-1/4 mt-2" />
        </div>
      </div>
    ))}
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const NotificationPanel: React.FC = () => {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const {
    notifications,
    unreadCount,
    loading,
    markAsRead,
    markAllAsRead,
    fetchNotifications,
    parseNotificationData,
  } = useNotifications();

  // --------------------------------------------------------------------------
  // Click-outside handler (only active when panel is open)
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // --------------------------------------------------------------------------
  // Toggle panel
  // --------------------------------------------------------------------------

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => {
      const opening = !prev;
      // Fetch full list on first open, or re-fetch on subsequent opens
      if (opening) {
        fetchNotifications();
        setHasFetched(true);
      }
      return opening;
    });
  }, [fetchNotifications]);

  // --------------------------------------------------------------------------
  // Notification click: mark as read + navigate
  // --------------------------------------------------------------------------

  const handleNotificationClick = useCallback(
    (notification: InAppNotification) => {
      // Mark as read if not already
      if (!notification.isRead) {
        markAsRead(notification.id);
      }

      // Navigate to relevant route
      const data = parseNotificationData(notification);
      const route = resolveNotificationRoute(data);

      // SECURITY: FE-HIGH-009 — Validate URL against allowlist to prevent
      // open redirect via crafted notification payload
      const validatedRoute = validateNavigationUrl(route);
      if (validatedRoute) {
        setIsOpen(false);
        navigate(validatedRoute);
      }
    },
    [markAsRead, parseNotificationData, navigate],
  );

  // --------------------------------------------------------------------------
  // Mark all as read
  // --------------------------------------------------------------------------

  const handleMarkAllRead = useCallback(() => {
    markAllAsRead();
  }, [markAllAsRead]);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  // ── FE-HIGH-034: Paginated notification list ──
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const paginatedNotifications = useMemo(
    () => notifications.slice(0, visibleCount),
    [notifications, visibleCount],
  );

  const hasMore = notifications.length > visibleCount;

  const handleLoadMore = useCallback(() => {
    setVisibleCount((prev) => prev + PAGE_SIZE);
  }, []);

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell Button */}
      <button
        type="button"
        onClick={handleToggle}
        className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        aria-label={`Notifications ${unreadCount > 0 ? `(${unreadCount} unread)` : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-96 max-h-[32rem] rounded-lg bg-white shadow-xl ring-1 ring-black/5 z-50 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
              {unreadCount > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  {unreadCount} new
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Notification List */}
          <div className="overflow-y-auto flex-1">
            {loading && !hasFetched ? (
              <LoadingSkeleton />
            ) : notifications.length === 0 ? (
              <EmptyState />
            ) : (
              <>
                {/* FE-HIGH-034: Render only the paginated subset to prevent unbounded DOM growth */}
                {paginatedNotifications.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                    data={parseNotificationData(notification)}
                    onClick={() => handleNotificationClick(notification)}
                  />
                ))}
                {hasMore && (
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    className="w-full py-2 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-gray-50 transition-colors"
                  >
                    Load more ({notifications.length - visibleCount} remaining)
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationPanel;
