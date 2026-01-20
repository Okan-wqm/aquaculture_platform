/**
 * Mock Data Helper Functions
 *
 * Common utilities for accessing and manipulating mock report data
 */

import { ReportType, ReportStatus, ReportBase } from '../types/reports.types';
import { mockSeaLiceReports } from './seaLiceData';
import { mockBiomassReports } from './biomassData';
import { mockSmoltReports } from './smoltData';
import { mockCleanerFishReports } from './cleanerFishData';
import {
  mockSlaughterReports,
  mockPlannedSlaughterReports,
  mockExecutedSlaughterReports,
} from './slaughterData';
import { mockWelfareEvents } from './welfareEventData';
import { mockDiseaseOutbreaks } from './diseaseOutbreakData';
import { mockEscapeReports } from './escapeReportData';

/**
 * Report type to data mapping
 */
const reportDataMap: Record<ReportType, ReportBase[]> = {
  'sea-lice': mockSeaLiceReports,
  'biomass': mockBiomassReports,
  'smolt': mockSmoltReports,
  'cleaner-fish': mockCleanerFishReports,
  'slaughter': mockSlaughterReports,
  'slaughter-planned': mockPlannedSlaughterReports,   // Mattilsynet API
  'slaughter-executed': mockExecutedSlaughterReports, // Mattilsynet API
  'welfare': mockWelfareEvents,
  'disease': mockDiseaseOutbreaks,
  'escape': mockEscapeReports,
};

/**
 * Filter interface for report queries
 */
export interface ReportFilter {
  status?: ReportStatus | ReportStatus[];
  siteId?: string;
  startDate?: Date;
  endDate?: Date;
  year?: number;
  month?: number;
  weekNumber?: number;
}

/**
 * Get all reports of a specific type
 */
export function getMockReports<T extends ReportBase>(
  reportType: ReportType,
  filter?: ReportFilter
): T[] {
  let reports = reportDataMap[reportType] as T[];

  if (!filter) {
    return reports;
  }

  // Filter by status
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    reports = reports.filter((r) => statuses.includes(r.status));
  }

  // Filter by site
  if (filter.siteId) {
    reports = reports.filter((r) => r.siteId === filter.siteId);
  }

  // Filter by date range (using createdAt)
  if (filter.startDate) {
    reports = reports.filter((r) => r.createdAt >= filter.startDate!);
  }
  if (filter.endDate) {
    reports = reports.filter((r) => r.createdAt <= filter.endDate!);
  }

  return reports;
}

/**
 * Get a single report by ID
 */
export function getMockReportById<T extends ReportBase>(
  reportType: ReportType,
  reportId: string
): T | undefined {
  const reports = reportDataMap[reportType] as T[];
  return reports.find((r) => r.id === reportId);
}

/**
 * Simulate report submission
 * Returns a promise that resolves after a short delay
 */
export function submitMockReport<T extends ReportBase>(
  reportType: ReportType,
  report: Partial<T>,
  userId: string = 'current-user'
): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const now = new Date();
      const updatedReport = {
        ...report,
        status: 'submitted' as ReportStatus,
        submittedAt: now,
        submittedBy: userId,
        updatedAt: now,
      } as T;

      // In a real app, this would update the mock data array
      // For now, just return the updated report
      resolve(updatedReport);
    }, 500); // Simulate network delay
  });
}

/**
 * Get reports with upcoming deadlines
 */
export function getReportsWithUpcomingDeadlines(
  daysAhead: number = 7
): { reportType: ReportType; report: ReportBase; daysUntilDeadline: number }[] {
  const now = new Date();
  const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const results: { reportType: ReportType; report: ReportBase; daysUntilDeadline: number }[] = [];

  (Object.keys(reportDataMap) as ReportType[]).forEach((reportType) => {
    const reports = reportDataMap[reportType];
    reports.forEach((report) => {
      if ('deadline' in report && report.deadline) {
        const deadline = report.deadline as Date;
        if (
          deadline >= now &&
          deadline <= cutoff &&
          (report.status === 'pending' || report.status === 'draft')
        ) {
          const daysUntilDeadline = Math.ceil(
            (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          );
          results.push({ reportType, report, daysUntilDeadline });
        }
      }
    });
  });

  // Sort by deadline (closest first)
  return results.sort((a, b) => a.daysUntilDeadline - b.daysUntilDeadline);
}

/**
 * Get overdue reports
 */
export function getOverdueReports(): { reportType: ReportType; report: ReportBase; daysOverdue: number }[] {
  const now = new Date();
  const results: { reportType: ReportType; report: ReportBase; daysOverdue: number }[] = [];

  (Object.keys(reportDataMap) as ReportType[]).forEach((reportType) => {
    const reports = reportDataMap[reportType];
    reports.forEach((report) => {
      if (report.status === 'overdue') {
        const deadline = 'deadline' in report ? (report.deadline as Date) : now;
        const daysOverdue = Math.ceil(
          (now.getTime() - deadline.getTime()) / (1000 * 60 * 60 * 24)
        );
        results.push({ reportType, report, daysOverdue: Math.max(0, daysOverdue) });
      }
    });
  });

  // Sort by most overdue first
  return results.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/**
 * Get report counts by status
 */
export function getReportCountsByStatus(siteId?: string): Record<ReportStatus, number> {
  const counts: Record<ReportStatus, number> = {
    draft: 0,
    pending: 0,
    submitted: 0,
    approved: 0,
    rejected: 0,
    overdue: 0,
  };

  (Object.keys(reportDataMap) as ReportType[]).forEach((reportType) => {
    let reports = reportDataMap[reportType];
    if (siteId) {
      reports = reports.filter((r) => r.siteId === siteId);
    }
    reports.forEach((report) => {
      counts[report.status]++;
    });
  });

  return counts;
}

/**
 * Get report counts by type
 */
export function getReportCountsByType(
  siteId?: string,
  statusFilter?: ReportStatus[]
): Record<ReportType, number> {
  const counts: Record<ReportType, number> = {
    'sea-lice': 0,
    'biomass': 0,
    'smolt': 0,
    'cleaner-fish': 0,
    'slaughter': 0,
    'slaughter-planned': 0,   // Mattilsynet API
    'slaughter-executed': 0,  // Mattilsynet API
    'welfare': 0,
    'disease': 0,
    'escape': 0,
  };

  (Object.keys(reportDataMap) as ReportType[]).forEach((reportType) => {
    let reports = reportDataMap[reportType];
    if (siteId) {
      reports = reports.filter((r) => r.siteId === siteId);
    }
    if (statusFilter && statusFilter.length > 0) {
      reports = reports.filter((r) => statusFilter.includes(r.status));
    }
    counts[reportType] = reports.length;
  });

  return counts;
}

/**
 * Get all pending/action-required reports
 */
export function getActionRequiredReports(siteId?: string): {
  reportType: ReportType;
  report: ReportBase;
  urgency: 'urgent' | 'high' | 'medium' | 'low';
}[] {
  const results: { reportType: ReportType; report: ReportBase; urgency: 'urgent' | 'high' | 'medium' | 'low' }[] = [];
  const now = new Date();

  (Object.keys(reportDataMap) as ReportType[]).forEach((reportType) => {
    let reports = reportDataMap[reportType];
    if (siteId) {
      reports = reports.filter((r) => r.siteId === siteId);
    }

    reports.forEach((report) => {
      if (report.status === 'pending' || report.status === 'draft' || report.status === 'overdue') {
        let urgency: 'urgent' | 'high' | 'medium' | 'low' = 'low';

        // Immediate reports are always urgent
        if (['welfare', 'disease', 'escape'].includes(reportType)) {
          urgency = 'urgent';
        } else if (report.status === 'overdue') {
          urgency = 'urgent';
        } else if ('deadline' in report && report.deadline) {
          const deadline = report.deadline as Date;
          const daysUntil = Math.ceil(
            (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          );
          if (daysUntil <= 1) {
            urgency = 'urgent';
          } else if (daysUntil <= 3) {
            urgency = 'high';
          } else if (daysUntil <= 7) {
            urgency = 'medium';
          }
        }

        results.push({ reportType, report, urgency });
      }
    });
  });

  // Sort by urgency
  const urgencyOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
  return results.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);
}

/**
 * Check if any report needs immediate attention (urgent)
 */
export function hasUrgentReports(siteId?: string): boolean {
  const actionRequired = getActionRequiredReports(siteId);
  return actionRequired.some((r) => r.urgency === 'urgent');
}

/**
 * Get summary statistics for dashboard
 */
export function getReportSummary(siteId?: string): {
  totalPending: number;
  totalOverdue: number;
  upcomingDeadlines: number;
  recentlySubmitted: number;
  urgentCount: number;
} {
  const counts = getReportCountsByStatus(siteId);
  const upcoming = getReportsWithUpcomingDeadlines(7);
  const actionRequired = getActionRequiredReports(siteId);

  // Count recently submitted (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let recentlySubmitted = 0;
  (Object.keys(reportDataMap) as ReportType[]).forEach((reportType) => {
    let reports = reportDataMap[reportType];
    if (siteId) {
      reports = reports.filter((r) => r.siteId === siteId);
    }
    reports.forEach((report) => {
      if (
        report.status === 'submitted' &&
        report.submittedAt &&
        report.submittedAt >= weekAgo
      ) {
        recentlySubmitted++;
      }
    });
  });

  return {
    totalPending: counts.pending + counts.draft,
    totalOverdue: counts.overdue,
    upcomingDeadlines: upcoming.filter((u) => !siteId || u.report.siteId === siteId).length,
    recentlySubmitted,
    urgentCount: actionRequired.filter((r) => r.urgency === 'urgent').length,
  };
}
