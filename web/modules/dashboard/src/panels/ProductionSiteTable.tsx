/**
 * The Production dashboard's Site status table (design D6 `dashboard` page,
 * aqua workspace): per fish site its alarms, the lowest dissolved oxygen of
 * the units fed today against the configured limit — with where it came from
 * (live channel or manual sample) and how old it is — the water temperature
 * and today's feed against the plan so far (model/production says where each
 * value comes from). Colour appears only where a value is abnormal; a stale
 * site's values are greyed; a site's name opens its live readings.
 */
import { useI18n, type MessageKey, type SupportedLocale } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { useProductionRows } from '../hooks/useProductionRows';
import { worstPriority } from '../model/alarms';
import type { Cell } from '../model/cell';
import { formatAge, formatClock, formatDecimal } from '../model/format';
import type {
  DataFreshness,
  FeedProgress,
  OxygenState,
  ProductionSiteRow,
  ReadingLevel,
  ReadingSource,
} from '../model/production';

import { AlarmTally } from './AlarmTally';
import { CellValue } from './CellValue';
import { SiteIdentity } from './SiteIdentity';
import { SiteStatusTable, type SiteColumn } from './SiteStatusTable';

const LEVEL_CLASS: Readonly<Record<ReadingLevel, string>> = {
  critical: 'text-sd-danger-ink',
  warning: 'text-sd-hz-amber-ink',
  normal: 'text-sd-ink',
};

/** A stale site's readings are old news: greyed, unless a limit is crossed. */
const STALE_CLASS = 'text-sd-neutral-600';

const VALUE_CLASS = 'font-display-sd text-lg leading-tight font-semibold tabular-nums';
const NOTE_CLASS = 'text-sm text-sd-neutral-700';

const SOURCE_KEY: Readonly<Record<ReadingSource, MessageKey>> = {
  live: 'dashboard.production.source.live',
  manual: 'dashboard.production.source.manual',
};

const NO_OXYGEN_KEY: Readonly<Record<Exclude<OxygenState['kind'], 'reading'>, MessageKey>> = {
  noParameter: 'dashboard.production.oxygenNoParameter',
  noUnits: 'dashboard.production.oxygenNoUnits',
  noReading: 'dashboard.production.oxygenNoReading',
};

function isStale(data: Cell<DataFreshness>): boolean {
  return data.status === 'ready' && data.value.state === 'stale';
}

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

/** The bar of today's feed: fed so far, the plan-so-far marker, amber when behind it. */
function FeedBar({ feed }: { readonly feed: FeedProgress }): ReactElement {
  const percent = Math.min(Math.round(feed.ratio * 100), 100);
  const byNow =
    feed.plannedByNowRatio === null
      ? null
      : Math.min(Math.round(feed.plannedByNowRatio * 100), 100);
  return (
    <svg
      viewBox="0 0 100 12"
      preserveAspectRatio="none"
      className="mt-1 block h-3 w-full"
      aria-hidden="true"
    >
      <rect y="3" width="100" height="6" className="fill-sd-neutral-300" />
      <rect
        y="3"
        width={percent}
        height="6"
        className={feed.behind ? 'fill-sd-hz-amber' : 'fill-sd-neutral-700'}
      />
      {byNow !== null && (
        <line
          x1={byNow}
          x2={byNow}
          y1="0"
          y2="12"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          className="stroke-sd-ink"
        />
      )}
    </svg>
  );
}

function OxygenCell({
  oxygen,
  stale,
  now,
}: {
  readonly oxygen: OxygenState;
  readonly stale: boolean;
  readonly now: Date;
}): ReactElement {
  const { t, locale } = useI18n();
  if (oxygen.kind !== 'reading') {
    return (
      <>
        <div className={VALUE_CLASS}>{t('dashboard.production.oxygenNone')}</div>
        <div className={NOTE_CLASS}>{t(NO_OXYGEN_KEY[oxygen.kind])}</div>
      </>
    );
  }
  const { reading } = oxygen;
  const colour = reading.level === 'normal' && stale ? STALE_CLASS : LEVEL_CLASS[reading.level];
  return (
    <>
      <div className={`${VALUE_CLASS} ${colour}`}>
        {t('dashboard.production.oxygen', {
          value: formatDecimal(reading.value, 1, locale),
          unit: reading.unit,
        })}
      </div>
      <div className={NOTE_CLASS}>
        {reading.limit === null
          ? t('dashboard.production.oxygenNoLimit', { unit: reading.unitCode })
          : t('dashboard.production.oxygenLimit', {
              unit: reading.unitCode,
              limit: formatDecimal(reading.limit, 1, locale),
            })}
      </div>
      <div className={`${NOTE_CLASS} tabular-nums`}>
        {t(SOURCE_KEY[reading.source], { age: formatAge(reading.observedAt, now, locale) })}
      </div>
    </>
  );
}

function FeedCell({ feed }: { readonly feed: FeedProgress | null }): ReactElement {
  const { t, locale } = useI18n();
  if (feed === null) {
    return <span className={NOTE_CLASS}>{t('dashboard.production.feedNone')}</span>;
  }
  const amounts = feedAmounts(feed, locale);
  return (
    <>
      <div className="flex justify-between gap-2 text-sm tabular-nums">
        <span className="font-semibold text-sd-ink">
          {t('dashboard.production.feedPercent', { value: Math.round(feed.ratio * 100) })}
        </span>
        <span className="text-sd-neutral-700">
          {t(amounts.tonnes ? 'dashboard.production.feedTonnes' : 'dashboard.production.feedKg', {
            actual: amounts.actual,
            planned: amounts.planned,
          })}
        </span>
      </div>
      <FeedBar feed={feed} />
      {feed.plannedByNowRatio !== null && (
        <span className="sr-only">
          {t(
            feed.behind
              ? 'dashboard.production.feedBehindPlan'
              : 'dashboard.production.feedPlannedByNow',
            { value: Math.round(feed.plannedByNowRatio * 100) },
          )}
        </span>
      )}
    </>
  );
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
          {(oxygen) => <OxygenCell oxygen={oxygen} stale={isStale(row.data)} now={now} />}
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
                <div className={`${VALUE_CLASS} ${isStale(row.data) ? STALE_CLASS : ''}`}>
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
      render: (row) => <CellValue cell={row.feed}>{(feed) => <FeedCell feed={feed} />}</CellValue>,
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
