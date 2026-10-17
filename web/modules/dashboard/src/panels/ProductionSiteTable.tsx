/**
 * The Production dashboard's Site status table (design D6 `dashboard` page,
 * aqua workspace): per fish site its alarms, the lowest dissolved oxygen
 * against the configured limit, the water temperature and today's feed
 * (model/production says where each value comes from). Colour appears only
 * where a value is abnormal; a site row opens the site's live readings.
 */
import { useI18n, type SupportedLocale } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { useProductionRows } from '../hooks/useProductionRows';
import { worstPriority } from '../model/alarms';
import { formatClock, formatDecimal } from '../model/format';
import type { FeedProgress, ProductionSiteRow, ReadingLevel } from '../model/production';

import { AlarmTally } from './AlarmTally';
import { CellValue } from './CellValue';
import { SiteIdentity } from './SiteIdentity';
import { SiteStatusTable, type SiteColumn } from './SiteStatusTable';

const LEVEL_CLASS: Readonly<Record<ReadingLevel, string>> = {
  critical: 'text-sd-danger-ink',
  warning: 'text-sd-hz-amber-ink',
  normal: 'text-sd-ink',
};

const VALUE_CLASS = 'font-display-sd text-lg leading-tight font-semibold tabular-nums';
const NOTE_CLASS = 'text-sm text-sd-neutral-700';

function feedAmounts(
  feed: FeedProgress,
  locale: SupportedLocale,
): { actual: string; planned: string; tonnes: boolean } {
  const tonnes = feed.plannedKg >= 1000;
  const scale = tonnes ? 1000 : 1;
  return {
    actual: formatDecimal(feed.actualKg / scale, 1, locale),
    planned: formatDecimal(feed.plannedKg / scale, 1, locale),
    tonnes,
  };
}

export function ProductionSiteTable({ now }: { readonly now: Date }): ReactElement {
  const { t, locale } = useI18n();
  const { sites, rows } = useProductionRows();

  const columns: SiteColumn<ProductionSiteRow>[] = [
    {
      key: 'site',
      header: t('dashboard.sites.column.site'),
      render: (row) => (
        <SiteIdentity
          code={row.code}
          type={row.type}
          name={row.name}
          href={`/sites/environment/${row.siteId}`}
          data={row.data}
          now={now}
          extra={
            row.tankCount.status === 'ready' && row.tankCount.value !== null ? (
              <span title={t('dashboard.sites.tanksSource')}>
                {` · ${t(row.tankCount.value === 1 ? 'dashboard.sites.tanks.one' : 'dashboard.sites.tanks.other', { count: row.tankCount.value })}`}
              </span>
            ) : undefined
          }
        />
      ),
    },
    {
      key: 'alarms',
      header: t('dashboard.sites.column.alarms'),
      width: '120px',
      render: (row) => (
        <CellValue cell={row.alarms}>{(tally) => <AlarmTally tally={tally} />}</CellValue>
      ),
    },
    {
      key: 'oxygen',
      header: t('dashboard.production.column.keyReading'),
      render: (row) => (
        <CellValue cell={row.oxygen}>
          {(oxygen) =>
            oxygen === null ? (
              <>
                <div className={VALUE_CLASS}>{t('dashboard.production.oxygenNone')}</div>
                <div className={NOTE_CLASS}>{t('dashboard.production.oxygenNoReading')}</div>
              </>
            ) : (
              <>
                <div className={`${VALUE_CLASS} ${LEVEL_CLASS[oxygen.level]}`}>
                  {t('dashboard.production.oxygen', {
                    value: formatDecimal(oxygen.value, 1, locale),
                  })}
                </div>
                <div className={NOTE_CLASS}>
                  {oxygen.limit === null
                    ? t('dashboard.production.oxygenNoLimit', {
                        unit: oxygen.unitCode ?? t('dashboard.production.unknownUnit'),
                      })
                    : t('dashboard.production.oxygenLimit', {
                        unit: oxygen.unitCode ?? t('dashboard.production.unknownUnit'),
                        limit: formatDecimal(oxygen.limit, 1, locale),
                      })}
                </div>
              </>
            )
          }
        </CellValue>
      ),
    },
    {
      key: 'temperature',
      header: t('dashboard.production.column.temperature'),
      render: (row) => (
        <CellValue cell={row.temperature}>
          {(temperature) =>
            temperature === null ? (
              <>
                <div className={VALUE_CLASS}>{t('dashboard.production.temperatureNone')}</div>
                <div className={NOTE_CLASS}>{t('dashboard.production.temperatureNoReading')}</div>
              </>
            ) : (
              <>
                <div className={VALUE_CLASS}>
                  {t('dashboard.production.temperature', {
                    value: formatDecimal(temperature.latest, 1, locale),
                  })}
                </div>
                {temperature.hottest !== null && (
                  <div className={NOTE_CLASS}>
                    {t('dashboard.production.hottest', {
                      unit: temperature.hottest.unitCode,
                      value: formatDecimal(temperature.hottest.celsius, 1, locale),
                    })}
                  </div>
                )}
              </>
            )
          }
        </CellValue>
      ),
    },
    {
      key: 'feed',
      header: t('dashboard.production.column.feed'),
      width: '160px',
      render: (row) => (
        <CellValue cell={row.feed}>
          {(feed) => {
            if (feed === null) {
              return <span className={NOTE_CLASS}>{t('dashboard.production.feedNone')}</span>;
            }
            const percent = Math.round(feed.ratio * 100);
            const amounts = feedAmounts(feed, locale);
            return (
              <>
                <div className="flex justify-between gap-2 text-sm tabular-nums">
                  <span className="font-semibold text-sd-ink">
                    {t('dashboard.production.feedPercent', { value: percent })}
                  </span>
                  <span className="text-sd-neutral-700">
                    {t(
                      amounts.tonnes
                        ? 'dashboard.production.feedTonnes'
                        : 'dashboard.production.feedKg',
                      {
                        actual: amounts.actual,
                        planned: amounts.planned,
                      },
                    )}
                  </span>
                </div>
                <svg
                  viewBox="0 0 100 6"
                  preserveAspectRatio="none"
                  className="mt-1.5 block h-1.5 w-full"
                  aria-hidden="true"
                >
                  <rect width="100" height="6" className="fill-sd-neutral-300" />
                  <rect width={Math.min(percent, 100)} height="6" className="fill-sd-neutral-700" />
                </svg>
              </>
            );
          }}
        </CellValue>
      ),
    },
  ];

  return (
    <SiteStatusTable
      headingId="dashboard-sites-production"
      title={t('dashboard.sites.title')}
      status={
        sites.dataUpdatedAt > 0
          ? t('dashboard.sites.updated', {
              time: formatClock(new Date(sites.dataUpdatedAt), locale),
            })
          : undefined
      }
      footnote={t('dashboard.production.footnote')}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.siteId}
      alarmOf={(row) => (row.alarms.status === 'ready' ? worstPriority(row.alarms.value) : null)}
      loading={sites.isLoading}
      failed={sites.isError}
    />
  );
}
