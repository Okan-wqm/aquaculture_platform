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
import { useCallback, useState, type ReactElement } from 'react';

import { BottomSheet } from './BottomSheet';
import { Button } from './Button';

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
      <p className="text-body text-ink-2">{message}</p>
      {errorMessage && (
        <p className="mt-3 text-body text-crit" role="alert">
          {errorMessage}
        </p>
      )}
      <div className="mt-6 flex gap-3">
        <Button
          variant="secondary"
          block
          onClick={onCancel}
          disabled={isPending}
          className="flex-1"
        >
          {cancelLabel}
        </Button>
        <Button variant={tone} block onClick={handleConfirm} loading={isPending} className="flex-1">
          {confirmLabel}
        </Button>
      </div>
    </BottomSheet>
  );
}
