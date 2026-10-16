/**
 * The cost-centre register: each centre's code, name, the sites whose
 * expenses it collects and the role answerable for it (Tenant Console D6
 * `fin-settings › centers`, shown on the Cost centres tab because the tab is
 * where centres are bound to the location tree).
 *
 * Rendered from CostCentresTab inside MockPreview (FARM-MEDIUM-440).
 */
import { DataTable, useI18n, type DataTableColumn } from '@aquaculture/shared-ui';
import React, { useId, useMemo } from 'react';

import type { CostCentreSample } from '../model/costCentreModel';
import { localized } from '../model/financeFormat';
import type { LocalizedText } from '../model/localizedText';

const SECTION_TITLE = 'font-display text-2xl font-semibold text-gray-900 dark:text-gray-100';

export function CostCentreRegister({
  centres,
  note,
}: {
  centres: readonly CostCentreSample[];
  /** How the centres collect expenses, from the sample (it describes the sample's model). */
  note: LocalizedText;
}): React.ReactElement {
  const { t, locale } = useI18n();
  const headingId = useId();

  const columns = useMemo(
    (): DataTableColumn<CostCentreSample>[] => [
      {
        key: 'code',
        header: t('finance.col.code'),
        minWidth: '5.5rem',
        render: (_value, row) => (
          <span className="font-display font-semibold tracking-[0.06em]">{row.code}</span>
        ),
      },
      {
        key: 'name',
        header: t('finance.col.costCentre'),
        minWidth: '13rem',
        render: (_value, row) => (
          <span className="font-semibold text-gray-900 dark:text-gray-100">
            {localized(row.name, locale)}
          </span>
        ),
      },
      {
        key: 'sites',
        header: t('finance.col.sites'),
        minWidth: '14rem',
        render: (_value, row) => row.sites.map((site) => localized(site, locale)).join(', '),
      },
      {
        key: 'owner',
        header: t('finance.col.owner'),
        minWidth: '10rem',
        render: (_value, row) => localized(row.owner, locale),
      },
    ],
    [t, locale],
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className={SECTION_TITLE}>
        {t('finance.costCentres.register.title')}
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-400">{localized(note, locale)}</p>
      <div className="sd-card">
        <DataTable<CostCentreSample>
          data={centres}
          columns={columns}
          keyExtractor={(row) => row.code}
          searchable={false}
          sortable={false}
          stickyHeader={false}
          flush
        />
      </div>
    </section>
  );
}
