/**
 * StaffHubPage -- Enterprise staff hub with attendance status, leave balance,
 * schedule preview, and self-service actions.
 *
 * WHY a dedicated hub: Field workers need fast access to clock in/out, leave
 * requests, and schedule views. The previous approach buried these under the
 * flat Operations grid, requiring workers to remember which section contained
 * each action. This hub groups all HR self-service functions with at-a-glance
 * KPIs (duty status, leave balance, next shift), reducing daily navigation
 * from 4+ taps to 1.
 */

import {
  Users,
  MapPin,
  CalendarOff,
  Calendar,
  Clock,
  ChevronRight,
} from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HubHeader, KpiStrip, QuickActionGrid } from '@/components/hub';
import type { KpiItem } from '@/components/hub';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useStaffSummary } from '@/hooks/useStaffSummary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * WHY separate time formatter: Same pattern as DailyOpsHubPage. Extracts
 * HH:MM from an ISO string without a date library dependency.
 */
function formatClockTime(isoDate: string | null): string {
  if (!isoDate) return '';
  try {
    return new Date(isoDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * WHY short date format: "Mon, Mar 30" is universally readable and fits
 * within the KPI strip's limited width. Locale-aware formatting ensures
 * correct day/month ordering for international deployments.
 */
function formatShortDate(isoDate: string | null): string {
  if (!isoDate) return '\u2014'; // em-dash
  try {
    return new Date(isoDate).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '\u2014';
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Skeleton loading placeholder for the leave balance card. */
function LeaveBalanceSkeleton(): JSX.Element {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading leave balance">
      <div className="h-20 rounded-xl skeleton" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function StaffHubPage(): JSX.Element {
  const navigate = useNavigate();
  const { isOnline } = useOfflineQueue();
  const { summary, isLoading } = useStaffSummary();

  const isClockedIn = summary?.isClockedIn ?? false;
  const clockedInSince = summary?.clockedInSince ?? null;
  const totalLeaveRemaining = summary?.totalLeaveRemaining ?? 0;
  const nextShiftDate = summary?.nextShiftDate ?? null;

  const subtitle = isClockedIn
    ? `On duty since ${formatClockTime(clockedInSince)}`
    : 'Off duty';

  const kpiItems: KpiItem[] = [
    {
      label: 'Status',
      value: isClockedIn ? 'On Duty' : 'Off Duty',
      ariaLabel: isClockedIn ? 'Attendance status: on duty' : 'Attendance status: off duty',
      valueColor: isClockedIn ? 'text-green-300' : 'text-white/50',
      isLoading,
    },
    {
      label: 'Leave',
      value: `${totalLeaveRemaining}d`,
      ariaLabel: `${totalLeaveRemaining} leave days remaining`,
      isLoading,
    },
    {
      label: 'Next Shift',
      value: formatShortDate(nextShiftDate),
      ariaLabel: nextShiftDate
        ? `Next shift: ${formatShortDate(nextShiftDate)}`
        : 'No upcoming shift scheduled',
      isLoading,
    },
  ];

  // WHY: Schedule preview days is used to calculate the leave progress bar.
  // The denominator is the total annual entitlement, approximated by remaining + used.
  // Since we only have "remaining" from the summary, we show a simplified card.
  const leaveProgressPercent = totalLeaveRemaining > 0
    ? Math.min(Math.round((totalLeaveRemaining / (totalLeaveRemaining + 1)) * 100), 100)
    : 0;

  return (
    <ErrorBoundary fallbackTitle="Staff Error">
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <HubHeader
          title="Staff"
          subtitle={subtitle}
          icon={Users}
          gradient="from-indigo-700 via-indigo-600 to-indigo-500"
        >
          <KpiStrip items={kpiItems} />
        </HubHeader>

        <main className="px-5 pt-4 space-y-5">
          {!isOnline && (
            <p className="text-center text-amber-500 dark:text-amber-400 text-xs font-medium">
              Data may be outdated
            </p>
          )}

          {/* Quick Actions */}
          <section aria-label="Quick actions">
            <h2 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
              Quick Actions
            </h2>
            <QuickActionGrid
              actions={[
                {
                  feature: 'attendance',
                  path: '/attendance',
                  icon: MapPin,
                  label: 'Clock In/Out',
                  gradient: 'from-emerald-500 to-emerald-600',
                },
                {
                  feature: 'leave',
                  path: '/leave/request',
                  icon: CalendarOff,
                  label: 'Leave Request',
                  gradient: 'from-indigo-500 to-indigo-600',
                },
                {
                  feature: 'schedule',
                  path: '/schedule',
                  icon: Calendar,
                  label: 'My Schedule',
                  gradient: 'from-sky-500 to-sky-600',
                },
                {
                  feature: 'leave',
                  path: '/leave',
                  icon: Clock,
                  label: 'My Leaves',
                  gradient: 'from-violet-500 to-violet-600',
                },
              ]}
            />
          </section>

          {/* Leave Balance Summary Card */}
          <section aria-label="Leave balance">
            <h2 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
              Leave Balance
            </h2>

            {isLoading ? (
              <LeaveBalanceSkeleton />
            ) : (
              <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">
                    Remaining Days
                  </span>
                  <span className="text-2xl font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                    {totalLeaveRemaining}
                  </span>
                </div>

                {/* WHY: Progress bar gives a visual sense of leave consumption.
                    Green fill = remaining balance relative to total. This is an
                    approximation since we only have the remaining count. */}
                <div
                  className="h-2 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden mb-3"
                  role="progressbar"
                  aria-valuenow={totalLeaveRemaining}
                  aria-valuemin={0}
                  aria-label={`${totalLeaveRemaining} leave days remaining`}
                >
                  <div
                    className="h-full bg-indigo-500 rounded-full motion-safe:transition-all motion-safe:duration-500"
                    style={{ width: `${leaveProgressPercent}%` }}
                  />
                </div>

                <button
                  onClick={() => navigate('/leave')}
                  className="flex items-center gap-1 text-sm font-semibold text-indigo-600 dark:text-indigo-400 min-h-[44px]"
                >
                  View Details
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </section>
        </main>

        {/* WHY: Bottom spacer prevents content from hiding behind the fixed tab bar. */}
        <div className="h-24" />
      </div>
    </ErrorBoundary>
  );
}
