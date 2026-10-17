/**
 * The Budget tab's figures: budget vs month-to-date actual per cost centre,
 * how much is used against how far the month has run, the month-end forecast
 * and its variance (Tenant Console D6 `fin-budget`).
 *
 * WHY a component that takes the sample as a prop: BudgetTab hands it the
 * figures from inside MockPreview, so the notice naming FARM-MEDIUM-439 is
 * always drawn around it; when the budget query lands, the same component
 * renders the real rows and only BudgetTab changes. Budgets are read-only
 * here — there is no mutation to save one to, and an input that kept an
 * edit only until the next render would pretend there was.
 */
import { DataTable, useI18n, type DataTableColumn } from '@aquaculture/shared-ui';
import React, { useId, useMemo } from 'react';

import { budgetView, type BudgetRow, type BudgetSample } from '../model/budgetModel';
import {
  currencySymbol,
  formatMonthYear,
  formatRatio,
  formatSignedWhole,
  formatWhole,
  localized,
} from '../model/financeFormat';

import { PaceBar } from './PaceBar';
import { SeverityMark } from './SeverityMark';
import { FIGURE, SEVERITY_INK, SEVERITY_ROW } from './severityStyles';

const SECTION_TITLE = 'font-display text-2xl font-semibold text-gray-900 dark:text-gray-100';
const SUBTEXT = 'text-sm text-gray-600 dark:text-gray-400';

export function BudgetFigures({ sample }: { sample: BudgetSample }): React.ReactElement {
  const { t, locale } = useI18n();
  const headingId = useId();
  const view = useMemo(() => budgetView(sample), [sample]);

  const columns = useMemo(
    (): DataTableColumn<BudgetRow>[] => [
      {
        key: 'centre',
        header: t('finance.col.costCentre'),
        minWidth: '14rem',
        render: (_value, row) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {localized(row.name, locale)}
            </span>
            <span className={SUBTEXT}>
              {t('finance.budget.centreMeta', {
                code: row.code,
                owner: localized(row.owner, locale),
              })}
            </span>
          </div>
        ),
      },
      {
        key: 'budget',
        header: t('finance.budget.col.budget', {
          currency: sample.currency,
          currencySymbol: currencySymbol(sample.currency, locale),
        }),
        align: 'right',
        minWidth: '9rem',
        render: (_value, row) => (
          <span className={`${FIGURE} text-lg`}>{formatWhole(row.budget, locale)}</span>
        ),
      },
      {
        key: 'actual',
        header: t('finance.budget.col.actual'),
        align: 'right',
        minWidth: '7rem',
        render: (_value, row) => (
          <span className={`${FIGURE} text-lg`}>{formatWhole(row.actual, locale)}</span>
        ),
      },
      {
        key: 'used',
        header: t('finance.budget.col.used'),
        minWidth: '11rem',
        render: (_value, row) => (
          <div className="flex flex-col">
            <span className="text-sm tabular-nums">{formatRatio(row.used, locale)}</span>
            <PaceBar used={row.used} pace={view.pace} />
          </div>
        ),
      },
      {
        key: 'forecast',
        header: t('finance.budget.col.forecast'),
        align: 'right',
        minWidth: '8rem',
        render: (_value, row) => (
          <div className="flex flex-col items-end gap-0.5">
            <span className={`inline-flex items-center gap-2 ${SEVERITY_INK[row.severity]}`}>
              <SeverityMark severity={row.severity} />
              <span className={`${FIGURE} text-lg`}>{formatWhole(row.forecast, locale)}</span>
            </span>
            <span className={SUBTEXT}>{formatRatio(row.forecastRatio, locale)}</span>
          </div>
        ),
      },
      {
        key: 'variance',
        header: t('finance.budget.col.variance'),
        align: 'right',
        minWidth: '7rem',
        render: (_value, row) => (
          <span className={`${FIGURE} text-base ${SEVERITY_INK[row.severity]}`}>
            {formatSignedWhole(row.variance, locale)}
          </span>
        ),
      },
    ],
    [t, locale, sample.currency, view.pace],
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 p-4 sm:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id={headingId} className={SECTION_TITLE}>
          {t('finance.budget.title')}
        </h2>
        <p className="text-base tabular-nums text-gray-900 dark:text-gray-100">
          {t('finance.budget.period', {
            month: formatMonthYear(sample.month.year, sample.month.month, locale),
            day: sample.dayOfMonth,
            days: view.daysInMonth,
          })}
        </p>
      </header>
      <div className="sd-card">
        <DataTable<BudgetRow>
          data={view.rows}
          columns={columns}
          keyExtractor={(row) => row.code}
          rowClassName={(row) => SEVERITY_ROW[row.severity]}
          searchable={false}
          sortable={false}
          stickyHeader={false}
          flush
        />
      </div>
      <p className={SUBTEXT}>
        {t('finance.budget.paceNote', { pace: formatRatio(view.pace, locale) })}
      </p>
    </section>
  );
}
