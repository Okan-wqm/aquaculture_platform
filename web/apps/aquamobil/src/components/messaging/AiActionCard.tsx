/**
 * AiActionCard -- Card for AI-proposed write actions.
 *
 * WHY: When the AI proposes a write action (e.g., "Create task: Check water quality
 * in Tank A3"), the user must explicitly confirm or cancel. This card renders
 * the action description and two 48dp touch-target buttons. It tracks status
 * transitions: proposed -> confirmed -> completed/failed.
 */

import { clsx } from 'clsx';
import { Check, X, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useCallback, type ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Action card status lifecycle. */
export type AiActionStatus = 'proposed' | 'confirming' | 'completed' | 'failed';

interface AiActionCardProps {
  /** Unique ID for this action. */
  actionId: string;
  /** Human-readable description of the proposed action. */
  description: string;
  /** Current status of the action. */
  status: AiActionStatus;
  /** Result message after completion or failure. */
  resultMessage?: string;
  /** Called when user confirms the action. */
  onConfirm: (actionId: string) => void;
  /** Called when user cancels the action. */
  onCancel: (actionId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * AiActionCard renders an AI-proposed action with Confirm/Cancel buttons.
 * After confirmation, it shows a spinner then the result.
 */
export function AiActionCard({
  actionId,
  description,
  status,
  resultMessage,
  onConfirm,
  onCancel,
}: AiActionCardProps): ReactElement {
  const handleConfirm = useCallback(() => {
    onConfirm(actionId);
  }, [actionId, onConfirm]);

  const handleCancel = useCallback(() => {
    onCancel(actionId);
  }, [actionId, onCancel]);

  const isResolved = status === 'completed' || status === 'failed';

  return (
    <div
      className={clsx(
        'mx-4 my-2 rounded-2xl border p-4 shadow-sm',
        'bg-white dark:bg-gray-900',
        status === 'completed' && 'border-green-200 dark:border-green-800',
        status === 'failed' && 'border-red-200 dark:border-red-800',
        !isResolved && 'border-purple-200 dark:border-purple-800',
      )}
    >
      {/* Action description */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
          {status === 'completed' ? (
            <CheckCircle2 size={18} className="text-green-500" />
          ) : status === 'failed' ? (
            <AlertCircle size={18} className="text-red-500" />
          ) : (
            <svg
              className="w-[18px] h-[18px] text-purple-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wider mb-1">
            AI Proposed Action
          </p>
          <p className="text-sm text-gray-900 dark:text-white leading-relaxed">
            {description}
          </p>
        </div>
      </div>

      {/* Result message (after resolution) */}
      {isResolved && resultMessage && (
        <div
          className={clsx(
            'text-xs rounded-lg px-3 py-2 mb-3',
            status === 'completed'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
          )}
        >
          {resultMessage}
        </div>
      )}

      {/* Action buttons */}
      {!isResolved && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleConfirm}
            disabled={status === 'confirming'}
            className={clsx(
              'flex-1 h-12 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 touch-feedback transition-all',
              status === 'confirming'
                ? 'bg-green-100 text-green-400 cursor-not-allowed'
                : 'bg-green-500 text-white active:scale-95 shadow-sm shadow-green-500/30',
            )}
          >
            {status === 'confirming' ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Check size={18} />
            )}
            {status === 'confirming' ? 'Confirming...' : 'Confirm'}
          </button>

          <button
            onClick={handleCancel}
            disabled={status === 'confirming'}
            className={clsx(
              'flex-1 h-12 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 touch-feedback transition-all',
              status === 'confirming'
                ? 'bg-gray-100 text-gray-300 dark:bg-gray-800 dark:text-gray-600 cursor-not-allowed'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 active:scale-95',
            )}
          >
            <X size={18} />
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
