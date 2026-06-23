/**
 * @module ConfirmDialog
 * @description Reusable confirmation modal for destructive actions (leave channel,
 * delete channel, delete message). Follows iOS/Android alert dialog conventions
 * with backdrop dismiss and 48dp minimum touch targets.
 */

import type { ReactElement } from 'react';

interface ConfirmDialogProps {
  /** Dialog title. */
  title: string;
  /** Descriptive message explaining the action. */
  message: string;
  /** Text for the confirm button. */
  confirmLabel: string;
  /** Tailwind background class for the confirm button. Defaults to bg-red-600. */
  confirmColor?: string;
  /** Called when the user confirms the action. */
  onConfirm: () => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}

/**
 * ConfirmDialog renders a centered modal overlay with cancel/confirm buttons.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmColor,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6" role="dialog" aria-modal="true" aria-label={title}>
      {/* WHY a native <button> backdrop: a clickable dismiss target must be
          keyboard-operable and focusable. A native button supplies Enter/Space
          activation, focus, and the correct role with no extra handlers. */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
        aria-label="Dismiss dialog"
      />
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-xl max-w-sm w-full p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          {title}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          {message}
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 min-h-[48px] py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 min-h-[48px] py-2.5 rounded-xl ${confirmColor ?? 'bg-red-600'} text-white font-medium text-sm transition-colors`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
