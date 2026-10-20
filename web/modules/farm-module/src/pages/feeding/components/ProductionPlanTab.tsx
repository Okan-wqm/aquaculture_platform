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
import { useI18n, useAuth, Button, Input, Select, useToast } from '@aquaculture/shared-ui';
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
  const { toast } = useToast();
  const { hasPermission } = useAuth();
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
      toast({
        title: locale === 'tr' ? 'Senaryo kaydedildi' : 'Scenario saved',
        description: created.name,
        variant: 'success',
      });
    } catch (err) {
      toast({ title: 'Error', description: (err as Error).message, variant: 'error' });
    }
  };

  const canManage = hasPermission('farm:write') !== false;

  return (
    <div className="space-y-4">
      {/* Controls: scope · horizon · scenario */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[180px]">
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {locale === 'tr' ? 'Saha' : 'Site'}
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
            {locale === 'tr' ? 'Sistem (departman)' : 'System (department)'}
          </label>
          <Select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            options={[
              { value: '', label: locale === 'tr' ? 'Tüm sistemler' : 'All systems' },
              ...departments.map((d) => ({ value: d.id, label: d.name })),
            ]}
          />
        </div>
        <div className="min-w-[120px]">
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {locale === 'tr' ? 'Ufuk (gün)' : 'Horizon (days)'}
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
            {locale === 'tr' ? 'Sıcaklık senaryosu' : 'Temperature scenario'}
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
                label: `${s.name} (${s.points.length} ${locale === 'tr' ? 'nokta' : 'points'})`,
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
            {locale === 'tr' ? 'Senaryoyu sil' : 'Delete scenario'}
          </Button>
        )}
      </div>

      {/* Scenario editor: dated points, piecewise-linear between them */}
      {showScenarioForm && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            {locale === 'tr'
              ? 'Yeni sıcaklık senaryosu (tarih + °C, aralarında interpolasyon)'
              : 'New temperature scenario (date + °C, interpolated between)'}
          </h3>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
              placeholder={locale === 'tr' ? 'Senaryo adı' : 'Scenario name'}
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
                  placeholder="°C"
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
              {locale === 'tr' ? '+ Nokta ekle' : '+ Add point'}
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
              {locale === 'tr' ? 'Kaydet' : 'Save'}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-error-200 bg-error-50 p-3 text-sm text-error-700 dark:border-error-800 dark:bg-error-900/20 dark:text-error-300">
          {(error as Error).message}
        </div>
      )}

      {/* Projection table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              {[
                locale === 'tr' ? 'Birim' : 'Unit',
                locale === 'tr' ? 'Protokol' : 'Protocol',
                locale === 'tr' ? 'Balık' : 'Fish',
                locale === 'tr' ? 'Ort. ağırlık' : 'Avg. weight',
                locale === 'tr' ? 'Biyokütle' : 'Biomass',
                locale === 'tr' ? 'Ufuk sonu ağırlık' : 'Projected weight',
                locale === 'tr' ? 'Ufuk sonu biyokütle' : 'Projected biomass',
                locale === 'tr' ? 'Toplam yem' : 'Total feed',
                locale === 'tr' ? 'Kapasite doluluk' : 'Capacity fill',
              ].map((header) => (
                <th
                  key={header}
                  className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-800 dark:bg-gray-900">
            {isLoading && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {!isLoading && (projections ?? []).length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                  {locale === 'tr'
                    ? 'Kapsamda atanmış protokollü stoklu tank yok'
                    : 'No stocked tanks with an assigned protocol in scope'}
                </td>
              </tr>
            )}
            {(projections ?? []).map((p) => (
              <tr
                key={p.unitId}
                onClick={() => setSelectedUnitId(p.unitId)}
                className={`cursor-pointer ${
                  selected?.unitId === p.unitId
                    ? 'bg-accent-50 dark:bg-accent-900/30'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                <td className="px-3 py-2">
                  <div className="font-semibold text-gray-900 dark:text-gray-100">{p.unitCode}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{p.siteName}</div>
                </td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{p.protocolName}</td>
                <td className="px-3 py-2">{fmt(p.fishCount, 0)}</td>
                <td className="px-3 py-2">{fmt(p.currentAvgWeightG)} g</td>
                <td className="px-3 py-2">{fmt(p.currentBiomassKg)} kg</td>
                <td className="px-3 py-2 font-medium">{fmt(p.projectedAvgWeightG)} g</td>
                <td className="px-3 py-2 font-medium">{fmt(p.projectedBiomassKg)} kg</td>
                <td className="px-3 py-2">{fmt(p.totalFeedKg)} kg</td>
                <td className="px-3 py-2">
                  <span
                    className={
                      p.overCapacityDay !== null
                        ? 'font-bold text-error-600 dark:text-error-400'
                        : p.peakCapacityPercent > 80
                          ? 'font-medium text-warning-600 dark:text-warning-400'
                          : 'text-gray-700 dark:text-gray-300'
                    }
                  >
                    %{fmt(p.peakCapacityPercent, 0)}
                    {p.overCapacityDay !== null &&
                      ` · ${locale === 'tr' ? 'gün' : 'day'} ${p.overCapacityDay}+`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Selected tank curve */}
      {selected && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <h3 className="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">
            {selected.unitCode} · {selected.protocolName}
          </h3>
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
            {locale === 'tr'
              ? 'Projeksiyon: ortalamama ağırlığı, biyokütle, kapasite doluluk ve senaryo sıcaklığı'
              : 'Projection: average weight, biomass, capacity fill and scenario temperature'}
          </p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" fontSize={12} />
                <YAxis yAxisId="left" fontSize={12} />
                <YAxis yAxisId="right" orientation="right" fontSize={12} />
                <Tooltip />
                <Legend />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="avgWeightG"
                  name={locale === 'tr' ? 'Ort. ağırlık (g)' : 'Avg weight (g)'}
                  stroke="#2563eb"
                  dot={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="biomassKg"
                  name={locale === 'tr' ? 'Biyokütle (kg)' : 'Biomass (kg)'}
                  stroke="#16a34a"
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="capacityPercent"
                  name={locale === 'tr' ? 'Kapasite (%)' : 'Capacity (%)'}
                  stroke="#d97706"
                  dot={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="temperatureC"
                  name={locale === 'tr' ? 'Senaryo (°C)' : 'Scenario (°C)'}
                  stroke="#9333ea"
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
