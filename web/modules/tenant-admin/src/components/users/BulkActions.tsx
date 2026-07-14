import React, { useState, useCallback } from 'react';
import { RefreshCw, UserMinus } from 'lucide-react';

export interface BulkDeactivateResult {
  userId: string;
  status: 'fulfilled' | 'rejected';
  reason?: string;
}

export interface BulkActionsProps {
  selectedUsers: string[];
  onDeactivate: (userId: string) => Promise<void>;
  onClearSelection: () => void;
  isDeactivating: boolean;
  canDeactivateUsers: boolean;
}

/**
 * Bulk action bar for user list.
 * FIX (HIGH-05): Uses Promise.allSettled instead of Promise.all for resilient bulk operations.
 * Shows per-item results (success/failure) after bulk operation.
 */
export const BulkActions: React.FC<BulkActionsProps> = ({
  selectedUsers,
  onDeactivate,
  onClearSelection,
  isDeactivating,
  canDeactivateUsers,
}) => {
  const [results, setResults] = useState<BulkDeactivateResult[]>([]);
  const [running, setRunning] = useState(false);

  const handleBulkDeactivate = useCallback(async () => {
    if (selectedUsers.length === 0 || !canDeactivateUsers) return;
    setResults([]);
    setRunning(true);

    const settled = await Promise.allSettled(
      selectedUsers.map((userId) => onDeactivate(userId))
    );

    const itemResults: BulkDeactivateResult[] = settled.map((result, idx) => ({
      userId: selectedUsers[idx],
      status: result.status,
      reason: result.status === 'rejected' ? String((result as PromiseRejectedResult).reason) : undefined,
    }));

    setResults(itemResults);
    setRunning(false);

    const allSucceeded = itemResults.every((r) => r.status === 'fulfilled');
    if (allSucceeded) {
      onClearSelection();
      setResults([]);
    }
  }, [selectedUsers, canDeactivateUsers, onDeactivate, onClearSelection]);

  if (selectedUsers.length === 0 || !canDeactivateUsers) return null;

  const failedCount = results.filter((r) => r.status === 'rejected').length;
  const successCount = results.filter((r) => r.status === 'fulfilled').length;

  return (
    <div className="bg-tenant-50 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-tenant-700">{selectedUsers.length} user(s) selected</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleBulkDeactivate}
            disabled={isDeactivating || running}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-700 bg-red-100 rounded-lg hover:bg-red-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDeactivating || running ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Deactivating...
              </>
            ) : (
              <>
                <UserMinus className="w-3.5 h-3.5" />
                Deactivate
              </>
            )}
          </button>
        </div>
      </div>
      {results.length > 0 && failedCount > 0 && (
        <div className="text-sm space-y-1">
          <p className="text-green-700">{successCount} user(s) deactivated successfully.</p>
          <p className="text-red-600">{failedCount} user(s) failed to deactivate:</p>
          <ul className="list-disc list-inside text-red-600 text-xs">
            {results
              .filter((r) => r.status === 'rejected')
              .map((r) => (
                <li key={r.userId}>{r.userId}: {r.reason}</li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
};
