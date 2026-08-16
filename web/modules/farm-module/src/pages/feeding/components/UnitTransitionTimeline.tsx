/**
 * UnitTransitionTimeline (Faz 7, plan §8) — ünite başına yem-geçiş zaman
 * çizelgesi: "Tank 1 A kullanıyor → 12 gün sonra B'ye geçecek". Yatay bar
 * ufka normalize edilir; geçiş sınırları işaretlenir, kapsama açığı taşıyan
 * geçiş (TRANSITION_COVERAGE_GAP alerti) kırmızı rozet alır.
 *
 * Grafik kütüphanesine ihtiyaç yok — CSS bar; DepletionForecastChart ile yan
 * yana "A şimdi → B'ye geçiş; B X gün yeter" hikâyesini anlatır.
 */
import React from 'react';
import { useI18n } from '@aquaculture/shared-ui';

import type { ProtocolFeedForecastView } from '../../../hooks/useProtocolFeeding';

const SEGMENT_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

interface Props {
  forecast: ProtocolFeedForecastView;
}

export function UnitTransitionTimeline({ forecast }: Props): React.ReactElement {
  const { t } = useI18n();
  const horizon = forecast.horizonDays;
  const feedCodeById = new Map(forecast.perFeed.map((f) => [f.feedId, f.feedCode]));
  const gapKeys = new Set(
    forecast.alerts
      .filter((a) => a.type === 'TRANSITION_COVERAGE_GAP' && a.unitId)
      .map((a) => `${a.unitId}:${a.feedId}`),
  );

  if (forecast.perUnit.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-8 text-center">
        {t('feedingV2.forecast.noUnits')}
      </p>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-gray-900 mb-3">
        {t('feedingV2.forecast.timelineTitle', { days: horizon })}
      </h3>
      <div className="space-y-3">
        {forecast.perUnit.map((unit) => {
          // Segmentler: [gün-0, geçiş-1), [geçiş-1, geçiş-2), ... [son, ufuk)
          const boundaries = [0, ...unit.transitions.map((tr) => tr.daysFromNow), horizon];
          const feeds = [
            ...unit.transitions.map((tr) => tr.fromFeedId),
            unit.terminalFeedId,
          ];
          return (
            <div key={unit.unitId}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="font-medium text-gray-800">
                  {unit.unitName} ({unit.unitCode})
                </span>
                <span className="text-xs text-gray-500">
                  {unit.transitions.length === 0
                    ? t('feedingV2.forecast.noTransition')
                    : unit.transitions
                        .map((tr) =>
                          t('feedingV2.forecast.transitionLabel', {
                            code: feedCodeById.get(tr.toFeedId) ?? tr.toFeedId.slice(0, 8),
                            days: tr.daysFromNow,
                          }),
                        )
                        .join(' · ')}
                </span>
              </div>
              <div className="relative flex h-6 rounded overflow-hidden border border-gray-200">
                {boundaries.slice(0, -1).map((start, index) => {
                  const end = boundaries[index + 1] ?? horizon;
                  const widthPercent = Math.max(((end - start) / horizon) * 100, 1);
                  const feedId = feeds[index] ?? null;
                  const code = feedId ? (feedCodeById.get(feedId) ?? '?') : '?';
                  const hasGap = feedId !== null && gapKeys.has(`${unit.unitId}:${feedId}`);
                  return (
                    <div
                      key={`${unit.unitId}-${start}`}
                      className="flex items-center justify-center text-[10px] text-white font-semibold"
                      style={{
                        width: `${widthPercent}%`,
                        backgroundColor: SEGMENT_COLORS[index % SEGMENT_COLORS.length],
                      }}
                      title={`${code}: gün ${start}–${end}`}
                    >
                      {widthPercent > 8 ? code : ''}
                      {hasGap && (
                        <span className="ml-1 px-1 rounded bg-red-600">
                          {t('feedingV2.forecast.gapBadge')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
