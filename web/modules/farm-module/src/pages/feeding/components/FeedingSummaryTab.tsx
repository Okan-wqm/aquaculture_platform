/**
 * Feeding Summary Tab
 *
 * Shows feeding summary statistics including totals, variance analysis,
 * FCR calculation, and feed type breakdown for a selected batch.
 */
import {
  parseMoney,
  DataTable,
  type DataTableColumn,
  Spinner,
  Input,
} from '@aquaculture/shared-ui';
import React, { useState, useMemo } from 'react';
import { useFeedingSummary, FeedTypeSummary } from '../../../hooks/useFeedingRecords';
import { isBlockingError } from '../../../utils/list-view-state';
import type { Batch } from '../../../hooks/useBatches';
import { ChartColumn } from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

interface FeedingSummaryTabProps {
  batchId?: string;
  batches: readonly Batch[];
}

// ============================================================================
// COMPONENT
// ============================================================================

export const FeedingSummaryTab: React.FC<FeedingSummaryTabProps> = ({ batchId, batches }) => {
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
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Select a batch to view feeding summary
          </label>
          <select
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
            className="block w-full max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-info-500 focus:ring-info-500 sm:text-sm"
          >
            <option value="">Choose batch...</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.batchNumber} - {b.name || 'Unnamed'}
              </option>
            ))}
          </select>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-12 text-center">
          <ChartColumn
            className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500 mb-4"
            aria-hidden="true"
          />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
            No Batch Selected
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Select a batch above or from the page filters to view feeding summary and FCR analysis.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="xl" />
      </div>
    );
  }

  // Blocking error — ONLY when the initial load failed and there is no cached
  // summary. A failed background refetch with cached data keeps rendering it and
  // surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, Boolean(data))) {
    return (
      <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-4">
        <p className="text-error-800 dark:text-error-200">
          Failed to load feeding summary: {(error as Error).message}
        </p>
      </div>
    );
  }

  // Find the current batch for FCR calculation display
  const currentBatch = batches.find((b) => b.id === effectiveBatchId);

  const feedTypeSummaryColumns = (currency: string): DataTableColumn<FeedTypeSummary>[] => [
    {
      key: 'feed',
      header: 'Feed',
      render: (_value, ft) => ft.feedName,
    },
    {
      key: 'totalKg',
      header: 'Total (kg)',
      align: 'right',
      render: (_value, ft) => ft.totalKg.toFixed(1),
    },
    {
      key: 'percentage',
      header: 'Percentage',
      align: 'right',
      render: (_value, ft) => <>{ft.percentage.toFixed(1)}%</>,
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      render: (_value, ft) => (
        <>
          {ft.cost.toFixed(0)} {currency}
        </>
      ),
    },
    {
      key: 'distribution',
      header: 'Distribution',
      render: (_value, ft) => (
        <div className="w-32 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
          <div className="bg-info-500 h-2 rounded-full" style={{ width: `${ft.percentage}%` }} />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Non-blocking refresh error — keeps the last-loaded summary visible. */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 p-3">
          <p className="text-sm text-warning-800 dark:text-warning-200">
            Couldn&apos;t refresh feeding summary — showing the last loaded data.{' '}
            <span className="text-warning-700 dark:text-warning-300">
              {(error as Error).message}
            </span>
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 rounded bg-warning-100 dark:bg-warning-900/40 px-3 py-1 text-sm text-warning-800 dark:text-warning-200 hover:bg-warning-200 dark:hover:bg-warning-800/60"
          >
            Retry
          </button>
        </div>
      )}

      {/* Controls */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Batch Selector (if not from parent) */}
          {!batchId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Batch
              </label>
              <select
                value={selectedBatchId}
                onChange={(e) => setSelectedBatchId(e.target.value)}
                className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-info-500 focus:ring-info-500 sm:text-sm"
              >
                <option value="">Choose batch...</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.batchNumber} - {b.name || 'Unnamed'}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              From
            </label>
            <Input
              fullWidth
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              To
            </label>
            <Input
              fullWidth
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>
      </div>

      {data && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Total Feed Given
              </p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {data.totalFeedGivenKg.toFixed(1)} kg
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {data.totalFeedings} feedings
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Planned</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {data.totalPlannedKg.toFixed(1)} kg
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Avg: {data.avgFeedingKg.toFixed(1)} kg/feeding
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Variance</p>
              <p
                className={`text-2xl font-semibold ${
                  Math.abs(data.variancePercent) <= 10
                    ? 'text-success-600 dark:text-success-400'
                    : 'text-warning-600 dark:text-warning-400'
                }`}
              >
                {data.variancePercent > 0 ? '+' : ''}
                {data.variancePercent.toFixed(1)}%
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {data.varianceKg > 0 ? '+' : ''}
                {data.varianceKg.toFixed(1)} kg
              </p>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-4">
              <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Cost</p>
              <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {parseMoney(data.totalCostDecimal).toFixed(0)} {data.currency || 'NOK'}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {data.totalFeedGivenKg > 0
                  ? `${(parseMoney(data.totalCostDecimal) / data.totalFeedGivenKg).toFixed(2)} per kg`
                  : '-'}
              </p>
            </div>
          </div>

          {/* FCR Display */}
          {currentBatch && (
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow p-6">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                FCR Analysis
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="text-center">
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Target FCR</p>
                  <p className="text-3xl font-bold text-info-600 dark:text-info-400">
                    {currentBatch.fcr?.target?.toFixed(2) || '-'}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Actual FCR</p>
                  <p
                    className={`text-3xl font-bold ${
                      currentBatch.fcr?.actual &&
                      currentBatch.fcr?.target &&
                      currentBatch.fcr.actual <= currentBatch.fcr.target
                        ? 'text-success-600 dark:text-success-400'
                        : 'text-error-600 dark:text-error-400'
                    }`}
                  >
                    {currentBatch.fcr?.actual?.toFixed(2) || '-'}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Theoretical FCR</p>
                  <p className="text-3xl font-bold text-gray-600 dark:text-gray-400">
                    {currentBatch.fcr?.theoretical?.toFixed(2) || '-'}
                  </p>
                </div>
              </div>
              {currentBatch.fcr?.actual && currentBatch.fcr?.target && (
                <div className="mt-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {currentBatch.fcr.actual <= currentBatch.fcr.target
                      ? 'FCR is within target. Feed conversion is efficient.'
                      : `FCR is ${(((currentBatch.fcr.actual - currentBatch.fcr.target) / currentBatch.fcr.target) * 100).toFixed(1)}% above target. Consider reviewing feeding strategy.`}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Feed Type Breakdown */}
          {data.byFeedType && data.byFeedType.length > 0 && (
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Feed Type Breakdown
                </h3>
              </div>
              <DataTable<FeedTypeSummary>
                data={data.byFeedType}
                columns={feedTypeSummaryColumns(data.currency || 'NOK')}
                keyExtractor={(ft) => ft.feedId}
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
