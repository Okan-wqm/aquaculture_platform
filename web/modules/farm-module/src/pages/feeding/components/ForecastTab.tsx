/**
 * ForecastTab (Faz 7, plan §8) — tükenme tahmini yüzeyi: DepletionForecastChart
 * (yem başına kalan stok + tükeniş işaretleri) + UnitTransitionTimeline
 * ("A şimdi → X gün sonra B; B Y gün yeter"). Veri K-10 snapshot dilimidir;
 * tazelik `computedAt` damgasıyla görünür, event-driven yenileme (D-6) yeni
 * teslimatı dakikalar içinde yansıtır.
 */
import React, { useMemo, useState } from 'react';
import { useI18n } from '@aquaculture/shared-ui';

import { useProtocolFeedForecast } from '../../../hooks/useProtocolFeeding';
import { useSiteList } from '../../../hooks/useSites';
import { DepletionForecastChart } from './DepletionForecastChart';
import { UnitTransitionTimeline } from './UnitTransitionTimeline';

const HORIZON_OPTIONS = [30, 60, 90, 120] as const;

export function ForecastTab(): React.ReactElement {
  const { t } = useI18n();
  const { data: sitesPage } = useSiteList();
  const sites = useMemo(() => sitesPage?.items ?? [], [sitesPage]);
  const [siteId, setSiteId] = useState<string>('');
  const [horizonDays, setHorizonDays] = useState<number>(90);

  const effectiveSiteId = siteId || sites[0]?.id;
  const { data: forecast, isLoading, isError } = useProtocolFeedForecast(
    effectiveSiteId,
    horizonDays,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-700">
          {t('feedingV2.forecast.siteLabel')}
          <select
            className="ml-2 border border-gray-300 rounded px-2 py-1 text-sm"
            value={effectiveSiteId ?? ''}
            onChange={(e) => setSiteId(e.target.value)}
          >
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-gray-700">
          {t('feedingV2.forecast.horizonLabel')}
          <select
            className="ml-2 border border-gray-300 rounded px-2 py-1 text-sm"
            value={horizonDays}
            onChange={(e) => setHorizonDays(Number(e.target.value))}
          >
            {HORIZON_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading && <p className="text-sm text-gray-500 py-8">{t('common.loading')}</p>}
      {isError && <p className="text-sm text-red-600 py-8">{t('common.error')}</p>}
      {!isLoading && !isError && !forecast && (
        <p className="text-sm text-gray-500 py-8">{t('feedingV2.forecast.notComputed')}</p>
      )}
      {forecast && (
        <>
          <DepletionForecastChart forecast={forecast} />
          <UnitTransitionTimeline forecast={forecast} />
        </>
      )}
    </div>
  );
}
