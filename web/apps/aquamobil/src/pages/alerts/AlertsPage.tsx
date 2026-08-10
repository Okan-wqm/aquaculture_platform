import { clsx } from 'clsx';
import { AlertTriangle, Check, CheckCheck, RefreshCw, WifiOff } from 'lucide-react';
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Button, Card, EmptyState, IconButton, SegmentedControl, Skeleton } from '@/components/ui';
import type { AlertSeverity } from '@/generated/graphql';
import { useAlerts, type MobileAlert } from '@/hooks/useAlerts';

/**
 * MOB-HIGH-006: the mobile alarm surface. Unacknowledged first, severity
 * styling, and one-tap acknowledge that works OFFLINE (the ack rides the
 * offline queue with the command envelope; the list flips optimistically).
 */

type StatusFilter = 'unacked' | 'all';

const STATUS_OPTIONS = [
  { value: 'unacked' as const, label: 'Needs Action' },
  { value: 'all' as const, label: 'All' },
];

/**
 * Severity → the tone its badge and icon take, plus the label.
 *
 * CRITICAL and HIGH share the alarm token, MEDIUM and WARNING share the watch
 * token: v4 has exactly ONE alarm colour and one watch colour, and the LABEL is
 * what separates the tiers inside each pair. That label is always rendered
 * beside the icon, so the distinction never rests on hue alone.
 */
const SEVERITY_STYLES: Record<AlertSeverity, { badge: string; icon: string; label: string }> = {
  CRITICAL: { badge: 'bg-crit-dim text-crit', icon: 'text-crit', label: 'Critical' },
  HIGH: { badge: 'bg-crit-dim text-crit', icon: 'text-crit', label: 'High' },
  MEDIUM: { badge: 'bg-warn-dim text-warn', icon: 'text-warn', label: 'Medium' },
  WARNING: { badge: 'bg-warn-dim text-warn', icon: 'text-warn', label: 'Warning' },
  LOW: { badge: 'bg-acc-dim text-acc', icon: 'text-acc', label: 'Low' },
  INFO: { badge: 'bg-surface-2 text-ink-2', icon: 'text-ink-3', label: 'Info' },
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US');
}

/**
 * One alarm.
 *
 * NOT a <ListRow>: the card carries a severity badge, a wrapping (not truncated)
 * message, the rule name, an acknowledgement stamp and the Acknowledge action
 * itself. ListRow truncates its title and subtitle to one line each and has no
 * slot for an action, so folding this into one would drop the text a worker
 * acknowledges the alarm ON.
 */
function AlertCard({
  alert,
  onAcknowledge,
  isAcknowledging,
}: {
  alert: MobileAlert;
  onAcknowledge: (alertId: string) => Promise<void>;
  isAcknowledging: boolean;
}): JSX.Element {
  const style = SEVERITY_STYLES[alert.severity];

  return (
    <Card
      className={clsx(
        'p-4',
        alert.acknowledged ? 'opacity-70' : alert.severity === 'CRITICAL' && 'border-crit',
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={22} className={clsx('mt-0.5 shrink-0', style.icon)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={clsx('px-2 py-0.5 rounded-full text-meta font-semibold', style.badge)}>
              {style.label}
            </span>
            <span className="text-meta text-ink-3">{formatTimeAgo(alert.triggeredAt)}</span>
          </div>
          <p className="text-body font-semibold text-ink-1 break-words">{alert.message}</p>
          <p className="text-meta text-ink-3 mt-0.5">{alert.ruleName}</p>
          {alert.acknowledged && (
            <p className="text-meta text-ok mt-1.5 flex items-center gap-1">
              <CheckCheck size={14} />
              Acknowledged{alert.acknowledgedAt ? ` · ${formatTimeAgo(alert.acknowledgedAt)}` : ''}
            </p>
          )}
        </div>
      </div>
      {!alert.acknowledged && (
        <Button
          variant="primary"
          block
          onClick={() => void onAcknowledge(alert.id)}
          disabled={isAcknowledging}
          className="mt-3"
        >
          <Check size={18} />
          Acknowledge
        </Button>
      )}
    </Card>
  );
}

export function AlertsPage(): JSX.Element {
  const navigate = useNavigate();
  const { alerts, unacknowledgedCount, isLoading, error, acknowledge, refetch } = useAlerts();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('unacked');
  const [ackingId, setAckingId] = useState<string | null>(null);

  // MOB-MEDIUM-007: the notification's Acknowledge action deep-links here as
  // /alerts?ack=<alertId> — the AUTHENTICATED app performs the ack (offline-
  // safe via the queue), never the credential-less service worker. Processed
  // at most once per alert id, then the param is dropped from the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const ackParam = searchParams.get('ack');
  const processedAckRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ackParam || processedAckRef.current === ackParam || isLoading) return;
    processedAckRef.current = ackParam;
    void acknowledge(ackParam).finally(() => {
      setSearchParams({}, { replace: true });
    });
  }, [ackParam, isLoading, acknowledge, setSearchParams]);

  const visible = useMemo(
    () => (statusFilter === 'unacked' ? alerts.filter((a) => !a.acknowledged) : alerts),
    [alerts, statusFilter],
  );

  const handleAcknowledge = async (alertId: string): Promise<void> => {
    setAckingId(alertId);
    try {
      await acknowledge(alertId);
    } finally {
      setAckingId(null);
    }
  };

  return (
    <div className="pb-32">
      <AppHeader
        title="Alerts"
        subtitle={
          unacknowledgedCount > 0
            ? `${unacknowledgedCount} alert${unacknowledgedCount > 1 ? 's' : ''} awaiting acknowledgement`
            : undefined
        }
        onBack={() => navigate(-1)}
        showAvatar={false}
        actions={
          <IconButton
            aria-label="Refresh alerts"
            onClick={() => void refetch()}
            className="bg-surface-2 rounded-xl"
          >
            <RefreshCw size={18} className="text-ink-2" />
          </IconButton>
        }
      />

      {/* Status filter */}
      <div className="px-4">
        <SegmentedControl
          label="Alert status"
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
        />
      </div>

      {/* List */}
      <div className="px-4 py-4 space-y-3">
        {isLoading && alerts.length === 0 && <Skeleton variant="tile" count={3} />}

        {error && alerts.length === 0 && (
          // A failed fetch is not "no alarms". On a boat with no signal the two
          // must never look the same — an all-clear the app cannot support is
          // worse than showing nothing.
          <EmptyState
            tone="error"
            icon={<WifiOff size={22} />}
            title="Could not load alerts"
            description={error}
            action={
              <Button variant="primary" onClick={() => void refetch()}>
                Retry
              </Button>
            }
          />
        )}

        {!isLoading && !error && visible.length === 0 && (
          <EmptyState
            icon={<CheckCheck size={22} />}
            title={statusFilter === 'unacked' ? 'All alerts acknowledged' : 'No alerts'}
            description={
              statusFilter === 'unacked'
                ? 'Nothing needs your attention right now.'
                : 'No alarm history in this window.'
            }
          />
        )}

        {visible.map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onAcknowledge={handleAcknowledge}
            isAcknowledging={ackingId === alert.id}
          />
        ))}
      </div>
    </div>
  );
}
