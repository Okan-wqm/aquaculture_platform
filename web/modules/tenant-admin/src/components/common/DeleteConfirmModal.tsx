/**
 * DeleteConfirmModal Component
 *
 * A reusable confirmation dialog for delete operations.
 * Provides a consistent UI pattern for confirming destructive actions
 * with customizable title, message, and warning content.
 *
 * @module components/common/DeleteConfirmModal
 */

import React from 'react';
import { Trash2, RefreshCw, AlertTriangle } from 'lucide-react';

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
  /** Optional custom icon to display */
  icon?: React.ReactNode;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get variant-specific styles for the modal
 *
 * @param variant - The modal variant
 * @returns Object containing CSS classes and icon for the variant
 */
const getVariantStyles = (variant: DeleteConfirmVariant) => {
  switch (variant) {
    case 'warning':
      return {
        iconBg: 'bg-amber-100',
        iconColor: 'text-amber-600',
        buttonBg: 'bg-amber-600 hover:bg-amber-700',
        Icon: AlertTriangle,
      };
    case 'danger':
    default:
      return {
        iconBg: 'bg-red-100',
        iconColor: 'text-red-600',
        buttonBg: 'bg-red-600 hover:bg-red-700',
        Icon: Trash2,
      };
  }
};

// ============================================================================
// Main Component
// ============================================================================

/**
 * Reusable confirmation dialog for delete operations
 *
 * This component provides a consistent pattern for confirming destructive
 * actions across the application. It supports:
 * - Customizable title and message
 * - Optional warning message for additional context
 * - Loading state during async operations
 * - Multiple visual variants (danger, warning)
 * - Custom icons
 *
 * @example
 * ```tsx
 * // Basic usage
 * <DeleteConfirmModal
 *   isOpen={showDeleteModal}
 *   onClose={() => setShowDeleteModal(false)}
 *   onConfirm={handleDelete}
 *   message="Are you sure you want to delete this item?"
 * />
 *
 * // With warning message
 * <DeleteConfirmModal
 *   isOpen={showDeleteModal}
 *   onClose={() => setShowDeleteModal(false)}
 *   onConfirm={handleDelete}
 *   title="Delete User"
 *   message={`Are you sure you want to delete "${userName}"?`}
 *   warningMessage="This action cannot be undone."
 *   isLoading={isDeleting}
 * />
 *
 * // Warning variant
 * <DeleteConfirmModal
 *   isOpen={showArchiveModal}
 *   onClose={() => setShowArchiveModal(false)}
 *   onConfirm={handleArchive}
 *   title="Archive Item"
 *   message="Are you sure you want to archive this item?"
 *   variant="warning"
 *   confirmLabel="Archive"
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
  icon,
}) => {
  if (!isOpen) return null;

  const variantStyles = getVariantStyles(variant);
  const IconComponent = variantStyles.Icon;

  /**
   * Handle backdrop click to close modal
   */
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !isLoading) {
      onClose();
    }
  };

  /**
   * Handle keyboard events for accessibility
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !isLoading) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-description"
      >
        {/* Header with Icon */}
        <div className="flex items-center gap-4">
          <div
            className={`p-3 rounded-full ${variantStyles.iconBg}`}
            aria-hidden="true"
          >
            {icon || (
              <IconComponent className={`w-6 h-6 ${variantStyles.iconColor}`} />
            )}
          </div>
          <div>
            <h3
              id="delete-confirm-title"
              className="text-lg font-bold text-gray-900"
            >
              {title}
            </h3>
            <p
              id="delete-confirm-description"
              className="text-sm text-gray-500"
            >
              {message}
            </p>
          </div>
        </div>

        {/* Warning Message */}
        {warningMessage && (
          <div
            className="mt-4 p-3 bg-amber-50 rounded-lg border border-amber-100"
            role="alert"
          >
            <p className="text-sm text-amber-700">
              <AlertTriangle
                className="w-4 h-4 inline mr-1"
                aria-hidden="true"
              />
              {warningMessage}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={`px-4 py-2 text-sm font-medium text-white ${variantStyles.buttonBg} rounded-lg disabled:opacity-50 flex items-center gap-2 transition-colors`}
          >
            {isLoading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Processing...
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmModal;
