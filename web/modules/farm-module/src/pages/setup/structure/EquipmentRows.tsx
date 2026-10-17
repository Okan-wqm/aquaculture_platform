/**
 * The equipment rows of one opened department or system in the facility tree.
 *
 * WHY its own component: equipment is read per container (useNodeEquipment),
 * and a hook can only run per container when each opened container mounts
 * its own reader — closed containers never query.
 *
 * WHAT: the rows (rendered by the tree's row renderer so they share focus and
 * selection), a loading or error line, an empty line when the container holds
 * nothing at all, and a note when the container holds more than one page. It
 * reports the row keys it draws to the tree, which keeps its single tab stop
 * on a row that is actually on screen.
 */
import { Spinner, useI18n } from '@aquaculture/shared-ui';
import React, { useEffect, useMemo } from 'react';

import type { DepartmentNode, FacilityNode, SystemNode } from './facilityTree';
import { KIND_PLURAL_KEY } from './kindLabels';
import { TreeNoteRow } from './TreeRow';
import { useNodeEquipment } from './useNodeEquipment';

export interface EquipmentRowsProps {
  parent: DepartmentNode | SystemNode;
  /** Sub-systems are listed above; the empty line shows only when there are none. */
  hasOtherChildren: boolean;
  renderRow: (node: FacilityNode, expandable: boolean) => React.ReactElement;
  /** The keys of the rows drawn now; null once this container closes. */
  onRendered: (containerKey: string, keys: ReadonlySet<string> | null) => void;
}

export function EquipmentRows({
  parent,
  hasOtherChildren,
  renderRow,
  onRendered,
}: EquipmentRowsProps): React.ReactElement {
  const { t } = useI18n();
  const { nodes, isLoading, isError, capped } = useNodeEquipment(parent);
  const depth = parent.depth + 1;

  const drawnKeys = useMemo(
    () => new Set(isLoading || isError ? [] : nodes.map((node) => node.key)),
    [isLoading, isError, nodes],
  );
  useEffect(() => {
    onRendered(parent.key, drawnKeys);
  }, [onRendered, parent.key, drawnKeys]);
  useEffect(() => () => onRendered(parent.key, null), [onRendered, parent.key]);

  if (isLoading) {
    return (
      <TreeNoteRow depth={depth}>
        <Spinner size="sm" label={t('common.loading')} />
      </TreeNoteRow>
    );
  }
  if (isError) {
    return <TreeNoteRow depth={depth}>{t('facilityStructure.loadError')}</TreeNoteRow>;
  }
  return (
    <>
      {nodes.map((node) => renderRow(node, false))}
      {nodes.length === 0 && !hasOtherChildren ? (
        <TreeNoteRow depth={depth}>{t('facilityStructure.tree.noItems')}</TreeNoteRow>
      ) : null}
      {capped ? (
        <TreeNoteRow depth={depth}>
          {t('facilityStructure.tree.truncated', {
            what: t(KIND_PLURAL_KEY.equipment),
            shown: capped.shown,
            total: capped.total,
          })}
        </TreeNoteRow>
      ) : null}
    </>
  );
}
