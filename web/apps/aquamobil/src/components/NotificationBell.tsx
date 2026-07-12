import { Bell } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { useNotifications } from '@/hooks/useNotifications';

export function NotificationBell(): ReactElement {
  const navigate = useNavigate();
  const { unreadCount, isCountError } = useNotifications();

  // FE-LOW-051: a failed count fetch must not read as "0 unread". The error
  // affordance takes precedence over any (stale) numeric value so the bell
  // never claims "all caught up" while the count is actually unknown.
  const ariaLabel = isCountError
    ? 'Notifications, unread count unavailable'
    : unreadCount > 0
      ? `Notifications, ${unreadCount} unread`
      : 'Notifications';

  return (
    <button
      onClick={() => navigate('/notifications')}
      aria-label={ariaLabel}
      className="p-2.5 bg-white/10 rounded-xl touch-feedback hover:bg-white/20 transition-colors relative"
    >
      <Bell size={18} />
      {isCountError ? (
        <span className="absolute -top-1 -right-1 bg-amber-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 shadow-sm">
          !
        </span>
      ) : (
        unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 shadow-sm">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )
      )}
    </button>
  );
}
