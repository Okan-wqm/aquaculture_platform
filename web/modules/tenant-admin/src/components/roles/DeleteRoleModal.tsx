/**
 * DeleteRoleModal Component
 *
 * Specialized confirmation dialog for deleting tenant roles.
 * Displays role-specific information and warnings about affected users.
 *
 * Thin wrapper over the shared-ui `ConfirmModal` (ADMIN-MEDIUM-004): keeps the
 * module-local props API; the dialog markup comes from shared-ui. This is a
 * LEAF modal — it never opens another modal on top of itself.
 *
 * All button labels are passed explicitly in English (shared-ui defaults are
 * Turkish).
 *
 * @module components/roles/DeleteRoleModal
 */

import React from 'react';
import { AlertCircle } from 'lucide-react';
import { ConfirmModal } from '@aquaculture/shared-ui';
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
  isLoading = false,
}) => {
  if (!role) return null;

  return (
    <ConfirmModal
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Delete Role"
      variant="danger"
      isLoading={isLoading}
      confirmText="Delete Role"
      cancelText="Cancel"
      loadingText="Deleting..."
      message={
        <>
          <p>Are you sure you want to delete "{role.name}"?</p>
          {(role.userCount ?? 0) > 0 && (
            <div
              className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-100 text-left"
              role="alert"
            >
              <p className="text-sm text-amber-700">
                <AlertCircle className="w-4 h-4 inline mr-1" aria-hidden="true" />
                This role is assigned to {role.userCount ?? 0} user(s). They will lose
                access to associated permissions.
              </p>
            </div>
          )}
        </>
      }
    />
  );
};

export default DeleteRoleModal;
