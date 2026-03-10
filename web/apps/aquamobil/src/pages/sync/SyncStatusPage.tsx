import { Navbar, Block, BlockTitle, Button, List, ListItem } from 'konsta/react';
import { Cloud, CloudOff, RefreshCw, Trash2, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { clsx } from 'clsx';

// BUG-06: Include recordFeeding so feeding queue entries show a friendly label.
const OPERATION_LABELS: Record<string, { label: string; icon: string }> = {
  recordMortality: { label: 'Mortality', icon: '💀' },
  recordCull: { label: 'Cull', icon: '✂️' },
  createHarvestRecord: { label: 'Harvest', icon: '📦' },
  recordFeeding: { label: 'Feeding', icon: '🐟' },
};

export function SyncStatusPage() {
  const { pendingOperations, pendingCount, isOnline, isSyncing, syncNow, removeFromQueue } =
    useOfflineQueue();

  const formatDate = (dateStr: string) => {
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
            onClick={syncNow}
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
              const statusIcon =
                op.status === 'syncing' ? (
                  <RefreshCw size={16} className="animate-spin text-blue-500" />
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
                      {op.retryCount > 0 && ` • Retries: ${op.retryCount}`}
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
                        onClick={() => removeFromQueue(op.id)}
                        className="p-2 text-red-500 touch-feedback"
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
            <li>• Failed syncs retry up to 3 times</li>
            <li>• You can manually remove failed entries</li>
          </ul>
        </div>
      </Block>

      {/* Spacer for bottom nav */}
      <div className="h-20" />
    </>
  );
}
