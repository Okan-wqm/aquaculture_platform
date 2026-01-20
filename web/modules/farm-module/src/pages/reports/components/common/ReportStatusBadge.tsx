/**
 * Report Status Badge Component
 * Displays the status of a regulatory report with appropriate styling
 */
import React from 'react';
import { ReportStatus } from '../../types/reports.types';

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
    bgColor: 'bg-gray-100',
    textColor: 'text-gray-700',
    dotColor: 'bg-gray-400',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    ),
  },
  pending: {
    label: 'Pending',
    bgColor: 'bg-yellow-100',
    textColor: 'text-yellow-800',
    dotColor: 'bg-yellow-400',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  submitted: {
    label: 'Submitted',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-800',
    dotColor: 'bg-blue-400',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  approved: {
    label: 'Approved',
    bgColor: 'bg-green-100',
    textColor: 'text-green-800',
    dotColor: 'bg-green-400',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
  },
  rejected: {
    label: 'Rejected',
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    dotColor: 'bg-red-400',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
  },
  overdue: {
    label: 'Overdue',
    bgColor: 'bg-red-100',
    textColor: 'text-red-800',
    dotColor: 'bg-red-500',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
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
