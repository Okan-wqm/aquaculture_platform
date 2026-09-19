/**
 * Deadline Indicator Component
 * Shows deadline status with color-coded urgency levels
 */
import React, { useMemo } from 'react';
import { ReportStatus } from '../../types/reports.types';
import { getDaysUntilDeadline, isDeadlineOverdue, isDeadlineUrgent } from '../../utils/thresholds';
import { Calendar, Check, CircleAlert, CircleCheck, Clock, TriangleAlert } from 'lucide-react';

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
    bgColor: 'bg-error-50 dark:bg-error-900/20',
    textColor: 'text-error-700 dark:text-error-300',
    borderColor: 'border-error-200 dark:border-error-800',
    icon: <TriangleAlert className="w-4 h-4 text-error-500" aria-hidden="true" />,
  },
  today: {
    label: 'Due today',
    bgColor: 'bg-warning-50 dark:bg-warning-900/20',
    textColor: 'text-warning-700 dark:text-warning-300',
    borderColor: 'border-warning-200 dark:border-warning-800',
    icon: <Clock className="w-4 h-4 text-warning-500" aria-hidden="true" />,
  },
  urgent: {
    label: 'Due soon',
    bgColor: 'bg-warning-50 dark:bg-warning-900/20',
    textColor: 'text-warning-700 dark:text-warning-300',
    borderColor: 'border-warning-200 dark:border-warning-800',
    icon: <CircleAlert className="w-4 h-4 text-warning-500" aria-hidden="true" />,
  },
  soon: {
    label: 'Coming up',
    bgColor: 'bg-info-50 dark:bg-info-900/20',
    textColor: 'text-info-700 dark:text-info-300',
    borderColor: 'border-info-200 dark:border-info-800',
    icon: <Calendar className="w-4 h-4 text-info-500" aria-hidden="true" />,
  },
  normal: {
    label: 'On track',
    bgColor: 'bg-success-50 dark:bg-success-900/20',
    textColor: 'text-success-700 dark:text-success-300',
    borderColor: 'border-success-200 dark:border-success-800',
    icon: <CircleCheck className="w-4 h-4 text-success-500" aria-hidden="true" />,
  },
  submitted: {
    label: 'Submitted',
    bgColor: 'bg-gray-50 dark:bg-gray-800',
    textColor: 'text-gray-600 dark:text-gray-400',
    borderColor: 'border-gray-200 dark:border-gray-700',
    icon: <Check className="w-4 h-4 text-gray-500 dark:text-gray-400" aria-hidden="true" />,
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
        {showDate && <span className="text-xs opacity-75">{formatDate(deadline)}</span>}
      </div>
    </div>
  );
};

export default DeadlineIndicator;
