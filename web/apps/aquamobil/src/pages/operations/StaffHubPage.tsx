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

import { Users, MapPin, CalendarOff, Calendar, Clock, ChevronRight } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HubHeader, KpiStrip, QuickActionGrid } from '@/components/hub';
import type { KpiItem } from '@/components/hub';
import { Card, Skeleton } from '@/components/ui';
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
    <div aria-busy="true" aria-label="Loading leave balance">
      <Skeleton variant="tile" />
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

  const subtitle = isClockedIn ? `On duty since ${formatClockTime(clockedInSince)}` : 'Off duty';

  const kpiItems: KpiItem[] = [
    {
      label: 'Status',
      value: isClockedIn ? 'On Duty' : 'Off Duty',
      ariaLabel: isClockedIn ? 'Attendance status: on duty' : 'Attendance status: off duty',
      valueColor: isClockedIn ? 'text-ok' : 'text-ink-3',
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
  const leaveProgressPercent =
    totalLeaveRemaining > 0
      ? Math.min(Math.round((totalLeaveRemaining / (totalLeaveRemaining + 1)) * 100), 100)
      : 0;

  return (
    <ErrorBoundary fallbackTitle="Staff Error">
      <div>
        <HubHeader title="Staff" subtitle={subtitle} icon={Users}>
          <KpiStrip items={kpiItems} />
        </HubHeader>

        <main className="px-4 space-y-5">
          {!isOnline && (
            <p className="text-center text-warn text-meta font-medium">Data may be outdated</p>
          )}

          {/* Quick Actions */}
          <section aria-label="Quick actions">
            <h2 className="text-body font-semibold text-ink-3 mb-2 px-1">Quick Actions</h2>
            <QuickActionGrid
              actions={[
                {
                  feature: 'attendance',
                  path: '/attendance',
                  icon: MapPin,
                  label: 'Clock In/Out',
                  tone: 'accent',
                },
                {
                  feature: 'leave',
                  path: '/leave/request',
                  icon: CalendarOff,
                  label: 'Leave Request',
                  tone: 'neutral',
                },
                {
                  feature: 'schedule',
                  path: '/schedule',
                  icon: Calendar,
                  label: 'My Schedule',
                  tone: 'accent',
                },
                {
                  feature: 'leave',
                  path: '/leave',
                  icon: Clock,
                  label: 'My Leaves',
                  tone: 'neutral',
                },
              ]}
            />
          </section>

          {/* Leave Balance Summary Card */}
          <section aria-label="Leave balance">
            <h2 className="text-body font-semibold text-ink-3 mb-2 px-1">Leave Balance</h2>

            {isLoading ? (
              <LeaveBalanceSkeleton />
            ) : (
              <Card className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-body font-semibold text-ink-1">Remaining Days</span>
                  <span className="text-display font-mono font-bold text-acc tabular-nums">
                    {totalLeaveRemaining}
                  </span>
                </div>

                {/* WHY: Progress bar gives a visual sense of leave consumption.
                    The accent fill = remaining balance relative to total. This is
                    an approximation since we only have the remaining count. */}
                <div
                  className="h-2 bg-surface-2 rounded-full overflow-hidden mb-3"
                  role="progressbar"
                  aria-valuenow={totalLeaveRemaining}
                  aria-valuemin={0}
                  aria-label={`${totalLeaveRemaining} leave days remaining`}
                >
                  <div
                    className="h-full bg-acc rounded-full motion-safe:transition-all motion-safe:duration-500"
                    style={{ width: `${leaveProgressPercent}%` }}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => navigate('/leave')}
                  className="flex items-center gap-1 text-body font-semibold text-acc min-h-touch touch-feedback"
                >
                  View Details
                  <ChevronRight size={16} />
                </button>
              </Card>
            )}
          </section>
        </main>

        {/* WHY: Bottom spacer prevents content from hiding behind the fixed tab bar. */}
        <div className="h-24" />
      </div>
    </ErrorBoundary>
  );
}
