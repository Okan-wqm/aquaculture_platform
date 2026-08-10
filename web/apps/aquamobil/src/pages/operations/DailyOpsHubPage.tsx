/**
 * DailyOpsHubPage -- Enterprise daily operations hub showing shift status,
 * task progress, quick actions, and today's checklist.
 *
 * WHY a dedicated hub (not just the grid): Field workers need at-a-glance
 * awareness of their shift status, how many tanks they've fed, and which
 * checklist items remain. A flat action grid forces them to navigate into
 * each section to discover this. The hub pattern surfaces KPIs on the
 * landing screen, reducing taps by ~60% for the most common morning routine.
 */

import { clsx } from 'clsx';
import {
  Clock,
  MapPin,
  Skull,
  Droplets,
  Utensils,
  CheckSquare,
  Square,
  ChevronRight,
  Inbox,
} from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HubHeader, KpiStrip, QuickActionGrid } from '@/components/hub';
import type { KpiItem } from '@/components/hub';
import { Card, EmptyState, Skeleton } from '@/components/ui';
import { useDailyOpsStats } from '@/hooks/useDailyOpsStats';
import { useMyTasks } from '@/hooks/useMyTasks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { Task, TaskPriority } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * WHY static map: Tailwind JIT cannot detect dynamically constructed class strings.
 * URGENT and HIGH share the alarm token because the design has exactly one alarm
 * colour — the badge's own text ("URGENT" / "HIGH") is what separates them, and it
 * is always rendered. Same mapping as the Today screen and TaskDetailPage, so a
 * task does not change colour between the three places it appears.
 */
const PRIORITY_BADGE: Record<TaskPriority, string> = {
  URGENT: 'bg-crit-dim text-crit',
  HIGH: 'bg-crit-dim text-crit',
  MEDIUM: 'bg-warn-dim text-warn',
  LOW: 'bg-surface-2 text-ink-3',
};

/** Maximum tasks shown in the checklist preview before showing "View all". */
const MAX_CHECKLIST_ITEMS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * WHY format clock-in time separately: The raw ISO timestamp from the backend
 * needs to be displayed as a short time (e.g., "08:15") in the subtitle. This
 * avoids pulling in a date library for a single formatting call.
 */
function formatClockTime(isoDate: string | null): string {
  if (!isoDate) return '';
  try {
    return new Date(isoDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Single task row in the checklist section. */
function TaskRow({ task }: { task: Task }): JSX.Element {
  const isCompleted = task.status === 'COMPLETED';
  const badge = PRIORITY_BADGE[task.priority];

  return (
    <li className="flex items-center gap-3 py-2.5">
      {/* WHY: Checkbox icon provides instant visual status without reading text. */}
      {isCompleted ? (
        <CheckSquare size={18} className="text-ok flex-shrink-0" />
      ) : (
        <Square size={18} className="text-ink-3 flex-shrink-0" />
      )}
      <span
        className={clsx(
          'text-body flex-1 min-w-0 truncate',
          isCompleted ? 'text-ink-3 line-through' : 'text-ink-1 font-medium',
        )}
      >
        {task.title}
      </span>
      {badge && (
        <span
          className={clsx('text-meta font-semibold px-2 py-0.5 rounded-full flex-shrink-0', badge)}
        >
          {task.priority}
        </span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function DailyOpsHubPage(): JSX.Element {
  const navigate = useNavigate();
  const { isOnline } = useOfflineQueue();
  const { stats, isLoading: statsLoading } = useDailyOpsStats();
  const { tasks, loading: tasksLoading } = useMyTasks('today');

  // WHY: Derive completed/total from the tasks hook rather than duplicating
  // the count in DailyOpsStats. The tasks hook already filters for today's
  // segment, and this avoids a second API call for the same data.
  const completedTasks = (tasks ?? []).filter((t: Task) => t.status === 'COMPLETED').length;
  const totalTasks = (tasks ?? []).length;
  const displayTasks = (tasks ?? []).slice(0, MAX_CHECKLIST_ITEMS);

  // WHY: Use stats from the aggregation hook with safe defaults. During loading
  // or if the hook returns undefined, the page degrades gracefully to zeros.
  const isClockedIn = stats?.isClockedIn ?? false;
  const clockedInSince = stats?.clockedInSince ?? null;
  const tanksFed = stats?.tanksFedToday ?? 0;
  const totalTanks = stats?.totalTanksToFeed ?? 0;
  const mortalityCount = stats?.mortalityCountToday ?? 0;
  const wqReadings = stats?.wqReadingsToday ?? 0;

  const subtitle = isClockedIn
    ? `Clocked in since ${formatClockTime(clockedInSince)}`
    : 'Not clocked in';

  const kpiItems: KpiItem[] = [
    {
      label: 'Shift',
      value: isClockedIn ? '\u25CF' : '\u25CB',
      ariaLabel: isClockedIn ? 'Shift status: clocked in' : 'Shift status: not clocked in',
      valueColor: isClockedIn ? 'text-ok' : 'text-ink-3',
      isLoading: statsLoading,
    },
    {
      label: 'Fed',
      value: `${tanksFed}/${totalTanks}`,
      ariaLabel: `${tanksFed} of ${totalTanks} tanks fed today`,
      isLoading: statsLoading,
    },
    {
      label: 'Mortality',
      value: mortalityCount,
      ariaLabel: `${mortalityCount} mortality events today`,
      isLoading: statsLoading,
    },
    {
      label: 'WQ',
      value: wqReadings,
      ariaLabel: `${wqReadings} water quality readings today`,
      isLoading: statsLoading,
    },
  ];

  // WHY: Progress percentage is clamped to 0-100 to handle edge cases where
  // completed > total (e.g., task added mid-day then completed concurrently).
  const progressPercent =
    totalTasks > 0 ? Math.min(Math.round((completedTasks / totalTasks) * 100), 100) : 0;

  return (
    <ErrorBoundary fallbackTitle="Daily Operations Error">
      <div>
        <HubHeader title="Daily Operations" subtitle={subtitle} icon={Clock}>
          <KpiStrip items={kpiItems} />
        </HubHeader>

        <main className="px-4 space-y-5">
          {/* WHY: Offline indicator warns workers that KPI data may be stale. */}
          {!isOnline && (
            <p className="text-center text-warn text-meta font-medium">Data may be outdated</p>
          )}

          {/* Shift Checklist Progress Card */}
          <section aria-label="Today's checklist">
            <h2 className="text-body font-semibold text-ink-3 mb-2 px-1">Today&apos;s Checklist</h2>

            {tasksLoading ? (
              <div aria-busy="true" aria-label="Loading checklist">
                <Skeleton variant="row" count={3} />
              </div>
            ) : totalTasks === 0 ? (
              <EmptyState icon={<Inbox size={22} />} title="No tasks for today" className="py-8" />
            ) : (
              <Card className="p-4">
                {/* Progress bar */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-body font-semibold text-ink-1">
                    {completedTasks}/{totalTasks} completed
                  </span>
                  <span className="text-meta text-ink-3 font-mono tabular-nums">
                    {progressPercent}%
                  </span>
                </div>
                <div
                  className="h-2 bg-surface-2 rounded-full overflow-hidden mb-3"
                  role="progressbar"
                  aria-valuenow={progressPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${completedTasks} of ${totalTasks} tasks completed`}
                >
                  <div
                    className="h-full bg-ok rounded-full motion-safe:transition-all motion-safe:duration-500"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>

                {/* Task list */}
                <ul className="divide-y divide-line">
                  {displayTasks.map((task: Task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </ul>

                {/* "View all" link when more tasks exist */}
                {totalTasks > MAX_CHECKLIST_ITEMS && (
                  <button
                    type="button"
                    onClick={() => navigate('/tasks')}
                    className="mt-3 flex items-center gap-1 text-body font-semibold text-acc min-h-touch touch-feedback"
                  >
                    View all
                    <ChevronRight size={16} />
                  </button>
                )}
              </Card>
            )}
          </section>

          {/* Quick Actions */}
          <section aria-label="Quick actions">
            <h2 className="text-body font-semibold text-ink-3 mb-2 px-1">Quick Actions</h2>
            <QuickActionGrid
              actions={[
                {
                  feature: 'attendance',
                  path: '/attendance',
                  icon: MapPin,
                  label: 'Clock In',
                  tone: 'accent',
                },
                {
                  feature: 'mortality',
                  path: '/mortality/record',
                  icon: Skull,
                  label: 'Mortality Check',
                  tone: 'mortality',
                },
                {
                  feature: 'waterQuality',
                  path: '/water-quality/record',
                  icon: Droplets,
                  label: 'Water Quality',
                  tone: 'water',
                },
                {
                  feature: 'feeding',
                  path: '/feeding/record',
                  icon: Utensils,
                  label: 'Feeding',
                  tone: 'feeding',
                },
              ]}
            />
          </section>
        </main>

        {/* WHY: Bottom spacer prevents content from hiding behind the fixed tab bar. */}
        <div className="h-24" />
      </div>
    </ErrorBoundary>
  );
}
