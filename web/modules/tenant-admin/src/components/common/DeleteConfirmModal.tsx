/**
 * DeleteConfirmModal Component
 *
 * A reusable confirmation dialog for delete operations.
 *
 * Thin wrapper over the shared-ui `ConfirmModal` (ADMIN-MEDIUM-004): keeps the
 * module-local props API so call sites don't churn; the dialog markup, focus
 * handling, and portal come from shared-ui. This is a LEAF modal — it never
 * opens another modal on top of itself, so it does not need the nested-trap
 * stack from `hooks/useFocusTrap`.
 *
 * All button labels are passed explicitly in English (shared-ui defaults are
 * Turkish).
 *
 * @module components/common/DeleteConfirmModal
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { ConfirmModal } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

/**
 * Variant options for the delete confirmation modal
 */
export type DeleteConfirmVariant = 'danger' | 'warning';

/**
 * Props for the DeleteConfirmModal component
 */
export interface DeleteConfirmModalProps {
  /** Whether the modal is currently visible */
  isOpen: boolean;
  /** Callback fired when the modal should close */
  onClose: () => void;
  /** Callback fired when deletion is confirmed */
  onConfirm: () => void;
  /** Modal title (default: "Confirm Delete") */
  title?: string;
  /** Main confirmation message describing what will be deleted */
  message: string;
  /** Optional warning message to display (e.g., affected items count) */
  warningMessage?: string;
  /** Label for the confirm button (default: "Delete") */
  confirmLabel?: string;
  /** Label for the cancel button (default: "Cancel") */
  cancelLabel?: string;
  /** Whether a delete operation is in progress */
  isLoading?: boolean;
  /** Visual variant for the modal (default: "danger") */
  variant?: DeleteConfirmVariant;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Reusable confirmation dialog for delete operations
 *
 * @example
 * ```tsx
 * <DeleteConfirmModal
 *   isOpen={showDeleteModal}
 *   onClose={() => setShowDeleteModal(false)}
 *   onConfirm={handleDelete}
 *   title="Delete User"
 *   message={`Are you sure you want to delete "${userName}"?`}
 *   warningMessage="This action cannot be undone."
 *   isLoading={isDeleting}
 * />
 * ```
 */
export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title = 'Confirm Delete',
  message,
  warningMessage,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  isLoading = false,
  variant = 'danger',
}) => (
  <ConfirmModal
    isOpen={isOpen}
    onClose={onClose}
    onConfirm={onConfirm}
    title={title}
    variant={variant}
    isLoading={isLoading}
    confirmText={confirmLabel}
    cancelText={cancelLabel}
    loadingText="Processing..."
    message={
      warningMessage ? (
        <>
          <p>{message}</p>
          <div
            className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-100 text-left"
            role="alert"
          >
            <p className="text-sm text-amber-700">
              <AlertTriangle className="w-4 h-4 inline mr-1" aria-hidden="true" />
              {warningMessage}
            </p>
          </div>
        </>
      ) : (
        message
      )
    }
  />
);

export default DeleteConfirmModal;
