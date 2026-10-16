/**
 * Subtree counts of the selected facility node (the KPI band).
 *
 * The counts are what farm-service reports for the node's subtree
 * (useNodeCounts); roles that cannot read them see why instead of zeros.
 */
import { Spinner, useI18n } from '@aquaculture/shared-ui';
import React from 'react';

import type { FacilityNode } from './facilityTree';
import { FRAME, KICKER, MUTED_TEXT } from './panelStyles';
import { useNodeCounts } from './useNodeCounts';

export function NodeKpis({ node }: { node: FacilityNode }): React.ReactElement {
  const { t } = useI18n();
  const counts = useNodeCounts(node);

  // TODO(data): the design's energy tiles — power now (kW), today (kWh) and
  // this month (MWh) — have no per-node source: needs a farm-service energy
  // rollup per site/department/system/equipment (power-meter and VFD channels
  // bound to equipment). Left out rather than estimated. The design's cost /
  // site-share tile is CostShareCard (the site's booked electricity, and
  // labelled previews where no record exists, FARM-MEDIUM-440).
  return (
    <section aria-label={t('facilityStructure.kpi.label')}>
      {counts.status === 'restricted' ? (
        <p className={MUTED_TEXT}>{t('facilityStructure.kpi.restricted')}</p>
      ) : null}
      {counts.status === 'loading' ? <Spinner size="sm" label={t('common.loading')} /> : null}
      {counts.status === 'error' ? (
        <p role="alert" className="text-sm text-error-700 dark:text-error-300">
          {t('facilityStructure.kpi.error')}
        </p>
      ) : null}
      {counts.status === 'ready' ? (
        <dl
          className={`grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] overflow-hidden ${FRAME}`}
        >
          {counts.counts.map((count) => (
            <div
              key={count.labelKey}
              className="flex flex-col gap-1 px-5 py-4 -mr-px -mb-px border-r border-b border-gray-200 dark:border-gray-700"
            >
              <dt className={KICKER}>{t(count.labelKey)}</dt>
              <dd className="text-3xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {count.value}
              </dd>
              {count.liveStock !== undefined && count.liveStock > 0 ? (
                <dd className="text-xs text-gray-600 dark:text-gray-400">
                  {t('facilityStructure.kpi.liveStock', { count: count.liveStock })}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
