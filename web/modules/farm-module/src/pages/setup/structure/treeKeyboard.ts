/**
 * Keyboard model of the facility tree (WAI-ARIA tree view pattern).
 *
 * WHY: the tree renders flat — every visible row is a `treeitem` with an
 * aria-level, in reading order — and equipment rows arrive per container as
 * their queries resolve. Navigating the rendered `treeitem`s in DOM order
 * therefore always matches what is on screen, with no second copy of the
 * visible-row list to keep in sync with lazy loading.
 *
 * WHAT: ↓/↑ next/previous row, Home/End first/last, → opens a closed row or
 * moves into an open one, ← closes an open row or moves to its parent,
 * Enter/Space activate (select) the row. Focus moves; selection does not.
 */
import type { KeyboardEvent } from 'react';

export interface TreeRowKeyContext {
  /** The `role="tree"` element the row lives in. */
  tree: HTMLElement | null;
  parentKey: string | null;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  onActivate: () => void;
}

const ROW_SELECTOR = '[role="treeitem"]';

function rowsOf(tree: HTMLElement): HTMLElement[] {
  return Array.from(tree.querySelectorAll<HTMLElement>(ROW_SELECTOR));
}

function focusRow(row: HTMLElement | undefined): void {
  row?.focus();
}

function levelOf(row: HTMLElement | undefined): number {
  return Number(row?.getAttribute('aria-level') ?? 0);
}

export function handleTreeRowKeyDown(
  event: KeyboardEvent<HTMLElement>,
  context: TreeRowKeyContext,
): void {
  const { tree } = context;
  if (!tree) return;
  const rows = rowsOf(tree);
  const index = rows.indexOf(event.currentTarget);
  let handled = true;

  switch (event.key) {
    case 'ArrowDown':
      focusRow(rows[index + 1]);
      break;
    case 'ArrowUp':
      focusRow(rows[index - 1]);
      break;
    case 'Home':
      focusRow(rows[0]);
      break;
    case 'End':
      focusRow(rows[rows.length - 1]);
      break;
    case 'ArrowRight':
      if (context.expandable && !context.expanded) {
        context.onToggle();
      } else if (context.expanded && levelOf(rows[index + 1]) > levelOf(event.currentTarget)) {
        focusRow(rows[index + 1]);
      }
      break;
    case 'ArrowLeft':
      if (context.expandable && context.expanded) {
        context.onToggle();
      } else if (context.parentKey !== null) {
        focusRow(rows.find((row) => row.dataset.nodeKey === context.parentKey));
      }
      break;
    case 'Enter':
    case ' ':
      context.onActivate();
      break;
    default:
      handled = false;
  }

  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}
