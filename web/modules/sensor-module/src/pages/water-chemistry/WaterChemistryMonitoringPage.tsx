/**
 * Water-chemistry monitoring (sensor-module): one tab per system of the farm,
 * each the loop's measurement points overlaid on one Deffeyes diagram, with
 * the selected point's chart, results and live source tiles.
 *
 * Every value is read from the farm API (the sources bound at each point and
 * the calculation inputs resolved there); binding is the farm Sources tab's.
 * The only thing the browser keeps is the chart-type choice, per tenant.
 *
 * Routes: /sensor/water-chemistry (the first system),
 * /sensor/water-chemistry/system/:id, /sensor/water-chemistry/tank/:id (the
 * tank's system, the tank selected).
 */
import { PageHeader, Tabs, useAuth, useI18n, useTenantScopedStorage } from '@aquaculture/shared-ui';
import { type FC, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { clearRetiredMockStorage } from './retiredMockStorage';
import { isChartType, type ChartType } from './types';
import { useTankSystem, useWcSystemList, WC_REFRESH_MS } from './useWaterChemistryMonitoring';
import { WcSystemView } from './WcSystemView';

const CHART_TYPE_STORAGE_KEY = 'wc-monitoring-chart-type';

/** The clock tiles measure ages to, ticking with the refresh. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const WaterChemistryMonitoringPage: FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { scopeKind, scopeId } = useParams();
  const { tenantId } = useAuth();
  const chartStorage = useTenantScopedStorage<string>(CHART_TYPE_STORAGE_KEY, tenantId);
  const [chartType, setChartType] = useState<ChartType>('deffeyes');
  const now = useNow(WC_REFRESH_MS);

  useEffect(() => {
    clearRetiredMockStorage();
  }, []);
  useEffect(() => {
    const stored = chartStorage.read();
    if (isChartType(stored)) setChartType(stored);
  }, [chartStorage]);

  const systems = useWcSystemList();
  const tankScope = scopeKind === 'tank' && scopeId !== undefined ? scopeId : null;
  const tankSystem = useTankSystem(tankScope);
  const systemList = systems.data ?? [];

  const activeSystemId =
    scopeKind === 'system' && scopeId !== undefined
      ? scopeId
      : tankScope !== null
        ? (tankSystem.data ?? null)
        : (systemList[0]?.id ?? null);
  const activeSystem = systemList.find((system) => system.id === activeSystemId) ?? null;

  const changeChartType = (next: ChartType): void => {
    setChartType(next);
    chartStorage.write(next);
  };

  return (
    <div className="p-4">
      <PageHeader
        title={t('wqSource.ui.monitoringTitle')}
        description={t('wqSource.ui.monitoringDescription')}
        className="mb-3"
      />

      {systems.error !== null && (
        <p role="alert" className="text-sm text-error-700 dark:text-error-300">
          {t('wqSource.ui.systemsReadFailed', { error: systems.error.message })}
        </p>
      )}
      {systems.isSuccess && systemList.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('wqSource.ui.noSystem')}</p>
      )}

      {systemList.length > 0 && activeSystemId !== null && (
        <Tabs
          aria-label={t('wqSource.ui.systems')}
          className="mb-4"
          scrollable
          value={activeSystemId}
          onChange={(id) => navigate(`/sensor/water-chemistry/system/${id}`)}
          items={systemList.map((system) => ({ id: system.id, label: system.name }))}
        />
      )}

      {activeSystem !== null && (
        <WcSystemView
          key={activeSystem.id}
          system={activeSystem}
          focusTankId={tankScope}
          chartType={chartType}
          onChartTypeChange={changeChartType}
          now={now}
        />
      )}
    </div>
  );
};

export default WaterChemistryMonitoringPage;
