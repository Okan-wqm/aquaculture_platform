/**
 * Responsibility of each level of the selected node's chain (site, department).
 *
 * Read-only: a site's responsible people are edited as its contacts in the
 * Sites tab (SiteFormModal › contacts), so the card links there rather than
 * keeping a second editor. A department's manager is the managerId /
 * managerName that createDepartment / updateDepartment store.
 */
import { Button, Spinner, useI18n } from '@aquaculture/shared-ui';
import { AlertTriangle } from 'lucide-react';
import React, { useId } from 'react';
import { Link } from 'react-router-dom';

import type { FacilityNode } from './facilityTree';
import { KIND_LABEL_KEY } from './kindLabels';
import { CARD_HEADING, FRAME, KICKER } from './panelStyles';
import type { ResponsibilityRow } from './useChainResponsibility';

export interface ResponsibilityCardProps {
  rows: readonly ResponsibilityRow[];
  onSelect: (node: FacilityNode) => void;
}

function ResponsibleValue({ row }: { row: ResponsibilityRow }): React.ReactElement {
  const { t } = useI18n();
  if (row.status === 'loading') return <Spinner size="sm" label={t('common.loading')} />;
  if (row.status === 'error') {
    return <span className="text-error-700 dark:text-error-300">{t('common.error')}</span>;
  }
  if (row.responsible === null) {
    return (
      <span className="inline-flex items-center gap-2 font-semibold text-warning-800 dark:text-warning-200">
        <AlertTriangle aria-hidden="true" className="w-4 h-4 shrink-0" />
        {t('facilityStructure.resp.notAssigned')}
      </span>
    );
  }
  if (row.responsible.kind === 'unnamedUser') {
    return (
      <span className="text-gray-700 dark:text-gray-300">
        {t('facilityStructure.resp.unnamedUser')}
      </span>
    );
  }
  return <span className="text-gray-900 dark:text-gray-100">{row.responsible.label}</span>;
}

export function ResponsibilityCard({
  rows,
  onSelect,
}: ResponsibilityCardProps): React.ReactElement {
  const { t } = useI18n();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={FRAME}>
      <h3
        id={headingId}
        className={`px-5 py-3 border-b border-gray-200 dark:border-gray-700 ${CARD_HEADING}`}
      >
        {t('facilityStructure.resp.title')}
      </h3>
      <ul className="divide-y divide-gray-200 dark:divide-gray-700">
        {rows.map((row) => (
          <li
            key={row.node.key}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 min-h-11 text-sm"
          >
            <span className={`w-24 shrink-0 ${KICKER}`}>{t(KIND_LABEL_KEY[row.node.kind])}</span>
            <Button variant="ghost" size="sm" onClick={() => onSelect(row.node)}>
              {row.node.code} · {row.node.name}
            </Button>
            <span className="ml-auto">
              <ResponsibleValue row={row} />
            </span>
          </li>
        ))}
      </ul>
      <div className="px-5 py-2.5 border-t border-gray-200 dark:border-gray-700">
        <Link
          to="/sites/setup/sites"
          className="text-sm font-medium text-primary-700 dark:text-primary-300 hover:underline"
        >
          {t('facilityStructure.resp.manageSites')}
        </Link>
      </div>
    </section>
  );
}
