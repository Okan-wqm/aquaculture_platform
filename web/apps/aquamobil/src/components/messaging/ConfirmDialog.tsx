// ---------------------------------------------------------------------------
// ConfirmDialog -- Reusable confirmation modal for destructive actions
// ---------------------------------------------------------------------------

/**
 * WHY: Extracted from ChannelSettingsPage to a shared component. Used for
 * leave channel, delete channel, and potentially delete message confirmations.
 * Follows iOS/Android alert dialog conventions with backdrop dismiss.
 */

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
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
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
            className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-2.5 rounded-xl ${confirmColor ?? 'bg-red-600'} text-white font-medium text-sm transition-colors`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
