/**
 * Sheet — the bottom sheet the v4 log flow lives in.
 *
 * "The sheet springs from the dock." It rises on a spring curve from the bottom
 * edge, which is where the thumb already is and where the dock's scan button
 * sits — the motion says the sheet came from the control you pressed.
 *
 * WHY a bottom sheet rather than a route: logging happens standing at a pen,
 * often one-handed, and a route transition loses the context behind it. The
 * sheet keeps the unit list or the unit detail visible underneath, so the worker
 * can see what they are logging against while they log it.
 *
 * Accessibility this owns, because a hand-rolled overlay usually forgets:
 * Escape closes; focus moves into the sheet on open and returns to the opener on
 * close; focus is trapped while open; the page behind does not scroll; the
 * backdrop is a real button so it is keyboard-operable.
 */
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, type ReactElement, type ReactNode } from 'react';

import { IconButton } from './IconButton';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Shown at 600/19px in the sheet header. */
  title: string;
  /** Pinned below the scrolling body — the commit action lives here. */
  footer?: ReactNode;
  children: ReactNode;
}

/** Everything that can hold focus inside the sheet, for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ open, onClose, title, footer, children }: SheetProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Remember who opened us so focus can go home on close. Captured on the
  // open transition, before focus moves into the panel.
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): void => {
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;

      // Wrap at both ends so Tab never escapes to the page behind the scrim.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [open, onClose],
  );

  useEffect(() => {
    if (!open) return undefined;

    document.addEventListener('keydown', handleKeyDown);
    // Lock the page behind the sheet; a scrolling backdrop under a modal reads
    // as a broken app and, on iOS, steals the sheet's own scroll.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus in, so a screen-reader user is not left on the page behind.
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    firstFocusable?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      {/* The scrim is a real button so it is keyboard-operable, and it is named
          distinctly from the header's Close — two controls that do the same
          thing should still announce themselves differently. */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[3px] animate-am-fade"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'relative flex flex-col max-h-[88%] overflow-hidden',
          'bg-surface-0 border border-line-strong border-b-0 rounded-t-[26px]',
          'shadow-[0_-20px_50px_rgba(2,8,18,0.5)] animate-am-up',
        )}
      >
        {/* Grabber — the affordance that says "this can be dragged down". */}
        <div className="shrink-0 flex justify-center pt-3 pb-1">
          <span aria-hidden className="w-9 h-1 rounded-full bg-line-strong" />
        </div>
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 pt-2 pb-3">
          <h2 className="text-head font-semibold text-ink-1 truncate">{title}</h2>
          <IconButton aria-label="Close" onClick={onClose} className="bg-surface-2 rounded-xl">
            <X size={16} className="text-ink-2" />
          </IconButton>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">{children}</div>
        {footer !== undefined && (
          <div className="shrink-0 bg-surface-0 border-t border-line px-5 pt-2 pb-4">{footer}</div>
        )}
      </div>
    </div>
  );
}
