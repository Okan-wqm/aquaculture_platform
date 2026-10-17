/**
 * Facility structure — /sites/setup/structure.
 *
 * WHY: the Sites, Departments, Systems and Equipment tabs edit each level as a
 * flat table; this tab shows the location tree those records form, with the
 * selected node's chain, subtree counts, responsible people, linked process
 * diagrams and setup gaps beside it. Every value is read from the existing
 * farm-service / sensor-service queries; nothing here is stored or estimated.
 *
 * WHAT: left, a sticky keyboard-operable tree (stacked and height-capped on
 * narrow screens); right, the panel of the selected node. The first site
 * starts open and selected; selecting from the panel opens the tree down to
 * the selected node so the two panes always show the same place.
 */
import { Spinner, useI18n } from '@aquaculture/shared-ui';
import React, { useCallback, useId, useState } from 'react';

import { ancestorsOf, type FacilityNode, type FacilityTree } from './facilityTree';
import { FacilityTreeView } from './FacilityTreeView';
import { KIND_PLURAL_KEY } from './kindLabels';
import { NodePanel } from './NodePanel';
import { FRAME, MUTED_TEXT } from './panelStyles';
import { useFacilityStructure } from './useFacilityStructure';

/**
 * The selection as it stands in the current tree: a container is re-read by
 * key (so a refetch shows fresh data), an equipment row stays while its
 * container does. Null when nothing is selected or the node disappeared — the
 * page then falls back to the first site.
 */
function resolveSelection(tree: FacilityTree, selected: FacilityNode | null): FacilityNode | null {
  if (selected?.kind === 'equipment') {
    return selected.parentKey !== null && tree.byKey.has(selected.parentKey) ? selected : null;
  }
  return selected ? (tree.byKey.get(selected.key) ?? null) : null;
}

export function FacilityStructureTab(): React.ReactElement {
  const { t } = useI18n();
  const treeHeadingId = useId();
  const { tree, isLoading, isError, capped } = useFacilityStructure();
  const [selectedState, setSelected] = useState<FacilityNode | null>(null);
  // null until the operator opens or closes a row: the first site starts open.
  const [expandedState, setExpanded] = useState<ReadonlySet<string> | null>(null);

  const firstSiteKey = tree.sites[0]?.key ?? null;
  const expanded: ReadonlySet<string> =
    expandedState ?? new Set(firstSiteKey !== null ? [firstSiteKey] : []);
  const selected = resolveSelection(tree, selectedState) ?? tree.sites[0] ?? null;
  const path = selected ? [...ancestorsOf(tree, selected), selected] : [];

  const toggle = useCallback(
    (key: string): void => {
      setExpanded((previous) => {
        const next = new Set(previous ?? (firstSiteKey !== null ? [firstSiteKey] : []));
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [firstSiteKey],
  );

  /** Select from the panel: also open every ancestor so the tree shows the node. */
  const selectAndReveal = useCallback(
    (node: FacilityNode): void => {
      setSelected(node);
      setExpanded((previous) => {
        const next = new Set(previous ?? (firstSiteKey !== null ? [firstSiteKey] : []));
        for (const ancestor of ancestorsOf(tree, node)) next.add(ancestor.key);
        return next;
      });
    },
    [tree, firstSiteKey],
  );

  return (
    <div className="flex flex-col gap-4">
      {capped.map((list) => (
        <p key={list.kind} role="status" className={MUTED_TEXT}>
          {t('facilityStructure.tree.truncated', {
            what: t(KIND_PLURAL_KEY[list.kind]),
            shown: list.shown,
            total: list.total,
          })}
        </p>
      ))}
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <section
          aria-labelledby={treeHeadingId}
          className={`w-full lg:w-96 lg:shrink-0 lg:sticky lg:top-4 flex flex-col max-h-[420px] lg:max-h-[calc(100vh-8rem)] ${FRAME}`}
        >
          <header className="flex flex-col gap-0.5 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h2
              id={treeHeadingId}
              className="text-[22px] leading-tight font-semibold text-gray-900 dark:text-gray-100"
            >
              {t('facilityStructure.tree.title')}
            </h2>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {t('facilityStructure.tree.levels')}
            </p>
          </header>
          <div className="overflow-y-auto">
            {isLoading ? (
              <div className="p-4">
                <Spinner size="md" block label={t('common.loading')} />
              </div>
            ) : null}
            {!isLoading && isError ? (
              <p role="alert" className="p-4 text-sm text-error-700 dark:text-error-300">
                {t('facilityStructure.loadError')}
              </p>
            ) : null}
            {!isLoading && !isError && tree.sites.length === 0 ? (
              <p className={`p-4 ${MUTED_TEXT}`}>{t('facilityStructure.tree.empty')}</p>
            ) : null}
            {!isLoading && !isError && tree.sites.length > 0 ? (
              <FacilityTreeView
                tree={tree}
                expanded={expanded}
                selected={selected}
                labelledBy={treeHeadingId}
                onToggle={toggle}
                onSelect={setSelected}
              />
            ) : null}
          </div>
        </section>
        <div className="flex-1 min-w-0 w-full">
          {selected ? <NodePanel node={selected} path={path} onSelect={selectAndReveal} /> : null}
        </div>
      </div>
    </div>
  );
}

export default FacilityStructureTab;
