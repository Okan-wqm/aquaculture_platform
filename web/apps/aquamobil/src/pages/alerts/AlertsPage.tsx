import { clsx } from 'clsx';
import { AlertTriangle, ArrowLeft, BellRing, Check, CheckCheck, RefreshCw } from 'lucide-react';
import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import type { AlertSeverity } from '@/generated/graphql';
import { useAlerts, type MobileAlert } from '@/hooks/useAlerts';

/**
 * MOB-HIGH-006: the mobile alarm surface. Unacknowledged first, severity
 * styling, and one-tap acknowledge that works OFFLINE (the ack rides the
 * offline queue with the command envelope; the list flips optimistically).
 */

type StatusFilter = 'unacked' | 'all';

const SEVERITY_STYLES: Record<AlertSeverity, { chip: string; icon: string; label: string }> = {
  CRITICAL: {
    chip: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    icon: 'text-red-600',
    label: 'Critical',
  },
  HIGH: {
    chip: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
    icon: 'text-orange-600',
    label: 'High',
  },
  MEDIUM: {
    chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    icon: 'text-amber-600',
    label: 'Medium',
  },
  WARNING: {
    chip: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300',
    icon: 'text-yellow-600',
    label: 'Warning',
  },
  LOW: {
    chip: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    icon: 'text-blue-600',
    label: 'Low',
  },
  INFO: {
    chip: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
    icon: 'text-gray-500',
    label: 'Info',
  },
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
    <div
      className={clsx(
        'bg-white dark:bg-gray-900 rounded-2xl shadow-card border p-4',
        alert.acknowledged
          ? 'border-gray-100 dark:border-gray-800 opacity-70'
          : alert.severity === 'CRITICAL'
            ? 'border-red-300 dark:border-red-800 shadow-glow-red'
            : 'border-gray-200 dark:border-gray-700',
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={22} className={clsx('mt-0.5 shrink-0', style.icon)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={clsx(
                'px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide',
                style.chip,
              )}
            >
              {style.label}
            </span>
            <span className="text-xs text-gray-400">{formatTimeAgo(alert.triggeredAt)}</span>
          </div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 break-words">
            {alert.message}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{alert.ruleName}</p>
          {alert.acknowledged && (
            <p className="text-xs text-green-600 dark:text-green-400 mt-1.5 flex items-center gap-1">
              <CheckCheck size={14} />
              Acknowledged{alert.acknowledgedAt ? ` · ${formatTimeAgo(alert.acknowledgedAt)}` : ''}
            </p>
          )}
        </div>
      </div>
      {!alert.acknowledged && (
        <button
          onClick={() => void onAcknowledge(alert.id)}
          disabled={isAcknowledging}
          className="mt-3 w-full min-h-[44px] flex items-center justify-center gap-2 rounded-xl bg-ocean-600 text-white font-semibold touch-feedback hover:bg-ocean-700 transition-colors disabled:opacity-60"
        >
          <Check size={18} />
          Acknowledge
        </button>
      )}
    </div>
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
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-red-600 to-red-500 text-white">
        <div className="flex items-center justify-between px-4 py-4 pt-safe-top">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate(-1)}
              aria-label="Back"
              className="p-2 -ml-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-white/10 touch-feedback"
            >
              <ArrowLeft size={22} />
            </button>
            <div className="flex items-center gap-2.5">
              <BellRing size={22} />
              <h1 className="text-lg font-bold">Alerts</h1>
            </div>
          </div>
          <button
            onClick={() => void refetch()}
            aria-label="Refresh alerts"
            className="p-2.5 min-h-[44px] min-w-[44px] flex items-center justify-center bg-white/10 rounded-xl touch-feedback hover:bg-white/20"
          >
            <RefreshCw size={18} />
          </button>
        </div>
        {unacknowledgedCount > 0 && (
          <div className="px-4 pb-3 text-sm font-semibold">
            {unacknowledgedCount} alert{unacknowledgedCount > 1 ? 's' : ''} awaiting acknowledgement
          </div>
        )}
      </div>

      {/* Status filter */}
      <div className="px-4 pt-4 flex gap-2">
        {(['unacked', 'all'] as const).map((filter) => (
          <button
            key={filter}
            onClick={() => setStatusFilter(filter)}
            className={clsx(
              'px-4 min-h-[44px] rounded-xl text-sm font-semibold touch-feedback transition-colors',
              statusFilter === filter
                ? 'bg-ocean-600 text-white'
                : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700',
            )}
          >
            {filter === 'unacked' ? 'Needs Action' : 'All'}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="px-4 py-4 space-y-3 pb-24">
        {isLoading && alerts.length === 0 && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-28 rounded-2xl bg-gray-200 dark:bg-gray-800 animate-pulse"
              />
            ))}
          </div>
        )}

        {error && alerts.length === 0 && (
          <div className="text-center py-10">
            <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
            <button
              onClick={() => void refetch()}
              className="min-h-[44px] px-6 rounded-xl bg-ocean-600 text-white font-semibold touch-feedback"
            >
              Retry
            </button>
          </div>
        )}

        {!isLoading && !error && visible.length === 0 && (
          <div className="text-center py-14">
            <CheckCheck size={40} className="mx-auto text-green-500 mb-3" />
            <p className="font-semibold text-gray-900 dark:text-gray-100">
              {statusFilter === 'unacked' ? 'All alerts acknowledged' : 'No alerts'}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {statusFilter === 'unacked'
                ? 'Nothing needs your attention right now.'
                : 'No alarm history in this window.'}
            </p>
          </div>
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
