/**
 * Leave Balance Widget Component
 * Displays employee's leave balance summary with visual indicators
 */

import React from 'react';
import { Calendar, Sun, Thermometer, Anchor, Clock } from 'lucide-react';
import { cn } from '@shared-ui/utils';
import { useLeaveBalanceSummary } from '../../hooks';
import { LeaveCategory, LEAVE_CATEGORY_CONFIG } from '../../types';

interface LeaveBalanceWidgetProps {
  employeeId: string;
  year?: number;
  className?: string;
  variant?: 'full' | 'compact';
}

const categoryIcons: Record<LeaveCategory, React.ReactNode> = {
  [LeaveCategory.ANNUAL]: <Sun className="h-4 w-4" />,
  [LeaveCategory.SICK]: <Thermometer className="h-4 w-4" />,
  [LeaveCategory.PARENTAL]: <Calendar className="h-4 w-4" />,
  [LeaveCategory.MATERNITY]: <Calendar className="h-4 w-4" />,
  [LeaveCategory.PATERNITY]: <Calendar className="h-4 w-4" />,
  [LeaveCategory.BEREAVEMENT]: <Calendar className="h-4 w-4" />,
  [LeaveCategory.UNPAID]: <Clock className="h-4 w-4" />,
  [LeaveCategory.COMPENSATORY]: <Calendar className="h-4 w-4" />,
  [LeaveCategory.SHORE_LEAVE]: <Anchor className="h-4 w-4" />,
  [LeaveCategory.ROTATION_BREAK]: <Anchor className="h-4 w-4" />,
  [LeaveCategory.EMERGENCY]: <Calendar className="h-4 w-4" />,
  [LeaveCategory.OTHER]: <Calendar className="h-4 w-4" />,
};

function BalanceBar({
  used,
  pending,
  entitled,
  color,
}: {
  used: number;
  pending: number;
  entitled: number;
  color: string;
}) {
  const usedPercent = entitled > 0 ? (used / entitled) * 100 : 0;
  const pendingPercent = entitled > 0 ? (pending / entitled) * 100 : 0;

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      <div className="flex h-full">
        <div
          className="transition-all"
          style={{
            width: `${usedPercent}%`,
            backgroundColor: color,
          }}
        />
        <div
          className="transition-all"
          style={{
            width: `${pendingPercent}%`,
            backgroundColor: color,
            opacity: 0.5,
          }}
        />
      </div>
    </div>
  );
}

export function LeaveBalanceWidget({
  employeeId,
  year = new Date().getFullYear(),
  className,
  variant = 'full',
}: LeaveBalanceWidgetProps) {
  const { data, isLoading, error } = useLeaveBalanceSummary(employeeId, year);

  if (isLoading) {
    return (
      <div className={cn('rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800', className)}>
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={cn('rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800', className)}>
        <p className="text-center text-sm text-gray-500">Failed to load leave balances</p>
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <div className={cn('rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800', className)}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Leave Balance</span>
          <span className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
            {data.totalAvailable}
            <span className="text-sm font-normal text-gray-500"> / {data.totalEntitled}</span>
          </span>
        </div>
        <BalanceBar
          used={data.totalUsed}
          pending={data.totalPending}
          entitled={data.totalEntitled}
          color="#6366f1"
        />
        <div className="mt-2 flex justify-between text-xs text-gray-500">
          <span>Used: {data.totalUsed}</span>
          <span>Pending: {data.totalPending}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800', className)}>
      <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-white">Leave Balance {year}</h3>
          <div className="text-right">
            <span className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
              {data.totalAvailable}
            </span>
            <span className="text-sm text-gray-500"> days available</span>
          </div>
        </div>
      </div>

      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {data.balances.map((balance) => (
          <div key={balance.leaveTypeId} className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${balance.leaveTypeColor}20` }}
                >
                  <span style={{ color: balance.leaveTypeColor }}>
                    {categoryIcons[LeaveCategory.ANNUAL]}
                  </span>
                </div>
                <span className="font-medium text-gray-900 dark:text-white">
                  {balance.leaveTypeName}
                </span>
              </div>
              <div className="text-right">
                <span className="font-semibold text-gray-900 dark:text-white">
                  {balance.available}
                </span>
                <span className="text-sm text-gray-500"> / {balance.entitled}</span>
              </div>
            </div>

            <div className="mt-2">
              <BalanceBar
                used={balance.used}
                pending={balance.pending}
                entitled={balance.entitled}
                color={balance.leaveTypeColor}
              />
            </div>

            <div className="mt-1 flex justify-between text-xs text-gray-500">
              <span>Used: {balance.used}</span>
              <span>Pending: {balance.pending}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default LeaveBalanceWidget;
