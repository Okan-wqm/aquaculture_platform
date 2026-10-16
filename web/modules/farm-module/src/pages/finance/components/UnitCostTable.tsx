/**
 * Unit production cost per site: the period's output, its cost, the cost per
 * unit of output against its target, and feed's share of the cost (Tenant
 * Console D6 `fin-cost`). A site over target is flagged with the same
 * thresholds as the budget (model/severity.ts).
 *
 * Rendered from CostCentresTab inside MockPreview (FARM-MEDIUM-440): unit
 * cost needs costs allocated to cost centres, which do not exist yet.
 */
import { DataTable, useI18n, type DataTableColumn } from '@aquaculture/shared-ui';
import React, { useId, useMemo } from 'react';

import { unitCostRows, type CostCentresSample, type UnitCostRow } from '../model/costCentreModel';
import {
  currencySymbol,
  formatMonth,
  formatOneDecimal,
  formatRatio,
  formatWhole,
  localized,
} from '../model/financeFormat';

import { SeverityMark } from './SeverityMark';
import { FIGURE, SEVERITY_INK, SEVERITY_ROW } from './severityStyles';

const SECTION_TITLE = 'font-display text-2xl font-semibold text-gray-900 dark:text-gray-100';
const SUBTEXT = 'text-sm text-gray-600 dark:text-gray-400';

export function UnitCostTable({ sample }: { sample: CostCentresSample }): React.ReactElement {
  const { t, locale } = useI18n();
  const headingId = useId();
  const rows = useMemo(() => unitCostRows(sample), [sample]);

  const columns = useMemo(
    (): DataTableColumn<UnitCostRow>[] => [
      {
        key: 'site',
        header: t('finance.col.site'),
        minWidth: '12rem',
        render: (_value, row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {localized(row.site, locale)}
            </span>
            <span className={SUBTEXT}>{localized(row.centreName, locale)}</span>
          </div>
        ),
      },
      {
        key: 'output',
        header: t('finance.col.output'),
        align: 'right',
        minWidth: '8rem',
        render: (_value, row) =>
          `${formatOneDecimal(row.output, locale)} ${localized(row.outputUnit, locale)}`,
      },
      {
        key: 'cost',
        header: t('finance.costCentres.col.cost', {
          currency: sample.currency,
          currencySymbol: currencySymbol(sample.currency, locale),
        }),
        align: 'right',
        minWidth: '8rem',
        render: (_value, row) => (
          <span className={`${FIGURE} text-lg`}>{formatWhole(row.cost, locale)}</span>
        ),
      },
      {
        key: 'unitCost',
        header: t('finance.col.unitCost'),
        align: 'right',
        minWidth: '11rem',
        render: (_value, row) => (
          <div className="flex flex-col items-end gap-0.5">
            <span className={`inline-flex items-center gap-2 ${SEVERITY_INK[row.severity]}`}>
              <SeverityMark severity={row.severity} />
              <span className={`${FIGURE} text-lg`}>{formatOneDecimal(row.unitCost, locale)}</span>
            </span>
            <span className={SUBTEXT}>{localized(row.unit, locale)}</span>
          </div>
        ),
      },
      {
        key: 'target',
        header: t('finance.col.target'),
        align: 'right',
        minWidth: '6rem',
        render: (_value, row) => (
          <span className="tabular-nums text-gray-800 dark:text-gray-200">
            {formatOneDecimal(row.target, locale)}
          </span>
        ),
      },
      {
        key: 'feedShare',
        header: t('finance.col.feedShare'),
        align: 'right',
        minWidth: '7rem',
        render: (_value, row) =>
          row.feedShare === null ? '—' : formatRatio(row.feedShare, locale),
      },
    ],
    [t, locale, sample.currency],
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className={SECTION_TITLE}>
        {t('finance.costCentres.unit.title', {
          month: formatMonth(sample.period.year, sample.period.month, locale),
          from: sample.period.fromDay,
          to: sample.period.toDay,
        })}
      </h2>
      <div className="sd-card">
        <DataTable<UnitCostRow>
          data={rows}
          columns={columns}
          keyExtractor={(row) => `${row.centreCode}:${row.site.en}`}
          rowClassName={(row) => SEVERITY_ROW[row.severity]}
          searchable={false}
          sortable={false}
          stickyHeader={false}
          flush
        />
      </div>
      <p className={SUBTEXT}>{localized(sample.unitNote, locale)}</p>
    </section>
  );
}
