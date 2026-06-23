import { clsx } from 'clsx';
import { CheckCircle, Clock, AlertTriangle, RefreshCw } from 'lucide-react';
import type { JSX } from 'react';

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
 * - pending: amber "Queued -- waiting for sync"
 * - syncing: spinner "Syncing..."
 * - synced: green "Confirmed"
 * - failed: red "Failed -- tap to retry"
 */
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

  return (
    <div className="flex flex-col items-center gap-2">
      {/* ── Icon ── */}
      {status === 'synced' && (
        <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
          <CheckCircle size={48} className="text-green-600" />
        </div>
      )}
      {status === 'pending' && (
        <div className="w-20 h-20 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center">
          <Clock size={48} className="text-amber-600" />
        </div>
      )}
      {status === 'syncing' && (
        <div className="w-20 h-20 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
          <RefreshCw size={48} className="text-blue-600 animate-spin" />
        </div>
      )}
      {status === 'failed' && (
        <div className="w-20 h-20 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
          <AlertTriangle size={48} className="text-red-600" />
        </div>
      )}

      {/* ── Title ── */}
      <h2
        className={clsx(
          'text-xl font-bold',
          status === 'synced' && 'text-green-700 dark:text-green-300',
          status === 'pending' && 'text-amber-700 dark:text-amber-300',
          status === 'syncing' && 'text-blue-700 dark:text-blue-300',
          status === 'failed' && 'text-red-700 dark:text-red-300',
        )}
      >
        {status === 'synced' && 'Confirmed'}
        {status === 'pending' && 'Queued'}
        {status === 'syncing' && 'Syncing...'}
        {status === 'failed' && 'Sync Failed'}
      </h2>

      {/* ── Subtitle ── */}
      <p
        className={clsx(
          'text-sm',
          status === 'synced' && 'text-green-600 dark:text-green-400',
          status === 'pending' && 'text-amber-600 dark:text-amber-400',
          status === 'syncing' && 'text-blue-600 dark:text-blue-400',
          status === 'failed' && 'text-red-600 dark:text-red-400',
        )}
      >
        {status === 'synced' && 'Saved to server successfully'}
        {status === 'pending' && 'Waiting for sync -- will send when online'}
        {status === 'syncing' && 'Sending to server...'}
        {status === 'failed' && 'Could not reach server'}
      </p>

      {/* ── Retry button for failed ── */}
      {status === 'failed' && (
        <button
          onClick={() => {
            void handleRetry();
          }}
          disabled={isSyncing}
          className="mt-2 px-4 py-2 bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 font-semibold text-sm rounded-xl border border-red-200 dark:border-red-800 touch-feedback disabled:opacity-50"
        >
          Tap to Retry
        </button>
      )}
    </div>
  );
}
