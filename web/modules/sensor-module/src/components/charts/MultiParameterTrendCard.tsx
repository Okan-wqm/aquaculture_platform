/**
 * Multi-parameter trend card (PR-6; channel-generic since SENSOR-HIGH-138).
 *
 * Renders every channel of one sensor on a single uPlot chart via
 * TrendChart's custom mode: one series per parameter, dual y-axes (unit
 * similarity heuristics), colors from channel displaySettings with palette
 * fallback, and alert-threshold bands as value-range zones.
 *
 * It shows what the server says it returned — bucket width, store, the zone
 * buckets were counted in — draws the time axis in the site's zone, breaks
 * lines where a channel has no data, and on an empty range offers to jump to
 * the channel's last stored data.
 */
import { type TimeRangeSpec } from '@aquaculture/shared-contracts';
import { Button, useI18n } from '@aquaculture/shared-ui';
import { Download } from 'lucide-react';
import { useMemo } from 'react';

import { TrendChart } from './TrendChart';
import { useChannelSeries } from '../../hooks/useChannelReadings';
import type {
  ChartLine,
  ChartLineZone,
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
  channels: readonly TrendChannelSpec[];
  /** The range to chart: a preset ending now, or a fixed window. */
  range: TimeRangeSpec;
  /** The sensor's last stored sample (ms), for the empty-range jump. */
  lastSampleAt?: number | null;
  /** Show another range — the page owns the range, so the card asks. */
  onShowRange?: (range: TimeRangeSpec) => void;
  title?: string;
}

const PALETTE = [
  themeColors.primary[700],
  themeColors.success[500],
  themeColors.accent[600],
  themeColors.warning[700],
  themeColors.primary[700],
  themeColors.primary[600],
];

function unitScaleGroup(unit: string | undefined): 1 | 2 {
  // Temperature-like units take axis 1, everything else axis 2 — keeps the
  // dominant parameter readable without configuring per-unit axes.
  return unit === '°C' || unit === 'C' ? 1 : 2;
}

function thresholdZones(thresholds: TrendChannelSpec['thresholds']): ChartLineZone[] {
  const zones: ChartLineZone[] = [];
  const warn = thresholds?.warning;
  const crit = thresholds?.critical;
  if (crit && (crit.low != null || crit.high != null)) {
    zones.push({
      min: crit.low ?? Number.NEGATIVE_INFINITY,
      max: crit.high ?? Number.POSITIVE_INFINITY,
      stroke: themeColors.warning[700],
      fill: 'rgba(176,74,40,0.10)',
    });
  }
  if (warn && (warn.low != null || warn.high != null)) {
    zones.push({
      min: warn.low ?? Number.NEGATIVE_INFINITY,
      max: warn.high ?? Number.POSITIVE_INFINITY,
      stroke: themeColors.accent[600],
      fill: 'rgba(200,154,60,0.08)',
    });
  }
  return zones;
}

export function MultiParameterTrendCard({
  sensorId,
  channels,
  range,
  lastSampleAt = null,
  onShowRange,
  title,
}: MultiParameterTrendCardProps) {
  const { locale, t } = useI18n();
  const labels = useSeriesLabels();
  const { series, loading, error } = useChannelSeries(sensorId, range);

  const lines: ChartLine[] = useMemo(
    () =>
      channels.map((channel, index) => {
        const zones = thresholdZones(channel.thresholds);
        return {
          id: `trend-${sensorId}-${channel.channelKey}`,
          tagId: channel.channelKey,
          label: channel.unit ? `${channel.displayLabel} (${channel.unit})` : channel.displayLabel,
          color: channel.color ?? PALETTE[index % PALETTE.length]!,
          yAxis: unitScaleGroup(channel.unit),
          interpolation: 'linear',
          // Every channel of the series shares the same buckets, so a bucket a
          // channel lacks is a stretch with no data: the line breaks there
          // (the gaps the server reports), and a lone bucket shows as a dot.
          spanGaps: false,
          showIsolatedPoints: true,
          zones: zones.length > 0 ? zones : undefined,
        };
      }),
    [channels, sensorId],
  );

  // Series come back keyed by channel; the chart lines are keyed by channelKey.
  const customData = useMemo(() => {
    const mapped: Record<string, HistoricalDataPoint[]> = {};
    for (const channel of series?.channels ?? []) {
      mapped[channel.channelKey] = channel.points.map((point) => ({
        timestamp: new Date(point.bucket).getTime(),
        value: point.avg,
      }));
    }
    return mapped;
  }, [series]);

  const hasAnyData = Object.values(customData).some((points) => points.length > 0);
  const lastSampleLabel =
    lastSampleAt === null
      ? null
      : new Intl.DateTimeFormat(locale, {
          timeZone: series?.displayTimeZone,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(lastSampleAt);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
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
          {loading && (
            <span className="text-xs text-gray-400 dark:text-gray-500">{t('series.loading')}</span>
          )}
          {series && hasAnyData && (
            <Button
              variant="secondary"
              size="xs"
              leftIcon={<Download className="w-3 h-3" />}
              onClick={() =>
                downloadCsv(
                  seriesCsv(series, labels.csvHeaders(series), locale),
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
        <p className="mb-2 text-xs text-warning-700 dark:text-warning-400" role="status">
          {t('series.zoneUnavailable')}
        </p>
      )}
      {series &&
        series.displayTimeZoneSource !== 'UNAVAILABLE' &&
        series.bucketTimeZone !== series.displayTimeZone && (
          <p className="mb-2 text-xs text-gray-500 dark:text-gray-400" role="status">
            {t('series.utcBuckets')}
          </p>
        )}
      {error ? (
        <p className="text-sm text-error-600 dark:text-error-400" role="alert">
          {t('series.loadFailed', { error })}
        </p>
      ) : hasAnyData ? (
        <TrendChart
          mode="custom"
          lines={lines}
          customData={customData}
          timeZone={series?.displayTimeZone}
          className="h-64"
        />
      ) : (
        <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          <p>{t('series.emptyRange')}</p>
          {lastSampleAt !== null && lastSampleLabel !== null && (
            <div className="mt-2 flex flex-col items-center gap-2">
              <p>{t('series.lastSample', { time: lastSampleLabel })}</p>
              {onShowRange && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onShowRange(rangeEndingAt(lastSampleAt, range, Date.now()))}
                >
                  {t('series.showLastData')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
