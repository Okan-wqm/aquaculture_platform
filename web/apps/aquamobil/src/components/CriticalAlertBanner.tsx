import { AlertTriangle, ChevronRight } from 'lucide-react';
import { type ReactElement, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAlerts } from '@/hooks/useAlerts';
import { PUSH_NOTIFICATION_EVENT, type PushNotificationDetail } from '@/hooks/useFirebaseMessaging';

/**
 * MOB-HIGH-006: persistent, screen-topping banner for UNACKNOWLEDGED CRITICAL
 * alarms. A life-safety alert (oxygen crash, temperature runaway) must not
 * hide behind a bell badge — it stays on screen on every page until a human
 * acknowledges it. Fed by two lanes:
 *   - the 30s alertHistory poll (useAlerts), which also serves offline reads
 *   - foreground FCM pushes (`data.type === 'alert'`), which trigger an
 *     immediate refetch + a haptic alarm pattern (MOB-MEDIUM-007)
 *
 * v4 keeps this the LOUDEST element on any screen it appears on: a full-bleed
 * fill in the `crit` token (the design's alarm colour, and the only solid-fill
 * alarm surface in the app), the message a step LARGER than it was, and the
 * pulse intact. Every other v4 alarm surface is a tinted card with a coloured
 * border — this one is deliberately not, because it must out-shout them all.
 */
export function CriticalAlertBanner(): ReactElement | null {
  const navigate = useNavigate();
  const location = useLocation();
  const { criticalUnacknowledged, refetch } = useAlerts();

  const handlePush = useCallback(
    (event: Event): void => {
      const detail = (event as CustomEvent<PushNotificationDetail>).detail;
      if (detail?.data?.type !== 'alert') return;
      // MOB-MEDIUM-007: a critical alarm push gets a distinct haptic pattern —
      // field workers may not be looking at the screen.
      if (detail.data.severity?.toUpperCase() === 'CRITICAL' && 'vibrate' in navigator) {
        navigator.vibrate([200, 100, 200, 100, 200]);
      }
      void refetch();
    },
    [refetch],
  );

  useEffect(() => {
    window.addEventListener(PUSH_NOTIFICATION_EVENT, handlePush);
    return () => window.removeEventListener(PUSH_NOTIFICATION_EVENT, handlePush);
  }, [handlePush]);

  // On the alerts page itself the list IS the surface — the banner would just
  // cover the ack buttons it points at.
  if (criticalUnacknowledged.length === 0 || location.pathname.startsWith('/alerts')) {
    return null;
  }

  const top = criticalUnacknowledged[0];

  return (
    <div role="alert">
      <button
        onClick={() => navigate('/alerts')}
        aria-label={`${criticalUnacknowledged.length} unacknowledged critical alert${criticalUnacknowledged.length > 1 ? 's' : ''}`}
        className="w-full min-h-touch bg-crit text-white px-4 py-2.5 flex items-center gap-2.5 text-left touch-feedback animate-pulse"
      >
        <AlertTriangle size={20} className="shrink-0" />
        <span className="flex-1 text-title font-bold truncate">
          {criticalUnacknowledged.length > 1
            ? `${criticalUnacknowledged.length} critical alerts need acknowledgement`
            : top?.message}
        </span>
        <span className="text-meta font-semibold uppercase tracking-wide shrink-0 flex items-center">
          Acknowledge
          <ChevronRight size={16} />
        </span>
      </button>
    </div>
  );
}
