/**
 * One row of the facility tree: a focusable `treeitem` (roving tabindex).
 *
 * WHY a flat row: the tree is rendered as one list of treeitems carrying
 * aria-level (the ARIA flat-tree form) so lazily loaded equipment rows slot in
 * without nested groups; treeKeyboard.ts walks the rendered rows.
 *
 * WHAT: click or Enter/Space on an unselected row selects it and opens it;
 * on the selected row they open/close it. The chevron is decorative — the
 * open state is aria-expanded.
 */
import { ChevronRight } from 'lucide-react';
import React, { type RefObject } from 'react';

import type { FacilityNode, FacilityNodeKind } from './facilityTree';
import { handleTreeRowKeyDown } from './treeKeyboard';

export interface TreeRowProps {
  node: FacilityNode;
  expandable: boolean;
  expanded: boolean;
  selected: boolean;
  tabStop: boolean;
  treeRef: RefObject<HTMLUListElement | null>;
  onToggle: (key: string) => void;
  onSelect: (node: FacilityNode) => void;
  onFocusRow: (key: string) => void;
}

/** Indent per depth (site 0 … deep sub-systems), as static classes Tailwind can see. */
const INDENT = ['pl-2', 'pl-6', 'pl-10', 'pl-14', 'pl-18', 'pl-22', 'pl-26'];

function indentClass(depth: number): string {
  return INDENT[Math.min(depth, INDENT.length - 1)];
}

const LABEL_WEIGHT: Record<FacilityNodeKind, string> = {
  site: 'text-base font-semibold',
  department: 'text-sm font-semibold',
  system: 'text-sm font-medium',
  equipment: 'text-sm',
};

export function TreeRow({
  node,
  expandable,
  expanded,
  selected,
  tabStop,
  treeRef,
  onToggle,
  onSelect,
  onFocusRow,
}: TreeRowProps): React.ReactElement {
  const activate = (): void => {
    if (!selected) {
      onSelect(node);
      if (expandable && !expanded) onToggle(node.key);
    } else if (expandable) {
      onToggle(node.key);
    }
  };

  const stateClass = selected
    ? 'bg-primary-50 dark:bg-primary-900/30 shadow-[inset_3px_0_0_var(--color-primary-600)]'
    : 'hover:bg-gray-100 dark:hover:bg-gray-800';

  return (
    <li
      role="treeitem"
      aria-level={node.depth + 1}
      aria-expanded={expandable ? expanded : undefined}
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      data-node-key={node.key}
      onClick={activate}
      onFocus={() => onFocusRow(node.key)}
      onKeyDown={(event) =>
        handleTreeRowKeyDown(event, {
          tree: treeRef.current,
          parentKey: node.parentKey,
          expandable,
          expanded,
          onToggle: () => onToggle(node.key),
          onActivate: activate,
        })
      }
      className={`flex items-center gap-2 pr-3 cursor-pointer text-gray-900 dark:text-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 ${node.kind === 'equipment' ? 'min-h-9.5' : 'min-h-10.5'} ${indentClass(node.depth)} ${stateClass}`}
    >
      {expandable ? (
        <ChevronRight
          aria-hidden="true"
          className={`w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      ) : (
        <span aria-hidden="true" className="w-3.5 shrink-0" />
      )}
      <span className={`flex-1 min-w-0 truncate ${LABEL_WEIGHT[node.kind]}`}>{node.name}</span>
      {/* TODO(data): the design puts the alarm glyph of the subtree's highest
          open alarm and a kW rollup here — needs an alert-engine query of open
          alarms per site/department/system/equipment and a per-node power
          rollup (no metering-per-node data exists). The record code stands in. */}
      <span className="shrink-0 text-xs tabular-nums text-gray-600 dark:text-gray-400">
        {node.code}
      </span>
    </li>
  );
}

/**
 * A non-item line inside the tree (loading, empty, capped list) at a row's
 * indent. role="none": it is read as text, not navigated as a treeitem.
 */
export function TreeNoteRow({
  depth,
  children,
}: {
  depth: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <li
      role="none"
      className={`flex items-center min-h-8 pr-3 text-xs text-gray-600 dark:text-gray-400 ${indentClass(depth)}`}
    >
      <span aria-hidden="true" className="w-3.5 shrink-0 mr-2" />
      {children}
    </li>
  );
}
