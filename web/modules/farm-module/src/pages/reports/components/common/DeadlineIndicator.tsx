/**
 * Deadline Indicator Component
 * Shows deadline status with color-coded urgency levels
 */
import React, { useMemo } from 'react';
import { ReportStatus } from '../../types/reports.types';
import { getDaysUntilDeadline, isDeadlineOverdue, isDeadlineUrgent } from '../../utils/thresholds';

interface DeadlineIndicatorProps {
  deadline: Date;
  status: ReportStatus;
  reportType?: string;
  showDate?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /**
   * Server-computed days-until-deadline (Oslo calendar). When provided, the
   * indicator renders from this authoritative value instead of re-deriving the
   * deadline from the browser's local clock — the data-driven path used by the
   * Reports-due view (RPT-003). Negative = overdue.
   */
  daysUntilDue?: number;
  /** Server-computed overdue flag (Oslo calendar); pairs with daysUntilDue. */
  overdue?: boolean;
}

type UrgencyLevel = 'overdue' | 'today' | 'urgent' | 'soon' | 'normal' | 'submitted';

const urgencyConfig: Record<
  UrgencyLevel,
  {
    label: string;
    bgColor: string;
    textColor: string;
    borderColor: string;
    icon: React.ReactNode;
  }
> = {
  overdue: {
    label: 'Overdue',
    bgColor: 'bg-red-50',
    textColor: 'text-red-700',
    borderColor: 'border-red-200',
    icon: (
      <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
  },
  today: {
    label: 'Due today',
    bgColor: 'bg-orange-50',
    textColor: 'text-orange-700',
    borderColor: 'border-orange-200',
    icon: (
      <svg className="w-4 h-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  urgent: {
    label: 'Due soon',
    bgColor: 'bg-yellow-50',
    textColor: 'text-yellow-700',
    borderColor: 'border-yellow-200',
    icon: (
      <svg className="w-4 h-4 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  soon: {
    label: 'Coming up',
    bgColor: 'bg-blue-50',
    textColor: 'text-blue-700',
    borderColor: 'border-blue-200',
    icon: (
      <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  normal: {
    label: 'On track',
    bgColor: 'bg-green-50',
    textColor: 'text-green-700',
    borderColor: 'border-green-200',
    icon: (
      <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  submitted: {
    label: 'Submitted',
    bgColor: 'bg-gray-50',
    textColor: 'text-gray-600',
    borderColor: 'border-gray-200',
    icon: (
      <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
  },
};

const sizeConfig = {
  sm: {
    padding: 'px-2 py-1',
    text: 'text-xs',
    iconSize: 'w-3 h-3',
  },
  md: {
    padding: 'px-3 py-1.5',
    text: 'text-sm',
    iconSize: 'w-4 h-4',
  },
  lg: {
    padding: 'px-4 py-2',
    text: 'text-base',
    iconSize: 'w-5 h-5',
  },
};

function getUrgencyLevel(deadline: Date, status: ReportStatus): UrgencyLevel {
  // Already submitted/approved
  if (status === 'submitted' || status === 'approved') {
    return 'submitted';
  }

  // Explicitly overdue status
  if (status === 'overdue') {
    return 'overdue';
  }

  const daysUntil = getDaysUntilDeadline(deadline);

  if (isDeadlineOverdue(deadline)) {
    return 'overdue';
  }

  if (daysUntil === 0) {
    return 'today';
  }

  if (isDeadlineUrgent(deadline)) {
    return 'urgent';
  }

  if (daysUntil <= 7) {
    return 'soon';
  }

  return 'normal';
}

/**
 * Urgency from the server-authoritative days/overdue (Oslo calendar). The 0–3
 * day window mirrors the backend deadline buckets (DUE_SOON = 1, APPROACHING =
 * 2–3), so the chip and the outbox reminder agree.
 */
function getUrgencyFromServer(
  daysUntilDue: number,
  overdue: boolean,
  status: ReportStatus,
): UrgencyLevel {
  if (status === 'submitted' || status === 'approved') {
    return 'submitted';
  }
  if (overdue || daysUntilDue < 0) {
    return 'overdue';
  }
  if (daysUntilDue === 0) {
    return 'today';
  }
  if (daysUntilDue <= 3) {
    return 'urgent';
  }
  if (daysUntilDue <= 7) {
    return 'soon';
  }
  return 'normal';
}

function formatDaysRemaining(daysUntil: number): string {
  if (daysUntil < 0) {
    const daysOverdue = Math.abs(daysUntil);
    return daysOverdue === 1 ? '1 day overdue' : `${daysOverdue} days overdue`;
  }
  if (daysUntil === 0) {
    return 'Due today';
  }
  if (daysUntil === 1) {
    return 'Due tomorrow';
  }
  return `${daysUntil} days left`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const DeadlineIndicator: React.FC<DeadlineIndicatorProps> = ({
  deadline,
  status,
  showDate = true,
  size = 'md',
  daysUntilDue,
  overdue,
}) => {
  // Prefer the server-computed days/overdue (Oslo calendar) when supplied;
  // otherwise fall back to deriving from the deadline in the local clock.
  const serverDriven = daysUntilDue !== undefined;
  const urgency = useMemo(
    () =>
      serverDriven
        ? getUrgencyFromServer(daysUntilDue, overdue ?? daysUntilDue < 0, status)
        : getUrgencyLevel(deadline, status),
    [serverDriven, daysUntilDue, overdue, deadline, status],
  );
  const daysUntil = useMemo(
    () => (serverDriven ? daysUntilDue : getDaysUntilDeadline(deadline)),
    [serverDriven, daysUntilDue, deadline],
  );
  const config = urgencyConfig[urgency];
  const sizes = sizeConfig[size];

  // Don't show for submitted/approved reports
  if (urgency === 'submitted') {
    return (
      <div
        className={`
          inline-flex items-center gap-2 ${sizes.padding} ${sizes.text}
          rounded-md ${config.bgColor} ${config.textColor} border ${config.borderColor}
        `}
      >
        {config.icon}
        <span>{config.label}</span>
      </div>
    );
  }

  return (
    <div
      className={`
        inline-flex items-center gap-2 ${sizes.padding} ${sizes.text}
        rounded-md ${config.bgColor} ${config.textColor} border ${config.borderColor}
      `}
    >
      {config.icon}
      <div className="flex flex-col">
        <span className="font-medium">{formatDaysRemaining(daysUntil)}</span>
        {showDate && (
          <span className="text-xs opacity-75">{formatDate(deadline)}</span>
        )}
      </div>
    </div>
  );
};

export default DeadlineIndicator;
