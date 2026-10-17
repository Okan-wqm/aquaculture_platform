/**
 * The Today page's KPI band: five counts in one ruled strip.
 *
 * Sources: "Scheduled today" is teamWeeklyOverview's working count for today
 * (the plan, so it follows the site filter); the four attendance counts are
 * dailyAttendanceOverview — hr-service's own tally, not recomputed here, so
 * this band and /hr/attendance can never disagree. "Present" is everyone who
 * came, late arrivals included; the overview counts them apart.
 *
 * A late or absent count above zero carries the design's shape-coded marker
 * (diamond for late, triangle for absent) and the warning ink.
 */
import React from 'react';
import { Diamond, Triangle } from 'lucide-react';
import { Card, ErrorState, cn, useI18n, type MessageKey } from '@aquaculture/shared-ui';

import type { DailyAttendanceOverview } from '../../types';
import { formatCount } from './todayFormat';

export interface TodayKpiBandProps {
  overview: DailyAttendanceOverview | undefined;
  overviewError: boolean;
  onRetryOverview: () => void;
  /** Today's planned working count, from the (possibly site-filtered) plan. */
  scheduled: number | undefined;
  /** A site filter is active: the attendance counts cannot follow it. */
  siteScoped: boolean;
}

type Marker = 'late' | 'absent';

interface Kpi {
  labelKey: MessageKey;
  value: number | undefined;
  marker?: Marker;
}

function KpiMarker({ marker }: { marker: Marker }): React.JSX.Element {
  return marker === 'late' ? (
    <Diamond className="h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden="true" />
  ) : (
    <Triangle className="h-3 w-3 shrink-0 fill-current" aria-hidden="true" />
  );
}

export function TodayKpiBand({
  overview,
  overviewError,
  onRetryOverview,
  scheduled,
  siteScoped,
}: TodayKpiBandProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const kpis: Kpi[] = [
    { labelKey: 'hr.today.kpi.scheduled', value: scheduled },
    { labelKey: 'hr.today.kpi.present', value: overview && overview.present + overview.late },
    { labelKey: 'hr.today.kpi.late', value: overview?.late, marker: 'late' },
    { labelKey: 'hr.today.kpi.absent', value: overview?.absent, marker: 'absent' },
    { labelKey: 'hr.today.kpi.leave', value: overview?.onLeave },
  ];

  return (
    <Card padding="none" className="overflow-hidden">
      <dl
        aria-label={t('hr.today.kpi.label')}
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
      >
        {kpis.map(({ labelKey, value, marker }) => {
          const shownMarker = value !== undefined && value > 0 ? marker : undefined;
          return (
            <div
              key={labelKey}
              className="flex min-w-0 flex-col gap-2 border-b border-r border-gray-200 px-6 py-4 dark:border-gray-700"
            >
              <dt className="text-xs font-bold uppercase tracking-widest text-gray-600 dark:text-gray-400">
                {t(labelKey)}
              </dt>
              <dd
                className={cn(
                  'flex items-center gap-2.5 text-4xl font-semibold leading-none tabular-nums',
                  shownMarker
                    ? 'text-warning-700 dark:text-warning-300'
                    : 'text-gray-900 dark:text-gray-100',
                )}
              >
                {shownMarker && <KpiMarker marker={shownMarker} />}
                {value === undefined ? '—' : formatCount(value, locale)}
              </dd>
            </div>
          );
        })}
      </dl>
      {overviewError && (
        <ErrorState
          variant="plain"
          size="sm"
          title={t('hr.today.panelError')}
          retryLabel={t('common.retry')}
          onRetry={onRetryOverview}
        />
      )}
      {/* TODO(data): site-scoped attendance counts — dailyAttendanceOverview(date) takes no site;
          needs a `siteId` argument on hr-service's dailyAttendanceOverview filtering employees.farmId. */}
      {siteScoped && (
        <p className="px-6 py-2.5 text-sm text-gray-700 dark:text-gray-300">
          {t('hr.today.kpi.scopeNote')}
        </p>
      )}
    </Card>
  );
}
