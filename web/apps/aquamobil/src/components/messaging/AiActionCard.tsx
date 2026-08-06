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

import { Button, Card } from '@/components/ui';

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

  // The card's BORDER carries the outcome (green confirmed, coral failed,
  // accent while the decision is still the user's). WHY the accent and not the
  // violet this replaces: v4 gives the accent every action and active state, and
  // there is no AI token — a hand-picked purple is a colour no theme owns.
  return (
    <Card
      className={clsx(
        'mx-4 my-2 p-4',
        status === 'completed' && 'border-ok',
        status === 'failed' && 'border-crit',
        !isResolved && 'border-acc',
      )}
    >
      {/* Action description */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-acc-dim flex items-center justify-center flex-shrink-0 mt-0.5">
          {status === 'completed' ? (
            <CheckCircle2 size={18} className="text-ok" />
          ) : status === 'failed' ? (
            <AlertCircle size={18} className="text-crit" />
          ) : (
            <svg
              className="w-[18px] h-[18px] text-acc"
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
          <p className="text-meta font-semibold text-acc uppercase tracking-wider mb-1">
            AI Proposed Action
          </p>
          <p className="text-body text-ink-1 leading-relaxed">{description}</p>
        </div>
      </div>

      {/* Result message (after resolution). `--ok` has no dim twin and
          `--type-harvest` is the same value in every theme, so the harvest tint
          is the green wash. */}
      {isResolved && resultMessage && (
        <div
          className={clsx(
            'text-meta rounded-lg px-3 py-2 mb-3',
            status === 'completed' ? 'bg-type-harvest-dim text-ok' : 'bg-crit-dim text-crit',
          )}
        >
          {resultMessage}
        </div>
      )}

      {/* Action buttons. Confirm is this card's ONE accent action — v4 reserves
          the teal for exactly that, so the pre-v4 green fill (which competed
          with the green "completed" state above it) becomes the primary variant
          and the outcome colours stay on the icon and the result row. */}
      {!isResolved && (
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            block
            onClick={handleConfirm}
            disabled={status === 'confirming'}
          >
            {status === 'confirming' ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Check size={18} />
            )}
            {status === 'confirming' ? 'Confirming...' : 'Confirm'}
          </Button>

          <Button
            variant="secondary"
            block
            onClick={handleCancel}
            disabled={status === 'confirming'}
          >
            <X size={18} />
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}
