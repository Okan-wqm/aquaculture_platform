/**
 * @module ConfirmDialog
 * @description Reusable confirmation modal for destructive actions (leave channel,
 * delete channel, delete message). Follows iOS/Android alert dialog conventions
 * with backdrop dismiss and 48dp minimum touch targets.
 *
 * WHY this stayed a centred alert instead of becoming the kit's <Sheet>: Sheet is
 * a bottom sheet with its own open/close contract, focus trap, Escape handler and
 * scroll lock, and it springs from the dock. Swapping it in would change the
 * component's modality, its prop shape (this one is mounted conditionally by the
 * parent and has no `open`) and where the destructive choice appears on screen —
 * none of which is a restyle. The SURFACE is now the kit's <Card> and the actions
 * are the kit's <Button>, so the parts that could be adopted mechanically were.
 */

import type { ReactElement } from 'react';

import { Button, Card } from '@/components/ui';

interface ConfirmDialogProps {
  /** Dialog title. */
  title: string;
  /** Descriptive message explaining the action. */
  message: string;
  /** Text for the confirm button. */
  confirmLabel: string;
  /**
   * Tailwind background class for the confirm button. Defaults to the `danger`
   * variant's own alarm fill, so callers only pass this to say something other
   * than "destructive".
   */
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* WHY a native <button> backdrop: a clickable dismiss target must be
          keyboard-operable and focusable. A native button supplies Enter/Space
          activation, focus, and the correct role with no extra handlers. */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onCancel}
        aria-label="Dismiss dialog"
      />
      <Card className="relative max-w-sm w-full p-6">
        <h3 className="text-head font-semibold text-ink-1 mb-2">{title}</h3>
        <p className="text-body text-ink-2 mb-6">{message}</p>
        <div className="flex gap-3">
          <Button variant="secondary" block onClick={onCancel}>
            Cancel
          </Button>
          {/* `danger` already fills with the alarm token; confirmColor overrides
              it via twMerge for the rare non-destructive confirmation. */}
          <Button variant="danger" block className={confirmColor} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}
