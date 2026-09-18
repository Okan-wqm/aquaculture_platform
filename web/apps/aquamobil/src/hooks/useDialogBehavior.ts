/**
 * useDialogBehavior — the one place AquaMobil's modal surfaces get their
 * dialog semantics (FE-HIGH-065, batch 5).
 *
 * Every hand-rolled sheet and confirm dialog in this app re-implemented a
 * subset of the same four behaviours — and each copy dropped a different one:
 * the messaging ConfirmDialog had no Escape handling, the AccountPage copy had
 * no `role="dialog"`, the add-member sheet trapped no focus and none of them
 * gave focus back to the control that opened them. This hook owns all four so
 * `BottomSheet` (and through it every dialog) gets them for free:
 *
 *   1. Escape closes (unless the caller is mid-operation);
 *   2. focus moves into the panel on open and is trapped there while open;
 *   3. focus returns to the previously focused element on close;
 *   4. the page behind does not scroll while the surface is open.
 *
 * AquaMobil deliberately does not import `@aquaculture/shared-ui` (standalone
 * lockfile, offline-first — see web/apps/aquamobil/CLAUDE.md), so this is the
 * mobile counterpart of shared-ui's `useDialogBehavior`, not a re-export.
 */
import { useEffect, type RefObject } from 'react';

export interface DialogBehaviorOptions {
  /** Whether the surface is currently open. */
  isOpen: boolean;
  /** Called when the surface asks to close (Escape). */
  onClose: () => void;
  /** Whether Escape closes the surface. Default true. */
  closeOnEscape?: boolean;
  /** The dialog panel; focus is moved into and trapped inside it. */
  panelRef: RefObject<HTMLElement | null>;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getAttribute('aria-hidden') !== 'true' && !el.classList.contains('hidden'),
  );
}

export function useDialogBehavior({
  isOpen,
  onClose,
  closeOnEscape = true,
  panelRef,
}: DialogBehaviorOptions): void {
  // Escape → close. Listens on `document` so the key works wherever focus is.
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeOnEscape, onClose]);

  // Focus in on open, trap while open, restore on close.
  useEffect(() => {
    if (!isOpen) return undefined;
    const panel = panelRef.current;
    if (!panel) return undefined;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const initial = focusableElements(panel)[0] ?? panel;
    initial.focus();

    const handleTab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', handleTab);

    return () => {
      panel.removeEventListener('keydown', handleTab);
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, panelRef]);

  // Scroll lock on the page behind the surface.
  useEffect(() => {
    if (!isOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);
}
