/**
 * FocusTrap Component
 *
 * Traps keyboard focus within a container. When the user presses Tab at the
 * last focusable element, focus cycles to the first; Shift+Tab at the first
 * cycles to the last. Pressing Escape calls onEscape.
 *
 * FE-HIGH-017: After modal/dialog close, focus returns to the trigger element.
 * FE-HIGH-019: SCADA builder keyboard traps are fixed by wrapping panels with
 *              this component instead of ad-hoc Tab handlers.
 *
 * @see FE-HIGH-017, FE-HIGH-019
 *
 * @example
 * // Wrap modal content
 * <FocusTrap active={isOpen} onEscape={handleClose} restoreFocusOnDeactivate>
 *   <ModalContent />
 * </FocusTrap>
 *
 * @example
 * // SCADA widget panel — Escape exits the panel
 * <FocusTrap active={isPanelOpen} onEscape={() => setPanelOpen(false)}>
 *   <WidgetPalette />
 * </FocusTrap>
 */

import React, { useRef, useEffect, useCallback } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface FocusTrapProps {
  /** Whether the focus trap is active */
  active: boolean;
  /** Callback when Escape is pressed inside the trap */
  onEscape?: () => void;
  /** Whether to restore focus to the previously focused element on deactivation */
  restoreFocusOnDeactivate?: boolean;
  /** Whether to auto-focus the first focusable element when activated */
  autoFocus?: boolean;
  /** Content to render inside the trap */
  children: React.ReactNode;
  /** Additional class names for the wrapper div */
  className?: string;
  /** ARIA role for the trap container */
  role?: string;
  /** ARIA label for the trap container */
  'aria-label'?: string;
}

// ============================================================================
// Focusable Element Selector
// ============================================================================

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// ============================================================================
// Component
// ============================================================================

export const FocusTrap: React.FC<FocusTrapProps> = ({
  active,
  onEscape,
  restoreFocusOnDeactivate = true,
  autoFocus = true,
  children,
  className,
  role,
  'aria-label': ariaLabel,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // ── Save and restore focus ──
  useEffect(() => {
    if (active) {
      previousActiveElement.current = document.activeElement as HTMLElement;

      if (autoFocus) {
        // Focus the first focusable element after React commit
        requestAnimationFrame(() => {
          if (!containerRef.current) return;
          const firstFocusable = containerRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
          if (firstFocusable) {
            firstFocusable.focus();
          } else {
            // If no focusable element, focus the container itself
            containerRef.current.focus();
          }
        });
      }
    } else if (restoreFocusOnDeactivate && previousActiveElement.current) {
      // Restore focus to the element that was focused before the trap activated
      previousActiveElement.current.focus();
      previousActiveElement.current = null;
    }
  }, [active, autoFocus, restoreFocusOnDeactivate]);

  // ── Keyboard handler ──
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!active || !containerRef.current) return;

      // Escape — call onEscape handler
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return;
      }

      // Tab — trap focus within container
      if (event.key === 'Tab') {
        const focusableElements = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusableElements.length === 0) {
          event.preventDefault();
          return;
        }

        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];

        if (event.shiftKey) {
          // Shift+Tab at first element -> wrap to last
          if (document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
        } else {
          // Tab at last element -> wrap to first
          if (document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    },
    [active, onEscape],
  );

  return (
    <div
      ref={containerRef}
      onKeyDown={handleKeyDown}
      tabIndex={active ? -1 : undefined}
      className={className}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
};
