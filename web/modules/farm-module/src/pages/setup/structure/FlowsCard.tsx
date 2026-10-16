/**
 * Linked flows of the selected facility node: the sensor-service process
 * diagrams that include it (useNodeFlows), each opening in the sensor-module
 * diagram editor. farm-module links to the editor's routes only; it does not
 * import sensor-module code.
 */
import { Spinner, useI18n, type MessageKey } from '@aquaculture/shared-ui';
import type { ProcessStatus } from '@platform/shared-ui/generated/graphql-types';
import { ArrowRight, Workflow } from 'lucide-react';
import React, { useId } from 'react';
import { Link } from 'react-router-dom';

import { CARD_HEADING, FRAME, MUTED_TEXT } from './panelStyles';
import type { NodeFlowsState } from './useNodeFlows';

const STATUS_KEY: Record<ProcessStatus, MessageKey> = {
  ACTIVE: 'facilityStructure.flows.status.ACTIVE',
  DRAFT: 'facilityStructure.flows.status.DRAFT',
  INACTIVE: 'facilityStructure.flows.status.INACTIVE',
  ARCHIVED: 'facilityStructure.flows.status.ARCHIVED',
};

export function FlowsCard({ state }: { state: NodeFlowsState }): React.ReactElement {
  const { t } = useI18n();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={FRAME}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex flex-col gap-0.5">
          <h3 id={headingId} className={CARD_HEADING}>
            {t('facilityStructure.flows.title')}
          </h3>
          <p className={MUTED_TEXT}>{t('facilityStructure.flows.subtitle')}</p>
        </div>
        <Link
          to="/sensor/processes"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 dark:text-primary-300 hover:underline"
        >
          {t('facilityStructure.flows.openAll')}
          <ArrowRight aria-hidden="true" className="w-4 h-4" />
        </Link>
      </header>
      <div className="px-5 py-3">
        {state.status === 'loading' ? <Spinner size="sm" label={t('common.loading')} /> : null}
        {state.status === 'error' ? (
          <p role="alert" className="text-sm text-error-700 dark:text-error-300">
            {t('facilityStructure.flows.error')}
          </p>
        ) : null}
        {state.status === 'ready' && state.flows.length === 0 ? (
          <p className={MUTED_TEXT}>{t('facilityStructure.flows.empty')}</p>
        ) : null}
        {state.status === 'ready' && state.flows.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {state.flows.map((flow) => (
              <li key={flow.id}>
                <Link
                  to={`/sensor/unified-editor/${flow.id}`}
                  className="flex items-center gap-3 min-h-11 rounded px-2 -mx-2 text-sm text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <Workflow
                    aria-hidden="true"
                    className="w-4 h-4 shrink-0 text-gray-500 dark:text-gray-400"
                  />
                  <span className="flex-1 min-w-0 truncate font-medium">{flow.name}</span>
                  <span className="shrink-0 text-xs text-gray-600 dark:text-gray-400">
                    {t(STATUS_KEY[flow.status])}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {state.capped ? (
          <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
            {t('facilityStructure.tree.truncated', {
              what: t('facilityStructure.flows.title'),
              shown: state.capped.shown,
              total: state.capped.total,
            })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
