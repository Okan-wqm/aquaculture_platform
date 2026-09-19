/**
 * Report Status Badge Component
 * Displays the status of a regulatory report with appropriate styling
 */
import React from 'react';
import { ReportStatus } from '../../types/reports.types';
import { Check, CircleCheck, Clock, Pencil, TriangleAlert, X } from 'lucide-react';

interface ReportStatusBadgeProps {
  status: ReportStatus;
  size?: 'sm' | 'md' | 'lg';
  showIcon?: boolean;
}

const statusConfig: Record<
  ReportStatus,
  {
    label: string;
    bgColor: string;
    textColor: string;
    dotColor: string;
    icon?: React.ReactNode;
  }
> = {
  draft: {
    label: 'Draft',
    bgColor: 'bg-gray-100 dark:bg-gray-800',
    textColor: 'text-gray-700 dark:text-gray-300',
    dotColor: 'bg-gray-400',
    icon: <Pencil className="w-3.5 h-3.5" aria-hidden="true" />,
  },
  pending: {
    label: 'Pending',
    bgColor: 'bg-yellow-100',
    textColor: 'text-yellow-800',
    dotColor: 'bg-yellow-400',
    icon: <Clock className="w-3.5 h-3.5" aria-hidden="true" />,
  },
  submitted: {
    label: 'Submitted',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-800',
    dotColor: 'bg-blue-400',
    icon: <CircleCheck className="w-3.5 h-3.5" aria-hidden="true" />,
  },
  approved: {
    label: 'Approved',
    bgColor: 'bg-green-100',
    textColor: 'text-green-800',
    dotColor: 'bg-green-400',
    icon: <Check className="w-3.5 h-3.5" aria-hidden="true" />,
  },
  rejected: {
    label: 'Rejected',
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    dotColor: 'bg-red-400',
    icon: <X className="w-3.5 h-3.5" aria-hidden="true" />,
  },
  overdue: {
    label: 'Overdue',
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    dotColor: 'bg-red-500',
    icon: <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />,
  },
};

const sizeConfig = {
  sm: {
    padding: 'px-2 py-0.5',
    text: 'text-xs',
    dot: 'w-1.5 h-1.5',
    gap: 'gap-1',
  },
  md: {
    padding: 'px-2.5 py-1',
    text: 'text-sm',
    dot: 'w-2 h-2',
    gap: 'gap-1.5',
  },
  lg: {
    padding: 'px-3 py-1.5',
    text: 'text-base',
    dot: 'w-2.5 h-2.5',
    gap: 'gap-2',
  },
};

export const ReportStatusBadge: React.FC<ReportStatusBadgeProps> = ({
  status,
  size = 'md',
  showIcon = false,
}) => {
  const config = statusConfig[status];
  const sizes = sizeConfig[size];

  return (
    <span
      className={`
        inline-flex items-center ${sizes.gap} ${sizes.padding} ${sizes.text}
        font-medium rounded-full ${config.bgColor} ${config.textColor}
      `}
    >
      {showIcon && config.icon ? (
        config.icon
      ) : (
        <span className={`${sizes.dot} rounded-full ${config.dotColor}`} />
      )}
      {config.label}
    </span>
  );
};

export default ReportStatusBadge;
