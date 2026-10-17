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
 *
 * Every word is a message key and every date follows the active locale
 * (FE-HIGH-089): the bell sits in the tenant console header beside controls
 * that speak the reader's language, and a Turkish reader was told
 * "Notifications (3 unread)". In that header the panel hangs from the header
 * at its gutter where the row wraps (the Popover's `header-gutter` anchor, as
 * the user menu does): anchored to the bell, it opened past the screen's left
 * edge on a phone. The unread badge is error-600: its white 12px bold text
 * holds 4.5:1 there in both themes and every console workspace (error-500 was
 * 3.55:1).
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  validateNavigationUrl,
  Popover,
  toIntlLocale,
  useI18n,
  type I18nContextValue,
} from '@aquaculture/shared-ui';
import {
  useNotifications,
  type InAppNotification,
  type NotificationData,
} from '@/hooks/useNotifications';
import { Bell } from 'lucide-react';

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
 * Format a timestamp into a human-readable relative time, in the reader's
 * language: the relative steps are message keys, an older date is formatted
 * for the active locale.
 *
 * FE-HIGH-022: Uses Intl.DateTimeFormat with explicit timezone instead of
 * bare toLocaleDateString() which shows server UTC times as local times.
 */
function formatTimeAgo(
  dateString: string,
  { t, locale }: Pick<I18nContextValue, 't' | 'locale'>,
): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return t('notifications.timeAgo.justNow');
  if (diffMinutes < 60) return t('notifications.timeAgo.minutes', { count: diffMinutes });
  if (diffHours < 24) return t('notifications.timeAgo.hours', { count: diffHours });
  if (diffDays < 7) return t('notifications.timeAgo.days', { count: diffDays });

  // FE-HIGH-022: Always include timezone to prevent UTC/local mismatch
  return new Intl.DateTimeFormat(toIntlLocale(locale), {
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
  if (!data?.type) return { color: 'bg-info-500', icon: 'info' };

  const type = data.type.toLowerCase();
  if (type.includes('alert') || type.includes('sensor'))
    return { color: 'bg-error-500', icon: 'alert' };
  if (type.includes('task')) return { color: 'bg-warning-500', icon: 'task' };
  if (type.includes('leave') || type.includes('attendance') || type.includes('hr'))
    return { color: 'bg-accent-500', icon: 'hr' };
  if (type.includes('harvest') || type.includes('feeding') || type.includes('farm'))
    return { color: 'bg-success-500', icon: 'farm' };
  if (type.includes('billing')) return { color: 'bg-accent-500', icon: 'billing' };
  if (type.includes('system')) return { color: 'bg-gray-500', icon: 'system' };

  return { color: 'bg-info-500', icon: 'info' };
}

/** Single notification item */
const NotificationItem: React.FC<{
  notification: InAppNotification;
  data: NotificationData | null;
  onClick: () => void;
}> = ({ notification, data, onClick }) => {
  const i18n = useI18n();
  const indicator = getNotificationIndicator(data);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        w-full text-left px-4 py-3 flex items-start gap-3
        hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border-b border-gray-100 dark:border-gray-700 last:border-b-0
        ${notification.isRead ? 'opacity-70' : ''}
      `}
    >
      {/* Indicator dot */}
      <div className="flex-shrink-0 mt-1">
        <div
          className={`w-2.5 h-2.5 rounded-full ${indicator.color} ${notification.isRead ? 'opacity-40' : ''}`}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm truncate ${notification.isRead ? 'text-gray-500 dark:text-gray-400 font-normal' : 'text-gray-900 dark:text-gray-100 font-semibold'}`}
        >
          {notification.title}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">
          {notification.body}
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          {formatTimeAgo(notification.createdAt, i18n)}
        </p>
      </div>

      {/* Unread indicator */}
      {!notification.isRead && (
        <div className="flex-shrink-0 mt-2">
          <div className="w-2 h-2 rounded-full bg-info-500" />
        </div>
      )}
    </button>
  );
};

/** Empty state */
const EmptyState: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="py-12 px-4 text-center">
      <Bell className="w-12 h-12 mx-auto text-gray-300 mb-3" aria-hidden="true" />
      <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
        {t('notifications.empty.title')}
      </p>
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
        {t('notifications.empty.subtitle')}
      </p>
    </div>
  );
};

/** Loading skeleton */
const LoadingSkeleton: React.FC = () => (
  <div className="py-2">
    {[1, 2, 3].map((i) => (
      <div key={i} className="px-4 py-3 flex items-start gap-3 animate-pulse">
        <div className="w-2.5 h-2.5 rounded-full bg-gray-200 dark:bg-gray-700 mt-1" />
        <div className="flex-1">
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4 mb-2" />
          <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-full mb-1" />
          <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-1/4 mt-2" />
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
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

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
  // Toggle panel
  // --------------------------------------------------------------------------

  const handleOpenChange = useCallback(
    (opening: boolean) => {
      // Fetch full list on first open, or re-fetch on subsequent opens
      if (opening) {
        fetchNotifications();
        setHasFetched(true);
      }
      setIsOpen(opening);
    },
    [fetchNotifications],
  );

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
    <Popover
      open={isOpen}
      onOpenChange={handleOpenChange}
      aria-label={t('notifications.title')}
      anchor="header-gutter"
      panelClassName="w-96"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className="relative p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          aria-label={
            unreadCount > 0
              ? t('notifications.triggerUnread', { count: unreadCount })
              : t('notifications.title')
          }
        >
          <Bell className="w-6 h-6" aria-hidden="true" />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-error-600 rounded-full">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      )}
    >
      {/* Panel content */}
      {isOpen && (
        <div className="max-h-[32rem] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('notifications.title')}
              </h3>
              {unreadCount > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200">
                  {t('notifications.new', { count: unreadCount })}
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs font-medium text-info-600 dark:text-info-400 hover:text-info-800 dark:hover:text-info-200 transition-colors"
              >
                {t('notifications.markAllRead')}
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
                    className="w-full py-2 text-xs font-medium text-info-600 hover:text-info-800 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    {t('notifications.loadMore', { count: notifications.length - visibleCount })}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
};

export default NotificationPanel;
