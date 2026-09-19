/**
 * Multi-parameter trend card (PR-6).
 *
 * Renders every channel of one sensor on a single uPlot chart via
 * TrendChart's custom mode: one series per parameter, dual y-axes (unit
 * similarity heuristics), colors from channel displaySettings with palette
 * fallback, and alert-threshold bands as value-range zones.
 */
import { useMemo } from 'react';

import { TrendChart } from './TrendChart';
import { useAggregatedMultiSeries } from '../../hooks/useAggregatedMultiSeries';
import type {
  ChartLine,
  ChartLineZone,
  HistoricalDataPoint,
} from '../../types/scada-runtime.types';
import { colors as themeColors } from '@aquaculture/shared-ui';

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
  /** Window length in ms (default 24h — served from the metrics_1min tier). */
  rangeMs?: number;
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
  rangeMs = 24 * 60 * 60 * 1000,
  title,
}: MultiParameterTrendCardProps) {
  const channelKeys = useMemo(() => channels.map((c) => c.channelKey), [channels]);
  const { series, loading, error } = useAggregatedMultiSeries(sensorId, channelKeys, rangeMs);

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
          spanGaps: true,
          zones: zones.length > 0 ? zones : undefined,
        };
      }),
    [channels, sensorId],
  );

  const customData = useMemo(() => {
    const mapped: Record<string, HistoricalDataPoint[]> = {};
    for (const [key, points] of Object.entries(series)) {
      mapped[key] = points.map((point) => ({ timestamp: point.timestamp, value: point.value }));
    }
    return mapped;
  }, [series]);

  const hasAnyData = Object.values(series).some((points) => points.length > 0);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {title ?? 'Parametre Trendleri'}
        </h4>
        {loading && <span className="text-xs text-gray-400 dark:text-gray-500">Yükleniyor…</span>}
      </div>
      {error ? (
        <p className="text-sm text-error-600 dark:text-error-400" role="alert">
          Trend verisi alınamadı: {error}
        </p>
      ) : hasAnyData ? (
        <TrendChart mode="custom" lines={lines} customData={customData} className="h-64" />
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center">
          Seçilen aralıkta trend verisi yok.
        </p>
      )}
    </div>
  );
}
