import { clsx } from 'clsx';
import { ArrowLeft, Bell, CheckCheck, AlertCircle, RefreshCw } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { VirtualList } from '@/components/VirtualList';
import { useNotifications } from '@/hooks/useNotifications';
import type { InAppNotification } from '@/types';
import { runAsyncAction } from '@/utils/async-action';

/**
 * Notification deep-link payload. The backend serializes a JSON blob into
 * InAppNotification.data; the only field this page navigates on is taskId.
 * Parsing through this type keeps the JSON.parse result typed end-to-end
 * (no `any` member access) and documents the contract.
 */
interface NotificationDeepLink {
  taskId?: string;
}

function parseNotificationDeepLink(data: string | null | undefined): NotificationDeepLink | null {
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && 'taskId' in parsed) {
      const taskId: unknown = parsed.taskId;
      if (typeof taskId === 'string') {
        return { taskId };
      }
    }
    return {};
  } catch {
    // invalid JSON — no deep link to follow
    return null;
  }
}

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US');
}

export function NotificationsPage(): JSX.Element {
  const navigate = useNavigate();
  const { notifications, loading, error, markAsRead, markAllAsRead, unreadCount, refetch } = useNotifications();

  const handleNotificationPress = async (notification: InAppNotification): Promise<void> => {
    if (!notification.isRead) {
      await markAsRead(notification.id);
    }

    // Navigate based on notification deep-link data
    const deepLink = parseNotificationDeepLink(notification.data);
    if (deepLink?.taskId) {
      navigate(`/tasks/${deepLink.taskId}`);
    }
  };

  return (
    <div className="h-full min-h-screen flex flex-col bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-600 to-amber-500 text-white">
        <div className="flex items-center justify-between px-4 py-4 pt-safe-top">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="min-h-touch min-w-touch flex items-center justify-center -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <div className="flex items-center gap-2.5">
              <Bell size={22} />
              <h1 className="text-lg font-bold">Notifications</h1>
            </div>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={() => {
                runAsyncAction(markAllAsRead, 'notifications-mark-all-read');
              }}
              className="flex items-center gap-1.5 text-sm font-medium bg-white/20 px-3 py-1.5 rounded-lg touch-feedback"
            >
              <CheckCheck size={16} />
              Mark All Read
            </button>
          )}
        </div>
      </div>

      {/* Notification list — virtualized (MOB-MEDIUM-012): only the visible
          window mounts, so a long history cannot jank low-end devices. */}
      <div className="flex-1 min-h-0 flex flex-col px-4 pt-4">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-2xl skeleton" />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <AlertCircle size={48} className="mx-auto mb-3 text-amber-400 opacity-60" />
            <p className="font-medium text-gray-600 dark:text-gray-300">
              Notifications are not available yet
            </p>
            <p className="text-sm text-gray-400 mt-1">Please try again later</p>
            <button
              onClick={() => {
                void refetch();
              }}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-ocean-500 text-white rounded-xl text-sm font-semibold touch-feedback"
            >
              <RefreshCw size={16} />
              Retry
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <Bell size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No notifications yet</p>
            <p className="text-sm mt-1">You will see alerts and updates here</p>
          </div>
        ) : (
          <VirtualList
            items={notifications}
            getKey={(notification) => notification.id}
            estimateSize={() => 96}
            gapPx={8}
            className="flex-1 min-h-0 pb-24"
            renderItem={(notification) => (
              <button
                onClick={() => {
                  runAsyncAction(() => handleNotificationPress(notification), 'notifications-press');
                }}
                className={clsx(
                  'w-full bg-white dark:bg-gray-900 rounded-xl p-4 border text-left touch-feedback transition-all',
                  notification.isRead
                    ? 'border-gray-100 dark:border-gray-800'
                    : 'border-ocean-200 dark:border-ocean-800 bg-ocean-50/50 dark:bg-ocean-900/10',
                )}
              >
                <div className="flex items-start gap-3">
                  {/* Unread indicator dot */}
                  <div className="mt-1.5 flex-shrink-0">
                    {!notification.isRead ? (
                      <div className="w-2.5 h-2.5 rounded-full bg-ocean-500" />
                    ) : (
                      <div className="w-2.5 h-2.5 rounded-full bg-transparent" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3
                      className={clsx(
                        'text-sm font-semibold mb-0.5 truncate',
                        notification.isRead
                          ? 'text-gray-700 dark:text-gray-300'
                          : 'text-gray-900 dark:text-white',
                      )}
                    >
                      {notification.title}
                    </h3>
                    <p className="text-xs text-gray-500 line-clamp-2">{notification.body}</p>
                    <p className="text-[11px] text-gray-400 mt-1.5">{formatTimeAgo(notification.createdAt)}</p>
                  </div>
                </div>
              </button>
            )}
          />
        )}
      </div>
    </div>
  );
}
