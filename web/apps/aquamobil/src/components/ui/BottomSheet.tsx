/**
 * BottomSheet — AquaMobil's one modal surface (FE-HIGH-065, batch 5).
 *
 * Six screens each built their own `fixed inset-0` layer: two copies of a
 * centred confirm dialog (messaging and AccountPage), the attachment picker
 * sheet, the add-member sheet, a full-screen forward picker and the message
 * long-press menu. Each copy owned its own backdrop, Escape handling, focus
 * management and close-button labelling — and each dropped a different one.
 *
 * On a phone the native pattern for all of them is the same surface: a sheet
 * that rises from the bottom edge (Material bottom sheet / iOS action sheet),
 * sized to its content, to a tall list, or to the full screen for a page-like
 * flow. This component is that surface. It renders through a portal so it is
 * never positioned relative to a transformed ancestor (the virtualised message
 * list translates its rows), and takes its dialog semantics from
 * `useDialogBehavior`, so a screen cannot get them wrong by hand.
 *
 * Sizes: `auto` (content height, capped at 85vh), `tall` (a fixed 70vh for
 * scrolling lists), `full` (the whole viewport, page-header layout with the
 * close control leading).
 */
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useId, useRef, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { twMerge } from 'tailwind-merge';

import { IconButton } from './IconButton';

import { useDialogBehavior } from '@/hooks/useDialogBehavior';

export type BottomSheetSize = 'auto' | 'tall' | 'full';

export interface BottomSheetProps {
  /** Whether the sheet is open. Closed sheets render nothing. */
  isOpen: boolean;
  /** Called when the sheet asks to close (backdrop, Escape, close control). */
  onClose: () => void;
  /** Sheet title; also the accessible name of the dialog. */
  title: string;
  /** Optional line under the title. */
  description?: ReactNode;
  /** Trailing header slot for a primary action (e.g. a send/forward control). */
  action?: ReactNode;
  /** `auto` = content height (default), `tall` = 70vh list, `full` = whole viewport. */
  size?: BottomSheetSize;
  /** Accessible label of the close control. Default "Close". */
  closeLabel?: string;
  /**
   * While true the sheet cannot be dismissed (backdrop, Escape and the close
   * control are inert). Use it while a mutation started from the sheet is
   * pending, so the user cannot leave a half-finished operation.
   */
  isBusy?: boolean;
  /** Whether the close control is rendered. Default true. */
  showCloseButton?: boolean;
  /** Optional footer, rendered above the safe-area inset. */
  footer?: ReactNode;
  /** Extra classes on the sheet panel. */
  className?: string;
  /** Classes on the scrolling body. Default `px-5 pb-4`. */
  bodyClassName?: string;
  children: ReactNode;
}

const PANEL_SIZE_CLASS: Record<BottomSheetSize, string> = {
  auto: 'max-h-[85vh] rounded-t-3xl pb-safe',
  tall: 'h-[70vh] rounded-t-3xl pb-safe',
  full: 'h-[100dvh] rounded-none pt-safe-top pb-safe',
};

export function BottomSheet({
  isOpen,
  onClose,
  title,
  description,
  action,
  size = 'auto',
  closeLabel = 'Close',
  isBusy = false,
  showCloseButton = true,
  footer,
  className,
  bodyClassName,
  children,
}: BottomSheetProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useDialogBehavior({ isOpen, onClose, closeOnEscape: !isBusy, panelRef });

  if (!isOpen) return null;

  const isFull = size === 'full';
  const closeControl = showCloseButton ? (
    <IconButton
      aria-label={closeLabel}
      onClick={onClose}
      disabled={isBusy}
      className="text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
    >
      <X size={22} />
    </IconButton>
  ) : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      {/* Backdrop. Decorative for AT — the dialog's own close control is the
          accessible dismissal; the sheet is modal, so nothing behind it is
          reachable anyway. */}
      <div
        className={clsx(
          'absolute inset-0 bg-black/40 animate-fade-in',
          isFull && 'hidden',
        )}
        onClick={isBusy ? undefined : onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={isBusy || undefined}
        tabIndex={-1}
        className={twMerge(
          clsx(
            'relative flex w-full max-w-lg flex-col bg-white shadow-elevated outline-none dark:bg-gray-900 animate-slide-up',
            PANEL_SIZE_CLASS[size],
          ),
          className,
        )}
      >
        {!isFull && (
          <div className="flex flex-shrink-0 justify-center pt-3 pb-2" aria-hidden="true">
            <div className="h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
          </div>
        )}

        <div
          className={clsx(
            'flex flex-shrink-0 items-center gap-3',
            isFull ? 'border-b border-gray-100 px-3 py-2 dark:border-gray-800' : 'px-5 pb-3',
          )}
        >
          {isFull && closeControl}
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className={clsx(
                'font-semibold text-gray-900 dark:text-white',
                isFull ? 'text-lg' : 'text-base font-bold',
              )}
            >
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {description}
              </p>
            )}
          </div>
          {action}
          {!isFull && closeControl}
        </div>

        <div className={twMerge('min-h-0 flex-1 overflow-y-auto px-5 pb-4', bodyClassName)}>
          {children}
        </div>

        {footer && (
          <div className="flex-shrink-0 border-t border-gray-100 px-5 pt-3 dark:border-gray-800">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
