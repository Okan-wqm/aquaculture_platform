/**
 * Menu — a list of actions behind a trigger, with menu semantics (FE-HIGH-085).
 *
 * role="menu" / "menuitem", ArrowUp/Down move focus (wrapping), Home/End jump,
 * Escape closes and returns focus to the trigger (from Popover), and choosing
 * an item closes the menu. Items may be marked `danger` (destructive) and
 * `separator` (a rule above the item); `header` renders above the list.
 */
import React, { useCallback, useRef } from 'react';

import { Popover, type PopoverProps, type PopoverTriggerProps } from './Popover';

export interface MenuItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a rule above this item */
  separator?: boolean;
}

export interface MenuProps {
  trigger: (props: PopoverTriggerProps) => React.ReactNode;
  items: readonly MenuItem[];
  /** Accessible name of the menu ("User menu") */
  'aria-label': string;
  /** Content above the items (the signed-in user, for instance) */
  header?: React.ReactNode;
  align?: PopoverProps['align'];
  panelClassName?: string;
  className?: string;
}

export const Menu: React.FC<MenuProps> = ({
  trigger,
  items,
  'aria-label': ariaLabel,
  header,
  align = 'end',
  panelClassName = 'w-64',
  className = '',
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ??
        [],
    );
    if (buttons.length === 0) return;
    const current = buttons.findIndex((b) => b === document.activeElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (current + 1) % buttons.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  }, []);

  return (
    <Popover
      trigger={trigger}
      role="menu"
      aria-label={ariaLabel}
      align={align}
      panelClassName={panelClassName}
      className={className}
    >
      {(close) => (
        <div ref={listRef} onKeyDown={onKeyDown}>
          {header && (
            <div className="border-b border-gray-100 px-4 py-3 dark:border-gray-700">{header}</div>
          )}
          <div className="py-1">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect();
                  close();
                }}
                className={`flex w-full items-center px-4 py-2 text-left text-sm focus:outline-hidden focus-visible:bg-gray-100 dark:focus-visible:bg-gray-700 disabled:opacity-50 ${
                  item.separator ? 'mt-1 border-t border-gray-100 pt-2 dark:border-gray-700' : ''
                } ${
                  item.danger
                    ? 'text-error-600 hover:bg-error-50 dark:text-error-400 dark:hover:bg-error-900/30'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                }`}
              >
                {item.icon && <span className="mr-3 flex-shrink-0">{item.icon}</span>}
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
};
