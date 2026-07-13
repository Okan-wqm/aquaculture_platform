import { BellRing } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAlerts } from '@/hooks/useAlerts';

/**
 * MOB-HIGH-006: header entry point to the alarm surface — a distinct bell for
 * ALARMS (alert-engine severity events), separate from the NotificationBell's
 * general in-app notifications, with the unacknowledged count as its badge.
 */
export function AlertsBell(): ReactElement {
  const navigate = useNavigate();
  const { unacknowledgedCount } = useAlerts();

  const ariaLabel =
    unacknowledgedCount > 0
      ? `Alerts, ${unacknowledgedCount} unacknowledged`
      : 'Alerts';

  return (
    <button
      onClick={() => navigate('/alerts')}
      aria-label={ariaLabel}
      className="min-h-touch min-w-touch flex items-center justify-center bg-white/10 rounded-xl touch-feedback hover:bg-white/20 transition-colors relative"
    >
      <BellRing size={18} />
      {unacknowledgedCount > 0 && (
        <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 shadow-sm">
          {unacknowledgedCount > 99 ? '99+' : unacknowledgedCount}
        </span>
      )}
    </button>
  );
}
