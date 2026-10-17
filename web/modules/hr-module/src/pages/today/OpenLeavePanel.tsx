/**
 * "Open leave today": teamLeaveCalendar(today, today) — hr-service returns
 * APPROVED and PENDING requests overlapping the range — so this is everyone
 * whose leave covers today, decided or still awaiting a decision. Pending ones
 * link to the leave requests page, where approval lives.
 */
import React, { useId } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, useI18n, type MessageKey } from '@aquaculture/shared-ui';

import { LeaveRequestStatus, type LeaveCalendarEntry } from '../../types';
import { PanelBody } from './PanelBody';
import { formatCalendarDay, formatCount } from './todayFormat';

const STATUS_LABEL: Record<LeaveRequestStatus, MessageKey> = {
  [LeaveRequestStatus.DRAFT]: 'hr.today.leave.status.DRAFT',
  [LeaveRequestStatus.PENDING]: 'hr.today.leave.status.PENDING',
  [LeaveRequestStatus.APPROVED]: 'hr.today.leave.status.APPROVED',
  [LeaveRequestStatus.REJECTED]: 'hr.today.leave.status.REJECTED',
  [LeaveRequestStatus.CANCELLED]: 'hr.today.leave.status.CANCELLED',
  [LeaveRequestStatus.WITHDRAWN]: 'hr.today.leave.status.WITHDRAWN',
};

export interface OpenLeavePanelProps {
  entries: readonly LeaveCalendarEntry[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function OpenLeavePanel({
  entries,
  isLoading,
  isError,
  onRetry,
}: OpenLeavePanelProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId}>
      <Card
        padding="none"
        title={<span id={headingId}>{t('hr.today.leave.title')}</span>}
        headerAction={
          <Link
            to="/hr/leaves"
            className="text-sm font-medium text-primary-700 hover:underline dark:text-primary-300"
          >
            {t('hr.today.leave.review')}
          </Link>
        }
      >
        <PanelBody
          isLoading={isLoading}
          isError={isError}
          onRetry={onRetry}
          isEmpty={entries.length === 0}
          emptyTitle={t('hr.today.leave.empty')}
        >
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-gray-900 dark:text-gray-100">
                    {entry.employeeName}
                  </div>
                  <div className="text-sm text-gray-700 dark:text-gray-300">
                    {entry.leaveTypeName}
                  </div>
                </div>
                <div className="text-sm tabular-nums text-gray-700 dark:text-gray-300">
                  {formatCalendarDay(entry.startDate, locale)}–
                  {formatCalendarDay(entry.endDate, locale)}
                  {' · '}
                  {entry.totalDays === 1
                    ? t('hr.today.leave.oneDay')
                    : t('hr.today.leave.days', { count: formatCount(entry.totalDays, locale) })}
                </div>
                <Badge
                  size="sm"
                  variant={entry.status === LeaveRequestStatus.PENDING ? 'warning' : 'default'}
                >
                  {t(STATUS_LABEL[entry.status])}
                </Badge>
              </li>
            ))}
          </ul>
        </PanelBody>
      </Card>
    </section>
  );
}
