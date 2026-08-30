/**
 * Feeding Summary Tab
 *
 * Shows feeding summary statistics including totals, variance analysis,
 * FCR calculation, and feed type breakdown for a selected batch.
 */
import { parseMoney } from '@aquaculture/shared-ui';
import React, { useState, useMemo } from 'react';
import {
  useFeedingSummary,
  FeedTypeSummary,
} from '../../../hooks/useFeedingRecords';
import { isBlockingError } from '../../../utils/list-view-state';
import type { Batch } from '../../../hooks/useBatches';

// ============================================================================
// TYPES
// ============================================================================

interface FeedingSummaryTabProps {
  batchId?: string;
  batches: Batch[];
}

// ============================================================================
// COMPONENT
// ============================================================================

export const FeedingSummaryTab: React.FC<FeedingSummaryTabProps> = ({
  batchId,
  batches,
}) => {
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [selectedBatchId, setSelectedBatchId] = useState(batchId || '');
  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);

  // Use batchId from props or local state
  const effectiveBatchId = batchId || selectedBatchId;

  const { data, isLoading, error, refetch } = useFeedingSummary(
    'batch',
    effectiveBatchId,
    startDate,
    endDate,
    { enabled: !!effectiveBatchId },
  );

  if (!effectiveBatchId) {
    return (
      <div className="space-y-4">
        {/* Batch Selector */}
        <div className="bg-white rounded-lg shadow p-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select a batch to view feeding summary
          </label>
          <select
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
            className="block w-full max-w-md rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          >
            <option value="">Choose batch...</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>{b.batchNumber} - {b.name || 'Unnamed'}</option>
            ))}
          </select>
        </div>

        <div className="bg-white rounded-lg shadow p-12 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <h3 className="text-lg font-medium text-gray-900 mb-1">No Batch Selected</h3>
          <p className="text-sm text-gray-500">Select a batch above or from the page filters to view feeding summary and FCR analysis.</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Blocking error — ONLY when the initial load failed and there is no cached
  // summary. A failed background refetch with cached data keeps rendering it and
  // surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, Boolean(data))) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800">Failed to load feeding summary: {(error as Error).message}</p>
      </div>
    );
  }

  // Find the current batch for FCR calculation display
  const currentBatch = batches.find(b => b.id === effectiveBatchId);

  return (
    <div className="space-y-6">
      {/* Non-blocking refresh error — keeps the last-loaded summary visible. */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh feeding summary — showing the last loaded data.{' '}
            <span className="text-amber-700">{(error as Error).message}</span>
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 rounded bg-amber-100 px-3 py-1 text-sm text-amber-800 hover:bg-amber-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Batch Selector (if not from parent) */}
          {!batchId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Batch</label>
              <select
                value={selectedBatchId}
                onChange={(e) => setSelectedBatchId(e.target.value)}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              >
                <option value="">Choose batch...</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>{b.batchNumber} - {b.name || 'Unnamed'}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">From</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">To</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
          </div>
        </div>
      </div>

      {data && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm font-medium text-gray-500">Total Feed Given</p>
              <p className="text-2xl font-semibold text-gray-900">{data.totalFeedGivenKg.toFixed(1)} kg</p>
              <p className="text-xs text-gray-500">{data.totalFeedings} feedings</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm font-medium text-gray-500">Total Planned</p>
              <p className="text-2xl font-semibold text-gray-900">{data.totalPlannedKg.toFixed(1)} kg</p>
              <p className="text-xs text-gray-500">Avg: {data.avgFeedingKg.toFixed(1)} kg/feeding</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm font-medium text-gray-500">Variance</p>
              <p className={`text-2xl font-semibold ${
                Math.abs(data.variancePercent) <= 10 ? 'text-green-600' : 'text-orange-600'
              }`}>
                {data.variancePercent > 0 ? '+' : ''}{data.variancePercent.toFixed(1)}%
              </p>
              <p className="text-xs text-gray-500">{data.varianceKg > 0 ? '+' : ''}{data.varianceKg.toFixed(1)} kg</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm font-medium text-gray-500">Total Cost</p>
              <p className="text-2xl font-semibold text-gray-900">
                {parseMoney(data.totalCostDecimal).toFixed(0)} {data.currency || 'NOK'}
              </p>
              <p className="text-xs text-gray-500">
                {data.totalFeedGivenKg > 0
                  ? `${(parseMoney(data.totalCostDecimal) / data.totalFeedGivenKg).toFixed(2)} per kg`
                  : '-'}
              </p>
            </div>
          </div>

          {/* FCR Display */}
          {currentBatch && (
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-medium text-gray-900 mb-4">FCR Analysis</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="text-center">
                  <p className="text-sm text-gray-500 mb-1">Target FCR</p>
                  <p className="text-3xl font-bold text-blue-600">
                    {currentBatch.fcr?.target?.toFixed(2) || '-'}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-sm text-gray-500 mb-1">Actual FCR</p>
                  <p className={`text-3xl font-bold ${
                    currentBatch.fcr?.actual && currentBatch.fcr?.target &&
                    currentBatch.fcr.actual <= currentBatch.fcr.target
                      ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {currentBatch.fcr?.actual?.toFixed(2) || '-'}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-sm text-gray-500 mb-1">Theoretical FCR</p>
                  <p className="text-3xl font-bold text-gray-600">
                    {currentBatch.fcr?.theoretical?.toFixed(2) || '-'}
                  </p>
                </div>
              </div>
              {currentBatch.fcr?.actual && currentBatch.fcr?.target && (
                <div className="mt-4 p-3 rounded-lg bg-gray-50">
                  <p className="text-sm text-gray-600">
                    {currentBatch.fcr.actual <= currentBatch.fcr.target
                      ? 'FCR is within target. Feed conversion is efficient.'
                      : `FCR is ${((currentBatch.fcr.actual - currentBatch.fcr.target) / currentBatch.fcr.target * 100).toFixed(1)}% above target. Consider reviewing feeding strategy.`
                    }
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Feed Type Breakdown */}
          {data.byFeedType && data.byFeedType.length > 0 && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200">
                <h3 className="text-lg font-medium text-gray-900">Feed Type Breakdown</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Feed</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Total (kg)</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Percentage</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cost</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Distribution</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {data.byFeedType.map((ft: FeedTypeSummary) => (
                      <tr key={ft.feedId} className="hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                          {ft.feedName}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                          {ft.totalKg.toFixed(1)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-500">
                          {ft.percentage.toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                          {ft.cost.toFixed(0)} {data.currency || 'NOK'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="w-32 bg-gray-200 rounded-full h-2">
                            <div
                              className="bg-blue-500 h-2 rounded-full"
                              style={{ width: `${ft.percentage}%` }}
                            />
                          </div>
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
