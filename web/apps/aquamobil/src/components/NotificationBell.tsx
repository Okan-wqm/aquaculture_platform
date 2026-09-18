import { Bell } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { IconButton } from '@/components/ui';
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
    <IconButton
      onClick={() => navigate('/notifications')}
      aria-label={ariaLabel}
      // IconButton bakes in the 44px floor; the classes are ALSO named here
      // because src/__tests__/field-ergonomics.invariant.spec.ts reads this
      // file's text for them (MOB-MEDIUM-009). Keep both.
      className="min-h-touch min-w-touch bg-surface-2 rounded-xl relative"
    >
      <Bell size={18} className="text-ink-2" />
      {isCountError ? (
        // FE-LOW-051: warn, not crit — the count is unknown, which is not the
        // same claim as "there are alarms". Deliberately quieter than the
        // count badge below so the two states stay tellable apart.
        <span className="absolute -top-1 -right-1 bg-warn-dim border border-warn text-warn text-meta font-bold rounded-full min-w-[20px] h-5 flex items-center justify-center px-1">
          !
        </span>
      ) : (
        unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-crit text-white text-meta font-bold rounded-full min-w-[20px] h-5 flex items-center justify-center px-1 tabular-nums">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )
      )}
    </IconButton>
  );
}
