/**
 * AttentionPane — the board's left column: what is alarming, then what is planned.
 *
 * It is the phone's Today screen minus the doing. Same two hooks (useAlerts,
 * useMyTasks('today')), same ListRow, same tones — because the cabin board and
 * the handheld in a worker's pocket must rank the same alarm the same way, and a
 * second implementation of "what needs me right now?" is a second thing to keep
 * true.
 *
 * WHY THERE IS NO ACKNOWLEDGE BUTTON HERE. Acknowledging an alarm is a claim
 * that somebody has looked at the pen. The board is on a wall in the cabin,
 * often signed in as a shared site account, and anyone walking past could clear
 * an oxygen alarm without going outside. So this pane READS: it shows the alarm,
 * names the unit when it can, and says in the list itself that the acknowledge
 * happens on the handheld at the pen. The full alarm surface with the
 * acknowledge action is one tap away in the top bar's alarms chip (/alerts) —
 * this pane removes an action, it does not hide a route.
 *
 * The same reasoning applies to tasks: no start/complete control. A task is
 * finished where the work is.
 *
 * WHAT A TAP DOES DO. An alarm that names a unit the board has loaded SELECTS
 * that unit, filling the detail column on the right. The board owns that
 * callback (`onSelectUnit`), so this pane never navigates and the board never
 * disappears out from under the person watching it.
 *
 * WHAT IS DELIBERATELY ABSENT, because the mobile client has no query for it:
 *   • a task → unit link. `myTasks` returns a free-text `location` and no unit
 *     id (src/graphql/operations.ts, GET_MY_TASKS), so a task row cannot fill
 *     the detail pane. Matching that string against unit names would be a guess
 *     rendered as a fact, which is the one thing this app must not do.
 *   • a site/system filter on either list. There is no site filter in the API
 *     this client speaks; the board shows the tenant, and the top bar says so.
 */
import { AlertTriangle, Bell, Circle, ListChecks } from 'lucide-react';
import { useId, useMemo, type ReactElement, type ReactNode } from 'react';

import { DataState, EmptyState, ListRow } from '@/components/ui';
import { useAlerts, type MobileAlert } from '@/hooks/useAlerts';
import { useMyTasks } from '@/hooks/useMyTasks';
import { useTanks } from '@/hooks/useTanks';
import type { Tank, Task } from '@/types';
import { alertSeverityTone, taskPriorityTone } from '@/utils/attention-tone';
import { useFeatureAccess } from '@/utils/feature-access';
import { toLoadable, type Loadable } from '@/utils/loadable';

export interface AttentionPaneProps {
  /**
   * Select the unit an alarm is raised on. Passing it makes an alarm row that
   * resolves to a loaded unit tappable; omitting it leaves the whole pane
   * read-only. The BOARD owns this, so selection stays a board concern and this
   * pane has no opinion about where the detail is shown.
   */
  onSelectUnit?: (unitId: string) => void;
}

/**
 * "07:12" from an ISO stamp, in the device's own zone.
 *
 * Absolute rather than relative ("18m ago") because the board carries a wall
 * clock in its top bar — an absolute stamp is directly comparable to it, and it
 * does not go stale on a display nobody has touched for an hour. It matches the
 * phone's Today rows, so the same alarm reads the same on both surfaces.
 */
function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AttentionPane({ onSelectUnit }: AttentionPaneProps): ReactElement {
  // Every figure below comes from a hook the phone already owns; this pane
  // writes no query. useAlerts() is called with NO options on purpose — the
  // same arguments the shell's top bar uses, so React Query serves the chip and
  // this list from one cache entry and one request rather than two.
  const {
    alerts,
    isLoading: alertsLoading,
    error: alertsError,
    refetch: refetchAlerts,
  } = useAlerts();
  const {
    tasks,
    loading: tasksLoading,
    error: tasksError,
    refetch: refetchTasks,
  } = useMyTasks('today');
  const { canReach } = useFeatureAccess();

  // The unit list is read ONLY to name the unit an alarm sits on and to decide
  // whether that alarm can select one. Same query key as the shell's useTanks(),
  // so this costs nothing on the wire.
  const units = toLoadable(useTanks());
  const loadedUnits = units.status === 'ready' ? units.data : undefined;
  const unitsById = useMemo(() => {
    const index = new Map<string, Tank>();
    for (const unit of loadedUnits ?? []) index.set(unit.id, unit);
    return index;
  }, [loadedUnits]);

  // Unacknowledged only. Acknowledged alarms are history and live on /alerts;
  // a watching surface should show what is still open, not what was handled.
  const openAlarms = useMemo(() => alerts.filter((alert) => !alert.acknowledged), [alerts]);

  // WHY Loadable rather than reading the arrays directly: both hooks hand back
  // `[]` on failure, and "no open alarms" rendered by a board that could not
  // reach the alert engine is an all-clear nobody checked. toLoadable() checks
  // the error arm FIRST, and <DataState/> cannot reach its children during one
  // (src/utils/loadable.ts — the defect this app has found seven times).
  const alarmsView = toLoadable<MobileAlert[]>({
    data: openAlarms,
    isLoading: alertsLoading,
    isError: alertsError !== null,
    error: alertsError !== null ? new Error(alertsError) : undefined,
    refetch: refetchAlerts,
  });

  const tasksView = toLoadable<Task[]>({
    data: tasks,
    isLoading: tasksLoading,
    isError: tasksError !== null,
    error: tasksError !== null ? new Error(tasksError) : undefined,
    refetch: refetchTasks,
  });

  return (
    <>
      <PaneSection title="Alarms" meta={openCountMeta(alarmsView)}>
        <DataState
          value={alarmsView}
          label="alarms"
          skeleton="row"
          skeletonCount={3}
          empty={
            <EmptyState
              icon={<Bell size={22} />}
              title="No open alarms"
              description="Nothing needs acknowledging right now."
              className="py-6"
            />
          }
        >
          {(rows) => (
            <>
              {rows.map((alert) => {
                // Only a pondId that matches a unit THIS BOARD HAS LOADED can be
                // selected. An alarm from the sensor lane may carry a pond the
                // inventory query never returned; making that row tappable would
                // hand the detail column an id it cannot resolve, so the row
                // stays a readout instead. It also means the unit name below is
                // never a guess — if it is shown, the board holds that unit.
                const unit = alert.pondId != null ? (unitsById.get(alert.pondId) ?? null) : null;
                return (
                  <ListRow
                    key={alert.id}
                    tone={alertSeverityTone(alert.severity)}
                    leading={<AlertTriangle size={18} />}
                    title={alert.ruleName}
                    subtitle={unit ? `${unit.name} · ${alert.message}` : alert.message}
                    trailing={<span className="font-mono">{clockOf(alert.triggeredAt)}</span>}
                    onClick={unit && onSelectUnit ? () => onSelectUnit(unit.id) : undefined}
                  />
                );
              })}
              <PaneNote>Acknowledge on the handheld, standing at the pen.</PaneNote>
            </>
          )}
        </DataState>
      </PaneSection>

      {/* PERMISSIONS: the same gate the phone uses. `/tasks` and `/tasks/:id`
          are wrapped in <FeatureRoute feature="tasks"> in App.tsx and Today
          hides its task section the same way, so the board cannot surface a
          list a role cannot reach on the handheld. canReach() is the SSoT
          (entitlement AND role floor) — see src/utils/feature-access.ts. */}
      {canReach('tasks') && (
        <PaneSection title="Tasks" meta={openCountMeta(tasksView)}>
          <DataState
            value={tasksView}
            label="today's tasks"
            skeleton="row"
            skeletonCount={3}
            empty={
              <EmptyState
                icon={<ListChecks size={22} />}
                title="Nothing scheduled"
                description="No tasks are assigned to this account for today."
                className="py-6"
              />
            }
          >
            {(rows) => (
              <>
                {rows.map((task) => (
                  <ListRow
                    key={task.id}
                    tone={taskPriorityTone(task.priority)}
                    leading={<Circle size={18} />}
                    title={task.title}
                    subtitle={task.location ?? task.category}
                    trailing={
                      task.dueTime ? <span className="font-mono">{task.dueTime}</span> : undefined
                    }
                  />
                ))}
                <PaneNote>
                  Assigned to this account, for today. Start and finish them on the handheld.
                </PaneNote>
              </>
            )}
          </DataState>
        </PaneSection>
      )}
    </>
  );
}

/**
 * The count beside a section heading — rendered ONLY from data that arrived.
 *
 * During a failure this returns nothing rather than "0 open": a number is a
 * claim, and the pane has no evidence for one while the fetch is down. The
 * DataState below the heading says what actually happened.
 */
function openCountMeta(view: Loadable<readonly unknown[]>): ReactNode {
  if (view.status !== 'ready' || view.data.length === 0) return undefined;
  return <span className="font-mono">{view.data.length} open</span>;
}

/**
 * One stacked list in the column.
 *
 * NOT wrapped in a <Card>: the region around this pane is already a card and
 * every ListRow is its own card, so a third surface between them would be the
 * box-drawn-around-content that the Card primitive exists to prevent. The
 * heading is an <h3> because the region owns the <h2> — the board's landmarks
 * stay a readable outline for anyone navigating it by heading.
 */
function PaneSection({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <h3 id={headingId} className="text-body font-semibold text-ink-3">
          {title}
        </h3>
        {meta !== undefined && <span className="text-meta text-ink-3">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * The line under a list that says where the ACTION on these rows lives.
 *
 * It is rendered with the rows rather than in the empty state on purpose: a
 * worker only needs to be told where to acknowledge when there is something to
 * acknowledge.
 */
function PaneNote({ children }: { children: ReactNode }): ReactElement {
  return <p className="text-meta text-ink-3 px-1">{children}</p>;
}

export default AttentionPane;
