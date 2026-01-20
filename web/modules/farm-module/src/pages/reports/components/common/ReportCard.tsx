/**
 * Report Card Component
 * Displays a summary card for a regulatory report
 */
import React from 'react';
import { ReportBase, ReportType } from '../../types/reports.types';
import { ReportStatusBadge } from './ReportStatusBadge';
import { DeadlineIndicator } from './DeadlineIndicator';

interface ReportCardProps {
  report: ReportBase & { deadline?: Date };
  reportType: ReportType;
  onClick?: () => void;
  onEdit?: () => void;
  onSubmit?: () => void;
  onView?: () => void;
  showActions?: boolean;
}

const reportTypeLabels: Record<ReportType, { label: string; icon: React.ReactNode }> = {
  'sea-lice': {
    label: 'Sea Lice',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  biomass: {
    label: 'Biomass',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  smolt: {
    label: 'Smolt',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" />
      </svg>
    ),
  },
  'cleaner-fish': {
    label: 'Cleaner Fish',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
      </svg>
    ),
  },
  slaughter: {
    label: 'Slaughter',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  welfare: {
    label: 'Welfare Event',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
  },
  disease: {
    label: 'Disease Outbreak',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
      </svg>
    ),
  },
  escape: {
    label: 'Escape Report',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
};

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const ReportCard: React.FC<ReportCardProps> = ({
  report,
  reportType,
  onClick,
  onEdit,
  onSubmit,
  onView,
  showActions = true,
}) => {
  const typeConfig = reportTypeLabels[reportType];
  const isUrgent = ['welfare', 'disease', 'escape'].includes(reportType);
  const canSubmit = report.status === 'draft' || report.status === 'pending';
  const canEdit = report.status === 'draft' || report.status === 'pending';

  return (
    <div
      className={`
        bg-white rounded-lg border shadow-sm hover:shadow-md transition-shadow
        ${isUrgent ? 'border-red-200' : 'border-gray-200'}
        ${onClick ? 'cursor-pointer' : ''}
      `}
      onClick={onClick}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`${isUrgent ? 'text-red-500' : 'text-gray-500'}`}>
              {typeConfig.icon}
            </span>
            <span className="font-medium text-gray-900">{typeConfig.label}</span>
            {isUrgent && (
              <span className="px-1.5 py-0.5 text-xs font-medium text-red-700 bg-red-100 rounded">
                URGENT
              </span>
            )}
          </div>
          <ReportStatusBadge status={report.status} size="sm" />
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3">
        <div className="space-y-2">
          {/* Site */}
          <div className="flex items-center text-sm">
            <span className="text-gray-500 w-20">Site:</span>
            <span className="text-gray-900 font-medium">{report.siteName}</span>
          </div>

          {/* Created */}
          <div className="flex items-center text-sm">
            <span className="text-gray-500 w-20">Created:</span>
            <span className="text-gray-700">{formatDate(report.createdAt)}</span>
          </div>

          {/* Submitted (if applicable) */}
          {report.submittedAt && (
            <div className="flex items-center text-sm">
              <span className="text-gray-500 w-20">Submitted:</span>
              <span className="text-gray-700">{formatDate(report.submittedAt)}</span>
              {report.submittedBy && (
                <span className="text-gray-400 ml-1">by {report.submittedBy}</span>
              )}
            </div>
          )}

          {/* Deadline */}
          {report.deadline && (
            <div className="flex items-center text-sm mt-2">
              <DeadlineIndicator
                deadline={report.deadline}
                status={report.status}
                size="sm"
                showDate={false}
              />
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      {showActions && (
        <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 rounded-b-lg">
          <div className="flex items-center justify-end gap-2">
            {onView && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onView();
                }}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                View
              </button>
            )}
            {canEdit && onEdit && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Edit
              </button>
            )}
            {canSubmit && onSubmit && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSubmit();
                }}
                className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Submit
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReportCard;
