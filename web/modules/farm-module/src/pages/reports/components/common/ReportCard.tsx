/**
 * Report Card Component
 * Displays a summary card for a regulatory report
 */
import React from 'react';
import { Button } from '@aquaculture/shared-ui';
import { ReportBase, ReportType } from '../../types/reports.types';
import { ReportStatusBadge } from './ReportStatusBadge';
import { DeadlineIndicator } from './DeadlineIndicator';
import {
  Box,
  Calendar,
  ChartColumn,
  CircleCheck,
  DollarSign,
  FlaskConical,
  Sparkles,
  TriangleAlert,
  Zap,
} from 'lucide-react';

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
    icon: <DollarSign className="w-5 h-5" aria-hidden="true" />,
  },
  biomass: {
    label: 'Biomass',
    icon: <ChartColumn className="w-5 h-5" aria-hidden="true" />,
  },
  smolt: {
    label: 'Smolt',
    icon: <Box className="w-5 h-5" aria-hidden="true" />,
  },
  'cleaner-fish': {
    label: 'Cleaner Fish',
    icon: <Sparkles className="w-5 h-5" aria-hidden="true" />,
  },
  slaughter: {
    label: 'Slaughter',
    icon: <Calendar className="w-5 h-5" aria-hidden="true" />,
  },
  'slaughter-planned': {
    label: 'Planned Slaughter',
    icon: <Calendar className="w-5 h-5" aria-hidden="true" />,
  },
  'slaughter-executed': {
    label: 'Executed Slaughter',
    icon: <CircleCheck className="w-5 h-5" aria-hidden="true" />,
  },
  welfare: {
    label: 'Welfare Event',
    icon: <TriangleAlert className="w-5 h-5" aria-hidden="true" />,
  },
  disease: {
    label: 'Disease Outbreak',
    icon: <FlaskConical className="w-5 h-5" aria-hidden="true" />,
  },
  escape: {
    label: 'Escape Report',
    icon: <Zap className="w-5 h-5" aria-hidden="true" />,
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
        bg-white dark:bg-gray-900 rounded-lg border shadow-sm hover:shadow-md transition-shadow
        ${isUrgent ? 'border-error-200 dark:border-error-800' : 'border-gray-200 dark:border-gray-700'}
        ${onClick ? 'cursor-pointer' : ''}
      `}
      onClick={onClick}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`${isUrgent ? 'text-error-500' : 'text-gray-500 dark:text-gray-400'}`}>
              {typeConfig.icon}
            </span>
            <span className="font-medium text-gray-900 dark:text-gray-100">{typeConfig.label}</span>
            {isUrgent && (
              <span className="px-1.5 py-0.5 text-xs font-medium text-error-700 dark:text-error-300 bg-error-100 dark:bg-error-900/40 rounded">
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
            <span className="text-gray-500 dark:text-gray-400 w-20">Site:</span>
            <span className="text-gray-900 dark:text-gray-100 font-medium">{report.siteName}</span>
          </div>

          {/* Created */}
          <div className="flex items-center text-sm">
            <span className="text-gray-500 dark:text-gray-400 w-20">Created:</span>
            <span className="text-gray-700 dark:text-gray-300">{formatDate(report.createdAt)}</span>
          </div>

          {/* Submitted (if applicable) */}
          {report.submittedAt && (
            <div className="flex items-center text-sm">
              <span className="text-gray-500 dark:text-gray-400 w-20">Submitted:</span>
              <span className="text-gray-700 dark:text-gray-300">
                {formatDate(report.submittedAt)}
              </span>
              {report.submittedBy && (
                <span className="text-gray-400 dark:text-gray-500 ml-1">
                  by {report.submittedBy}
                </span>
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
        <div className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-t border-gray-100 dark:border-gray-700 rounded-b-lg">
          <div className="flex items-center justify-end gap-2">
            {onView && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onView();
                }}
              >
                View
              </Button>
            )}
            {canEdit && onEdit && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                Edit
              </Button>
            )}
            {canSubmit && onSubmit && (
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSubmit();
                }}
              >
                Submit
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReportCard;
