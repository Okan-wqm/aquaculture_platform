/**
 * Daily Plan Tab
 *
 * Shows the daily feeding plan for a site with per-batch/tank breakdown.
 * Allows viewing plans for different dates.
 */
import React, { useState } from 'react';
import {
  useDailyFeedingPlan,
  PlannedFeeding,
} from '../../../hooks/useFeedingRecords';
import { isBlockingError } from '../../../utils/list-view-state';

// ============================================================================
// TYPES
// ============================================================================

interface DailyPlanTabProps {
  siteId?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export const DailyPlanTab: React.FC<DailyPlanTabProps> = ({ siteId }) => {
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);

  const { data, isLoading, error, refetch } = useDailyFeedingPlan(
    siteId || '',
    selectedDate,
    { enabled: !!siteId },
  );

  if (!siteId) {
    return (
      <div className="bg-white rounded-lg shadow p-12 text-center">
        <svg className="mx-auto h-12 w-12 text-gray-400 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <h3 className="text-lg font-medium text-gray-900 mb-1">Select a Site</h3>
        <p className="text-sm text-gray-500">Please select a site from the filters above to view the daily feeding plan.</p>
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
  // plan. A failed background refetch with cached data keeps rendering it and
  // surfaces a non-blocking banner below (stale-on-error).
  if (isBlockingError(error, Boolean(data))) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-red-800">Failed to load daily plan: {(error as Error).message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Non-blocking refresh error — keeps the last-loaded plan visible. */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-800">
            Couldn&apos;t refresh daily plan — showing the last loaded data.{' '}
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

      {/* Date Selector */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => {
              const d = new Date(selectedDate);
              d.setDate(d.getDate() - 1);
              setSelectedDate(d.toISOString().split('T')[0]);
            }}
            className="p-2 rounded-md border border-gray-300 hover:bg-gray-50"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
          />
          <button
            onClick={() => {
              const d = new Date(selectedDate);
              d.setDate(d.getDate() + 1);
              setSelectedDate(d.toISOString().split('T')[0]);
            }}
            className="p-2 rounded-md border border-gray-300 hover:bg-gray-50"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={() => setSelectedDate(today)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Today
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-sm font-medium text-gray-500">Total Planned</p>
            <p className="text-2xl font-semibold text-gray-900">{data.totalPlannedKg.toFixed(1)} kg</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-sm font-medium text-gray-500">Total Actual</p>
            <p className="text-2xl font-semibold text-gray-900">{data.totalActualKg.toFixed(1)} kg</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-sm font-medium text-gray-500">Completion</p>
            <div className="flex items-center space-x-3">
              <p className={`text-2xl font-semibold ${
                data.completionPercent >= 90 ? 'text-green-600' :
                data.completionPercent >= 50 ? 'text-yellow-600' : 'text-red-600'
              }`}>
                {data.completionPercent.toFixed(0)}%
              </p>
              <div className="flex-1 bg-gray-200 rounded-full h-2">
                <div
                  className={`h-2 rounded-full ${
                    data.completionPercent >= 90 ? 'bg-green-500' :
                    data.completionPercent >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${Math.min(100, data.completionPercent)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Planned Feedings Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Planned Feedings</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Batch</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tank</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Feed</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Planned (kg)</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actual (kg)</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Meals</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {(!data?.plannedFeedings || data.plannedFeedings.length === 0) && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                    No feeding plan for this date.
                  </td>
                </tr>
              )}
              {data?.plannedFeedings?.map((pf: PlannedFeeding, index: number) => (
                <tr key={`${pf.batchId}-${pf.feedId}-${index}`} className="hover:bg-gray-50">
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 font-medium">
                    {pf.batchCode}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                    {pf.tankCode || '-'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                    {pf.feedName}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                    {pf.plannedAmountKg.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900">
                    {pf.actualAmountKg.toFixed(1)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-center text-gray-500">
                    {pf.mealsCompleted}/{pf.mealsPlanned}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-center">
                    {pf.isComplete ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        Complete
                      </span>
                    ) : pf.mealsCompleted > 0 ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        In Progress
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                        Pending
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
