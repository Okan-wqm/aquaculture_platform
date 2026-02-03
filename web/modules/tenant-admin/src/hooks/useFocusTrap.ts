/**
 * useFocusTrap Hook
 *
 * Implements focus trapping for modals and dialogs.
 * Ensures keyboard focus stays within the modal when open.
 *
 * Features:
 * - Traps focus within modal boundaries
 * - Auto-focuses first focusable element on open
 * - Returns focus to trigger element on close
 * - Handles Escape key to close modal
 * - Supports Tab/Shift+Tab cycling
 */

import { useEffect, useRef, useCallback } from 'react';

// Selector for all focusable elements
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

interface UseFocusTrapOptions {
  /** Whether the modal is currently open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Whether to close on Escape key press (default: true) */
  closeOnEscape?: boolean;
  /** Whether to auto-focus first element (default: true) */
  autoFocus?: boolean;
  /** Whether to restore focus on close (default: true) */
  restoreFocus?: boolean;
}

interface UseFocusTrapReturn {
  /** Ref to attach to the modal container */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Handler for keydown events (attach to container) */
  handleKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * Custom hook for implementing focus trapping in modals
 *
 * @example
 * ```tsx
 * const { containerRef, handleKeyDown } = useFocusTrap({
 *   isOpen,
 *   onClose: handleClose,
 * });
 *
 * return (
 *   <div ref={containerRef} onKeyDown={handleKeyDown} role="dialog">
 *     {content}
 *   </div>
 * );
 * ```
 */
export function useFocusTrap({
  isOpen,
  onClose,
  closeOnEscape = true,
  autoFocus = true,
  restoreFocus = true,
}: UseFocusTrapOptions): UseFocusTrapReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Get all focusable elements within the container
  const getFocusableElements = useCallback((): HTMLElement[] => {
    if (!containerRef.current) return [];
    const elements = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    return Array.from(elements).filter(
      (el) => el.offsetParent !== null && !el.closest('[aria-hidden="true"]')
    );
  }, []);

  // Focus the first focusable element
  const focusFirstElement = useCallback(() => {
    const focusable = getFocusableElements();
    if (focusable.length > 0) {
      // Small delay to ensure DOM is ready
      requestAnimationFrame(() => {
        focusable[0].focus();
      });
    }
  }, [getFocusableElements]);

  // Handle keydown for focus trap and escape
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Handle Escape key
      if (e.key === 'Escape' && closeOnEscape) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      // Handle Tab key for focus trapping
      if (e.key === 'Tab') {
        const focusable = getFocusableElements();
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusable[0];
        const lastElement = focusable[focusable.length - 1];
        const activeElement = document.activeElement;

        // Shift+Tab on first element: go to last
        if (e.shiftKey && activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
          return;
        }

        // Tab on last element: go to first
        if (!e.shiftKey && activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
          return;
        }

        // If focus is outside the modal, bring it back
        if (!containerRef.current?.contains(activeElement)) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    },
    [closeOnEscape, onClose, getFocusableElements]
  );

  // Store trigger element when modal opens
  useEffect(() => {
    if (isOpen && restoreFocus) {
      triggerRef.current = document.activeElement as HTMLElement;
    }
  }, [isOpen, restoreFocus]);

  // Auto-focus first element when modal opens
  useEffect(() => {
    if (isOpen && autoFocus) {
      // Small delay to allow modal to render
      const timeoutId = setTimeout(focusFirstElement, 0);
      return () => clearTimeout(timeoutId);
    }
  }, [isOpen, autoFocus, focusFirstElement]);

  // Restore focus when modal closes
  useEffect(() => {
    if (!isOpen && restoreFocus && triggerRef.current) {
      // Restore focus to trigger element
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [isOpen, restoreFocus]);

  // Prevent focus from leaving the modal via clicks outside
  useEffect(() => {
    if (!isOpen) return;

    const handleFocusIn = (e: FocusEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        // Focus is outside modal, bring it back
        const focusable = getFocusableElements();
        if (focusable.length > 0) {
          focusable[0].focus();
        }
      }
    };

    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, [isOpen, getFocusableElements]);

  return {
    containerRef,
    handleKeyDown,
  };
}

export default useFocusTrap;
