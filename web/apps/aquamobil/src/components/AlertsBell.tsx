import { BellRing } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { IconButton } from '@/components/ui';
import { useAlerts } from '@/hooks/useAlerts';

/**
 * MOB-HIGH-006: header entry point to the alarm surface — a distinct bell for
 * ALARMS (alert-engine severity events), separate from the NotificationBell's
 * general in-app notifications, with the unacknowledged count as its badge.
 *
 * v4: the old `bg-white/10` fill assumed the ocean-gradient header this bell
 * used to sit in. AppHeader is now flat on the page ground, where a 10% white
 * wash is invisible — the button takes the same `bg-surface-2` well as the
 * header's own back button so the two read as one control group.
 */
export function AlertsBell(): ReactElement {
  const navigate = useNavigate();
  const { unacknowledgedCount } = useAlerts();

  const ariaLabel =
    unacknowledgedCount > 0 ? `Alerts, ${unacknowledgedCount} unacknowledged` : 'Alerts';

  return (
    <IconButton
      onClick={() => navigate('/alerts')}
      aria-label={ariaLabel}
      // IconButton bakes in the 44px floor; the classes are ALSO named here
      // because src/__tests__/field-ergonomics.invariant.spec.ts reads this
      // file's text for them (MOB-MEDIUM-009). Keep both.
      className="min-h-touch min-w-touch bg-surface-2 rounded-xl relative"
    >
      <BellRing size={18} className="text-ink-2" />
      {unacknowledgedCount > 0 && (
        <span className="absolute -top-1 -right-1 bg-crit text-white text-meta font-bold rounded-full min-w-[20px] h-5 flex items-center justify-center px-1 tabular-nums">
          {unacknowledgedCount > 99 ? '99+' : unacknowledgedCount}
        </span>
      )}
    </IconButton>
  );
}
