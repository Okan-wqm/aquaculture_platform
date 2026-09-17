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
      className="sd-modal-backdrop"
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
    >
      {/* Modal — SUDERRA parchment panel */}
      <div
        className="sd-modal"
        style={{ maxWidth: '26rem', width: '100%' }}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-description"
      >
        <div className="sd-modal-body">
          {/* Header with Icon */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              className={variantStyles.iconBg}
              style={{ display: 'grid', placeItems: 'center', padding: 11, borderRadius: 999 }}
              aria-hidden="true"
            >
              {icon || (
                <IconComponent className={`w-5 h-5 ${variantStyles.iconColor}`} />
              )}
            </div>
            <div>
              <h3
                id="delete-confirm-title"
                className="sd-modal-title"
                style={{ fontSize: 17 }}
              >
                {title}
              </h3>
              <p
                id="delete-confirm-description"
                style={{ margin: '3px 0 0', fontSize: 13, color: '#5c7783' }}
              >
                {message}
              </p>
            </div>
          </div>

          {/* Warning Message */}
          {warningMessage && (
            <div
              className="sd-banner"
              style={{ marginTop: 14, background: '#fbf3dc', borderColor: 'rgba(146,97,10,.28)' }}
              role="alert"
            >
              <p style={{ margin: 0, fontSize: 13, color: '#92610a', display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                <AlertTriangle
                  size={14}
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                {warningMessage}
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="sd-modal-foot">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="sd-btn-ghost"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className="sd-btn-danger"
          >
            {isLoading ? (
              <>
                <RefreshCw size={15} className="animate-spin" aria-hidden="true" />
                Processing…
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
