/**
 * Tooltip — a short hint on hover and on focus (FE-HIGH-085).
 *
 * WHY: 34 controls relied on the native `title=` attribute, which never
 * shows on keyboard focus or touch and is read inconsistently by assistive
 * technology. The child keeps its own accessible name (an icon-only button
 * needs `aria-label`); the tooltip is `aria-describedby` and appears on hover
 * and focus, hides on Escape.
 */
import React, { cloneElement, isValidElement, useCallback, useId, useRef, useState } from 'react';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement<{ 'aria-describedby'?: string }>;
  placement?: 'top' | 'bottom';
  /** Delay before showing on hover, in ms */
  delay?: number;
  className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  placement = 'top',
  delay = 300,
  className = '',
}) => {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (immediate: boolean) => {
      if (timer.current) clearTimeout(timer.current);
      if (immediate) setOpen(true);
      else timer.current = setTimeout(() => setOpen(true), delay);
    },
    [delay],
  );
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  }, []);

  const child = isValidElement(children)
    ? cloneElement(children, { 'aria-describedby': open ? id : undefined })
    : children;

  return (
    <span
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      onFocusCapture={() => show(true)}
      onBlurCapture={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hide();
      }}
    >
      {child}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-xs text-white shadow-md dark:bg-gray-100 dark:text-gray-900 ${
            placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {content}
        </span>
      )}
    </span>
  );
};
