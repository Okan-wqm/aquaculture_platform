/**
 * DepletionForecastChart (Faz 7, plan §8) — yem başına kalan-stok serileri.
 *
 * Materyalize snapshot'ın grafik-hazır `remainingStockSeries` verisini çizer
 * (P-16 — cap yok): sıfır taban çizgisi, yem başına tükeniş ReferenceDot'u,
 * `computedAt` tazelik damgası (D-6) ve mortalityAssumption açık varsayım
 * rozeti. Sorgu anında yeniden hesap YOKTUR — grafik snapshot'ın dilimidir.
 */
import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';
import { useI18n } from '@aquaculture/shared-ui';

import type { ProtocolFeedForecastView } from '../../../hooks/useProtocolFeeding';

const SERIES_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

function addDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface Props {
  forecast: ProtocolFeedForecastView;
}

export function DepletionForecastChart({ forecast }: Props): React.ReactElement {
  const { t } = useI18n();

  // computedAt'in takvim günü = serinin gün-0'ı (BE startDate sözleşmesi).
  const startDate = forecast.computedAt.slice(0, 10);
  const horizon = Math.max(...forecast.perFeed.map((f) => f.remainingStockSeries.length), 0);

  const data = useMemo(() => {
    const rows: Array<Record<string, number | string>> = [];
    for (let day = 0; day < horizon; day++) {
      const row: Record<string, number | string> = { date: addDays(startDate, day) };
      for (const feed of forecast.perFeed) {
        const remaining = feed.remainingStockSeries[day];
        if (remaining !== undefined) row[feed.feedCode] = Math.max(remaining, 0);
      }
      rows.push(row);
    }
    return rows;
  }, [forecast, startDate, horizon]);

  if (forecast.perFeed.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-8 text-center">{t('feedingV2.forecast.empty')}</p>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h3 className="font-semibold text-gray-900">{t('feedingV2.forecast.chartTitle')}</h3>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          {forecast.mortalityAssumption.applied ? (
            <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700">
              {t('feedingV2.forecast.mortalityApplied')}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">
              {t('feedingV2.forecast.mortalityNone')}
            </span>
          )}
          <span>
            {t('feedingV2.forecast.computedAt', {
              at: new Date(forecast.computedAt).toLocaleString(),
            })}
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
          <YAxis tick={{ fontSize: 11 }} unit=" kg" width={72} />
          <Tooltip />
          <Legend />
          <ReferenceLine y={0} stroke="#9ca3af" strokeWidth={1} />
          {forecast.perFeed.map((feed, index) => (
            <Line
              key={feed.feedId}
              type="monotone"
              dataKey={feed.feedCode}
              name={`${feed.feedCode} — ${feed.feedName}`}
              stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
              dot={false}
              strokeWidth={2}
            />
          ))}
          {forecast.perFeed.map((feed, index) =>
            feed.stockoutDate ? (
              <ReferenceDot
                key={`stockout-${feed.feedId}`}
                x={feed.stockoutDate}
                y={0}
                r={5}
                fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                stroke="#111827"
              />
            ) : null,
          )}
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-3 flex flex-wrap gap-2">
        {forecast.perFeed.map((feed) =>
          feed.daysOfCover !== null ? (
            <span
              key={feed.feedId}
              className={`text-xs px-2 py-1 rounded ${
                feed.daysOfCover <= 3 ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
              }`}
            >
              {t('feedingV2.forecast.stockoutBadge', {
                code: feed.feedCode,
                days: feed.daysOfCover,
              })}
              {feed.coverageFromAdoptionDays !== null &&
                ` · ${t('feedingV2.forecast.coverageBadge', {
                  days: feed.coverageFromAdoptionDays,
                })}`}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
