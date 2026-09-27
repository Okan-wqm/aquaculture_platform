/**
 * FCR Analysis Component
 *
 * Shows Feed Conversion Ratio analysis across batches
 * Compares actual vs target FCR
 */
import React, { useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { colors, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import { CircleCheck, Presentation } from 'lucide-react';

interface Batch {
  id: string;
  batchNumber: string;
  name?: string;
  currentQuantity: number;
  totalFeedConsumed?: number;
  weight?: {
    actual?: { avgWeight: number; totalBiomass: number };
    theoretical?: { avgWeight: number; totalBiomass: number };
    initial?: { avgWeight: number; totalBiomass: number };
  };
  fcr?: {
    target: number;
    actual: number;
    theoretical: number;
  };
  sgr?: number;
}

interface FCRAnalysisProps {
  siteId: string;
  batchId: string;
  batches: readonly Batch[];
}

export const FCRAnalysis: React.FC<FCRAnalysisProps> = ({ batches }) => {
  const [selectedMetric, setSelectedMetric] = useState<'fcr' | 'sgr'>('fcr');

  // Memoize FCR computations to prevent recalculation on every render (PERF-002)
  const batchFCRData = useMemo(
    () =>
      batches
        .map((batch) => {
          const initialBiomass = batch.weight?.initial?.totalBiomass ?? 0;
          const currentBiomass =
            batch.weight?.actual?.totalBiomass ?? batch.weight?.theoretical?.totalBiomass ?? 0;
          const weightGain = currentBiomass - initialBiomass;
          const feedConsumed = batch.totalFeedConsumed ?? 0;
          const actualFCR = weightGain > 0 && feedConsumed > 0 ? feedConsumed / weightGain : 0;
          const targetFCR = batch.fcr?.target ?? 1.2;
          const variance = actualFCR > 0 ? ((actualFCR - targetFCR) / targetFCR) * 100 : 0;

          return {
            id: batch.id,
            name: batch.batchNumber,
            displayName: batch.name || batch.batchNumber,
            actualFCR: parseFloat(actualFCR.toFixed(2)),
            targetFCR,
            theoreticalFCR: batch.fcr?.theoretical ?? 1.15,
            variance: parseFloat(variance.toFixed(1)),
            sgr: batch.sgr ?? 0,
            feedConsumed: feedConsumed,
            weightGain: weightGain,
            currentBiomass: currentBiomass,
            fishCount: batch.currentQuantity,
          };
        })
        .filter((b) => b.feedConsumed > 0 || b.currentBiomass > 0),
    [batches],
  );

  // Calculate averages (memoized implicitly via batchFCRData)
  const avgActualFCR =
    batchFCRData.length > 0
      ? batchFCRData.reduce((sum, b) => sum + b.actualFCR, 0) / batchFCRData.length
      : 0;
  const avgTargetFCR =
    batchFCRData.length > 0
      ? batchFCRData.reduce((sum, b) => sum + b.targetFCR, 0) / batchFCRData.length
      : 1.2;
  const avgSGR =
    batchFCRData.length > 0
      ? batchFCRData.reduce((sum, b) => sum + b.sgr, 0) / batchFCRData.length
      : 0;

  // Performance rating
  const getPerformanceRating = (
    actual: number,
    target: number,
  ): { label: string; color: string } => {
    if (actual === 0) return { label: 'No Data', color: 'text-gray-500 dark:text-gray-400' };
    const variance = ((actual - target) / target) * 100;
    if (variance <= -10)
      return { label: 'Excellent', color: 'text-success-600 dark:text-success-400' };
    if (variance <= 0) return { label: 'Good', color: 'text-success-500' };
    if (variance <= 10) return { label: 'Fair', color: 'text-warning-600 dark:text-warning-400' };
    if (variance <= 20)
      return { label: 'Below Target', color: 'text-accent-600 dark:text-accent-400' };
    return { label: 'Poor', color: 'text-error-600 dark:text-error-400' };
  };

  if (batches.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-6 text-center text-gray-500 dark:text-gray-400">
        No active batches found. Create a batch to analyze FCR.
      </div>
    );
  }

  type BatchRow = (typeof batchFCRData)[number];
  const batchRowColumns: DataTableColumn<BatchRow>[] = [
    {
      key: 'batch',
      header: 'Batch',
      render: (_value, batch) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{batch.name}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{batch.displayName}</div>
        </>
      ),
    },
    {
      key: 'fishCount',
      header: 'Fish Count',
      align: 'right',
      render: (_value, batch) => batch.fishCount.toLocaleString(),
    },
    {
      key: 'biomassKg',
      header: 'Biomass (kg)',
      align: 'right',
      render: (_value, batch) => batch.currentBiomass.toFixed(0),
    },
    {
      key: 'feedUsedKg',
      header: 'Feed Used (kg)',
      align: 'right',
      render: (_value, batch) => batch.feedConsumed.toFixed(0),
    },
    {
      key: 'weightGainKg',
      header: 'Weight Gain (kg)',
      align: 'right',
      render: (_value, batch) => batch.weightGain.toFixed(0),
    },
    {
      key: 'actualFcr',
      header: 'Actual FCR',
      align: 'right',
      render: (_value, batch) => (batch.actualFCR > 0 ? batch.actualFCR.toFixed(2) : '-'),
    },
    {
      key: 'targetFcr',
      header: 'Target FCR',
      align: 'right',
      render: (_value, batch) => batch.targetFCR.toFixed(2),
    },
    {
      key: 'variance',
      header: 'Variance',
      align: 'right',
      render: (_value, batch) => (
        <>
          {/* BUG-005: variance===0 (on-target) should be green, not gray */}
          <span
            className={`${
              batch.variance <= 0
                ? 'text-success-600 dark:text-success-400'
                : batch.variance > 10
                  ? 'text-error-600 dark:text-error-400'
                  : 'text-accent-600 dark:text-accent-400'
            }`}
          >
            {batch.variance > 0 ? '+' : ''}
            {batch.variance.toFixed(1)}%
          </span>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'center',
      render: (_value, batch) => {
        const rating = getPerformanceRating(batch.actualFCR, batch.targetFCR);
        return <span className={`text-sm font-medium ${rating.color}`}>{rating.label}</span>;
      },
    },
  ];

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Average FCR</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {avgActualFCR.toFixed(2)}
          </p>
          <p className={`text-sm ${getPerformanceRating(avgActualFCR, avgTargetFCR).color}`}>
            {getPerformanceRating(avgActualFCR, avgTargetFCR).label}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Target FCR</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {avgTargetFCR.toFixed(2)}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">Industry standard</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Average SGR</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {avgSGR.toFixed(2)}%
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">Daily growth rate</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">Batches Analyzed</p>
          <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {batchFCRData.length}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">of {batches.length} total</p>
        </div>
      </div>

      {/* Metric Toggle */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
        <div className="flex items-center space-x-4 mb-4">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">View:</span>
          <button
            onClick={() => setSelectedMetric('fcr')}
            className={`px-3 py-1 text-sm rounded-md ${
              selectedMetric === 'fcr'
                ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
            }`}
          >
            FCR Comparison
          </button>
          <button
            onClick={() => setSelectedMetric('sgr')}
            className={`px-3 py-1 text-sm rounded-md ${
              selectedMetric === 'sgr'
                ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
            }`}
          >
            SGR Analysis
          </button>
        </div>

        {/* FCR Chart */}
        {selectedMetric === 'fcr' && (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={batchFCRData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" domain={[0, 'auto']} />
                <YAxis type="category" dataKey="name" width={100} />
                <Tooltip />
                <Legend />
                <ReferenceLine
                  x={avgTargetFCR}
                  stroke={colors.success[500]}
                  strokeDasharray="3 3"
                  label="Target"
                />
                <Bar dataKey="actualFCR" fill={colors.info[500]} name="Actual FCR" />
                <Bar dataKey="targetFCR" fill={colors.success[500]} name="Target FCR" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* SGR Chart */}
        {selectedMetric === 'sgr' && (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={batchFCRData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" domain={[0, 'auto']} />
                <YAxis type="category" dataKey="name" width={100} />
                <Tooltip />
                <Legend />
                <Bar dataKey="sgr" fill={colors.primary[700]} name="SGR (%)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Historical Trend */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          FCR Historical Trend
        </h3>
        <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500">
          <Presentation className="w-12 h-12 mb-3" aria-hidden="true" />
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
            Not enough historical data yet
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            FCR trend will appear once sufficient feeding records are accumulated.
          </p>
        </div>
      </div>

      {/* Detailed Batch Table */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            Batch FCR Details
          </h3>
        </div>
        <DataTable<BatchRow>
          data={batchFCRData}
          columns={batchRowColumns}
          keyExtractor={(batch) => batch.id}
          emptyMessage="No records found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      </div>

      {/* FCR Optimization Tips */}
      <div className="bg-info-50 dark:bg-info-900/20 rounded-lg shadow p-4">
        <h3 className="text-lg font-medium text-info-900 dark:text-info-100 mb-2">
          FCR Optimization Tips
        </h3>
        <ul className="space-y-2 text-sm text-info-800 dark:text-info-200">
          <li className="flex items-start">
            <CircleCheck className="w-5 h-5 mr-2 text-info-500 flex-shrink-0" aria-hidden="true" />
            <span>
              Monitor water quality - optimal temperature and oxygen levels improve feed efficiency
            </span>
          </li>
          <li className="flex items-start">
            <CircleCheck className="w-5 h-5 mr-2 text-info-500 flex-shrink-0" aria-hidden="true" />
            <span>
              Match feed size to fish size - use the appropriate pellet size for the growth stage
            </span>
          </li>
          <li className="flex items-start">
            <CircleCheck className="w-5 h-5 mr-2 text-info-500 flex-shrink-0" aria-hidden="true" />
            <span>
              Feed multiple times per day - smaller, more frequent meals improve conversion
            </span>
          </li>
          <li className="flex items-start">
            <CircleCheck className="w-5 h-5 mr-2 text-info-500 flex-shrink-0" aria-hidden="true" />
            <span>Reduce stress factors - maintain stable conditions and minimize handling</span>
          </li>
        </ul>
      </div>
    </div>
  );
};
