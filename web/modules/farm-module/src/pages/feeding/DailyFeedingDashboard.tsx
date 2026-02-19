/**
 * Daily Feeding Dashboard
 *
 * Dashboard for daily feeding execution tracking:
 * - Date picker for selecting feeding date
 * - Summary cards: Total Feed, Completed, Pending, Transitions
 * - DataTable with tank feeding status
 * - Record Feeding Modal with FCR/Growth preview
 *
 * Now uses shared hooks from useDailyFeedingExecution
 * and extracted RecordFeedingModal component.
 */
import React, { useState, useMemo, useCallback } from 'react';

// Shared hooks and types
import {
  type DailyFeedingExecution,
  type FeedingStatus,
  useDailyFeedingExecutions,
  useSkipDailyFeeding,
  formatDateLocal,
  formatNumber,
  getStatusIcon,
  getStatusColor,
  getStatusLabel,
  sanitizeErrorMessage,
} from '../../hooks/useDailyFeedingExecution';
import { RecordFeedingModal } from './components/RecordFeedingModal';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Number of items per page for pagination */
const PAGE_SIZE = 20;

// ============================================================================
// SUMMARY CARD COMPONENT
// ============================================================================

interface SummaryCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  bgColor: string;
  iconBgColor: string;
  highlight?: boolean;
}

// PERF-010/011: Wrap in React.memo so card only re-renders when its own props change,
// preventing SVG icon JSX from being recreated on every parent render cycle.
const SummaryCard: React.FC<SummaryCardProps> = React.memo(({
  title,
  value,
  subtitle,
  icon,
  bgColor,
  iconBgColor,
  highlight = false,
}) => (
  <div className={`rounded-lg shadow p-4 ${bgColor} ${highlight ? 'ring-2 ring-offset-2 ring-blue-500' : ''}`}>
    <div className="flex items-center">
      <div className={`flex-shrink-0 rounded-lg p-3 ${iconBgColor}`}>{icon}</div>
      <div className="ml-4">
        <p className="text-sm font-medium text-gray-500">{title}</p>
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </div>
    </div>
  </div>
));

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const DailyFeedingDashboard: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState<string>(formatDateLocal(new Date()));
  const [selectedExecution, setSelectedExecution] = useState<DailyFeedingExecution | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  // Fetch data using shared hook
  const { data, isLoading, error, refetch } = useDailyFeedingExecutions(selectedDate);
  const skipMutation = useSkipDailyFeeding(selectedDate);

  // Handlers
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedDate(e.target.value);
    setCurrentPage(1);
  };

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
    // Refetch to ensure UI is in sync after skip (optimistic update + server confirmation)
    refetch();
  }, [skipMutation.mutateAsync, refetch]);

  // Summary data
  const summary = data?.summary;
  const allExecutions = data?.executions || [];

  // Paginated executions
  const totalPages = Math.ceil(allExecutions.length / PAGE_SIZE);
  const paginatedExecutions = useMemo(() => {
    const startIndex = (currentPage - 1) * PAGE_SIZE;
    return allExecutions.slice(startIndex, startIndex + PAGE_SIZE);
  }, [allExecutions, currentPage]);

  // Completion percentage — BUG-021: wrap in useMemo to avoid recomputing on
  // every render and to prevent divergence from PlannedVsActualSection's copy.
  const completionPercent = useMemo(
    () =>
      summary && summary.totalTanks > 0
        ? Math.round((summary.completedTanks / summary.totalTanks) * 100)
        : 0,
    [summary],
  );

  const skeletonCount = Math.min(PAGE_SIZE, 8);

  // Loading state
  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-64 mb-4" />
          <div className="grid grid-cols-4 gap-4 mb-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 rounded-lg" />
            ))}
          </div>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="h-12 bg-gray-100 border-b" />
            {[...Array(skeletonCount)].map((_, i) => (
              <div key={i} className="h-16 bg-gray-50 border-b last:border-b-0" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4" role="alert">
          <h3 className="text-red-800 font-medium">Error loading feeding data</h3>
          <p className="text-red-600 text-sm mt-1">{sanitizeErrorMessage(error)}</p>
          <button
            onClick={() => refetch()}
            className="mt-3 px-4 py-2 bg-red-100 text-red-800 rounded-lg hover:bg-red-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Date Picker */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Daily Feeding Dashboard</h2>
            <p className="text-sm text-gray-500">Track and record daily feeding executions by tank</p>
          </div>
          <div className="flex items-center gap-4">
            <label htmlFor="date-picker" className="text-sm font-medium text-gray-700">Date:</label>
            <input
              type="date"
              id="date-picker"
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

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <SummaryCard
          title="Total Feed"
          value={`${formatNumber(summary?.totalPlannedKg || 0, 1)} kg`}
          subtitle={`Actual: ${formatNumber(summary?.totalActualKg || 0, 1)} kg`}
          bgColor="bg-white"
          iconBgColor="bg-blue-100"
          icon={<svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>}
        />
        <SummaryCard
          title="Completed"
          value={summary?.completedTanks || 0}
          subtitle={`${completionPercent}% of tanks`}
          bgColor="bg-white"
          iconBgColor="bg-green-100"
          icon={<svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        />
        <SummaryCard
          title="Pending"
          value={summary?.pendingTanks || 0}
          subtitle={summary?.pendingTanks ? 'Awaiting feeding' : 'All done!'}
          bgColor={summary?.pendingTanks ? 'bg-yellow-50' : 'bg-white'}
          iconBgColor={summary?.pendingTanks ? 'bg-yellow-100' : 'bg-gray-100'}
          highlight={!!summary?.pendingTanks}
          icon={<svg className={`w-6 h-6 ${summary?.pendingTanks ? 'text-yellow-600' : 'text-gray-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        />
        <SummaryCard
          title="Transitions"
          value={summary?.transitionTanks || 0}
          subtitle={summary?.transitionTanks ? 'Feed changes today' : 'No transitions'}
          bgColor={summary?.transitionTanks ? 'bg-orange-50' : 'bg-white'}
          iconBgColor={summary?.transitionTanks ? 'bg-orange-100' : 'bg-gray-100'}
          icon={<svg className={`w-6 h-6 ${summary?.transitionTanks ? 'text-orange-600' : 'text-gray-600'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>}
        />
      </div>

      {/* Progress Bar */}
      {summary && summary.totalTanks > 0 && (
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Daily Progress</span>
            <span className="text-sm text-gray-500">
              {summary.completedTanks} / {summary.totalTanks} tanks completed
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className={`h-3 rounded-full transition-all duration-500 ${
                completionPercent === 100 ? 'bg-green-500' : completionPercent >= 50 ? 'bg-blue-500' : 'bg-yellow-500'
              }`}
              style={{ width: `${completionPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Feeding Executions</h3>
          <p className="text-sm text-gray-500">
            Click on a row to record feeding for that tank
            {allExecutions.length > PAGE_SIZE && (
              <span className="ml-2 text-gray-400">(Showing {paginatedExecutions.length} of {allExecutions.length})</span>
            )}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200" role="grid">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tank</th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Fish Count</th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Weight (g)</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Feed</th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Planned (kg)</th>
                <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actual (kg)</th>
                <th scope="col" className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paginatedExecutions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                    No feeding executions found for this date
                  </td>
                </tr>
              ) : (
                paginatedExecutions.map((execution) => (
                  <tr
                    key={execution.id}
                    onClick={() => handleRowClick(execution)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRowClick(execution); } }}
                    role="row"
                    tabIndex={0}
                    className={`hover:bg-gray-50 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500 ${
                      execution.status === 'COMPLETED' ? 'bg-green-50/50' : ''
                    } ${execution.status === 'SKIPPED' ? 'bg-gray-50/50 opacity-60' : ''} ${
                      execution.isTransitionDay ? 'border-l-4 border-l-orange-400' : ''
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{execution.tankName}</div>
                      <div className="text-sm text-gray-500">{execution.tankCode}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900">{formatNumber(execution.fishCount, 0)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900">{formatNumber(execution.avgWeightG, 1)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{execution.feedCode || '-'}</div>
                      {execution.isTransitionDay && (
                        <div className="text-xs text-orange-600">{'\u2192'} {execution.transitionToFeed}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900">{formatNumber(execution.plannedAmountKg, 2)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-right text-sm">
                      {execution.actualAmountKg != null ? (
                        <span className={`font-medium ${Math.abs(execution.actualAmountKg - execution.plannedAmountKg) < 0.5 ? 'text-green-600' : 'text-orange-600'}`}>
                          {formatNumber(execution.actualAmountKg, 2)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-center">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(execution.status)}`}>
                        <span className="mr-1" aria-hidden="true">{getStatusIcon(execution.status)}</span>
                        {getStatusLabel(execution.status)}
                      </span>
                      {execution.status === 'SKIPPED' && execution.skipReason && (
                        <span className="block text-xs text-gray-500 mt-1 truncate max-w-[120px]" title={execution.skipReason}>
                          {execution.skipReason}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
            <div className="text-sm text-gray-500">Page {currentPage} of {totalPages}</div>
            <div className="flex gap-2">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-1 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

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

export default DailyFeedingDashboard;
