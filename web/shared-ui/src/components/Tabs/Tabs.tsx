/**
 * Tabs — one tab strip for the product (FE-HIGH-085).
 *
 * WHY one component: twelve pages wrote their own `border-b-2` button rows,
 * six of them with no tab semantics at all, and the rest with `role="tab"`
 * but no `aria-controls`, no `tabpanel` and no arrow-key movement. A tab
 * strip is a keyboard pattern, not a styling: the strip is the single tab
 * stop, arrows move between tabs (roving tabindex), Home/End jump, and the
 * selected tab names its panel. Pages that route per tab pass `onChange`
 * and navigate; pages that switch content in place render `TabPanel`.
 *
 * The strip paints from the theme scales (primary), so every module's tabs
 * look the same and retint together.
 */
import React, { useCallback, useId, useRef } from 'react';

export interface TabItem<Id extends string = string> {
  id: Id;
  label: React.ReactNode;
  /** Optional leading icon */
  icon?: React.ReactNode;
  /** A count or status pill after the label */
  badge?: React.ReactNode;
  disabled?: boolean;
}

export interface TabsProps<Id extends string = string> {
  items: readonly TabItem<Id>[];
  /** The selected tab (controlled) */
  value: Id;
  onChange: (id: Id) => void;
  /** Accessible name of the strip ("Settings sections") */
  'aria-label'?: string;
  /**
   * Prefix for the panel ids; a `TabPanel` with the same `tabsId` and
   * `value` is what the selected tab controls. Defaults to a generated id.
   */
  tabsId?: string;
  /** `line` (default): underline strip; `pill`: segmented pills for toolbars */
  variant?: 'line' | 'pill';
  /** Let a long strip scroll sideways instead of wrapping */
  scrollable?: boolean;
  className?: string;
}

export function tabId(tabsId: string, id: string): string {
  return `${tabsId}-tab-${id}`;
}
export function panelId(tabsId: string, id: string): string {
  return `${tabsId}-panel-${id}`;
}

const lineClasses = {
  strip: 'flex gap-1 -mb-px border-b border-gray-200 dark:border-gray-700',
  tab: 'flex items-center gap-2 whitespace-nowrap px-4 py-3 text-sm font-medium border-b-2 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-inset',
  selected: 'border-primary-500 text-primary-600 dark:text-primary-400',
  idle: 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500',
};
const pillClasses = {
  strip: 'inline-flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800',
  tab: 'flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500',
  selected: 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100',
  idle: 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100',
};

export function Tabs<Id extends string = string>({
  items,
  value,
  onChange,
  'aria-label': ariaLabel,
  tabsId: tabsIdProp,
  variant = 'line',
  scrollable = false,
  className = '',
}: TabsProps<Id>): React.ReactElement {
  const generatedId = useId();
  const tabsId = tabsIdProp ?? generatedId;
  const stripRef = useRef<HTMLDivElement>(null);
  const classes = variant === 'pill' ? pillClasses : lineClasses;

  const focusTab = useCallback(
    (id: Id) => {
      stripRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(tabsId, id))}`)?.focus();
    },
    [tabsId],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const enabled = items.filter((item) => !item.disabled);
      if (enabled.length === 0) return;
      const current = enabled.findIndex((item) => item.id === value);
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = (current + 1) % enabled.length;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (current - 1 + enabled.length) % enabled.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = enabled.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const target = enabled[next];
      if (target === undefined) return;
      onChange(target.id);
      focusTab(target.id);
    },
    [items, value, onChange, focusTab],
  );

  return (
    <div
      ref={stripRef}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={`${classes.strip} ${scrollable ? 'overflow-x-auto' : ''} ${className}`}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(tabsId, item.id)}
            aria-selected={selected}
            aria-controls={panelId(tabsId, item.id)}
            aria-disabled={item.disabled || undefined}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            className={`${classes.tab} ${selected ? classes.selected : classes.idle} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {item.icon}
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** The `tabsId` the strip was given */
  tabsId: string;
  /** This panel's tab id */
  value: string;
  /** The selected tab id — the panel renders only when it matches */
  selected: string;
  children: React.ReactNode;
  className?: string;
}

/** The content a tab controls. Renders only for the selected tab, named by it. */
export const TabPanel: React.FC<TabPanelProps> = ({
  tabsId,
  value,
  selected,
  children,
  className = '',
}) => {
  if (value !== selected) return null;
  return (
    <div
      role="tabpanel"
      id={panelId(tabsId, value)}
      aria-labelledby={tabId(tabsId, value)}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
};
