/**
 * Popover — a panel anchored to its trigger (FE-HIGH-085).
 *
 * WHY: seventeen dropdowns were hand-built (the shell's user menu and
 * notification panel among them) and none closed on Escape, moved focus into
 * the panel or returned it to the trigger, and one was a fixed `w-96` that
 * overflowed a phone. A popover is a behaviour, not a styling: click-outside
 * and Escape close it, focus enters on open and returns on close, and the
 * panel never exceeds the viewport. `Menu` builds the menu semantics on top.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useClickOutside } from '../../hooks/useClickOutside';

export interface PopoverTriggerProps {
  ref: React.RefObject<HTMLButtonElement | null>;
  id: string;
  onClick: () => void;
  'aria-expanded': boolean;
  'aria-haspopup': 'menu' | 'dialog' | 'true';
  'aria-controls': string | undefined;
}

export interface PopoverProps {
  /** The element that opens the panel; spread the props onto a <button>. */
  trigger: (props: PopoverTriggerProps) => React.ReactNode;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  /** Accessible name of the panel */
  'aria-label'?: string;
  /** Which edge of the trigger the panel aligns to */
  align?: 'start' | 'end';
  /** Controlled open state */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Role of the panel: `dialog` (default, arbitrary content) or `menu` (used by Menu) */
  role?: 'dialog' | 'menu';
  haspopup?: PopoverTriggerProps['aria-haspopup'];
  /** Panel width classes (default `w-72`); the panel is always capped to the viewport */
  panelClassName?: string;
  className?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Popover: React.FC<PopoverProps> = ({
  trigger,
  children,
  'aria-label': ariaLabel,
  align = 'end',
  open: openProp,
  onOpenChange,
  role = 'dialog',
  haspopup,
  panelClassName = 'w-72',
  className = '',
}) => {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const id = useId();
  const panelId = `${id}-panel`;
  const triggerId = `${id}-trigger`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  useClickOutside(rootRef, () => setOpen(false), open);

  // Focus enters the panel on open (its first control, else the panel) and
  // returns to the trigger on close.
  useEffect(() => {
    if (open) {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus();
      wasOpen.current = true;
    } else if (wasOpen.current) {
      wasOpen.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        setOpen(false);
      }
    },
    [open, setOpen],
  );

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`} onKeyDown={onKeyDown}>
      {trigger({
        ref: triggerRef,
        id: triggerId,
        onClick: () => setOpen(!open),
        'aria-expanded': open,
        'aria-haspopup': haspopup ?? (role === 'menu' ? 'menu' : 'dialog'),
        'aria-controls': open ? panelId : undefined,
      })}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role={role}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : triggerId}
          tabIndex={-1}
          className={`absolute z-50 mt-2 ${align === 'end' ? 'right-0' : 'left-0'} max-w-[calc(100vw-1rem)] rounded-lg bg-white shadow-lg ring-1 ring-black/5 focus:outline-hidden dark:bg-gray-900 dark:ring-white/10 ${panelClassName}`}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
};
