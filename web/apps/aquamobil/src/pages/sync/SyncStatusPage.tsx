import { clsx } from 'clsx';
import { Navbar, Block, BlockTitle, Button, List, ListItem } from 'konsta/react';
import { Cloud, CloudOff, RefreshCw, Trash2, CheckCircle, AlertCircle, Clock, RotateCcw } from 'lucide-react';
import type { JSX } from 'react';

import { DataFreshness } from '@/components/DataFreshness';
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
    <>
      <Navbar title="Sync Status" />

      {/* MOB-LOW-011: the global last-synced clock — every drain (auto or
          manual) updates the stamp; DataFreshness colors its age. */}
      <div className="flex items-center justify-center gap-1.5 pt-2">
        <span className="text-xs text-gray-500 dark:text-gray-400">Last synced:</span>
        <DataFreshness timestamp={getLastSyncAt()} />
      </div>

      {/* Connection Status */}
      <Block className="!mt-0">
        <div
          className={clsx(
            'flex items-center justify-center gap-3 p-4 rounded-xl',
            isOnline
              ? 'bg-green-50 dark:bg-green-900/20'
              : 'bg-amber-50 dark:bg-amber-900/20'
          )}
        >
          {isOnline ? (
            <>
              <Cloud className="text-green-500" size={32} />
              <div>
                <h3 className="font-semibold text-green-700 dark:text-green-300">Online</h3>
                <p className="text-sm text-green-600 dark:text-green-400">
                  Connected to server
                </p>
              </div>
            </>
          ) : (
            <>
              <CloudOff className="text-amber-500 offline-pulse" size={32} />
              <div>
                <h3 className="font-semibold text-amber-700 dark:text-amber-300">Offline</h3>
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  Changes will sync when connected
                </p>
              </div>
            </>
          )}
        </div>
      </Block>

      {/* Pending Count */}
      <Block>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{pendingCount}</h2>
            <p className="text-gray-500">Pending Operations</p>
          </div>
          <Button
            onClick={() => { void syncNow(); }}
            disabled={!isOnline || pendingCount === 0 || isSyncing}
            className="!bg-aqua-500"
          >
            <RefreshCw size={18} className={isSyncing ? 'animate-spin' : ''} />
            <span className="ml-2">{isSyncing ? 'Syncing...' : 'Sync Now'}</span>
          </Button>
        </div>
      </Block>

      {/* Pending Operations List */}
      {pendingOperations.length > 0 ? (
        <>
          <BlockTitle>Pending Operations</BlockTitle>
          <List strongIos insetIos>
            {pendingOperations.map((op) => {
              const config = OPERATION_LABELS[op.type] || { label: op.type, icon: '📝' };
              // BUG-17: Distinguish between retryable failures (will auto-retry)
              // and permanently failed operations (exceeded MAX_RETRY_COUNT).
              const isPermanentlyFailed = op.status === 'failed' && op.retryCount >= MAX_RETRY_COUNT;
              const isRetrying = op.status === 'failed' && op.retryCount > 0 && op.retryCount < MAX_RETRY_COUNT;

              const statusIcon =
                op.status === 'syncing' ? (
                  <RefreshCw size={16} className="animate-spin text-blue-500" />
                ) : isPermanentlyFailed ? (
                  <AlertCircle size={16} className="text-red-500" />
                ) : isRetrying ? (
                  <RotateCcw size={16} className="text-amber-500" />
                ) : op.status === 'failed' ? (
                  <AlertCircle size={16} className="text-red-500" />
                ) : (
                  <Clock size={16} className="text-gray-400" />
                );

              return (
                <ListItem
                  key={op.id}
                  title={
                    <span className="flex items-center gap-2">
                      <span>{config.icon}</span>
                      <span>{config.label}</span>
                    </span>
                  }
                  subtitle={
                    <span className="text-xs">
                      {formatDate(op.createdAt)}
                      {op.retryCount > 0 && ` • Retries: ${op.retryCount}/${MAX_RETRY_COUNT}`}
                      {isRetrying && (
                        <span className="text-amber-600 dark:text-amber-400 block">
                          Will auto-retry
                        </span>
                      )}
                      {isPermanentlyFailed && (
                        <span className="text-red-600 dark:text-red-400 block">
                          Permanently failed — please remove
                        </span>
                      )}
                      {op.lastError && (
                        // SEC-07: Truncate error messages to limit social engineering
                        // potential from server-sourced text rendered in the UI.
                        <span className="text-red-500 block">
                          Error: {op.lastError.slice(0, 200)}
                        </span>
                      )}
                    </span>
                  }
                  after={
                    <div className="flex items-center gap-2">
                      {statusIcon}
                      <button
                        onClick={() => { void removeFromQueue(op.id); }}
                        aria-label="Remove queued operation"
                        className="min-h-touch min-w-touch flex items-center justify-center text-red-500 touch-feedback"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  }
                />
              );
            })}
          </List>
        </>
      ) : (
        <Block>
          <div className="text-center py-12">
            <CheckCircle size={48} className="mx-auto text-green-500 mb-4" />
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1">All Synced!</h3>
            <p className="text-gray-500 text-sm">No pending operations</p>
          </div>
        </Block>
      )}

      {/* Info */}
      <Block>
        <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4">
          <h4 className="font-medium text-gray-900 dark:text-white mb-2">How it works</h4>
          <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
            <li>• Data entries are saved locally first</li>
            <li>• Automatic sync when online</li>
            <li>• Failed syncs auto-retry up to {MAX_RETRY_COUNT} times with backoff</li>
            <li>• Permanently failed entries can be manually removed</li>
          </ul>
        </div>
      </Block>

      {/* Spacer for bottom nav */}
      <div className="h-20" />
    </>
  );
}
