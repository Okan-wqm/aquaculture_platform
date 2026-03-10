import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Bell, CheckCheck } from 'lucide-react';
import { useNotifications } from '@/hooks/useNotifications';
import { clsx } from 'clsx';

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Az once';
  if (minutes < 60) return `${minutes} dk once`;
  if (hours < 24) return `${hours} saat once`;
  if (days < 7) return `${days} gun once`;
  return new Date(dateStr).toLocaleDateString('tr-TR');
}

export function NotificationsPage() {
  const navigate = useNavigate();
  const { notifications, loading, markAsRead, markAllAsRead, unreadCount } = useNotifications();

  const handleNotificationPress = async (notification: typeof notifications[0]) => {
    if (!notification.isRead) {
      await markAsRead(notification.id);
    }

    // Navigate based on notification data
    if (notification.data) {
      try {
        const data = typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data;
        if (data.taskId) {
          navigate(`/tasks/${data.taskId}`);
          return;
        }
      } catch {
        // invalid data, ignore
      }
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-600 to-amber-500 text-white">
        <div className="flex items-center justify-between px-4 py-4 pt-safe-top">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <div className="flex items-center gap-2.5">
              <Bell size={22} />
              <h1 className="text-lg font-bold">Bildirimler</h1>
            </div>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllAsRead}
              className="flex items-center gap-1.5 text-sm font-medium bg-white/20 px-3 py-1.5 rounded-lg touch-feedback"
            >
              <CheckCheck size={16} />
              Tumunu Oku
            </button>
          )}
        </div>
      </div>

      {/* Notification list */}
      <div className="px-4 pt-4 space-y-2">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-2xl skeleton" />
            ))}
          </div>
        ) : notifications.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <Bell size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Bildirim yok</p>
          </div>
        ) : (
          notifications.map((notification) => (
            <button
              key={notification.id}
              onClick={() => handleNotificationPress(notification)}
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
          ))
        )}
      </div>

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
