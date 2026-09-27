/**
 * ConfirmSheet — the confirmation surface for destructive and irreversible
 * actions (leave/delete a channel, log out, clear the offline queue).
 *
 * Replaces two hand-rolled `ConfirmDialog` copies (messaging + AccountPage)
 * that had drifted apart: one carried an error slot and an async confirm, the
 * other had Escape handling; neither had both. This is the union, on top of
 * `BottomSheet`, so a confirmation is a sheet rising from the thumb — the
 * mobile pattern — rather than a desktop dialog floating mid-screen.
 *
 * `onConfirm` may be async (logout awaits a device wipe): the sheet stays open
 * and inert while it runs, and a rejection is the caller's to surface through
 * `errorMessage`, so the user is never told an action succeeded while
 * recoverable data remains (MT-MEDIUM-050).
 */
import { clsx } from 'clsx';
import { useCallback, useState, type ReactElement } from 'react';

import { BottomSheet } from './BottomSheet';

export type ConfirmTone = 'danger' | 'primary';

export interface ConfirmSheetProps {
  /** Whether the sheet is open. */
  isOpen: boolean;
  /** Sheet title. */
  title: string;
  /** What the action does and what it costs. */
  message: string;
  /** Text of the confirming control. */
  confirmLabel: string;
  /** Text of the cancelling control. Default "Cancel". */
  cancelLabel?: string;
  /** `danger` (default) for destructive actions, `primary` for the rest. */
  tone?: ConfirmTone;
  /** Runs the action; may be async. The sheet is inert until it settles. */
  onConfirm: () => void | Promise<void>;
  /** Called on cancel, backdrop, Escape. */
  onCancel: () => void;
  /** Error from a failed confirm, shown inside the sheet. */
  errorMessage?: string | null;
}

const CONFIRM_TONE_CLASS: Record<ConfirmTone, string> = {
  danger: 'bg-red-600 text-white',
  primary: 'bg-ocean-600 text-white',
};

export function ConfirmSheet({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
  errorMessage,
}: ConfirmSheetProps): ReactElement | null {
  const [isPending, setIsPending] = useState(false);

  const handleConfirm = useCallback((): void => {
    const result = onConfirm();
    if (!(result instanceof Promise)) return;
    setIsPending(true);
    // WHY settle-only: success closes the sheet (the caller unmounts it) and a
    // rejection is the caller's to surface through `errorMessage`; this
    // component only has to become interactive again either way.
    void result.finally(() => setIsPending(false));
  }, [onConfirm]);

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      isBusy={isPending}
      showCloseButton={false}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">{message}</p>
      {errorMessage && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {errorMessage}
        </p>
      )}
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="min-h-[3rem] flex-1 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 touch-feedback transition-colors disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isPending}
          className={clsx(
            'min-h-[3rem] flex-1 rounded-xl text-sm font-medium touch-feedback transition-colors disabled:opacity-50',
            CONFIRM_TONE_CLASS[tone],
          )}
        >
          {confirmLabel}
        </button>
      </div>
    </BottomSheet>
  );
}
