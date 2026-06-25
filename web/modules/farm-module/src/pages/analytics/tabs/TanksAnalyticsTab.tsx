/**
 * Tanks & Ponds Analytics Tab
 *
 * KPI cards and charts for tank/pond performance metrics.
 * Derives all KPIs and chart data from real tankData via useTanksList().
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Card, KpiCard, useAuth, getTenantId, tenantScopedStorageKey } from '@aquaculture/shared-ui';
import {
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useTanksList } from '../../../hooks/useTanks';
import { TankWithBatch, tankToTankWithBatch } from '../../tanks/types';
import {
  CompactSummaryStats,
  TankChartsSection,
  ChartSettingsModal,
  defaultChartVisibility,
} from '../../tanks/components';
import type { ChartVisibility } from '../../tanks/components';

// ============================================================================
// Constants
// ============================================================================

const tooltipStyle = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
};

// ============================================================================
// Status color mapping for pie chart
// ============================================================================

const STATUS_COLORS: Record<string, string> = {
  operational: '#22c55e',
  active: '#22c55e',
  maintenance: '#f59e0b',
  fallow: '#94a3b8',
  quarantine: '#ef4444',
  inactive: '#6b7280',
  empty: '#d1d5db',
};

// ============================================================================
// Component
// ============================================================================

interface TanksAnalyticsTabProps {
  dateRange: string;
}

/**
 * "No data available" placeholder for charts without real data
 */
const NoDataPlaceholder: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex flex-col items-center justify-center h-[300px] text-gray-400">
    <svg className="w-12 h-12 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 12H4M12 4v16" />
    </svg>
    <p className="text-sm">{label}</p>
  </div>
);

const TanksAnalyticsTab: React.FC<TanksAnalyticsTabProps> = ({ dateRange: _dateRange }) => {
  // Fetch tank data for chart components
  const { data } = useTanksList();

  const tankData: TankWithBatch[] = useMemo(() => {
    if (!data?.items) return [];
    return data.items.map(tankToTankWithBatch);
  }, [data?.items]);

  // BUG-6 FIX: Derive KPIs and chart data from real tankData instead of hardcoded mock
  const totalTanks = tankData.length;
  const avgBiomass = useMemo(() => {
    if (totalTanks === 0) return 0;
    const sum = tankData.reduce((acc, t) => acc + (t.biomass ?? 0), 0);
    return Math.round((sum / totalTanks) * 10) / 10;
  }, [tankData, totalTanks]);

  const avgMortalityRate = useMemo(() => {
    const tanksWithRate = tankData.filter(t => t.mortalityRate != null);
    if (tanksWithRate.length === 0) return null;
    const sum = tanksWithRate.reduce((acc, t) => acc + (t.mortalityRate ?? 0), 0);
    return Math.round((sum / tanksWithRate.length) * 10) / 10;
  }, [tankData]);

  // Biomass by tank -- top 10 sorted descending
  const biomassByTank = useMemo(() =>
    tankData
      .filter(t => (t.biomass ?? 0) > 0)
      .sort((a, b) => (b.biomass ?? 0) - (a.biomass ?? 0))
      .slice(0, 10)
      .map(t => ({ tank: t.name, biomass: Math.round((t.biomass ?? 0) * 10) / 10 })),
    [tankData],
  );

  // Tank status distribution from real data
  const tankStatusData = useMemo(() => {
    const statusMap = new Map<string, number>();
    for (const t of tankData) {
      const status = (t.status || 'unknown').toLowerCase();
      statusMap.set(status, (statusMap.get(status) || 0) + 1);
    }
    return Array.from(statusMap.entries()).map(([name, value]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      value,
      color: STATUS_COLORS[name] || '#6b7280',
    }));
  }, [tankData]);

  // ============================================================================
  // TENANT-SCOPED STORAGE KEYS
  // ============================================================================

  // Prefer the reactive tenantId from auth context so the keys re-derive on a
  // tenant switch (the previous `useMemo(..., [])` was stale). getTenantId() is the
  // fallback for render paths without an AuthProvider. A null key (no tenant) makes
  // every read/write below no-op — no shared 'default' bucket, so no cross-tenant bleed.
  const { tenantId: authTenantId } = useAuth();
  const tenantId = authTenantId ?? getTenantId();
  const timeRangeKey = useMemo(() => tenantScopedStorageKey('tanks-chart-time-range', tenantId), [tenantId]);
  const visibilityKey = useMemo(() => tenantScopedStorageKey('tanks-chart-visibility', tenantId), [tenantId]);
  const selectedIdsKey = useMemo(() => tenantScopedStorageKey('tanks-chart-selected-ids', tenantId), [tenantId]);

  // ============================================================================
  // CHART SETTINGS STATE
  // ============================================================================

  const [showChartSettings, setShowChartSettings] = useState(false);

  const [chartSelectedTankIds, setChartSelectedTankIds] = useState<string[]>([]);

  const [chartTimeRange, setChartTimeRange] = useState<'7d' | '30d' | '90d'>(() => {
    if (!timeRangeKey) return '30d';
    const saved = localStorage.getItem(timeRangeKey);
    return (saved as '7d' | '30d' | '90d') || '30d';
  });

  const [chartVisibility, setChartVisibility] = useState<ChartVisibility>(() => {
    try {
      const saved = visibilityKey ? localStorage.getItem(visibilityKey) : null;
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        // HIGH-04: validate shape before spreading to prevent prototype pollution
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const safe = Object.assign(
            {},
            defaultChartVisibility,
            Object.fromEntries(
              Object.entries(parsed as Record<string, unknown>).filter(
                ([k]) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype'
              )
            )
          );
          return safe as ChartVisibility;
        }
      }
    } catch {
      // ignore malformed localStorage value
    }
    return defaultChartVisibility;
  });

  // ============================================================================
  // CHART SETTINGS EFFECTS
  // ============================================================================

  useEffect(() => {
    if (tankData.length > 0 && chartSelectedTankIds.length === 0) {
      const saved = selectedIdsKey ? localStorage.getItem(selectedIdsKey) : null;
      if (saved) {
        let parsedIds: unknown;
        try { parsedIds = JSON.parse(saved); } catch { parsedIds = null; }
        const savedIds = Array.isArray(parsedIds) && parsedIds.every(x => typeof x === 'string')
          ? (parsedIds as string[])
          : [];
        const validIds = savedIds.filter(id => tankData.some(t => t.id === id));
        if (validIds.length > 0) {
          setChartSelectedTankIds(validIds);
        } else {
          setChartSelectedTankIds(tankData.map(t => t.id));
        }
      } else {
        setChartSelectedTankIds(tankData.map(t => t.id));
      }
    }
  }, [tankData, selectedIdsKey]);

  useEffect(() => {
    if (selectedIdsKey && chartSelectedTankIds.length > 0) {
      localStorage.setItem(selectedIdsKey, JSON.stringify(chartSelectedTankIds));
    }
  }, [chartSelectedTankIds, selectedIdsKey]);

  useEffect(() => {
    if (timeRangeKey) localStorage.setItem(timeRangeKey, chartTimeRange);
  }, [chartTimeRange, timeRangeKey]);

  useEffect(() => {
    if (visibilityKey) localStorage.setItem(visibilityKey, JSON.stringify(chartVisibility));
  }, [chartVisibility, visibilityKey]);

  return (
    <div className="space-y-6">
      {/* KPI Row -- derived from real tankData */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Tanks"
          value={totalTanks}
          variant="primary"
        />
        <KpiCard
          title="Avg. Biomass"
          value={totalTanks > 0 ? `${avgBiomass} kg` : 'N/A'}
          variant="success"
        />
        <KpiCard
          title="Active Tanks"
          value={tankData.filter(t => t.isActive).length}
          variant="info"
        />
        <KpiCard
          title="Mortality Rate"
          value={avgMortalityRate != null ? `${avgMortalityRate}%` : 'N/A'}
          variant="warning"
        />
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Biomass by Tank */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Biomass by Tank</h2>
            <p className="text-sm text-gray-500">Top 10 tanks by current biomass (kg)</p>
          </div>
          <div className="p-4">
            {biomassByTank.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={biomassByTank} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" stroke="#6b7280" />
                  <YAxis dataKey="tank" type="category" stroke="#6b7280" width={80} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="biomass" name="Biomass (kg)" fill="#0073e6" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <NoDataPlaceholder label="No biomass data available" />
            )}
          </div>
        </Card>

        {/* Tank Status Distribution */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Tank Status Distribution</h2>
            <p className="text-sm text-gray-500">Current operational status of all tanks</p>
          </div>
          <div className="p-4">
            {tankStatusData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={tankStatusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {tankStatusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <NoDataPlaceholder label="No tank status data available" />
            )}
          </div>
        </Card>
      </div>

      {/* Charts Row 2 -- No mock data; show placeholder until real time-series APIs are available */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Water Temperature Trend */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Water Temperature Trend</h2>
            <p className="text-sm text-gray-500">Daily average temperature over 30 days</p>
          </div>
          <div className="p-4">
            <NoDataPlaceholder label="No water temperature data available yet" />
          </div>
        </Card>

        {/* Mortality Trend */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Mortality Trend</h2>
            <p className="text-sm text-gray-500">Daily mortality count and cumulative total</p>
          </div>
          <div className="p-4">
            <NoDataPlaceholder label="No mortality trend data available yet" />
          </div>
        </Card>
      </div>

      {/* Divider — Live Tank Analytics */}
      <hr className="border-gray-300" />

      {/* Compact Summary Stats from real data */}
      <CompactSummaryStats data={tankData} />

      {/* Tank Charts Section */}
      <TankChartsSection
        data={tankData}
        selectedTankIds={chartSelectedTankIds}
        timeRange={chartTimeRange}
        chartVisibility={chartVisibility}
        onSettingsClick={() => setShowChartSettings(true)}
      />

      {/* Chart Settings Modal */}
      <ChartSettingsModal
        isOpen={showChartSettings}
        onClose={() => setShowChartSettings(false)}
        tanks={tankData}
        selectedTankIds={chartSelectedTankIds}
        onSelectionChange={setChartSelectedTankIds}
        timeRange={chartTimeRange}
        onTimeRangeChange={setChartTimeRange}
        chartVisibility={chartVisibility}
        onChartVisibilityChange={setChartVisibility}
      />
    </div>
  );
};

export default TanksAnalyticsTab;
