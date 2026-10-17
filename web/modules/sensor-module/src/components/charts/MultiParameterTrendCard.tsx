/**
 * Multi-parameter trend card (PR-6; channel-generic since SENSOR-HIGH-138).
 *
 * Renders EVERY channel of one sensor as its own small TrendChart — one
 * parameter per chart, each auto-scaled to its own data, time on the shared
 * x-axis (uPlot cursor sync ties the small multiples together). Drawing all
 * parameters on ONE chart crushed them onto two shared y-axes: one
 * high-magnitude channel (e.g. conductivity in µS/cm) re-scaled the axis so
 * pH/DO/etc. collapsed into one indistinguishable bundle at the bottom.
 *
 * Colors come from the channel's displaySettings with the design-system
 * chartPalette fallback; alert-threshold bands render as value-range zones
 * on that parameter's own chart.
 *
 * It shows what the server says it returned — bucket width, store, the zone
 * buckets were counted in — draws the time axis in the site's zone, breaks
 * lines where a channel has no data, and on an empty range offers to jump to
 * the channel's last stored data.
 */
import { type TimeRangeSpec } from '@aquaculture/shared-contracts';
import { Button, chartPalette, useI18n } from '@aquaculture/shared-ui';
import { Download } from 'lucide-react';
import React, { useMemo } from 'react';

import { TrendChart } from './TrendChart';
import { useChannelSeries } from '../../hooks/useChannelReadings';
import type {
  ChartLine,
  ChartLineZone,
  ChartOptions,
  HistoricalDataPoint,
} from '../../types/scada-runtime.types';
import { colors as themeColors } from '@aquaculture/shared-ui';
import { downloadCsv } from '../readings/downloadCsv';
import { rangeEndingAt, seriesCsv } from '../readings/readingsModel';
import { useSeriesLabels } from '../readings/seriesLabels';

export interface TrendChannelSpec {
  channelKey: string;
  displayLabel: string;
  unit?: string;
  color?: string;
  thresholds?: {
    warning?: { low?: number | null; high?: number | null };
    critical?: { low?: number | null; high?: number | null };
  };
}

export interface MultiParameterTrendCardProps {
  sensorId: string;
  /** Names the card's controls for assistive technology. */
  sensorName?: string;
  channels: readonly TrendChannelSpec[];
  /** The range to chart: a preset ending now, or a fixed window. */
  range: TimeRangeSpec;
  /** The sensor's last stored sample (ms), for the empty-range jump. */
  lastSampleAt?: number | null;
  /** Show another range — the page owns the range, so the card asks. */
  onShowRange?: (range: TimeRangeSpec) => void;
  title?: string;
}

/**
 * Small-multiple chart options, module-level for a single identity: a render-
 * local object literal would defeat TrendChart's `options` memo and rebuild
 * the uPlot instance on every parent re-render. The grid's header row is the
 * legend, so uPlot's own legend is turned off.
 */
const SMALL_MULTIPLE_OPTIONS: Partial<ChartOptions> = { legendMode: 'never' };

function thresholdZones(thresholds: TrendChannelSpec['thresholds']): ChartLineZone[] {
  const zones: ChartLineZone[] = [];
  const warn = thresholds?.warning;
  const crit = thresholds?.critical;
  if (crit && (crit.low != null || crit.high != null)) {
    zones.push({
      min: crit.low ?? Number.NEGATIVE_INFINITY,
      max: crit.high ?? Number.POSITIVE_INFINITY,
      stroke: themeColors.warning[700],
      // The band is its stroke at 10% (hex alpha 1a): one token, not a second literal hue.
      fill: `${themeColors.warning[700]}1a`,
    });
  }
  if (warn && (warn.low != null || warn.high != null)) {
    zones.push({
      min: warn.low ?? Number.NEGATIVE_INFINITY,
      max: warn.high ?? Number.POSITIVE_INFINITY,
      stroke: themeColors.accent[600],
      fill: `${themeColors.accent[600]}14`,
    });
  }
  return zones;
}

export function MultiParameterTrendCard({
  sensorId,
  sensorName,
  channels,
  range,
  lastSampleAt = null,
  onShowRange,
  title,
}: MultiParameterTrendCardProps) {
  const { locale, t } = useI18n();
  const labels = useSeriesLabels();
  const { series, loading, fetching, error } = useChannelSeries(sensorId, range);
  // Everything the card says — the chart, "no data", the export — is about the
  // channels it shows (the page's parameter filter), not the sensor's others.
  const shownKeys = useMemo(
    () => new Set(channels.map((channel) => channel.channelKey)),
    [channels],
  );

  /** One line per channel, keyed by channelKey — each chart draws its own. */
  const linesByKey = useMemo(() => {
    const byKey = new Map<string, ChartLine>();
    channels.forEach((channel, index) => {
      const zones = thresholdZones(channel.thresholds);
      byKey.set(channel.channelKey, {
        id: `trend-${sensorId}-${channel.channelKey}`,
        tagId: channel.channelKey,
        label: channel.unit ? `${channel.displayLabel} (${channel.unit})` : channel.displayLabel,
        color: channel.color ?? chartPalette[index % chartPalette.length]!,
        // Own chart → own y-scale: the parameter auto-scales to its data
        // instead of sharing an axis with every other unit.
        yAxis: 1,
        interpolation: 'linear',
        // Lines break only where the server reports this channel went
        // quiet (its gaps, measured against its own rhythm); a lone bucket
        // between two gaps shows as a dot.
        spanGaps: false,
        showIsolatedPoints: true,
        zones: zones.length > 0 ? zones : undefined,
      });
    });
    return byKey;
  }, [channels, sensorId]);

  // Series come back keyed by channel; the chart lines are keyed by channelKey.
  const { customData, breaks } = useMemo(() => {
    const mapped: Record<string, HistoricalDataPoint[]> = {};
    const stops: Record<string, number[]> = {};
    for (const channel of series?.channels ?? []) {
      if (!shownKeys.has(channel.channelKey)) continue;
      mapped[channel.channelKey] = channel.points.map((point) => ({
        timestamp: new Date(point.bucket).getTime(),
        value: point.avg,
      }));
      stops[channel.channelKey] = channel.gaps.map((gap) => new Date(gap.start).getTime());
    }
    return { customData: mapped, breaks: stops };
  }, [series, shownKeys]);

  const hasAnyData = Object.values(customData).some((points) => points.length > 0);
  // "No data" is said only about an answer for the range on screen, never
  // while the first answer, or the answer for a new range, is on its way.
  const settled = series !== null && !fetching;
  const lastSampleLabel =
    lastSampleAt === null
      ? null
      : new Intl.DateTimeFormat(locale, {
          timeZone: series?.displayTimeZone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(lastSampleAt);

  // One of four states, in this order: the request failed, there is data to
  // draw, the answer for this range is still coming, or the range is empty.
  let body: React.ReactNode;
  if (error) {
    body = (
      <p className="text-sm text-error-600 dark:text-error-400" role="alert">
        {t('series.loadFailed', { error })}
      </p>
    );
  } else if (hasAnyData) {
    body = (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {channels.map((channel) => {
          const line = linesByKey.get(channel.channelKey);
          const points = customData[channel.channelKey] ?? [];
          const label = channel.unit
            ? `${channel.displayLabel} (${channel.unit})`
            : channel.displayLabel;
          if (line === undefined || points.length === 0) {
            // The card has data for the range, this parameter does not: keep
            // its grid cell so the layout does not reflow per parameter.
            return (
              <div
                key={channel.channelKey}
                className="flex min-h-44 items-center justify-center rounded-lg border border-dashed border-gray-200 dark:border-gray-700 p-4 text-center text-xs text-gray-400 dark:text-gray-500"
              >
                {label} — {t('series.emptyRange')}
              </div>
            );
          }
          return (
            <div
              key={channel.channelKey}
              className="rounded-lg border border-gray-100 dark:border-gray-700 p-2"
            >
              <p className="mb-1 flex items-center gap-1.5 truncate text-xs font-medium text-gray-700 dark:text-gray-300">
                <span
                  className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                  style={{ background: line.color }}
                  aria-hidden="true"
                />
                {label}
              </p>
              <TrendChart
                lines={[line]}
                customData={{ [channel.channelKey]: points }}
                breaks={{ [channel.channelKey]: breaks[channel.channelKey] ?? [] }}
                timeZone={series?.displayTimeZone}
                options={SMALL_MULTIPLE_OPTIONS}
                className="h-44"
              />
            </div>
          );
        })}
      </div>
    );
  } else if (!settled) {
    body = (
      <p className="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
        {t('series.loading')}
      </p>
    );
  } else {
    body = (
      <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        <p>{t('series.emptyRange')}</p>
        {lastSampleAt !== null && lastSampleLabel !== null && (
          <div className="mt-2 flex flex-col items-center gap-2">
            <p>{t('series.lastSample', { time: lastSampleLabel })}</p>
            {onShowRange && (
              <Button
                variant="secondary"
                size="sm"
                aria-label={
                  sensorName ? t('series.showLastDataFor', { sensor: sensorName }) : undefined
                }
                onClick={() => onShowRange(rangeEndingAt(lastSampleAt, range, Date.now()))}
              >
                {t('series.showLastData')}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-(--shadow-sd-sm) border border-gray-100 dark:border-gray-700 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {title ?? t('series.title')}
          </h4>
          {series && (
            <p className="text-xs text-gray-500 dark:text-gray-400">{labels.resolution(series)}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {(loading || fetching) && (
            <span className="text-xs text-gray-400 dark:text-gray-500" aria-live="polite">
              {t('series.loading')}
            </span>
          )}
          {series && hasAnyData && (
            <Button
              variant="secondary"
              size="xs"
              leftIcon={<Download className="w-3 h-3" />}
              aria-label={sensorName ? t('series.csvFor', { sensor: sensorName }) : undefined}
              onClick={() =>
                downloadCsv(
                  seriesCsv(series, labels.csvHeaders(series), locale, shownKeys),
                  `seri-${sensorId}`,
                )
              }
            >
              {t('series.csv')}
            </Button>
          )}
        </div>
      </div>
      {series?.displayTimeZoneSource === 'UNAVAILABLE' && (
        <p className="mb-2 text-xs text-warning-700 dark:text-warning-400">
          {t('series.zoneUnavailable')}
        </p>
      )}
      {series &&
        series.displayTimeZoneSource !== 'UNAVAILABLE' &&
        series.bucketTimeZone !== series.displayTimeZone && (
          <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{t('series.utcBuckets')}</p>
        )}
      {body}
    </div>
  );
}
