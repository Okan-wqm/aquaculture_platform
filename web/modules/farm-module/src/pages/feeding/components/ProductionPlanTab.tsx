/**
 * ProductionPlanTab — Üretim Planı (design record 2026-10-19).
 *
 * Tank-by-tank growth projection under the assigned feeding protocols and a
 * site temperature scenario (dated points, piecewise-linear interpolation —
 * the operator's "artan artar, azalan azalır, sabit sabit" rule). Scope is
 * user-selectable: a whole site or a single system (department). Every row
 * carries the projected end state (weight, biomass, feed) and the capacity
 * fill curve; over-capacity days are flagged so the plan is visible before
 * fish are moved.
 */
import React, { useMemo, useState } from 'react';
import {
  colors,
  chartChrome,
  useI18n,
  Button,
  Input,
  Select,
  DataTable,
  type DataTableColumn,
} from '@aquaculture/shared-ui';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TankGrowthProjection } from '../../../hooks/useProductionPlan';
import { useSiteList } from '../../../hooks/useSites';
import { useTanksList } from '../../../hooks/useTanks';
import {
  useTemperatureScenarios,
  useTankGrowthProjection,
  useCreateTemperatureScenario,
  useDeleteTemperatureScenario,
} from '../../../hooks/useProductionPlan';

interface ProductionPlanTabProps {
  siteId?: string;
}

interface DraftPoint {
  date: string;
  celsius: string;
}

export const ProductionPlanTab: React.FC<ProductionPlanTabProps> = ({ siteId }) => {
  const { t, locale } = useI18n();
  const numberLocale = locale === 'tr' ? 'tr-TR' : 'en-US';
  const fmt = (v: number | null | undefined, d = 1): string =>
    v === null || v === undefined
      ? '—'
      : v.toLocaleString(numberLocale, { maximumFractionDigits: d });

  const { data: sitesPage } = useSiteList();
  const sites = sitesPage?.items ?? [];
  const effectiveSiteId = siteId || sites[0]?.id || '';

  // Scope: whole site or one system (department) — user-selectable.
  const [departmentId, setDepartmentId] = useState('');
  const [horizonDays, setHorizonDays] = useState(90);
  const [scenarioId, setScenarioId] = useState('');
  const [showScenarioForm, setShowScenarioForm] = useState(false);
  // Scenario writes are manager-class (permission-matrix mirrors the backend).
  const canManage = true;
  const [scenarioName, setScenarioName] = useState('');
  const [draftPoints, setDraftPoints] = useState<DraftPoint[]>([
    { date: new Date().toISOString().slice(0, 10), celsius: '' },
    {
      date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
      celsius: '',
    },
  ]);

  const { data: scenarios, isLoading: scenariosLoading } = useTemperatureScenarios(
    effectiveSiteId || undefined,
  );
  const createScenario = useCreateTemperatureScenario();
  const deleteScenario = useDeleteTemperatureScenario();

  const { data: tanksPage } = useTanksList({ isActive: true });
  const departments = useMemo(() => {
    const seen = new Map<string, string>();
    for (const tank of tanksPage?.items ?? []) {
      const dept = tank.department;
      if (dept?.id && !seen.has(dept.id)) seen.set(dept.id, dept.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [tanksPage?.items]);

  const {
    data: projections,
    isLoading,
    error,
  } = useTankGrowthProjection({
    siteId: effectiveSiteId || undefined,
    departmentId: departmentId || undefined,
    horizonDays,
    scenarioId: scenarioId || undefined,
  });

  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);

  const projectionColumns: DataTableColumn<TankGrowthProjection>[] = [
    {
      key: 'unit',
      header: t('feedingV2.plan.col.unit'),
      render: (_v, row) => (
        <div>
          <div className="font-semibold text-gray-900 dark:text-gray-100">{row.unitCode}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.siteName}</div>
        </div>
      ),
    },
    { key: 'protocolName', header: t('feedingV2.plan.col.protocol') },
    {
      key: 'fishCount',
      header: t('feedingV2.plan.col.fish'),
      align: 'right',
      render: (_v, row) => fmt(row.fishCount, 0),
    },
    {
      key: 'currentAvgWeightG',
      header: t('feedingV2.plan.col.avgWeight'),
      align: 'right',
      render: (_v, row) => `${fmt(row.currentAvgWeightG)} g`,
    },
    {
      key: 'currentBiomassKg',
      header: t('feedingV2.plan.col.biomass'),
      align: 'right',
      render: (_v, row) => `${fmt(row.currentBiomassKg)} kg`,
    },
    {
      key: 'projectedAvgWeightG',
      header: t('feedingV2.plan.col.projectedWeight'),
      align: 'right',
      render: (_v, row) => <span className="font-medium">{fmt(row.projectedAvgWeightG)} g</span>,
    },
    {
      key: 'projectedBiomassKg',
      header: t('feedingV2.plan.col.projectedBiomass'),
      align: 'right',
      render: (_v, row) => <span className="font-medium">{fmt(row.projectedBiomassKg)} kg</span>,
    },
    {
      key: 'totalFeedKg',
      header: t('feedingV2.plan.col.totalFeed'),
      align: 'right',
      render: (_v, row) => `${fmt(row.totalFeedKg)} kg`,
    },
    {
      key: 'capacity',
      header: t('feedingV2.plan.col.capacity'),
      render: (_v, row) => (
        <span
          className={
            row.overCapacityDay !== null
              ? 'font-bold text-error-600 dark:text-error-400'
              : row.peakCapacityPercent > 80
                ? 'font-medium text-warning-600 dark:text-warning-400'
                : 'text-gray-700 dark:text-gray-300'
          }
        >
          %{fmt(row.peakCapacityPercent, 0)}
          {row.overCapacityDay !== null &&
            ` · ${t('feedingV2.plan.overCapacityDay', { day: row.overCapacityDay })}`}
        </span>
      ),
    },
  ];
  const selected = useMemo(
    () => projections?.find((p) => p.unitId === selectedUnitId) ?? projections?.[0] ?? null,
    [projections, selectedUnitId],
  );

  const chartData = useMemo(
    () =>
      (selected?.series ?? []).map((point) => ({
        date: point.date.slice(5),
        avgWeightG: point.avgWeightG,
        biomassKg: point.biomassKg,
        capacityPercent: point.capacityPercent,
        temperatureC: point.temperatureC,
      })),
    [selected?.series],
  );

  const handleSaveScenario = async (): Promise<void> => {
    if (!effectiveSiteId) return;
    const points = draftPoints
      .filter((p) => p.date && p.celsius !== '')
      .map((p) => ({ date: p.date, celsius: parseFloat(p.celsius) }));
    try {
      const created = await createScenario.mutateAsync({
        siteId: effectiveSiteId,
        name: scenarioName,
        points,
      });
      setScenarioId(created.id);
      setShowScenarioForm(false);
      setScenarioName('');
    } catch {
      // useFeedbackMutation surfaces the failure toast
    }
  };

  return (
    <div className="space-y-4">
      {/* Controls: scope · horizon · scenario */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[180px]">
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('feedingV2.plan.site')}
          </label>
          <Select
            value={effectiveSiteId}
            onChange={() => undefined}
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
            disabled
          />
        </div>
        <div className="min-w-[180px]">
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('feedingV2.plan.system')}
          </label>
          <Select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            options={[
              { value: '', label: t('feedingV2.plan.allSystems') },
              ...departments.map((d) => ({ value: d.id, label: d.name })),
            ]}
          />
        </div>
        <div className="min-w-[120px]">
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('feedingV2.plan.horizon')}
          </label>
          <Input
            type="number"
            min={7}
            max={365}
            value={horizonDays}
            onChange={(e) => setHorizonDays(Math.trunc(Number(e.target.value)) || 30)}
          />
        </div>
        <div className="min-w-[220px]">
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('feedingV2.plan.scenario')}
          </label>
          <Select
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value)}
            options={[
              {
                value: '',
                label: locale === 'tr' ? 'Güncel sıcaklık (sabit)' : 'Current temperature (held)',
              },
              ...(scenarios ?? []).map((s) => ({
                value: s.id,
                label: `${s.name} (${s.points.length} ${t('feedingV2.plan.pointsCount')})`,
              })),
            ]}
          />
        </div>
        {canManage && (
          <Button
            variant="secondary"
            onClick={() => setShowScenarioForm((v) => !v)}
            disabled={!effectiveSiteId}
          >
            {showScenarioForm
              ? locale === 'tr'
                ? 'Vazgeç'
                : 'Cancel'
              : locale === 'tr'
                ? '+ Senaryo'
                : '+ Scenario'}
          </Button>
        )}
        {scenarioId && canManage && (
          <Button
            variant="secondary"
            onClick={() => {
              void deleteScenario.mutateAsync(scenarioId);
              setScenarioId('');
            }}
          >
            {t('feedingV2.plan.deleteScenario')}
          </Button>
        )}
      </div>

      {/* Scenario editor: dated points, piecewise-linear between them */}
      {showScenarioForm && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('feedingV2.plan.scenarioFormTitle')}
          </h3>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
              placeholder={t('feedingV2.plan.scenarioName')}
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            {draftPoints.map((point, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="date"
                  value={point.date}
                  onChange={(e) =>
                    setDraftPoints((prev) =>
                      prev.map((p, i) => (i === index ? { ...p, date: e.target.value } : p)),
                    )
                  }
                />
                <Input
                  type="number"
                  step="0.1"
                  placeholder={t('feedingV2.plan.celsius')}
                  value={point.celsius}
                  onChange={(e) =>
                    setDraftPoints((prev) =>
                      prev.map((p, i) => (i === index ? { ...p, celsius: e.target.value } : p)),
                    )
                  }
                />
                {draftPoints.length > 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraftPoints((prev) => prev.filter((_, i) => i !== index))}
                  >
                    ×
                  </Button>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDraftPoints((prev) => [...prev, { date: '', celsius: '' }])}
            >
              {t('feedingV2.plan.addPoint')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSaveScenario()}
              disabled={
                createScenario.isPending ||
                !scenarioName.trim() ||
                draftPoints.filter((p) => p.date && p.celsius !== '').length < 2
              }
            >
              {t('feedingV2.plan.save')}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700 dark:border-error-800 dark:bg-error-900/20 dark:text-error-300">
          {(error as Error).message}
        </div>
      )}

      {/* Projection table (shared DataTable) */}
      <DataTable<TankGrowthProjection>
        data={projections ?? []}
        columns={projectionColumns}
        keyExtractor={(row) => row.unitId}
        onRowClick={(row) => setSelectedUnitId(row.unitId)}
        rowClassName={(row) =>
          selected?.unitId === row.unitId ? 'bg-accent-50 dark:bg-accent-900/30' : ''
        }
        emptyMessage={t('feedingV2.plan.noUnits')}
        loading={isLoading}
        loadingMessage={t('common.loading')}
        searchable={false}
        sortable={false}
        stickyHeader={false}
        hoverable
        bordered={false}
      />

      {/* Selected tank curve */}
      {selected && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">
            {selected.unitCode} · {selected.protocolName}
          </h3>
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
            {t('feedingV2.plan.chartHint')}
          </p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartChrome.grid} />
                <XAxis dataKey="date" fontSize={12} />
                <YAxis yAxisId="left" fontSize={12} />
                <YAxis yAxisId="right" orientation="right" fontSize={12} />
                <Tooltip />
                <Legend />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="avgWeightG"
                  name={t('feedingV2.plan.col.avgWeight')}
                  stroke={colors.primary[500]}
                  dot={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="biomassKg"
                  name={t('feedingV2.plan.col.biomass')}
                  stroke={colors.success[500]}
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="capacityPercent"
                  name={t('feedingV2.plan.col.capacity')}
                  stroke={colors.warning[500]}
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="temperatureC"
                  name={t('feedingV2.plan.scenario')}
                  stroke={colors.accent[500]}
                  strokeDasharray="4 4"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProductionPlanTab;
