/**
 * The facility location tree (left pane of /sites/setup/structure).
 *
 * WHY: a keyboard-operable WAI-ARIA tree — `role="tree"` of flat `treeitem`
 * rows with aria-level / aria-expanded / aria-selected and one roving tab
 * stop — over the structure derived in facilityTree.ts. Sites, departments
 * and systems come from the tree; equipment rows mount per opened container.
 *
 * WHAT: renders the visible rows in reading order. The tab stop is the last
 * focused row, else the selected row, else the first site — whichever is
 * rendered right now, so Tab always lands on a row: a container must still be
 * in the tree with every ancestor open, and an equipment row must be among the
 * rows its open container reported as drawn (not loading, failed or moved).
 */
import { useI18n } from '@aquaculture/shared-ui';
import React, { useCallback, useRef, useState } from 'react';

import { EquipmentRows } from './EquipmentRows';
import type { ContainerNode, FacilityNode, FacilityNodeKind, FacilityTree } from './facilityTree';
import { TreeNoteRow, TreeRow } from './TreeRow';

export interface FacilityTreeViewProps {
  tree: FacilityTree;
  expanded: ReadonlySet<string>;
  selected: FacilityNode | null;
  labelledBy: string;
  onToggle: (key: string) => void;
  onSelect: (node: FacilityNode) => void;
}

interface RowRef {
  kind: FacilityNodeKind;
  key: string;
  parentKey: string | null;
}

/** Equipment row keys each open container currently draws, by container key. */
type RenderedEquipment = ReadonlyMap<string, ReadonlySet<string>>;

function isRendered(
  tree: FacilityTree,
  expanded: ReadonlySet<string>,
  renderedEquipment: RenderedEquipment,
  row: RowRef | null,
): row is RowRef {
  if (!row) return false;
  if (row.kind === 'equipment') {
    // Reported only by a mounted EquipmentRows, i.e. an open container whose
    // ancestors are open too — so membership alone means "on screen".
    return row.parentKey !== null && (renderedEquipment.get(row.parentKey)?.has(row.key) ?? false);
  }
  // A container is re-read from the current tree: it may have been deleted or
  // moved under another parent since it was focused.
  const node = tree.byKey.get(row.key);
  if (!node) return false;
  let parentKey = node.parentKey;
  while (parentKey !== null) {
    const parent = tree.byKey.get(parentKey);
    if (!parent || !expanded.has(parent.key)) return false;
    parentKey = parent.parentKey;
  }
  return true;
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

export function FacilityTreeView({
  tree,
  expanded,
  selected,
  labelledBy,
  onToggle,
  onSelect,
}: FacilityTreeViewProps): React.ReactElement {
  const { t } = useI18n();
  const treeRef = useRef<HTMLUListElement>(null);
  const [focused, setFocused] = useState<RowRef | null>(null);
  const [renderedEquipment, setRenderedEquipment] = useState<RenderedEquipment>(new Map());

  /** EquipmentRows reports the rows it draws (null when it unmounts). */
  const reportEquipment = useCallback(
    (containerKey: string, keys: ReadonlySet<string> | null): void => {
      setRenderedEquipment((previous) => {
        const current = previous.get(containerKey);
        if (
          keys === null ? current === undefined : current !== undefined && sameKeys(current, keys)
        ) {
          return previous;
        }
        const next = new Map(previous);
        if (keys === null) next.delete(containerKey);
        else next.set(containerKey, keys);
        return next;
      });
    },
    [],
  );

  const firstSite = tree.sites[0] ?? null;
  const tabStopKey =
    [focused, selected, firstSite].find((row) => isRendered(tree, expanded, renderedEquipment, row))
      ?.key ?? null;

  const renderRow = (node: FacilityNode, expandable: boolean): React.ReactElement => (
    <TreeRow
      key={node.key}
      node={node}
      expandable={expandable}
      expanded={expanded.has(node.key)}
      selected={node.key === selected?.key}
      tabStop={node.key === tabStopKey}
      treeRef={treeRef}
      onToggle={onToggle}
      onSelect={onSelect}
      onFocusRow={() => setFocused({ kind: node.kind, key: node.key, parentKey: node.parentKey })}
    />
  );

  const renderBranch = (node: ContainerNode): React.ReactElement => {
    const open = expanded.has(node.key);
    return (
      <React.Fragment key={node.key}>
        {renderRow(node, true)}
        {open ? node.children.map(renderBranch) : null}
        {open && node.kind !== 'site' ? (
          <EquipmentRows
            parent={node}
            hasOtherChildren={node.children.length > 0}
            renderRow={renderRow}
            onRendered={reportEquipment}
          />
        ) : null}
        {open && node.kind === 'site' && node.children.length === 0 ? (
          <TreeNoteRow depth={node.depth + 1}>{t('facilityStructure.tree.noItems')}</TreeNoteRow>
        ) : null}
      </React.Fragment>
    );
  };

  return (
    <ul role="tree" aria-labelledby={labelledBy} ref={treeRef} className="py-1.5">
      {tree.sites.map(renderBranch)}
    </ul>
  );
}
