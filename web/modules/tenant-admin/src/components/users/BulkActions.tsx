import React, { useState, useCallback } from 'react';
import { RefreshCw, UserMinus, ShieldCheck } from 'lucide-react';
import type { TenantRole } from '../../hooks/useTenantRoles';
import type { BulkAssignRoleResult } from '../../lib/types';
import { DeleteConfirmModal } from '../common';

export interface BulkDeactivateResult {
  userId: string;
  status: 'fulfilled' | 'rejected';
  reason?: string;
}

export interface BulkActionsProps {
  selectedUsers: string[];
  onDeactivate: (userId: string) => Promise<void>;
  /**
   * Bulk role assignment (ADMIN-MEDIUM-016). The page-level handler runs the
   * mutation and toasts the outcome summary; the resolved result lets this
   * component clear the selection when every user succeeded.
   */
  onAssignRole: (roleId: string) => Promise<BulkAssignRoleResult>;
  onClearSelection: () => void;
  isDeactivating: boolean;
  isAssigningRole: boolean;
  roles: TenantRole[];
  canManageUsers: boolean;
}

/**
 * Bulk action bar for user list.
 * FIX (HIGH-05): Uses Promise.allSettled instead of Promise.all for resilient bulk operations.
 * Shows per-item results (success/failure) after bulk operation.
 */
export const BulkActions: React.FC<BulkActionsProps> = ({
  selectedUsers,
  onDeactivate,
  onAssignRole,
  onClearSelection,
  isDeactivating,
  isAssigningRole,
  roles,
  canManageUsers,
}) => {
  const [results, setResults] = useState<BulkDeactivateResult[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [isAssignConfirmOpen, setIsAssignConfirmOpen] = useState(false);

  const handleBulkDeactivate = useCallback(async () => {
    if (selectedUsers.length === 0 || !canManageUsers) return;
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
  }, [selectedUsers, canManageUsers, onDeactivate, onClearSelection]);

  const handleConfirmAssignRole = useCallback(async () => {
    if (!selectedRoleId || selectedUsers.length === 0 || !canManageUsers) return;
    try {
      const result = await onAssignRole(selectedRoleId);
      setIsAssignConfirmOpen(false);
      if (result.failed.length === 0) {
        setSelectedRoleId('');
        onClearSelection();
      }
    } catch {
      // The page-level handler already toasted the failure; keep the
      // selection so the admin can retry.
      setIsAssignConfirmOpen(false);
    }
  }, [selectedRoleId, selectedUsers, canManageUsers, onAssignRole, onClearSelection]);

  if (selectedUsers.length === 0 || !canManageUsers) return null;

  const failedCount = results.filter((r) => r.status === 'rejected').length;
  const successCount = results.filter((r) => r.status === 'fulfilled').length;
  const selectedRole = roles.find((r) => r.id === selectedRoleId);

  return (
    <div className="bg-tenant-50 rounded-xl p-4 space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <span className="text-sm text-tenant-700">{selectedUsers.length} user(s) selected</span>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            aria-label="Role to assign"
            value={selectedRoleId}
            onChange={(e) => setSelectedRoleId(e.target.value)}
            disabled={isAssigningRole}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-hidden focus:ring-2 focus:ring-tenant-500 disabled:opacity-50"
          >
            <option value="">Select role...</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setIsAssignConfirmOpen(true)}
            disabled={!selectedRoleId || isAssigningRole}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-tenant-700 bg-tenant-100 rounded-lg hover:bg-tenant-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isAssigningRole ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Assigning...
              </>
            ) : (
              <>
                <ShieldCheck className="w-3.5 h-3.5" />
                Assign role
              </>
            )}
          </button>
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

      <DeleteConfirmModal
        isOpen={isAssignConfirmOpen}
        onClose={() => setIsAssignConfirmOpen(false)}
        onConfirm={handleConfirmAssignRole}
        title="Assign Role"
        message={`Assign the role "${selectedRole?.name ?? ''}" to ${selectedUsers.length} selected user(s)? Existing role assignments will be replaced.`}
        confirmLabel="Assign Role"
        cancelLabel="Cancel"
        variant="warning"
        isLoading={isAssigningRole}
      />
    </div>
  );
};
