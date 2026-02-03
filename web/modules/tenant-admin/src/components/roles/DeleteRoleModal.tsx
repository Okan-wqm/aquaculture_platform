/**
 * DeleteRoleModal Component
 *
 * Specialized confirmation dialog for deleting tenant roles.
 * Displays role-specific information and warnings about affected users.
 *
 * @module components/roles/DeleteRoleModal
 */

import React from 'react';
import { Trash2, RefreshCw, AlertCircle } from 'lucide-react';
import type { TenantRole } from '../../hooks/useTenantRoles';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the DeleteRoleModal component
 */
export interface DeleteRoleModalProps {
  /** Whether the modal is currently visible */
  isOpen: boolean;
  /** Callback fired when the modal should close */
  onClose: () => void;
  /** The role to be deleted */
  role: TenantRole | null;
  /** Callback fired when deletion is confirmed */
  onConfirm: () => void;
  /** Whether a delete operation is in progress */
  isLoading?: boolean;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Confirmation dialog for deleting tenant roles
 *
 * Provides a safe deletion workflow by:
 * - Displaying the role name prominently
 * - Warning about users who will be affected
 * - Requiring explicit confirmation
 * - Showing loading state during deletion
 *
 * @example
 * ```tsx
 * <DeleteRoleModal
 *   isOpen={!!deletingRole}
 *   onClose={() => setDeletingRole(null)}
 *   role={deletingRole}
 *   onConfirm={handleDeleteRole}
 *   isLoading={isDeleting}
 * />
 * ```
 */
export const DeleteRoleModal: React.FC<DeleteRoleModalProps> = ({
  isOpen,
  onClose,
  role,
  onConfirm,
  isLoading,
}) => {
  if (!isOpen || !role) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-role-title"
        aria-describedby="delete-role-description"
      >
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-full bg-red-100" aria-hidden="true">
            <Trash2 className="w-6 h-6 text-red-600" />
          </div>
          <div>
            <h3 id="delete-role-title" className="text-lg font-bold text-gray-900">
              Delete Role
            </h3>
            <p id="delete-role-description" className="text-sm text-gray-500">
              Are you sure you want to delete "{role.name}"?
            </p>
          </div>
        </div>

        {/* User count warning */}
        {(role.userCount ?? 0) > 0 && (
          <div
            className="mt-4 p-3 bg-amber-50 rounded-lg border border-amber-100"
            role="alert"
          >
            <p className="text-sm text-amber-700">
              <AlertCircle className="w-4 h-4 inline mr-1" aria-hidden="true" />
              This role is assigned to {role.userCount ?? 0} user(s). They will lose
              access to associated permissions.
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
          >
            {isLoading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete Role'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteRoleModal;
