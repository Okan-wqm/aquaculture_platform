import { clsx } from 'clsx';
import { CheckCircle, Clock, AlertTriangle, RefreshCw } from 'lucide-react';
import type { JSX } from 'react';

import { Button } from '@/components/ui';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { SyncStatus } from '@/hooks/useOfflineQueue';

interface QueuedStatusBadgeProps {
  /** The operationId returned by addToQueue(). */
  operationId: string;
  /** Optional callback when the user taps "retry" on a failed operation. */
  onRetry?: () => void;
}

/**
 * C7: Two-phase success UX badge. Shows honest sync status instead of
 * premature "Success!" when an operation is only queued locally.
 *
 * - pending: warn "Queued -- waiting for sync"
 * - syncing: accent spinner "Syncing..."
 * - synced: ok "Confirmed"
 * - failed: crit "Failed -- tap to retry"
 *
 * v4: each state is ONE token pair rather than four hand-written light/dark
 * ramps, so the four states stay distinguishable in night, day and colour.
 * `syncing` takes the accent because it is the in-flight/active state, which
 * is exactly what the teal is reserved for.
 */

/** Per-state token pair: the icon well's fill+ink, and the text ink. */
const STATE_TONE: Record<SyncStatus, { well: string; ink: string }> = {
  synced: { well: 'bg-surface-2 text-ok', ink: 'text-ok' },
  pending: { well: 'bg-warn-dim text-warn', ink: 'text-warn' },
  syncing: { well: 'bg-acc-dim text-acc', ink: 'text-acc' },
  failed: { well: 'bg-crit-dim text-crit', ink: 'text-crit' },
  // 'unknown' — the queue has no record of this operation. It renders no icon
  // and no copy (unchanged from pre-v4); neutral ink so the empty shell cannot
  // be read as a claim about whether the entry reached the farm.
  unknown: { well: 'bg-surface-2 text-ink-3', ink: 'text-ink-3' },
};

export function QueuedStatusBadge({ operationId, onRetry }: QueuedStatusBadgeProps): JSX.Element {
  const { getSyncStatus, isSyncing, syncNow } = useOfflineQueue();

  const status: SyncStatus = operationId ? getSyncStatus(operationId) : 'pending';

  const handleRetry = async (): Promise<void> => {
    if (onRetry) {
      onRetry();
      return;
    }
    await syncNow();
  };

  const tone = STATE_TONE[status];

  return (
    <div className="flex flex-col items-center gap-2">
      {/* ── Icon ── (absent for 'unknown', as before — an empty well would
          read as a state of its own) */}
      {status !== 'unknown' && (
        <div className={clsx('w-20 h-20 rounded-full flex items-center justify-center', tone.well)}>
          {status === 'synced' && <CheckCircle size={48} />}
          {status === 'pending' && <Clock size={48} />}
          {status === 'syncing' && <RefreshCw size={48} className="animate-spin" />}
          {status === 'failed' && <AlertTriangle size={48} />}
        </div>
      )}

      {/* ── Title ── */}
      <h2 className={clsx('text-head font-bold', tone.ink)}>
        {status === 'synced' && 'Confirmed'}
        {status === 'pending' && 'Queued'}
        {status === 'syncing' && 'Syncing...'}
        {status === 'failed' && 'Sync Failed'}
      </h2>

      {/* ── Subtitle ── */}
      <p className={clsx('text-body', tone.ink)}>
        {status === 'synced' && 'Saved to server successfully'}
        {status === 'pending' && 'Waiting for sync -- will send when online'}
        {status === 'syncing' && 'Sending to server...'}
        {status === 'failed' && 'Could not reach server'}
      </p>

      {/* ── Retry button for failed ── */}
      {status === 'failed' && (
        // Retry is a RECOVERY action, not a destructive one, so it wears the
        // accent rather than the alarm colour. Button also carries the 44px
        // floor the old `px-4 py-2` target fell short of (MOB-MEDIUM-009).
        <Button
          variant="primary"
          className="mt-2"
          onClick={() => {
            void handleRetry();
          }}
          disabled={isSyncing}
        >
          Tap to Retry
        </Button>
      )}
    </div>
  );
}
