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
 * SUDERRA restyle — mint selection band; behavior unchanged.
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
    <div
      className="sd-banner"
      style={{ background: 'rgba(110,231,199,.16)', borderColor: 'rgba(74,187,162,.38)', display: 'flex', flexDirection: 'column', gap: 8 }}
      role="status"
    >
      <div className="sd-toolbar" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: '#166f5a' }}>
          {selectedUsers.length} user(s) selected
        </span>
        <button
          onClick={handleBulkDeactivate}
          disabled={isDeactivating || running}
          className="sd-btn-danger"
          style={{ padding: '7px 14px', fontSize: 12.5 }}
        >
          {isDeactivating || running ? (
            <>
              <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
              Deactivating…
            </>
          ) : (
            <>
              <UserMinus size={14} aria-hidden="true" />
              Deactivate
            </>
          )}
        </button>
      </div>
      {results.length > 0 && failedCount > 0 && (
        <div style={{ fontSize: 13, display: 'grid', gap: 4 }}>
          <p style={{ margin: 0, color: '#166f5a' }}>{successCount} user(s) deactivated successfully.</p>
          <p style={{ margin: 0, color: '#8e3a1e', fontWeight: 600 }}>{failedCount} user(s) failed to deactivate:</p>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#8e3a1e', fontSize: 12 }}>
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
