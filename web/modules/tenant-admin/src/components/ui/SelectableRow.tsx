/**
 * SelectableRow — one row of a master-detail list (an announcement, a ticket,
 * a message thread) or of a section nav (Settings): the item whose detail the
 * page shows beside it.
 *
 * WHY one component: those rows were `<div onClick>` — no role, no tab stop,
 * no key handler — so a keyboard user could not open them, and the selection
 * was a fill alone: `primary-50` on the cream list is 1.04:1 in the Company
 * workspace (slate accent), invisible (WCAG 1.4.1, 2.1.1, 4.1.2). Written
 * once here, every row is a native button (Tab, Enter and Space with no key
 * code), the selected one is announced through `aria-current`, and its mark is
 * a shape, not a hue: README §7.2's active treatment — the accent-100 fill
 * and a 3px accent line on the left edge, reserved on every row (transparent
 * when not selected) so selecting shifts nothing. A row whose left edge
 * already carries a meaning (an announcement's type bar) takes the inset
 * accent frame instead. Focus is an outline, which neither mark draws, so a
 * focused row and a selected row never read alike.
 *
 * The row is shared-ui Button's `row` layout: the button semantics, the
 * `type`, the inset focus outline and the full-width start-aligned box come
 * from the design system; this component adds only the selection marks. The
 * caller owns the row's padding, dividers and inner layout; the label's
 * weight follows `current` there (README §7.2: 600 when active).
 */
import { Button } from '@aquaculture/shared-ui';
import React from 'react';

export interface SelectableRowProps {
  /** This row's detail is the one on screen. */
  readonly current: boolean;
  readonly onSelect: () => void;
  /**
   * `true` (default): the current item of a list. `page`: the entry of a
   * section nav that stands for the page shown.
   */
  readonly currentKind?: 'true' | 'page';
  /** `edge` (default): the left accent line. `frame`: an inset accent frame. */
  readonly marker?: 'edge' | 'frame';
  readonly className?: string;
  readonly children: React.ReactNode;
}

const SELECTED_FILL = 'bg-primary-100 dark:bg-primary-900/30';
const RESTING = 'hover:bg-gray-50 dark:hover:bg-gray-800';

const MARKER: Record<'edge' | 'frame', { readonly on: string; readonly off: string }> = {
  edge: {
    on: `border-l-[3px] border-l-primary-600 dark:border-l-primary-400 ${SELECTED_FILL}`,
    off: `border-l-[3px] border-l-transparent ${RESTING}`,
  },
  frame: {
    on: `ring-1 ring-inset ring-primary-600 dark:ring-primary-400 ${SELECTED_FILL}`,
    off: RESTING,
  },
};

export function SelectableRow({
  current,
  onSelect,
  currentKind = 'true',
  marker = 'edge',
  className = '',
  children,
}: SelectableRowProps): React.ReactElement {
  const mark = current ? MARKER[marker].on : MARKER[marker].off;
  return (
    <Button
      layout="row"
      aria-current={current ? currentKind : undefined}
      onClick={onSelect}
      className={`${mark} ${className}`.trim()}
    >
      {children}
    </Button>
  );
}
