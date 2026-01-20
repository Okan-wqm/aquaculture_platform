/**
 * useDeadlines Hook
 * Manages deadline calculations and tracking for regulatory reports
 *
 * Provides:
 * - Calculate next deadline for a report type
 * - Track upcoming deadlines across all report types
 * - Overdue report detection
 * - Urgency classification
 */
import { useMemo, useCallback } from 'react';
import { ReportType, ReportBase } from '../types/reports.types';
import {
  getReportsWithUpcomingDeadlines,
  getOverdueReports,
  getReportSummary,
} from '../mock/helpers';
import {
  getNextDeadline,
  getDaysUntilDeadline,
  isDeadlineOverdue,
  isDeadlineUrgent,
  REPORTING_DEADLINES,
} from '../utils/thresholds';

// ============================================================================
// Types
// ============================================================================

export type DeadlineUrgency = 'overdue' | 'today' | 'urgent' | 'soon' | 'normal';

export interface DeadlineInfo {
  reportType: ReportType;
  deadline: Date;
  daysRemaining: number;
  urgency: DeadlineUrgency;
  description: string;
  isRecurring: boolean;
}

export interface UpcomingDeadline {
  reportType: ReportType;
  report: ReportBase;
  deadline: Date;
  daysRemaining: number;
  urgency: DeadlineUrgency;
}

export interface UseDeadlinesOptions {
  /** Site ID to filter by */
  siteId?: string;
  /** Number of days ahead to look for deadlines (default: 14) */
  lookAheadDays?: number;
}

export interface UseDeadlinesReturn {
  /** All upcoming deadlines */
  upcomingDeadlines: UpcomingDeadline[];
  /** Overdue reports */
  overdueReports: { reportType: ReportType; report: ReportBase; daysOverdue: number }[];
  /** Get next deadline for a specific report type */
  getNextDeadlineForType: (reportType: ReportType) => DeadlineInfo;
  /** Get urgency level for a date */
  getUrgency: (deadline: Date) => DeadlineUrgency;
  /** Format deadline for display */
  formatDeadline: (deadline: Date) => string;
  /** Summary statistics */
  summary: {
    totalPending: number;
    totalOverdue: number;
    urgentCount: number;
    upcomingCount: number;
  };
  /** Check if any reports need immediate attention */
  hasUrgentDeadlines: boolean;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useDeadlines(options: UseDeadlinesOptions = {}): UseDeadlinesReturn {
  const { siteId, lookAheadDays = 14 } = options;

  /**
   * Get urgency level for a deadline
   */
  const getUrgency = useCallback((deadline: Date): DeadlineUrgency => {
    const days = getDaysUntilDeadline(deadline);

    if (days < 0) return 'overdue';
    if (days === 0) return 'today';
    if (days <= 3) return 'urgent';
    if (days <= 7) return 'soon';
    return 'normal';
  }, []);

  /**
   * Get upcoming deadlines with urgency
   */
  const upcomingDeadlines = useMemo((): UpcomingDeadline[] => {
    const raw = getReportsWithUpcomingDeadlines(lookAheadDays);

    return raw
      .filter((item) => !siteId || item.report.siteId === siteId)
      .map((item) => {
        const deadline = 'deadline' in item.report ? (item.report.deadline as Date) : new Date();
        return {
          reportType: item.reportType,
          report: item.report,
          deadline,
          daysRemaining: item.daysUntilDeadline,
          urgency: getUrgency(deadline),
        };
      });
  }, [lookAheadDays, siteId, getUrgency]);

  /**
   * Get overdue reports
   */
  const overdueReports = useMemo(() => {
    const raw = getOverdueReports();
    return raw.filter((item) => !siteId || item.report.siteId === siteId);
  }, [siteId]);

  /**
   * Get next deadline for a specific report type
   */
  const getNextDeadlineForType = useCallback(
    (reportType: ReportType): DeadlineInfo => {
      const deadline = getNextDeadline(reportType.toUpperCase() as keyof typeof REPORTING_DEADLINES);
      const days = getDaysUntilDeadline(deadline);
      const config = REPORTING_DEADLINES[reportType.toUpperCase() as keyof typeof REPORTING_DEADLINES];

      return {
        reportType,
        deadline,
        daysRemaining: days,
        urgency: getUrgency(deadline),
        description: config?.description || '',
        isRecurring: config?.frequency !== 'immediate' && config?.frequency !== 'event-based',
      };
    },
    [getUrgency]
  );

  /**
   * Format deadline for display
   */
  const formatDeadline = useCallback((deadline: Date): string => {
    const days = getDaysUntilDeadline(deadline);

    if (days < 0) {
      return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
    }
    if (days === 0) {
      return 'Due today';
    }
    if (days === 1) {
      return 'Due tomorrow';
    }
    if (days <= 7) {
      return `Due in ${days} days`;
    }

    return deadline.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    });
  }, []);

  /**
   * Get summary statistics
   */
  const summary = useMemo(() => {
    const rawSummary = getReportSummary(siteId);
    return {
      totalPending: rawSummary.totalPending,
      totalOverdue: rawSummary.totalOverdue,
      urgentCount: rawSummary.urgentCount,
      upcomingCount: rawSummary.upcomingDeadlines,
    };
  }, [siteId]);

  /**
   * Check if any reports need immediate attention
   */
  const hasUrgentDeadlines = useMemo(() => {
    return (
      overdueReports.length > 0 ||
      upcomingDeadlines.some((d) => d.urgency === 'today' || d.urgency === 'urgent')
    );
  }, [overdueReports, upcomingDeadlines]);

  return {
    upcomingDeadlines,
    overdueReports,
    getNextDeadlineForType,
    getUrgency,
    formatDeadline,
    summary,
    hasUrgentDeadlines,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get color classes for urgency level
 */
export function getUrgencyColorClasses(urgency: DeadlineUrgency): {
  bg: string;
  border: string;
  text: string;
  badge: string;
} {
  const colors = {
    overdue: {
      bg: 'bg-red-50',
      border: 'border-red-200',
      text: 'text-red-700',
      badge: 'bg-red-100 text-red-800',
    },
    today: {
      bg: 'bg-orange-50',
      border: 'border-orange-200',
      text: 'text-orange-700',
      badge: 'bg-orange-100 text-orange-800',
    },
    urgent: {
      bg: 'bg-yellow-50',
      border: 'border-yellow-200',
      text: 'text-yellow-700',
      badge: 'bg-yellow-100 text-yellow-800',
    },
    soon: {
      bg: 'bg-blue-50',
      border: 'border-blue-200',
      text: 'text-blue-700',
      badge: 'bg-blue-100 text-blue-800',
    },
    normal: {
      bg: 'bg-green-50',
      border: 'border-green-200',
      text: 'text-green-700',
      badge: 'bg-green-100 text-green-800',
    },
  };

  return colors[urgency];
}

/**
 * Get urgency label
 */
export function getUrgencyLabel(urgency: DeadlineUrgency): string {
  const labels = {
    overdue: 'Overdue',
    today: 'Due Today',
    urgent: 'Urgent',
    soon: 'Due Soon',
    normal: 'Upcoming',
  };
  return labels[urgency];
}

export default useDeadlines;
