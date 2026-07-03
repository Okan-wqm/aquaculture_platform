/**
 * Planned vs Actual Section
 *
 * Per-tank comparison of planned vs actual feeding amounts.
 * Includes date picker, summary cards, color-coded variance table,
 * and record feeding modal integration.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { useToast } from '@aquaculture/shared-ui';
import {
  useDailyFeedingExecutions,
  useSkipDailyFeeding,
  formatDateLocal,
  formatNumber,
  getVarianceColor,
  getStatusColor,
  getStatusLabel,
  getStatusIcon,
  formatFeedingMethod,
  type DailyFeedingExecution,
  type FeedingStatus,
} from '../../../hooks/useDailyFeedingExecution';
import { isBlockingError } from '../../../utils/list-view-state';
import { RecordFeedingModal } from './RecordFeedingModal';

// ============================================================================
// COMPONENT
// ============================================================================

interface PlannedVsActualSectionProps {
  siteId?: string;
}

export const PlannedVsActualSection: React.FC<PlannedVsActualSectionProps> = ({ siteId }) => {
  const [selectedDate, setSelectedDate] = useState<string>(formatDateLocal(new Date()));
  const [selectedExecution, setSelectedExecution] = useState<DailyFeedingExecution | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const { data, isLoading, error, refetch } = useDailyFeedingExecutions(selectedDate, siteId);
  const skipMutation = useSkipDailyFeeding(selectedDate);
  const { toast } = useToast();

  const executions = data?.executions || [];
  const summary = data?.summary;

  // Completion percentage
  const completionPercent = useMemo(() => {
    if (!summary || summary.totalTanks === 0) return 0;
    return Math.round((summary.completedTanks / summary.totalTanks) * 100);
  }, [summary]);

  // Overall variance — computed only over completed tanks to avoid pending (null actual) skewing result
  // BUG-016: totalActualKg includes 0 for pending tanks, creating false negative variance
  const overallVariance = useMemo(() => {
    const completed = executions.filter(e => e.status === 'COMPLETED');
    if (completed.length === 0) return null;
    const plannedCompleted = completed.reduce((s, e) => s + (e.plannedAmountKg || 0), 0);
    const actualCompleted = completed.reduce((s, e) => s + (e.actualAmountKg || 0), 0);
    if (plannedCompleted === 0) return null;
    return ((actualCompleted - plannedCompleted) / plannedCompleted) * 100;
  }, [executions]);

  const handleRowClick = useCallback((execution: DailyFeedingExecution) => {
    setSelectedExecution(execution);
    setIsModalOpen(true);
  }, []);

  const handleModalClose = useCallback(() => {
    setIsModalOpen(false);
    setSelectedExecution(null);
  }, []);

  const handleFeedingSuccess = useCallback(() => {
    refetch();
  }, [refetch]);

  const handleSkipFeeding = useCallback(async (executionId: string, reason: string) => {
    await skipMutation.mutateAsync({ executionId, reason });
    refetch();
  }, [skipMutation.mutateAsync, refetch]);

  // PERF-010: Only update state when the date string is a complete, valid value
  // (YYYY-MM-DD). This prevents firing a network request for every keystroke
  // when the user types the date manually.
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      setSelectedDate(val);
    }
  };

  // Blocking error — ONLY when the initial load failed and there is no cached
  // data. A failed background refetch with cached executions keeps rendering the
  // table and surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, executions.length > 0)) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800 font-medium">Failed to load feeding data</p>
        <button onClick={() => refetch()} className="mt-2 px-4 py-2 bg-red-100 text-red-800 rounded-lg hover:bg-red-200">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Non-blocking refresh error — keeps the last-loaded executions visible. */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh feeding data — showing the last loaded data.
          </p>
          <button
            onClick={() => refetch()}
            className="ml-3 shrink-0 rounded bg-amber-100 px-3 py-1 text-sm text-amber-800 hover:bg-amber-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* Header + Date Picker */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Planned vs Actual Feeding</h3>
            <p className="text-sm text-gray-500">Per-tank comparison with variance tracking</p>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="date"
              value={selectedDate}
              onChange={handleDateChange}
              max={formatDateLocal(new Date())}
              className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
            />
            <button
              onClick={() => setSelectedDate(formatDateLocal(new Date()))}
              className="px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded-md"
            >
              Today
            </button>
            <button
              onClick={() => refetch()}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
              title="Refresh"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="bg-white rounded-lg shadow p-8">
          <div className="animate-pulse space-y-4">
            <div className="grid grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => <div key={i} className="h-20 bg-gray-200 rounded-lg" />)}
            </div>
            <div className="h-4 bg-gray-200 rounded w-full" />
            {[1, 2, 3].map((i) => <div key={i} className="h-12 bg-gray-100 rounded" />)}
          </div>
        </div>
      )}

      {/* Content */}
      {!isLoading && summary && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Total Planned</p>
              <p className="text-2xl font-bold text-gray-900">{formatNumber(summary.totalPlannedKg, 1)} kg</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Total Actual</p>
              <p className="text-2xl font-bold text-gray-900">{formatNumber(summary.totalActualKg, 1)} kg</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Completed</p>
              <p className="text-2xl font-bold text-gray-900">
                {summary.completedTanks} / {summary.totalTanks}
              </p>
              <p className="text-xs text-gray-400">{completionPercent}% of tanks</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <p className="text-sm text-gray-500">Overall Variance</p>
              <p className={`text-2xl font-bold ${
                overallVariance === null ? 'text-gray-400'
                  : Math.abs(overallVariance) <= 5 ? 'text-green-600'
                  : Math.abs(overallVariance) <= 15 ? 'text-amber-600'
                  : 'text-red-600'
              }`}>
                {overallVariance !== null ? `${overallVariance > 0 ? '+' : ''}${formatNumber(overallVariance, 1)}%` : '-'}
              </p>
            </div>
          </div>

          {/* Progress Bar */}
          {summary.totalTanks > 0 && (
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Daily Progress</span>
                <span className="text-sm text-gray-500">
                  {summary.completedTanks} / {summary.totalTanks} tanks
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className={`h-2.5 rounded-full transition-all duration-500 ${
                    completionPercent === 100 ? 'bg-green-500'
                      : completionPercent >= 50 ? 'bg-blue-500'
                      : 'bg-yellow-500'
                  }`}
                  style={{ width: `${completionPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* Comparison Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200">
              <h4 className="text-md font-medium text-gray-900">Tank Feeding Details</h4>
              <p className="text-xs text-gray-500">Click a row to record or update feeding</p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tank</th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Biomass (kg)</th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Feed</th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Plan %</th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Plan (kg)</th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actual (kg)</th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actual %</th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Variance</th>
                    <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Feeder</th>
                    <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {executions.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                        No feeding executions for this date
                      </td>
                    </tr>
                  ) : (
                    executions.map((exec) => {
                      const actualPercent = exec.actualAmountKg != null && exec.biomassKg > 0
                        ? (exec.actualAmountKg / exec.biomassKg) * 100
                        : null;
                      const varianceDisplay = exec.varianceKg != null
                        ? `${exec.varianceKg > 0 ? '+' : ''}${formatNumber(exec.varianceKg, 2)} (${exec.variancePercent != null ? `${exec.variancePercent > 0 ? '+' : ''}${formatNumber(exec.variancePercent, 1)}%` : ''})`
                        : '-';

                      return (
                        <tr
                          key={exec.id}
                          onClick={() => handleRowClick(exec)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRowClick(exec); } }}
                          tabIndex={0}
                          role="row"
                          className={`cursor-pointer transition-colors hover:bg-gray-100 focus:outline-hidden focus:ring-2 focus:ring-inset focus:ring-blue-500 ${getVarianceColor(exec.variancePercent, exec.status)}`}
                        >
                          <td className="px-3 py-3 whitespace-nowrap">
                            <div className="font-medium text-gray-900 text-sm">{exec.tankName}</div>
                            <div className="text-xs text-gray-500">{exec.tankCode}</div>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-right text-sm text-gray-900">
                            {formatNumber(exec.biomassKg, 1)}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-sm text-gray-900">
                            {exec.feedCode || '-'}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-right text-sm text-gray-900">
                            {formatNumber(exec.feedingRatePercent, 2)}%
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-right text-sm text-gray-900">
                            {formatNumber(exec.plannedAmountKg, 2)}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-right text-sm">
                            {exec.actualAmountKg != null ? (
                              <span className="font-medium text-gray-900">{formatNumber(exec.actualAmountKg, 2)}</span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-right text-sm">
                            {actualPercent != null ? (
                              <span className="text-gray-900">{formatNumber(actualPercent, 2)}%</span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-right text-sm">
                            {exec.varianceKg != null ? (
                              <span className={exec.varianceKg > 0 ? 'text-orange-600' : exec.varianceKg < 0 ? 'text-red-600' : 'text-green-600'}>
                                {varianceDisplay}
                              </span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-sm text-gray-700">
                            {formatFeedingMethod(exec.feedingMethod, exec.feederName)}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-center">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(exec.status)}`}>
                              <span className="mr-1" aria-hidden="true">{getStatusIcon(exec.status)}</span>
                              {getStatusLabel(exec.status)}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
                {/* Totals Footer */}
                {executions.length > 0 && (
                  <tfoot className="bg-gray-50 font-medium">
                    <tr>
                      <td className="px-3 py-3 text-sm text-gray-900">Total ({executions.length} tanks)</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-900">
                        {formatNumber(executions.reduce((s, e) => s + e.biomassKg, 0), 0)}
                      </td>
                      <td className="px-3 py-3" />
                      <td className="px-3 py-3" />
                      <td className="px-3 py-3 text-right text-sm text-gray-900 font-bold">
                        {formatNumber(summary.totalPlannedKg, 1)}
                      </td>
                      <td className="px-3 py-3 text-right text-sm text-gray-900 font-bold">
                        {formatNumber(summary.totalActualKg, 1)}
                      </td>
                      <td className="px-3 py-3" />
                      <td className="px-3 py-3 text-right text-sm font-bold">
                        {overallVariance !== null ? (
                          <span className={
                            Math.abs(overallVariance) <= 5 ? 'text-green-600'
                              : Math.abs(overallVariance) <= 15 ? 'text-amber-600'
                              : 'text-red-600'
                          }>
                            {overallVariance > 0 ? '+' : ''}{formatNumber(overallVariance, 1)}%
                          </span>
                        ) : '-'}
                      </td>
                      <td className="px-3 py-3" />
                      <td className="px-3 py-3" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Color Legend */}
          <div className="bg-white rounded-lg shadow p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-2">Variance Legend</h4>
            <div className="flex flex-wrap gap-3 text-xs">
              <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-green-50 border border-green-200" /> -5% to +5% (Normal)</span>
              <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-amber-50 border border-amber-200" /> +5% to +15% (Above plan)</span>
              <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-orange-50 border border-orange-200" /> &gt;+15% (Well above)</span>
              <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-yellow-100 border border-yellow-200" /> -5% to -15% (Below plan)</span>
              <span className="flex items-center gap-1"><span className="w-4 h-4 rounded bg-red-50 border border-red-200" /> &lt;-15% (Well below)</span>
            </div>
          </div>
        </>
      )}

      {/* Record Feeding Modal */}
      {selectedExecution && (
        <RecordFeedingModal
          isOpen={isModalOpen}
          onClose={handleModalClose}
          execution={selectedExecution}
          onSuccess={handleFeedingSuccess}
          onSkip={handleSkipFeeding}
          date={selectedDate}
        />
      )}
    </div>
  );
};
