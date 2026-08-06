import { clsx } from 'clsx';
import { Bell, CheckCheck, AlertCircle, RefreshCw } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Button, Chip, EmptyState, Skeleton } from '@/components/ui';
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

function parseNotificationDeepLink(data: string | undefined): NotificationDeepLink | null {
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
    <div className="h-full min-h-screen flex flex-col">
      <AppHeader
        title="Notifications"
        onBack={() => navigate(-1)}
        showAvatar={false}
        actions={
          unreadCount > 0 ? (
            <Chip
              tone="accent"
              onClick={() => {
                runAsyncAction(markAllAsRead, 'notifications-mark-all-read');
              }}
            >
              <CheckCheck size={16} />
              Mark All Read
            </Chip>
          ) : undefined
        }
      />

      {/* Notification list — virtualized (MOB-MEDIUM-012): only the visible
          window mounts, so a long history cannot jank low-end devices. */}
      <div className="flex-1 min-h-0 flex flex-col px-4">
        {loading ? (
          <Skeleton variant="tile" count={3} />
        ) : error ? (
          // "Not available yet" and "we could not reach it" are different facts,
          // and only the second is an error — the tone keeps them apart.
          <EmptyState
            tone="error"
            icon={<AlertCircle size={22} />}
            title="Notifications are not available yet"
            description="Please try again later"
            action={
              <Button
                variant="primary"
                onClick={() => {
                  void refetch();
                }}
              >
                <RefreshCw size={16} />
                Retry
              </Button>
            }
          />
        ) : notifications.length === 0 ? (
          <EmptyState
            icon={<Bell size={22} />}
            title="No notifications yet"
            description="You will see alerts and updates here"
          />
        ) : (
          <VirtualList
            items={notifications}
            getKey={(notification) => notification.id}
            estimateSize={() => 96}
            gapPx={8}
            className="flex-1 min-h-0 pb-24"
            renderItem={(notification) => (
              <button
                type="button"
                onClick={() => {
                  runAsyncAction(() => handleNotificationPress(notification), 'notifications-press');
                }}
                className={clsx(
                  'w-full min-h-touch rounded-2xl p-4 border text-left touch-feedback shadow-token',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                  notification.isRead
                    ? 'bg-surface-1 border-line'
                    : 'bg-acc-dim border-acc',
                )}
              >
                <div className="flex items-start gap-3">
                  {/* Unread indicator dot */}
                  <div className="mt-1.5 flex-shrink-0">
                    {!notification.isRead ? (
                      <div className="w-2.5 h-2.5 rounded-full bg-acc" />
                    ) : (
                      <div className="w-2.5 h-2.5 rounded-full bg-transparent" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3
                      className={clsx(
                        'text-body font-semibold mb-0.5 truncate',
                        notification.isRead ? 'text-ink-2' : 'text-ink-1',
                      )}
                    >
                      {notification.title}
                    </h3>
                    <p className="text-meta text-ink-2 line-clamp-2">{notification.body}</p>
                    <p className="text-meta text-ink-3 mt-1.5">
                      {formatTimeAgo(notification.createdAt)}
                    </p>
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
