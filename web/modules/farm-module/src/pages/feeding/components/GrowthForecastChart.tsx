/**
 * Growth Forecast Chart Component
 *
 * Visualizes fish growth projections using SGR formula
 * Shows weight, biomass, and feed consumption over time
 */
import React, { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
  ComposedChart,
  Bar,
} from 'recharts';
import { useGrowthSimulation, GrowthSimulationInput } from '../../../hooks/useFeeding';
import { colors, DataTable, type DataTableColumn, Spinner } from '@aquaculture/shared-ui';

interface Batch {
  id: string;
  batchNumber: string;
  name?: string;
  currentQuantity: number;
  weight?: {
    actual?: { avgWeight: number; totalBiomass: number };
    theoretical?: { avgWeight: number; totalBiomass: number };
    initial?: { avgWeight: number; totalBiomass: number };
  };
  sgr?: number;
}

interface GrowthForecastChartProps {
  siteId: string;
  batchId: string;
  batches: readonly Batch[];
}

export const GrowthForecastChart: React.FC<GrowthForecastChartProps> = ({
  batchId,
  batches,
}) => {
  const [selectedBatchId, setSelectedBatchId] = useState<string>(batchId || batches[0]?.id || '');
  const [projectionDays, setProjectionDays] = useState<number>(30);
  const [customSGR, setCustomSGR] = useState<number | null>(null);

  // Find selected batch
  const selectedBatch = batches.find((b) => b.id === selectedBatchId);

  // Get current weight from batch
  const currentWeightG =
    selectedBatch?.weight?.actual?.avgWeight ??
    selectedBatch?.weight?.theoretical?.avgWeight ??
    selectedBatch?.weight?.initial?.avgWeight ??
    0;

  const currentCount = selectedBatch?.currentQuantity ?? 0;
  const batchSGR = selectedBatch?.sgr ?? 1.5;

  // Build simulation input
  const simulationInput: GrowthSimulationInput | null = useMemo(() => {
    if (!selectedBatchId || currentWeightG <= 0 || currentCount <= 0) {
      return null;
    }
    return {
      batchId: selectedBatchId,
      currentWeightG,
      currentCount,
      sgr: customSGR ?? batchSGR,
      projectionDays,
    };
  }, [selectedBatchId, currentWeightG, currentCount, customSGR, batchSGR, projectionDays]);

  // Fetch growth simulation
  const { data: simulationData, isLoading, error } = useGrowthSimulation(simulationInput);

  // Prepare chart data
  const chartData = useMemo(() => {
    if (!simulationData?.projections) return [];
    return simulationData.projections.map((p) => ({
      day: p.day,
      date: new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      weight: p.avgWeightG,
      biomass: p.biomassKg,
      dailyFeed: p.dailyFeedKg,
      cumulativeFeed: p.cumulativeFeedKg,
      fishCount: p.fishCount,
      feedingRate: p.feedingRatePercent,
    }));
  }, [simulationData]);

  if (batches.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-6 text-center text-gray-500 dark:text-gray-400">
        No active batches found. Create a batch to see growth forecasts.
      </div>
    );
  }

  type FeedRow = NonNullable<NonNullable<typeof simulationData>['feedRequirements']>[number];
  const feedRowColumns: DataTableColumn<FeedRow>[] = [
    {
      key: 'feedType',
      header: 'Feed Type',
      render: (_value, feed) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{feed.feedName}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{feed.feedCode}</div>
        </>
      ),
    },
    {
      key: 'totalRequired',
      header: 'Total Required',
      align: 'right',
      render: (_value, feed) => (
        <>
          {feed.totalKg.toFixed(0)} kg
        </>
      ),
    },
    {
      key: 'daysUsed',
      header: 'Days Used',
      align: 'right',
      render: (_value, feed) => (
        <>
          {feed.daysUsed} days
        </>
      ),
    },
    {
      key: 'period',
      header: 'Period',
      align: 'right',
      render: (_value, feed) => (
        <>
          Day {feed.startDay} - Day {feed.endDay}
        </>
      ),
    }
  ];

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Batch Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Batch
            </label>
            <select
              value={selectedBatchId}
              onChange={(e) => setSelectedBatchId(e.target.value)}
              className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            >
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.batchNumber} - {batch.name || 'Unnamed'}
                </option>
              ))}
            </select>
          </div>

          {/* Projection Days */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Projection Period
            </label>
            <select
              value={projectionDays}
              onChange={(e) => setProjectionDays(Number(e.target.value))}
              className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            >
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={120}>120 days</option>
            </select>
          </div>

          {/* SGR Override */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              SGR (%) - Default: {batchSGR.toFixed(2)}%
            </label>
            <input
              type="number"
              step="0.1"
              placeholder={`${batchSGR.toFixed(2)}`}
              value={customSGR ?? ''}
              onChange={(e) => setCustomSGR(e.target.value ? Number(e.target.value) : null)}
              className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
          </div>

          {/* Current Stats */}
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Current Status</p>
            <p className="text-sm font-medium">
              {currentWeightG.toFixed(0)}g avg | {currentCount.toLocaleString()} fish
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {((currentWeightG * currentCount) / 1000).toFixed(0)} kg biomass
            </p>
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-12 text-center">
          <Spinner size="xl" block />
          <p className="mt-4 text-gray-500 dark:text-gray-400">Calculating growth projections...</p>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-50 rounded-lg shadow p-6 text-center text-red-600">
          Error loading growth simulation. Please try again.
        </div>
      )}

      {/* Charts */}
      {!isLoading && simulationData && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">Projected Weight</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {simulationData.summary.endWeight.toFixed(0)}g
              </p>
              <p className="text-xs text-green-600">
                +{(simulationData.summary.endWeight - simulationData.summary.startWeight).toFixed(0)}g
                ({(((simulationData.summary.endWeight - simulationData.summary.startWeight) / simulationData.summary.startWeight) * 100).toFixed(0)}%)
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">Projected Biomass</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {(simulationData.summary.endBiomass / 1000).toFixed(2)}t
              </p>
              <p className="text-xs text-green-600">
                +{((simulationData.summary.endBiomass - simulationData.summary.startBiomass) / 1000).toFixed(2)}t
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Feed Required</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {simulationData.summary.totalFeedKg.toFixed(0)} kg
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {(simulationData.summary.totalFeedKg / 1000).toFixed(2)}t
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">Expected FCR</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {simulationData.summary.avgFCR.toFixed(2)}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {simulationData.summary.totalMortality} mortality
              </p>
            </div>
          </div>

          {/* Weight & Biomass Chart */}
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Weight & Biomass Projection</h3>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis yAxisId="left" label={{ value: 'Weight (g)', angle: -90, position: 'insideLeft' }} />
                  <YAxis yAxisId="right" orientation="right" label={{ value: 'Biomass (kg)', angle: 90, position: 'insideRight' }} />
                  <Tooltip />
                  <Legend />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="weight"
                    stroke={colors.info[500]}
                    name="Avg Weight (g)"
                    strokeWidth={2}
                  />
                  <Area
                    yAxisId="right"
                    type="monotone"
                    dataKey="biomass"
                    fill={colors.success[500]}
                    fillOpacity={0.3}
                    stroke={colors.success[500]}
                    name="Biomass (kg)"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Daily Feed Chart */}
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Daily Feed Requirements</h3>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis yAxisId="left" label={{ value: 'Daily Feed (kg)', angle: -90, position: 'insideLeft' }} />
                  <YAxis yAxisId="right" orientation="right" label={{ value: 'Cumulative (kg)', angle: 90, position: 'insideRight' }} />
                  <Tooltip />
                  <Legend />
                  <Bar
                    yAxisId="left"
                    dataKey="dailyFeed"
                    fill={colors.warning[500]}
                    name="Daily Feed (kg)"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cumulativeFeed"
                    stroke={colors.primary[700]}
                    name="Cumulative Feed (kg)"
                    strokeWidth={2}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Feed Requirements Summary */}
          {simulationData.feedRequirements.length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow">
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Feed Requirements by Type</h3>
              </div>
              <DataTable<FeedRow>
                data={simulationData.feedRequirements}
                columns={feedRowColumns}
                keyExtractor={(feed) => feed.feedCode}
                emptyMessage="No records found"
                searchable={false}
                sortable={false}
                stickyHeader={false}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};
