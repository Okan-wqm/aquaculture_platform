/**
 * Popover — a panel anchored to its trigger (FE-HIGH-085).
 *
 * WHY: seventeen dropdowns were hand-built (the shell's user menu and
 * notification panel among them) and none closed on Escape, moved focus into
 * the panel or returned it to the trigger, and one was a fixed `w-96` that
 * overflowed a phone. A popover is a behaviour, not a styling: click-outside
 * and Escape close it, focus enters on open and returns on close, and the
 * panel never exceeds the viewport. `Menu` builds the menu semantics on top.
 *
 * Focus leaving for the page closes it too: Tab past the panel's last control
 * lands on whatever follows the trigger, which an open panel would cover
 * (WCAG 2.4.11) — the rule WorkspaceMenu follows. Moving between the trigger
 * and the panel keeps it open, and focus is handed back to the trigger on
 * close only when it was in the panel (or fell to <body> with it), never
 * pulled back from where the reader moved it.
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
  /**
   * The panel's paint. `card` (default): the rounded white card the shell's
   * dropdowns use. `console`: the tenant console's Industry panel — square,
   * paper ground, 1px rule frame, the console elevation, 10px below the
   * trigger (README §7.4) — so a console control reuses this behaviour
   * without fighting the card's classes.
   */
  surface?: 'card' | 'console';
  /**
   * Where the panel hangs. `trigger` (default): under the trigger, on its
   * `align` edge. `header-gutter`: a control in the tenant console header
   * (ConsoleHeader). While the header row holds one line that is the same;
   * where the row wraps (console width ≤ 820 px) the trigger can start any
   * line and a panel on its edge ran off the console's side, so the root
   * drops its positioning and the panel hangs from the header at the row's
   * gutter (`--sd-header-gutter`), never wider than the console column less
   * both gutters. Outside the console (no `page` container) it is `trigger`.
   */
  anchor?: 'trigger' | 'header-gutter';
  className?: string;
}

/** The two panel paints; position and z-order are shared, the width cap is the anchor's. */
const PANEL_SURFACE: Record<NonNullable<PopoverProps['surface']>, string> = {
  card: 'mt-2 rounded-lg bg-white shadow-lg ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10',
  console: 'mt-2.5 border border-sd-rule bg-sd-paper text-sd-ink shadow-(--shadow-sd-lg)',
};

/**
 * Positioning per anchor: classes on the root and on the panel. The console
 * header owns `--sd-header-gutter`; the fallback keeps the viewport cap valid
 * where no header defines it.
 */
const ANCHOR: Record<
  NonNullable<PopoverProps['anchor']>,
  { readonly root: string; readonly panel: string }
> = {
  trigger: { root: '', panel: 'max-w-[calc(100vw-1rem)]' },
  'header-gutter': {
    root: '@max-[821px]/page:static',
    panel:
      'max-w-[min(calc(100vw-1rem),calc(100cqw-2*var(--sd-header-gutter,0.5rem)))] @max-[821px]/page:left-auto @max-[821px]/page:right-(--sd-header-gutter)',
  },
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  surface = 'card',
  anchor = 'trigger',
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

  // Focus enters the panel on open (its first control, else the panel). On
  // close it returns to the trigger when it was lost with the panel — on
  // <body>, or still inside the root — and stays wherever the reader moved it.
  useEffect(() => {
    if (open) {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus();
      wasOpen.current = true;
    } else if (wasOpen.current) {
      wasOpen.current = false;
      const focused = document.activeElement;
      const lost =
        focused === null || focused === document.body || !!rootRef.current?.contains(focused);
      if (lost) triggerRef.current?.focus();
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

  // Tab leaving the root for the page closes the panel; moving between the
  // trigger and the panel does not, nor does a blur with no next element
  // (the window losing focus, a press on something unfocusable).
  const onBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (!open) return;
      const next = event.relatedTarget;
      if (!(next instanceof Node)) return;
      if (event.currentTarget.contains(next)) return;
      setOpen(false);
    },
    [open, setOpen],
  );

  const placement = ANCHOR[anchor];

  return (
    <div
      ref={rootRef}
      className={`relative inline-block ${placement.root} ${className}`}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
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
          className={`absolute z-50 ${align === 'end' ? 'right-0' : 'left-0'} ${placement.panel} focus:outline-hidden ${PANEL_SURFACE[surface]} ${panelClassName}`}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
};
