import { clsx } from 'clsx';
import {
  Cloud,
  CloudOff,
  RefreshCw,
  Trash2,
  CheckCircle,
  AlertCircle,
  Clock,
  RotateCcw,
} from 'lucide-react';
import type { JSX } from 'react';

import { AppHeader } from '@/components/AppHeader';
import { DataFreshness } from '@/components/DataFreshness';
import { Button, Card, EmptyState, IconButton } from '@/components/ui';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { MAX_RETRY_COUNT } from '@/pwa/offline-queue';
import { getLastSyncAt } from '@/utils/last-sync';

// WHY: Every OperationType must have a friendly label so the sync status page
// shows human-readable operation names. Without this, messaging and other operations
// fall through to the raw type string (e.g. 'sendMessage'), making the queue
// opaque to field operators. This map is the SINGLE source of truth for operation
// display names across the sync UI.
const OPERATION_LABELS: Record<string, { label: string; icon: string }> = {
  // Farm operations
  recordMortality: { label: 'Mortality', icon: '💀' },
  recordCull: { label: 'Cull', icon: '✂️' },
  createHarvestRecord: { label: 'Harvest', icon: '📦' },
  recordFeeding: { label: 'Feeding', icon: '🐟' },
  recordTransfer: { label: 'Transfer', icon: '🔄' },
  createWaterQuality: { label: 'Water Quality', icon: '💧' },
  // Warehouse operations
  recordStockMovement: { label: 'Stock Movement', icon: '📋' },
  transferStock: { label: 'Stock Transfer', icon: '🏭' },
  // HR operations
  clockIn: { label: 'Clock In', icon: '🕐' },
  clockOut: { label: 'Clock Out', icon: '🕑' },
  createLeaveRequest: { label: 'Leave Request', icon: '🏖️' },
  // Task operations
  completeTask: { label: 'Complete Task', icon: '✅' },
  startTask: { label: 'Start Task', icon: '▶️' },
  // Messaging operations — ADR-012
  sendMessage: { label: 'Send Message', icon: '💬' },
  editMessage: { label: 'Edit Message', icon: '✏️' },
  deleteMessage: { label: 'Delete Message', icon: '🗑️' },
  markMessagesRead: { label: 'Mark Read', icon: '👁️' },
};

export function SyncStatusPage(): JSX.Element {
  const { pendingOperations, pendingCount, isOnline, isSyncing, syncNow, removeFromQueue } =
    useOfflineQueue();

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="pb-32">
      <AppHeader title="Sync Status" showAvatar={false} />

      <div className="px-4 flex flex-col gap-4">
        {/* MOB-LOW-011: the global last-synced clock — every drain (auto or
            manual) updates the stamp; DataFreshness colors its age. */}
        <div className="flex items-center justify-center gap-1.5">
          <span className="text-meta text-ink-3">Last synced:</span>
          <DataFreshness timestamp={getLastSyncAt()} />
        </div>

        {/* Connection Status */}
        <Card
          className={clsx(
            'flex items-center justify-center gap-3 p-4',
            isOnline ? 'border-line' : 'border-warn',
          )}
        >
          {isOnline ? (
            <>
              <Cloud className="text-ok" size={32} />
              <div>
                <h3 className="text-title font-semibold text-ok">Online</h3>
                <p className="text-body text-ink-2">Connected to server</p>
              </div>
            </>
          ) : (
            <>
              <CloudOff className="text-warn offline-pulse" size={32} />
              <div>
                <h3 className="text-title font-semibold text-warn">Offline</h3>
                <p className="text-body text-ink-2">Changes will sync when connected</p>
              </div>
            </>
          )}
        </Card>

        {/* Pending Count */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-display font-mono font-bold text-ink-1 tabular-nums">
              {pendingCount}
            </h2>
            <p className="text-body text-ink-3">Pending Operations</p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              void syncNow();
            }}
            disabled={!isOnline || pendingCount === 0 || isSyncing}
          >
            <RefreshCw size={18} className={isSyncing ? 'animate-spin' : ''} />
            {isSyncing ? 'Syncing...' : 'Sync Now'}
          </Button>
        </div>

        {/* Pending Operations List */}
        {pendingOperations.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="text-body font-semibold text-ink-3 px-1">Pending Operations</h2>
            {pendingOperations.map((op) => {
              const config = OPERATION_LABELS[op.type] || { label: op.type, icon: '📝' };
              // BUG-17: Distinguish between retryable failures (will auto-retry)
              // and permanently failed operations (exceeded MAX_RETRY_COUNT).
              const isPermanentlyFailed =
                op.status === 'failed' && op.retryCount >= MAX_RETRY_COUNT;
              const isRetrying =
                op.status === 'failed' && op.retryCount > 0 && op.retryCount < MAX_RETRY_COUNT;

              const statusIcon =
                op.status === 'syncing' ? (
                  <RefreshCw size={16} className="animate-spin text-acc" />
                ) : isPermanentlyFailed ? (
                  <AlertCircle size={16} className="text-crit" />
                ) : isRetrying ? (
                  <RotateCcw size={16} className="text-warn" />
                ) : op.status === 'failed' ? (
                  <AlertCircle size={16} className="text-crit" />
                ) : (
                  <Clock size={16} className="text-ink-3" />
                );

              return (
                // NOT a <ListRow>: the subtitle here is a multi-line block —
                // retry count, "Will auto-retry", "Permanently failed" and the
                // server's error text. ListRow truncates its subtitle to one
                // line, which would hide exactly the sentence a worker needs in
                // order to know whether their entry is still going to land.
                <Card key={op.id} className="p-3 flex items-center gap-3">
                  <span aria-hidden className="text-title shrink-0">
                    {config.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-title font-medium text-ink-1">{config.label}</div>
                    <div className="text-meta text-ink-3">
                      {formatDate(op.createdAt)}
                      {op.retryCount > 0 && ` • Retries: ${op.retryCount}/${MAX_RETRY_COUNT}`}
                      {isRetrying && <span className="text-warn block">Will auto-retry</span>}
                      {isPermanentlyFailed && (
                        <span className="text-crit block">Permanently failed — please remove</span>
                      )}
                      {op.lastError && (
                        // SEC-07: Truncate error messages to limit social engineering
                        // potential from server-sourced text rendered in the UI.
                        <span className="text-crit block break-words">
                          Error: {op.lastError.slice(0, 200)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {statusIcon}
                    <IconButton
                      aria-label="Remove queued operation"
                      onClick={() => {
                        void removeFromQueue(op.id);
                      }}
                      className="text-crit"
                    >
                      <Trash2 size={18} />
                    </IconButton>
                  </div>
                </Card>
              );
            })}
          </section>
        ) : (
          <EmptyState
            icon={<CheckCircle size={22} />}
            title="All Synced!"
            description="No pending operations"
          />
        )}

        {/* Info */}
        <Card tone={2} elevated={false} className="p-4">
          <h4 className="text-title font-semibold text-ink-1 mb-2">How it works</h4>
          <ul className="text-body text-ink-2 space-y-1">
            <li>• Data entries are saved locally first</li>
            <li>• Automatic sync when online</li>
            <li>• Failed syncs auto-retry up to {MAX_RETRY_COUNT} times with backoff</li>
            <li>• Permanently failed entries can be manually removed</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
