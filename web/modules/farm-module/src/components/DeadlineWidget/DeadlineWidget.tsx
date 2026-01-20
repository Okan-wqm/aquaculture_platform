/**
 * Deadline Widget
 *
 * Shows upcoming regulatory report deadlines in a sidebar widget.
 * Follows the AlertSummaryWidget pattern for consistency.
 */

import React, { useState, useMemo, useCallback } from 'react';

// ============================================================================
// Type Definitions
// ============================================================================

export type DeadlineUrgency = 'overdue' | 'today' | 'this_week' | 'upcoming';
export type ReportType =
  | 'sea_lice'
  | 'biomass'
  | 'smolt'
  | 'cleaner_fish'
  | 'slaughter'
  | 'welfare_event'
  | 'disease_outbreak'
  | 'escape';

export interface UpcomingDeadline {
  id: string;
  reportType: ReportType;
  reportName: string;
  deadline: Date;
  status: 'pending' | 'in_progress' | 'overdue';
  daysRemaining: number;
  siteId: string;
  siteName: string;
  weekNumber?: number;
  month?: number;
  year: number;
}

export interface DeadlineWidgetProps {
  /** Deadlines to display */
  deadlines?: UpcomingDeadline[];
  /** Loading state */
  isLoading?: boolean;
  /** Error message */
  error?: string | null;
  /** Callback when deadline is clicked */
  onViewReport?: (deadline: UpcomingDeadline) => void;
  /** Callback when "View All" is clicked */
  onViewAll?: () => void;
  /** Maximum deadlines to display */
  maxDeadlines?: number;
  /** Show urgency filter controls */
  showFilters?: boolean;
  /** Compact mode */
  compact?: boolean;
  /** Custom class name */
  className?: string;
}

// ============================================================================
// Urgency Configuration
// ============================================================================

export const urgencyConfig: Record<
  DeadlineUrgency,
  {
    bgColor: string;
    borderColor: string;
    iconColor: string;
    textColor: string;
    label: string;
    priority: number;
  }
> = {
  overdue: {
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
    iconColor: 'text-red-600',
    textColor: 'text-red-700',
    label: 'Overdue',
    priority: 4,
  },
  today: {
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
    iconColor: 'text-orange-600',
    textColor: 'text-orange-700',
    label: 'Today',
    priority: 3,
  },
  this_week: {
    bgColor: 'bg-yellow-50',
    borderColor: 'border-yellow-200',
    iconColor: 'text-yellow-600',
    textColor: 'text-yellow-700',
    label: 'This Week',
    priority: 2,
  },
  upcoming: {
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    iconColor: 'text-green-600',
    textColor: 'text-green-700',
    label: 'Upcoming',
    priority: 1,
  },
};

// Report type icons and labels
export const reportTypeConfig: Record<
  ReportType,
  {
    label: string;
    icon: string;
    path: string;
  }
> = {
  sea_lice: { label: 'Sea Lice', icon: '🦠', path: 'sea-lice' },
  biomass: { label: 'Biomass', icon: '📊', path: 'biomass' },
  smolt: { label: 'Smolt', icon: '🐟', path: 'smolt' },
  cleaner_fish: { label: 'Cleaner Fish', icon: '🐠', path: 'cleaner-fish' },
  slaughter: { label: 'Slaughter', icon: '📦', path: 'slaughter' },
  welfare_event: { label: 'Welfare Event', icon: '⚠️', path: 'welfare' },
  disease_outbreak: { label: 'Disease', icon: '🏥', path: 'disease' },
  escape: { label: 'Escape', icon: '🚨', path: 'escape' },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate urgency based on days remaining
 */
export function getDeadlineUrgency(daysRemaining: number): DeadlineUrgency {
  if (daysRemaining < 0) return 'overdue';
  if (daysRemaining === 0) return 'today';
  if (daysRemaining <= 7) return 'this_week';
  return 'upcoming';
}

/**
 * Format days remaining as human-readable string
 */
export function formatDaysRemaining(daysRemaining: number): string {
  if (daysRemaining < 0) {
    const overdueDays = Math.abs(daysRemaining);
    return overdueDays === 1 ? '1 day overdue' : `${overdueDays} days overdue`;
  }
  if (daysRemaining === 0) return 'Due today';
  if (daysRemaining === 1) return 'Due tomorrow';
  if (daysRemaining <= 7) return `Due in ${daysRemaining} days`;
  return `Due in ${daysRemaining} days`;
}

/**
 * Sort deadlines by urgency and date
 */
export function sortDeadlines(deadlines: UpcomingDeadline[]): UpcomingDeadline[] {
  return [...deadlines].sort((a, b) => {
    // Overdue first, then by days remaining
    return a.daysRemaining - b.daysRemaining;
  });
}

/**
 * Filter deadlines by urgency
 */
export function filterDeadlines(
  deadlines: UpcomingDeadline[],
  urgencyFilter?: DeadlineUrgency[]
): UpcomingDeadline[] {
  if (!urgencyFilter?.length) return deadlines;

  return deadlines.filter((deadline) => {
    const urgency = getDeadlineUrgency(deadline.daysRemaining);
    return urgencyFilter.includes(urgency);
  });
}

/**
 * Count deadlines by urgency
 */
export function countByUrgency(
  deadlines: UpcomingDeadline[]
): Record<DeadlineUrgency, number> {
  const counts: Record<DeadlineUrgency, number> = {
    overdue: 0,
    today: 0,
    this_week: 0,
    upcoming: 0,
  };

  for (const deadline of deadlines) {
    const urgency = getDeadlineUrgency(deadline.daysRemaining);
    counts[urgency]++;
  }

  return counts;
}

/**
 * Format deadline date
 */
export function formatDeadlineDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

// ============================================================================
// Sub-Components
// ============================================================================

interface DeadlineIconProps {
  urgency: DeadlineUrgency;
  className?: string;
}

export const DeadlineIcon: React.FC<DeadlineIconProps> = ({ urgency, className = '' }) => {
  const config = urgencyConfig[urgency];

  return (
    <div
      className={`
        flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center
        ${config.bgColor} ${config.iconColor}
        ${className}
      `}
      data-testid={`deadline-icon-${urgency}`}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </div>
  );
};

interface DeadlineItemCardProps {
  deadline: UpcomingDeadline;
  onViewReport?: (deadline: UpcomingDeadline) => void;
  compact?: boolean;
}

export const DeadlineItemCard: React.FC<DeadlineItemCardProps> = ({
  deadline,
  onViewReport,
  compact = false,
}) => {
  const urgency = getDeadlineUrgency(deadline.daysRemaining);
  const config = urgencyConfig[urgency];
  const reportConfig = reportTypeConfig[deadline.reportType];

  const handleClick = () => {
    if (onViewReport) {
      onViewReport(deadline);
    }
  };

  return (
    <div
      className={`
        p-3 hover:bg-gray-50 transition-colors cursor-pointer border-l-4
        ${config.borderColor}
      `}
      onClick={handleClick}
      data-testid={`deadline-item-${deadline.id}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <div className="flex items-start space-x-3">
        <DeadlineIcon urgency={urgency} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-900 truncate">
              {reportConfig.icon} {deadline.reportName}
            </p>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${config.bgColor} ${config.textColor}`}>
              {config.label}
            </span>
          </div>

          <p className="text-sm text-gray-600 truncate">{deadline.siteName}</p>

          {!compact && (
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs text-gray-500">
                {deadline.weekNumber
                  ? `Week ${deadline.weekNumber}, ${deadline.year}`
                  : deadline.month
                  ? `${new Date(deadline.year, deadline.month - 1).toLocaleDateString('en-GB', { month: 'short' })} ${deadline.year}`
                  : deadline.year}
              </span>
              <span className={`text-xs font-medium ${config.textColor}`}>
                {formatDaysRemaining(deadline.daysRemaining)}
              </span>
            </div>
          )}

          {compact && (
            <span className={`text-xs font-medium ${config.textColor}`}>
              {formatDaysRemaining(deadline.daysRemaining)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

interface UrgencyFilterProps {
  selectedUrgencies: DeadlineUrgency[];
  onFilterChange: (urgencies: DeadlineUrgency[]) => void;
  deadlineCounts: Record<DeadlineUrgency, number>;
}

export const UrgencyFilter: React.FC<UrgencyFilterProps> = ({
  selectedUrgencies,
  onFilterChange,
  deadlineCounts,
}) => {
  const toggleUrgency = (urgency: DeadlineUrgency) => {
    if (selectedUrgencies.includes(urgency)) {
      onFilterChange(selectedUrgencies.filter((u) => u !== urgency));
    } else {
      onFilterChange([...selectedUrgencies, urgency]);
    }
  };

  return (
    <div className="flex flex-wrap gap-1" data-testid="urgency-filter">
      {(Object.keys(urgencyConfig) as DeadlineUrgency[]).map((urgency) => {
        const config = urgencyConfig[urgency];
        const isSelected = selectedUrgencies.length === 0 || selectedUrgencies.includes(urgency);
        const count = deadlineCounts[urgency];

        return (
          <button
            key={urgency}
            type="button"
            onClick={() => toggleUrgency(urgency)}
            className={`
              px-2 py-1 text-xs rounded-full transition-colors
              ${isSelected ? `${config.bgColor} ${config.iconColor}` : 'bg-gray-100 text-gray-500'}
              ${count === 0 ? 'opacity-50' : ''}
            `}
            data-testid={`filter-${urgency}`}
          >
            {config.label} ({count})
          </button>
        );
      })}
    </div>
  );
};

interface EmptyStateProps {
  message?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  message = 'No upcoming deadlines',
}) => (
  <div className="p-8 text-center" data-testid="empty-state">
    <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-3">
      <svg
        className="w-6 h-6 text-green-600"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M5 13l4 4L19 7"
        />
      </svg>
    </div>
    <p className="text-sm text-gray-500">{message}</p>
  </div>
);

interface LoadingStateProps {
  count?: number;
}

export const LoadingState: React.FC<LoadingStateProps> = ({ count = 3 }) => (
  <div className="p-4 space-y-3" data-testid="loading-state">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="animate-pulse flex space-x-3">
        <div className="w-8 h-8 bg-gray-200 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-gray-200 rounded w-3/4" />
          <div className="h-3 bg-gray-200 rounded w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry }) => (
  <div className="p-8 text-center" data-testid="error-state">
    <div className="mx-auto w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mb-3">
      <svg
        className="w-6 h-6 text-red-600"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </div>
    <p className="text-sm text-red-600 mb-2">{message}</p>
    {onRetry && (
      <button
        onClick={onRetry}
        className="text-sm text-blue-600 hover:text-blue-800 font-medium"
      >
        Retry
      </button>
    )}
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const DeadlineWidget: React.FC<DeadlineWidgetProps> = ({
  deadlines = [],
  isLoading = false,
  error = null,
  onViewReport,
  onViewAll,
  maxDeadlines = 5,
  showFilters = true,
  compact = false,
  className = '',
}) => {
  const [selectedUrgencies, setSelectedUrgencies] = useState<DeadlineUrgency[]>([]);

  // Filter and sort deadlines
  const processedDeadlines = useMemo(() => {
    let result = filterDeadlines(deadlines, selectedUrgencies);
    result = sortDeadlines(result);
    return result.slice(0, maxDeadlines);
  }, [deadlines, selectedUrgencies, maxDeadlines]);

  // Count by urgency for filter display
  const urgencyCounts = useMemo(() => countByUrgency(deadlines), [deadlines]);

  // Calculate summary stats
  const overdueCount = urgencyCounts.overdue;
  const todayCount = urgencyCounts.today;
  const thisWeekCount = urgencyCounts.this_week;
  const totalPending = deadlines.length;

  const handleFilterChange = useCallback((urgencies: DeadlineUrgency[]) => {
    setSelectedUrgencies(urgencies);
  }, []);

  return (
    <div
      className={`bg-white rounded-lg shadow border border-gray-200 ${className}`}
      data-testid="deadline-widget"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Report Deadlines</h3>
          <div className="flex items-center space-x-2">
            {overdueCount > 0 && (
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700"
                data-testid="overdue-count"
              >
                {overdueCount} Overdue
              </span>
            )}
            {todayCount > 0 && (
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700"
                data-testid="today-count"
              >
                {todayCount} Today
              </span>
            )}
            {overdueCount === 0 && todayCount === 0 && totalPending === 0 && (
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700"
                data-testid="all-clear"
              >
                All Clear
              </span>
            )}
          </div>
        </div>

        {/* Urgency Filters */}
        {showFilters && !isLoading && deadlines.length > 0 && (
          <div className="mt-2">
            <UrgencyFilter
              selectedUrgencies={selectedUrgencies}
              onFilterChange={handleFilterChange}
              deadlineCounts={urgencyCounts}
            />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} />
        ) : processedDeadlines.length === 0 ? (
          <EmptyState
            message={
              selectedUrgencies.length > 0
                ? 'No deadlines match selected filters'
                : 'No upcoming deadlines'
            }
          />
        ) : (
          processedDeadlines.map((deadline) => (
            <DeadlineItemCard
              key={deadline.id}
              deadline={deadline}
              onViewReport={onViewReport}
              compact={compact}
            />
          ))
        )}
      </div>

      {/* Footer */}
      {!isLoading && !error && deadlines.length > 0 && (
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              Total: {totalPending} pending ({overdueCount} overdue, {thisWeekCount} this
              week)
            </span>
            {onViewAll && (
              <button
                onClick={onViewAll}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                data-testid="view-all-btn"
              >
                View All Reports
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DeadlineWidget;
