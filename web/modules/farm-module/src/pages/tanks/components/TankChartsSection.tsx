/**
 * Tank Charts Section Component
 * Collapsible section with 8 pie charts and 4 line charts for tank analytics
 */

import React, { useMemo, useState, useEffect } from 'react';
import { PieChart, LineChart } from '@aquaculture/shared-ui';
import type { PieDataItem, LineDataset } from '@aquaculture/shared-ui';
import type { TankWithBatch } from '../types';

// Chart visibility configuration
export interface ChartVisibility {
  // Pie charts (8)
  categoryDistribution: boolean;
  biomassByTank: boolean;
  fishCountByTank: boolean;
  densityUsage: boolean;
  speciesBiomass: boolean;
  mortalityByTank: boolean;
  cullByTank: boolean;
  biomassBySpecies: boolean;
  // Line charts (8) - 2 rows of 4
  mortalityTrend: boolean;
  growthTrend: boolean;
  biomassTrend: boolean;
  fcrTrend: boolean;
  feedTrend: boolean;
  densityTrend: boolean;
  fishCountTrend: boolean;
  sgrTrend: boolean;
}

export const defaultChartVisibility: ChartVisibility = {
  // Pie charts
  categoryDistribution: true,
  biomassByTank: true,
  fishCountByTank: true,
  densityUsage: true,
  speciesBiomass: true,
  mortalityByTank: true,
  cullByTank: false,
  biomassBySpecies: true,
  // Line charts
  mortalityTrend: true,
  growthTrend: true,
  biomassTrend: true,
  fcrTrend: true,
  feedTrend: true,
  densityTrend: true,
  fishCountTrend: true,
  sgrTrend: true,
};

interface TankChartsSectionProps {
  data: TankWithBatch[];
  selectedTankIds: string[];
  timeRange: '7d' | '30d' | '90d';
  onSettingsClick: () => void;
  chartVisibility: ChartVisibility;
  // Analytics data for line charts (optional - will show placeholder if not provided)
  analyticsData?: TankAnalyticsData[];
}

interface TankAnalyticsData {
  equipmentId: string;
  tankName: string;
  tankCode: string;
  dailySummaries: Array<{
    date: string;
    mortalityCount?: number;
    avgWeightG?: number;
    biomassKg?: number;
    fcr?: number;
    feedAmountKg?: number;
    densityKgM3?: number;
    fishCount?: number;
    sgr?: number;
  }>;
}

// Default colors for charts
const CHART_COLORS = {
  category: {
    TANK: '#06B6D4',   // cyan
    POND: '#3B82F6',   // blue
    CAGE: '#8B5CF6',   // purple
  },
  density: {
    low: '#10B981',    // green (< 50%)
    medium: '#F59E0B', // yellow (50-80%)
    high: '#EF4444',   // red (> 80%)
  },
};

export const TankChartsSection: React.FC<TankChartsSectionProps> = ({
  data,
  selectedTankIds,
  timeRange,
  onSettingsClick,
  chartVisibility,
  analyticsData,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const saved = localStorage.getItem('tanks-charts-collapsed');
    return saved === 'true';
  });

  // Save collapse state to localStorage
  useEffect(() => {
    localStorage.setItem('tanks-charts-collapsed', String(isCollapsed));
  }, [isCollapsed]);

  // Filter data by selected tank IDs
  const filteredData = useMemo(() => {
    if (selectedTankIds.length === 0) return data;
    return data.filter(t => selectedTankIds.includes(t.id));
  }, [data, selectedTankIds]);

  // ============================================================================
  // PIE CHART DATA CALCULATIONS
  // ============================================================================

  // 1. Category Distribution (Tank/Pond/Cage count)
  const categoryData = useMemo((): PieDataItem[] => {
    const tanks = filteredData.filter(t => t.category.toUpperCase() === 'TANK').length;
    const ponds = filteredData.filter(t => t.category.toUpperCase() === 'POND').length;
    const cages = filteredData.filter(t => t.category.toUpperCase() === 'CAGE').length;

    return [
      { label: 'Tanks', value: tanks, color: CHART_COLORS.category.TANK },
      { label: 'Ponds', value: ponds, color: CHART_COLORS.category.POND },
      { label: 'Cages', value: cages, color: CHART_COLORS.category.CAGE },
    ].filter(item => item.value > 0);
  }, [filteredData]);

  // 2. Biomass by Tank
  const biomassByTankData = useMemo((): PieDataItem[] => {
    return filteredData
      .filter(t => (t.biomass || 0) > 0)
      .map(t => ({
        label: t.code || t.name,
        value: t.biomass || 0,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10); // Top 10
  }, [filteredData]);

  // 3. Fish Count by Tank
  const fishCountByTankData = useMemo((): PieDataItem[] => {
    return filteredData
      .filter(t => (t.pieces || 0) > 0)
      .map(t => ({
        label: t.code || t.name,
        value: t.pieces || 0,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10); // Top 10
  }, [filteredData]);

  // 4. Density Usage Distribution
  const densityUsageData = useMemo((): PieDataItem[] => {
    const low = filteredData.filter(t => (t.capacityUsedPercent || 0) < 50).length;
    const medium = filteredData.filter(t => {
      const cap = t.capacityUsedPercent || 0;
      return cap >= 50 && cap < 80;
    }).length;
    const high = filteredData.filter(t => (t.capacityUsedPercent || 0) >= 80).length;

    return [
      { label: '< 50%', value: low, color: CHART_COLORS.density.low },
      { label: '50-80%', value: medium, color: CHART_COLORS.density.medium },
      { label: '> 80%', value: high, color: CHART_COLORS.density.high },
    ].filter(item => item.value > 0);
  }, [filteredData]);

  // 5. Species Biomass % (requires batch info with species)
  const speciesBiomassData = useMemo((): PieDataItem[] => {
    // Group by batch species (using batchNumber as proxy for species for now)
    const speciesMap = new Map<string, number>();

    filteredData.forEach(t => {
      if (t.batchNumber && t.biomass) {
        // Extract species hint from batch number or use generic
        const speciesKey = t.batchNumber.split('-')[0] || 'Other';
        speciesMap.set(speciesKey, (speciesMap.get(speciesKey) || 0) + t.biomass);
      }
    });

    return Array.from(speciesMap.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [filteredData]);

  // 6. Mortality by Tank (using totalMortality field from Batch)
  const mortalityByTankData = useMemo((): PieDataItem[] => {
    return filteredData
      .filter(t => (t.totalMortality || 0) > 0)
      .map(t => ({
        label: t.code || t.name,
        value: t.totalMortality || 0,
        color: '#EF4444', // red
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [filteredData]);

  // 7. Cull by Tank (using totalCull field from Batch)
  const cullByTankData = useMemo((): PieDataItem[] => {
    return filteredData
      .filter(t => (t.totalCull || 0) > 0)
      .map(t => ({
        label: t.code || t.name,
        value: t.totalCull || 0,
        color: '#F97316', // orange
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [filteredData]);

  // 8. Total Biomass by Species (absolute values)
  const totalBiomassBySpeciesData = useMemo((): PieDataItem[] => {
    // Same as speciesBiomassData but shown as absolute kg values
    return speciesBiomassData;
  }, [speciesBiomassData]);

  // ============================================================================
  // LINE CHART DATA (Placeholder - requires backend analytics API)
  // ============================================================================

  const getTimeLabels = (): string[] => {
    const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
    const labels: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      labels.push(date.toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' }));
    }
    return labels;
  };

  const timeLabels = useMemo(() => getTimeLabels(), [timeRange]);

  // Generate placeholder data for line charts
  const mortalityLineData = useMemo((): LineDataset[] => {
    if (!analyticsData || analyticsData.length === 0) {
      // Placeholder data
      return [{
        label: 'No data',
        data: new Array(timeLabels.length).fill(0),
        color: '#9CA3AF',
      }];
    }

    return analyticsData.slice(0, 5).map((tank, idx) => ({
      label: tank.tankCode,
      data: tank.dailySummaries.map(d => d.mortalityCount || 0),
      color: ['#EF4444', '#F97316', '#F59E0B', '#84CC16', '#10B981'][idx % 5],
    }));
  }, [analyticsData, timeLabels]);

  const growthLineData = useMemo((): LineDataset[] => {
    if (!analyticsData || analyticsData.length === 0) {
      return [{
        label: 'No data',
        data: new Array(timeLabels.length).fill(0),
        color: '#9CA3AF',
      }];
    }

    return analyticsData.slice(0, 5).map((tank, idx) => ({
      label: tank.tankCode,
      data: tank.dailySummaries.map(d => d.avgWeightG || 0),
      color: ['#3B82F6', '#8B5CF6', '#EC4899', '#06B6D4', '#10B981'][idx % 5],
    }));
  }, [analyticsData, timeLabels]);

  const biomassLineData = useMemo((): LineDataset[] => {
    if (!analyticsData || analyticsData.length === 0) {
      return [{
        label: 'No data',
        data: new Array(timeLabels.length).fill(0),
        color: '#9CA3AF',
      }];
    }

    return analyticsData.slice(0, 5).map((tank, idx) => ({
      label: tank.tankCode,
      data: tank.dailySummaries.map(d => d.biomassKg || 0),
      color: ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444'][idx % 5],
    }));
  }, [analyticsData, timeLabels]);

  const fcrLineData = useMemo((): LineDataset[] => {
    if (!analyticsData || analyticsData.length === 0) {
      return [{
        label: 'No data',
        data: new Array(timeLabels.length).fill(0),
        color: '#9CA3AF',
      }];
    }

    return analyticsData.slice(0, 5).map((tank, idx) => ({
      label: tank.tankCode,
      data: tank.dailySummaries.map(d => d.fcr || 0),
      color: ['#F59E0B', '#EF4444', '#3B82F6', '#10B981', '#8B5CF6'][idx % 5],
    }));
  }, [analyticsData, timeLabels]);

  // 5. Feed Trend
  const feedLineData = useMemo((): LineDataset[] => {
    if (!analyticsData || analyticsData.length === 0) {
      return [{
        label: 'No data',
        data: new Array(timeLabels.length).fill(0),
        color: '#9CA3AF',
      }];
    }

    return analyticsData.slice(0, 5).map((tank, idx) => ({
      label: tank.tankCode,
      data: tank.dailySummaries.map(d => d.feedAmountKg || 0),
      color: ['#8B5CF6', '#EC4899', '#06B6D4', '#F59E0B', '#10B981'][idx % 5],
    }));
  }, [analyticsData, timeLabels]);

  // 6. Density Trend
  const densityLineData = useMemo((): LineDataset[] => {
    if (!analyticsData || analyticsData.length === 0) {
      return [{
        label: 'No data',
        data: new Array(timeLabels.length).fill(0),
        color: '#9CA3AF',
      }];
    }

    return analyticsData.slice(0, 5).map((tank, idx) => ({
      label: tank.tankCode,
      data: tank.dailySummaries.map(d => d.densityKgM3 || 0),
      color: ['#06B6D4', '#3B82F6', '#10B981', '#F59E0B', '#EF4444'][idx % 5],
    }));
  }, [analyticsData, timeLabels]);

  // 7. Fish Count Trend
  const fishCountLineData = useMemo((): LineDataset[] => {
    if (!analyticsData || analyticsData.length === 0) {
      return [{
        label: 'No data',
        data: new Array(timeLabels.length).fill(0),
        color: '#9CA3AF',
      }];
    }

    return analyticsData.slice(0, 5).map((tank, idx) => ({
      label: tank.tankCode,
      data: tank.dailySummaries.map(d => d.fishCount || 0),
      color: ['#3B82F6', '#8B5CF6', '#10B981', '#EF4444', '#F59E0B'][idx % 5],
    }));
  }, [analyticsData, timeLabels]);

  // 8. SGR (Specific Growth Rate) Trend
  const sgrLineData = useMemo((): LineDataset[] => {
    if (!analyticsData || analyticsData.length === 0) {
      return [{
        label: 'No data',
        data: new Array(timeLabels.length).fill(0),
        color: '#9CA3AF',
      }];
    }

    return analyticsData.slice(0, 5).map((tank, idx) => ({
      label: tank.tankCode,
      data: tank.dailySummaries.map(d => d.sgr || 0),
      color: ['#10B981', '#06B6D4', '#8B5CF6', '#EC4899', '#F59E0B'][idx % 5],
    }));
  }, [analyticsData, timeLabels]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="bg-white rounded-lg border border-gray-200 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200">
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-700 hover:text-gray-900"
        >
          <svg
            className={`w-4 h-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          Analytics
        </button>
        <button
          onClick={onSettingsClick}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
          title="Chart Settings"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-4">
          {/* Pie Charts - All 8 in single row */}
          <div className="mb-6">
            <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
              Distribution Charts
            </h4>
            <div className="grid grid-cols-4 lg:grid-cols-8 gap-3">
              {chartVisibility.categoryDistribution && (
                <ChartCard title="Category">
                  {categoryData.length > 0 ? (
                    <PieChart data={categoryData} size={120} showPercentages />
                  ) : (
                    <EmptyChart message="No data" />
                  )}
                </ChartCard>
              )}

              {chartVisibility.biomassByTank && (
                <ChartCard title="Biomass/Tank">
                  {biomassByTankData.length > 0 ? (
                    <PieChart
                      data={biomassByTankData}
                      size={120}
                      showPercentages
                    />
                  ) : (
                    <EmptyChart message="No data" />
                  )}
                </ChartCard>
              )}

              {chartVisibility.fishCountByTank && (
                <ChartCard title="Fish Count">
                  {fishCountByTankData.length > 0 ? (
                    <PieChart
                      data={fishCountByTankData}
                      size={120}
                      showPercentages
                    />
                  ) : (
                    <EmptyChart message="No data" />
                  )}
                </ChartCard>
              )}

              {chartVisibility.densityUsage && (
                <ChartCard title="Density">
                  {densityUsageData.length > 0 ? (
                    <PieChart data={densityUsageData} size={120} showPercentages />
                  ) : (
                    <EmptyChart message="No data" />
                  )}
                </ChartCard>
              )}

              {chartVisibility.speciesBiomass && (
                <ChartCard title="Species %">
                  {speciesBiomassData.length > 0 ? (
                    <PieChart data={speciesBiomassData} size={120} showPercentages />
                  ) : (
                    <EmptyChart message="No data" />
                  )}
                </ChartCard>
              )}

              {chartVisibility.mortalityByTank && (
                <ChartCard title="Mortality">
                  {mortalityByTankData.length > 0 ? (
                    <PieChart
                      data={mortalityByTankData}
                      size={120}
                      showPercentages
                    />
                  ) : (
                    <EmptyChart message="No data" />
                  )}
                </ChartCard>
              )}

              {chartVisibility.cullByTank && (
                <ChartCard title="Cull">
                  {cullByTankData.length > 0 ? (
                    <PieChart data={cullByTankData} size={120} showPercentages />
                  ) : (
                    <EmptyChart message="No data" />
                  )}
                </ChartCard>
              )}

              {chartVisibility.biomassBySpecies && (
                <ChartCard title="Species kg">
                  {totalBiomassBySpeciesData.length > 0 ? (
                    <PieChart
                      data={totalBiomassBySpeciesData}
                      size={120}
                      showPercentages
                    />
                  ) : (
                    <EmptyChart message="No data" />
                  )}
                </ChartCard>
              )}
            </div>
          </div>

          {/* Line Charts - 2 rows of 4 */}
          {(chartVisibility.mortalityTrend || chartVisibility.growthTrend ||
            chartVisibility.biomassTrend || chartVisibility.fcrTrend ||
            chartVisibility.feedTrend || chartVisibility.densityTrend ||
            chartVisibility.fishCountTrend || chartVisibility.sgrTrend) && (
            <div>
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                Time Series (Last {timeRange === '7d' ? '7 days' : timeRange === '30d' ? '30 days' : '90 days'})
              </h4>
              {/* Row 1 - 4 charts */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                {chartVisibility.mortalityTrend && (
                  <LineChartCard title="Mortality">
                    <LineChart
                      labels={timeLabels}
                      datasets={mortalityLineData}
                      height={140}
                      showGrid
                      showDots={timeRange === '7d'}
                      formatValue={(v) => v.toFixed(0)}
                    />
                  </LineChartCard>
                )}

                {chartVisibility.growthTrend && (
                  <LineChartCard title="Growth (g)">
                    <LineChart
                      labels={timeLabels}
                      datasets={growthLineData}
                      height={140}
                      showGrid
                      showDots={timeRange === '7d'}
                      formatValue={(v) => `${v.toFixed(0)}g`}
                    />
                  </LineChartCard>
                )}

                {chartVisibility.biomassTrend && (
                  <LineChartCard title="Biomass (kg)">
                    <LineChart
                      labels={timeLabels}
                      datasets={biomassLineData}
                      height={140}
                      showGrid
                      showDots={timeRange === '7d'}
                      formatValue={(v) => `${v.toFixed(0)}`}
                    />
                  </LineChartCard>
                )}

                {chartVisibility.fcrTrend && (
                  <LineChartCard title="FCR">
                    <LineChart
                      labels={timeLabels}
                      datasets={fcrLineData}
                      height={140}
                      showGrid
                      showDots={timeRange === '7d'}
                      formatValue={(v) => v.toFixed(2)}
                    />
                  </LineChartCard>
                )}
              </div>

              {/* Row 2 - 4 charts */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {chartVisibility.feedTrend && (
                  <LineChartCard title="Feed (kg)">
                    <LineChart
                      labels={timeLabels}
                      datasets={feedLineData}
                      height={140}
                      showGrid
                      showDots={timeRange === '7d'}
                      formatValue={(v) => `${v.toFixed(1)}`}
                    />
                  </LineChartCard>
                )}

                {chartVisibility.densityTrend && (
                  <LineChartCard title="Density (kg/m³)">
                    <LineChart
                      labels={timeLabels}
                      datasets={densityLineData}
                      height={140}
                      showGrid
                      showDots={timeRange === '7d'}
                      formatValue={(v) => v.toFixed(1)}
                    />
                  </LineChartCard>
                )}

                {chartVisibility.fishCountTrend && (
                  <LineChartCard title="Fish Count">
                    <LineChart
                      labels={timeLabels}
                      datasets={fishCountLineData}
                      height={140}
                      showGrid
                      showDots={timeRange === '7d'}
                      formatValue={(v) => v.toLocaleString()}
                    />
                  </LineChartCard>
                )}

                {chartVisibility.sgrTrend && (
                  <LineChartCard title="SGR (%)">
                    <LineChart
                      labels={timeLabels}
                      datasets={sgrLineData}
                      height={140}
                      showGrid
                      showDots={timeRange === '7d'}
                      formatValue={(v) => `${v.toFixed(2)}%`}
                    />
                  </LineChartCard>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

const ChartCard: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-gray-50 rounded-lg p-2">
    <h5 className="text-[10px] font-medium text-gray-600 mb-1 text-center truncate">{title}</h5>
    <div className="flex justify-center">{children}</div>
  </div>
);

const LineChartCard: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-gray-50 rounded-lg p-4">
    <h5 className="text-sm font-medium text-gray-700 mb-3">{title}</h5>
    {children}
  </div>
);

const EmptyChart: React.FC<{ message: string }> = ({ message }) => (
  <div className="w-[120px] h-[120px] flex items-center justify-center text-gray-400 text-xs">
    {message}
  </div>
);

export default TankChartsSection;
