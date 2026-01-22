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
  batches: Batch[];
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
      <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
        No active batches found. Create a batch to see growth forecasts.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Batch Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Batch
            </label>
            <select
              value={selectedBatchId}
              onChange={(e) => setSelectedBatchId(e.target.value)}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Projection Period
            </label>
            <select
              value={projectionDays}
              onChange={(e) => setProjectionDays(Number(e.target.value))}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              SGR (%) - Default: {batchSGR.toFixed(2)}%
            </label>
            <input
              type="number"
              step="0.1"
              placeholder={`${batchSGR.toFixed(2)}`}
              value={customSGR ?? ''}
              onChange={(e) => setCustomSGR(e.target.value ? Number(e.target.value) : null)}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
          </div>

          {/* Current Stats */}
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-1">Current Status</p>
            <p className="text-sm font-medium">
              {currentWeightG.toFixed(0)}g avg | {currentCount.toLocaleString()} fish
            </p>
            <p className="text-xs text-gray-500">
              {((currentWeightG * currentCount) / 1000).toFixed(0)} kg biomass
            </p>
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-500">Calculating growth projections...</p>
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
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Projected Weight</p>
              <p className="text-2xl font-semibold text-gray-900">
                {simulationData.summary.endWeight.toFixed(0)}g
              </p>
              <p className="text-xs text-green-600">
                +{(simulationData.summary.endWeight - simulationData.summary.startWeight).toFixed(0)}g
                ({(((simulationData.summary.endWeight - simulationData.summary.startWeight) / simulationData.summary.startWeight) * 100).toFixed(0)}%)
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Projected Biomass</p>
              <p className="text-2xl font-semibold text-gray-900">
                {(simulationData.summary.endBiomass / 1000).toFixed(2)}t
              </p>
              <p className="text-xs text-green-600">
                +{((simulationData.summary.endBiomass - simulationData.summary.startBiomass) / 1000).toFixed(2)}t
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Total Feed Required</p>
              <p className="text-2xl font-semibold text-gray-900">
                {simulationData.summary.totalFeedKg.toFixed(0)} kg
              </p>
              <p className="text-xs text-gray-500">
                {(simulationData.summary.totalFeedKg / 1000).toFixed(2)}t
              </p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Expected FCR</p>
              <p className="text-2xl font-semibold text-gray-900">
                {simulationData.summary.avgFCR.toFixed(2)}
              </p>
              <p className="text-xs text-gray-500">
                {simulationData.summary.totalMortality} mortality
              </p>
            </div>
          </div>

          {/* Weight & Biomass Chart */}
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Weight & Biomass Projection</h3>
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
                    stroke="#3B82F6"
                    name="Avg Weight (g)"
                    strokeWidth={2}
                  />
                  <Area
                    yAxisId="right"
                    type="monotone"
                    dataKey="biomass"
                    fill="#10B981"
                    fillOpacity={0.3}
                    stroke="#10B981"
                    name="Biomass (kg)"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Daily Feed Chart */}
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Daily Feed Requirements</h3>
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
                    fill="#F59E0B"
                    name="Daily Feed (kg)"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cumulativeFeed"
                    stroke="#8B5CF6"
                    name="Cumulative Feed (kg)"
                    strokeWidth={2}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Feed Requirements Summary */}
          {simulationData.feedRequirements.length > 0 && (
            <div className="bg-white rounded-lg shadow">
              <div className="px-4 py-3 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900">Feed Requirements by Type</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Feed Type
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Total Required
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Days Used
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Period
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {simulationData.feedRequirements.map((feed) => (
                      <tr key={feed.feedCode} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-sm font-medium text-gray-900">{feed.feedName}</div>
                          <div className="text-sm text-gray-500">{feed.feedCode}</div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                          {feed.totalKg.toFixed(0)} kg
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                          {feed.daysUsed} days
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                          Day {feed.startDay} - Day {feed.endDay}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
