/**
 * FCR Analysis Component
 *
 * Shows Feed Conversion Ratio analysis across batches
 * Compares actual vs target FCR
 */
import React, { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  ReferenceLine,
} from 'recharts';

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
  batches: Batch[];
}

export const FCRAnalysis: React.FC<FCRAnalysisProps> = ({ batches }) => {
  const [selectedMetric, setSelectedMetric] = useState<'fcr' | 'sgr'>('fcr');

  // Calculate FCR for batches
  const batchFCRData = batches.map((batch) => {
    const initialBiomass = batch.weight?.initial?.totalBiomass ?? 0;
    const currentBiomass =
      batch.weight?.actual?.totalBiomass ??
      batch.weight?.theoretical?.totalBiomass ??
      0;
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
  }).filter(b => b.feedConsumed > 0 || b.currentBiomass > 0);

  // Calculate averages
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
  const getPerformanceRating = (actual: number, target: number): { label: string; color: string } => {
    if (actual === 0) return { label: 'No Data', color: 'text-gray-500' };
    const variance = ((actual - target) / target) * 100;
    if (variance <= -10) return { label: 'Excellent', color: 'text-green-600' };
    if (variance <= 0) return { label: 'Good', color: 'text-green-500' };
    if (variance <= 10) return { label: 'Fair', color: 'text-yellow-600' };
    if (variance <= 20) return { label: 'Below Target', color: 'text-orange-600' };
    return { label: 'Poor', color: 'text-red-600' };
  };

  // Mock historical FCR data (would come from API in production)
  const historicalData = [
    { month: 'Jan', actual: 1.18, target: 1.2 },
    { month: 'Feb', actual: 1.22, target: 1.2 },
    { month: 'Mar', actual: 1.15, target: 1.2 },
    { month: 'Apr', actual: 1.19, target: 1.2 },
    { month: 'May', actual: 1.24, target: 1.2 },
    { month: 'Jun', actual: 1.21, target: 1.2 },
  ];

  if (batches.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
        No active batches found. Create a batch to analyze FCR.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Average FCR</p>
          <p className="text-2xl font-semibold text-gray-900">
            {avgActualFCR.toFixed(2)}
          </p>
          <p className={`text-sm ${getPerformanceRating(avgActualFCR, avgTargetFCR).color}`}>
            {getPerformanceRating(avgActualFCR, avgTargetFCR).label}
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Target FCR</p>
          <p className="text-2xl font-semibold text-gray-900">
            {avgTargetFCR.toFixed(2)}
          </p>
          <p className="text-sm text-gray-500">
            Industry standard
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Average SGR</p>
          <p className="text-2xl font-semibold text-gray-900">
            {avgSGR.toFixed(2)}%
          </p>
          <p className="text-sm text-gray-500">
            Daily growth rate
          </p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-sm text-gray-500">Batches Analyzed</p>
          <p className="text-2xl font-semibold text-gray-900">
            {batchFCRData.length}
          </p>
          <p className="text-sm text-gray-500">
            of {batches.length} total
          </p>
        </div>
      </div>

      {/* Metric Toggle */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center space-x-4 mb-4">
          <span className="text-sm font-medium text-gray-700">View:</span>
          <button
            onClick={() => setSelectedMetric('fcr')}
            className={`px-3 py-1 text-sm rounded-md ${
              selectedMetric === 'fcr'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            FCR Comparison
          </button>
          <button
            onClick={() => setSelectedMetric('sgr')}
            className={`px-3 py-1 text-sm rounded-md ${
              selectedMetric === 'sgr'
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
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
                <ReferenceLine x={avgTargetFCR} stroke="#10B981" strokeDasharray="3 3" label="Target" />
                <Bar dataKey="actualFCR" fill="#3B82F6" name="Actual FCR" />
                <Bar dataKey="targetFCR" fill="#10B981" name="Target FCR" />
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
                <Bar dataKey="sgr" fill="#8B5CF6" name="SGR (%)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Historical Trend */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">FCR Historical Trend</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={historicalData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" />
              <YAxis domain={[1, 1.4]} />
              <Tooltip />
              <Legend />
              <ReferenceLine y={1.2} stroke="#10B981" strokeDasharray="3 3" label="Target" />
              <Line
                type="monotone"
                dataKey="actual"
                stroke="#3B82F6"
                strokeWidth={2}
                name="Actual FCR"
                dot={{ fill: '#3B82F6' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-gray-500 mt-2 text-center">
          * Historical data is illustrative. Connect to actual records for live data.
        </p>
      </div>

      {/* Detailed Batch Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Batch FCR Details</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Batch
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Fish Count
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Biomass (kg)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Feed Used (kg)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Weight Gain (kg)
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actual FCR
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Target FCR
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Variance
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {batchFCRData.map((batch) => {
                const rating = getPerformanceRating(batch.actualFCR, batch.targetFCR);
                return (
                  <tr key={batch.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{batch.name}</div>
                      <div className="text-sm text-gray-500">{batch.displayName}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {batch.fishCount.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {batch.currentBiomass.toFixed(0)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {batch.feedConsumed.toFixed(0)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">
                      {batch.weightGain.toFixed(0)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-medium text-gray-900">
                      {batch.actualFCR > 0 ? batch.actualFCR.toFixed(2) : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-500">
                      {batch.targetFCR.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-right">
                      <span
                        className={`${
                          batch.variance < 0
                            ? 'text-green-600'
                            : batch.variance > 10
                            ? 'text-red-600'
                            : 'text-gray-600'
                        }`}
                      >
                        {batch.variance > 0 ? '+' : ''}{batch.variance.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <span className={`text-sm font-medium ${rating.color}`}>
                        {rating.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* FCR Optimization Tips */}
      <div className="bg-blue-50 rounded-lg shadow p-4">
        <h3 className="text-lg font-medium text-blue-900 mb-2">FCR Optimization Tips</h3>
        <ul className="space-y-2 text-sm text-blue-800">
          <li className="flex items-start">
            <svg className="w-5 h-5 mr-2 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span>Monitor water quality - optimal temperature and oxygen levels improve feed efficiency</span>
          </li>
          <li className="flex items-start">
            <svg className="w-5 h-5 mr-2 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span>Match feed size to fish size - use the appropriate pellet size for the growth stage</span>
          </li>
          <li className="flex items-start">
            <svg className="w-5 h-5 mr-2 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span>Feed multiple times per day - smaller, more frequent meals improve conversion</span>
          </li>
          <li className="flex items-start">
            <svg className="w-5 h-5 mr-2 text-blue-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span>Reduce stress factors - maintain stable conditions and minimize handling</span>
          </li>
        </ul>
      </div>
    </div>
  );
};
