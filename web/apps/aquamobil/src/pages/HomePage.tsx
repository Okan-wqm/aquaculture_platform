/**
 * HomePage — the v4 "Today" screen.
 *
 * WHAT CHANGED AND WHY: the pre-v4 home was a brand banner (gradient, three
 * decorative blobs, an SVG wave) followed by a four-up stats row, then banners,
 * then a nine-item action grid, then a farm summary, then the tank list. A
 * worker arriving on shift had to scroll past four sections before reaching
 * anything that told them what to DO.
 *
 * Today answers one question — "what needs me right now?" — in priority order:
 *
 *   Alarms → Tasks → Shortcuts → Snapshot
 *
 * Alarms and tasks now sit on ONE screen. Before, tasks lived behind their own
 * dock tab, so the worker had to hold the relative priority of "oxygen alarm on
 * U-07" versus "net inspection at 10:30" in their head. Putting them in one
 * column makes the order visible instead of remembered.
 *
 * The tank list moved out to /units (its own dock slot), because it is a
 * navigation surface, not a to-do list, and it was burying the things that are.
 */
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  Bell,
  CalendarOff,
  CheckCircle2,
  Circle,
  Droplets,
  ListChecks,
  MapPin,
  Package,
  Scissors,
  ShieldAlert,
  Skull,
  Warehouse,
} from 'lucide-react';
import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { AiInsightsCard } from '@/components/ai';
import { AlertsBell } from '@/components/AlertsBell';
import { AppHeader } from '@/components/AppHeader';
import { LogSheet, type SheetType } from '@/components/log-sheet/LogSheet';
import { NotificationBell } from '@/components/NotificationBell';
import { Card, Chip, EmptyState, ListRow, Skeleton, StatusDot } from '@/components/ui';
import type { RowTone } from '@/components/ui';
import { useAlerts, type MobileAlert } from '@/hooks/useAlerts';
import { useAuth } from '@/hooks/useAuth';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import { useMyTasks } from '@/hooks/useMyTasks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTanks } from '@/hooks/useTanks';
import type { Task } from '@/types';
import { useFeatureAccess } from '@/utils/feature-access';

interface Shortcut {
  feature: MobileFeature;
  /** Where a tap goes when the type is NOT covered by the log sheet. */
  path: string;
  /**
   * Set when this entry type is one the log sheet covers. Tapping opens the
   * sheet in place instead of navigating — the worker keeps their context and
   * the entry is two taps rather than a page load plus a form.
   */
  sheet?: SheetType;
  icon: typeof Skull;
  label: string;
  tone: RowTone;
}

/**
 * The shortcut grid. WHAT CHANGED: each tile used to carry its own two-stop
 * gradient, so nine tiles meant nine competing colours and the alarm red on the
 * same screen had nothing left to be louder than. Tiles now sit on the surface
 * and carry only the log type's hue on the icon.
 */
const ALL_SHORTCUTS: Shortcut[] = [
  { feature: 'feeding', path: '/feeding/record', icon: Package, label: 'Feeding', tone: 'feeding' },
  {
    feature: 'mortality',
    path: '/mortality/record',
    icon: Skull,
    label: 'Mortality',
    tone: 'mortality',
  },
  {
    feature: 'cull',
    sheet: 'cull',
    path: '/cull/record',
    icon: Scissors,
    label: 'Culling',
    tone: 'cull',
  },
  { feature: 'harvest', path: '/harvest/record', icon: Package, label: 'Harvest', tone: 'harvest' },
  {
    feature: 'waterQuality',
    path: '/water-quality/record',
    icon: Droplets,
    label: 'Water',
    tone: 'water',
  },
  {
    feature: 'transfer',
    path: '/transfer/record',
    icon: ArrowLeftRight,
    label: 'Transfer',
    tone: 'transfer',
  },
  { feature: 'attendance', path: '/attendance', icon: MapPin, label: 'Clock in', tone: 'accent' },
  { feature: 'leave', path: '/leave', icon: CalendarOff, label: 'Leave', tone: 'neutral' },
  { feature: 'storage', path: '/storage', icon: Warehouse, label: 'Storage', tone: 'neutral' },
];

/** Alarm severity → the row's icon tile tone. */
function alertTone(severity: MobileAlert['severity']): RowTone {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'crit';
  if (severity === 'MEDIUM' || severity === 'WARNING') return 'warn';
  return 'neutral';
}

/** Task priority → tone. Overdue is decided separately, below. */
function taskTone(task: Task): RowTone {
  if (task.priority === 'URGENT' || task.priority === 'HIGH') return 'crit';
  if (task.priority === 'MEDIUM') return 'warn';
  return 'neutral';
}

/** "07:12" from an ISO stamp, in the device's own zone. */
function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function greetingFor(hour: number): string {
  if (hour < 5) return 'Night shift';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomePage(): JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: tanks, isLoading: tanksLoading, isError: tanksError } = useTanks();
  const { pendingCount, isOnline } = useOfflineQueue();
  const { canAccess, permissionsDegraded, permissionSource, refreshPermissions } =
    useMobilePermissions();
  // SEC-MEDIUM-050: canReach folds the entitlement flag with any feature role
  // floor (harvest => MODULE_MANAGER), so the harvest shortcut disappears for a
  // MODULE_USER exactly as the route guard and backend @Roles require.
  const { canReach } = useFeatureAccess();
  const { tasks: todayTasks, loading: tasksLoading } = useMyTasks('today');
  const { alerts, unacknowledgedCount, isLoading: alertsLoading } = useAlerts({ limit: 5 });

  const allTanks = tanks ?? [];
  const activeTanks = allTanks.filter((t) => t.batchMetrics);
  const shortcuts = ALL_SHORTCUTS.filter((s) => canReach(s.feature));

  const openAlerts = alerts.filter((a) => !a.acknowledged).slice(0, 4);
  const doneCount = todayTasks.filter((t) => t.status === 'COMPLETED').length;

  // Unit totals, not primary-batch totals: a mixed pen holds more than its
  // primary batch reports, and farm aggregates built from the batch understate
  // the farm (ORPHAN-HIGH-585).
  const totalFish = activeTanks.reduce((sum, t) => sum + t.currentQuantity, 0);
  const totalBiomass = activeTanks.reduce((sum, t) => sum + t.currentBiomass, 0);
  const overCapacityCount = activeTanks.filter((t) => t.batchMetrics?.isOverCapacity).length;

  const [sheet, setSheet] = useState<{ type: SheetType } | null>(null);

  const firstName = (user?.name ?? '').split(/\s+/)[0] ?? '';
  const greeting = greetingFor(new Date().getHours());

  return (
    <div className="pb-32">
      <AppHeader
        title={firstName ? `${greeting}, ${firstName}` : greeting}
        subtitle={new Date().toLocaleDateString([], {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
        // The bells are the ONLY entry point to /alerts and /notifications.
        // Dropping the old gradient header took them off the screen with it and
        // left both routes unreachable — they belong beside the avatar.
        actions={
          <>
            <AlertsBell />
            <NotificationBell />
          </>
        }
      />

      {/* Status row — the shift's context in one line: connection, alarm load,
          and how much work is still sitting unsent on this device. */}
      <div className="px-4 pb-4 flex gap-2 overflow-x-auto">
        <Chip tone={isOnline ? 'neutral' : 'warn'}>
          <StatusDot tone={isOnline ? 'ok' : 'warn'} live={isOnline} />
          {isOnline ? 'On duty' : 'Offline'}
        </Chip>
        <Chip
          tone={unacknowledgedCount > 0 ? 'crit' : 'neutral'}
          onClick={() => navigate('/alerts')}
        >
          <span className="font-mono font-semibold">{unacknowledgedCount}</span>
          alarms
        </Chip>
        <Chip tone={pendingCount > 0 ? 'warn' : 'neutral'} onClick={() => navigate('/sync')}>
          <span className="font-mono font-semibold">{pendingCount}</span>
          queued
        </Chip>
      </div>

      <div className="px-4 flex flex-col gap-6">
        {/* SECURITY: fail-closed degradation banner — the worker must know that
            permissions could not be verified and features may be hidden. */}
        {permissionsDegraded && (
          <button
            type="button"
            onClick={() => void refreshPermissions()}
            className="w-full text-left touch-feedback"
          >
            <Card className="p-3.5 flex items-center gap-3 border-warn">
              <span className="w-9 h-9 shrink-0 rounded-xl bg-warn-dim text-warn inline-flex items-center justify-center">
                <ShieldAlert size={18} />
              </span>
              <span className="flex-1">
                <span className="block text-body font-semibold text-ink-1">
                  {permissionSource === 'fail-closed'
                    ? 'Permissions unavailable'
                    : 'Using cached permissions'}
                </span>
                <span className="block text-meta text-ink-3">
                  {permissionSource === 'fail-closed'
                    ? 'Some features are hidden. Tap to retry.'
                    : 'Feature access may be outdated. Tap to refresh.'}
                </span>
              </span>
            </Card>
          </button>
        )}

        {overCapacityCount > 0 && (
          <Card className="p-3.5 flex items-center gap-3 border-crit">
            <span className="w-9 h-9 shrink-0 rounded-xl bg-crit-dim text-crit inline-flex items-center justify-center">
              <AlertTriangle size={18} />
            </span>
            <span className="flex-1">
              <span className="block text-body font-semibold text-ink-1">
                {overCapacityCount} unit{overCapacityCount > 1 ? 's' : ''} over capacity
              </span>
              <span className="block text-meta text-ink-3">
                Consider harvesting or transferring
              </span>
            </span>
          </Card>
        )}

        {/* ── Alarms ─────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <SectionHead
            title="Alarms"
            meta={
              unacknowledgedCount > 0 ? (
                <span className="text-crit font-mono">{unacknowledgedCount} active</span>
              ) : undefined
            }
          />
          {alertsLoading && <Skeleton variant="row" count={2} />}
          {!alertsLoading && openAlerts.length === 0 && (
            <EmptyState
              icon={<Bell size={22} />}
              title="No open alarms"
              description="Nothing needs acknowledging right now."
              className="py-6"
            />
          )}
          {openAlerts.map((alert) => (
            <ListRow
              key={alert.id}
              tone={alertTone(alert.severity)}
              leading={<AlertTriangle size={18} />}
              title={alert.ruleName}
              subtitle={alert.message}
              trailing={<span className="font-mono">{clockOf(alert.triggeredAt)}</span>}
              onClick={() => navigate('/alerts')}
            />
          ))}
        </section>

        {/* ── Tasks ──────────────────────────────────────────────────── */}
        {canAccess('tasks') && (
          <section className="flex flex-col gap-2">
            <SectionHead
              title="Tasks"
              meta={
                todayTasks.length > 0 ? (
                  <span className="font-mono">
                    {doneCount}/{todayTasks.length}
                  </span>
                ) : undefined
              }
            />
            {tasksLoading && <Skeleton variant="row" count={3} />}
            {!tasksLoading && todayTasks.length === 0 && (
              <EmptyState
                icon={<ListChecks size={22} />}
                title="Nothing scheduled"
                description="No tasks are assigned to you for today."
                className="py-6"
              />
            )}
            {todayTasks.slice(0, 5).map((task) => {
              const done = task.status === 'COMPLETED';
              return (
                <ListRow
                  key={task.id}
                  tone={done ? 'ok' : taskTone(task)}
                  muted={done}
                  leading={done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                  title={task.title}
                  subtitle={task.location ?? task.category}
                  trailing={
                    task.dueTime ? <span className="font-mono">{task.dueTime}</span> : undefined
                  }
                  onClick={() => navigate(`/tasks/${task.id}`)}
                />
              );
            })}
            {todayTasks.length > 5 && (
              <button
                type="button"
                onClick={() => navigate('/tasks')}
                className="text-body font-semibold text-acc py-2 touch-feedback"
              >
                See all {todayTasks.length} tasks
              </button>
            )}
          </section>
        )}

        {/* ── Shortcuts ──────────────────────────────────────────────── */}
        {shortcuts.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionHead title="Shortcuts" />
            <div className="grid grid-cols-3 gap-2">
              {shortcuts.map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.feature}
                    type="button"
                    onClick={() => (s.sheet ? setSheet({ type: s.sheet }) : navigate(s.path))}
                    className="h-tap-tile min-h-touch rounded-2xl border border-line bg-surface-1 shadow-token flex flex-col items-center justify-center gap-1.5 touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
                  >
                    <Icon size={19} className={SHORTCUT_ICON_CLASS[s.tone]} />
                    <span className="text-meta font-semibold text-ink-2">{s.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Snapshot ───────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <SectionHead title="Snapshot" />
          {tanksLoading ? (
            <Skeleton variant="tile" />
          ) : tanksError ? (
            // A failed fetch must NOT render as "0 fish, 0 biomass, capacity OK".
            // On a boat with no signal that reads as an authoritative all-clear
            // about the farm, which is worse than showing nothing.
            <EmptyState
              tone="error"
              icon={<Activity size={22} />}
              title="Could not load the farm summary"
              description="These figures are unavailable, not zero. Anything you log is still queued on this device."
            />
          ) : (
            <Card className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Activity size={14} className="text-acc" />
                <span className="text-meta font-semibold text-ink-3">
                  {allTanks.length} units · {activeTanks.length} stocked
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Metric
                  value={
                    totalFish >= 1_000_000
                      ? `${(totalFish / 1_000_000).toFixed(1)}M`
                      : totalFish >= 1000
                        ? `${(totalFish / 1000).toFixed(1)}K`
                        : String(totalFish)
                  }
                  label="Fish"
                />
                <Metric
                  value={
                    totalBiomass >= 1000
                      ? `${(totalBiomass / 1000).toFixed(1)}t`
                      : `${totalBiomass.toFixed(0)}kg`
                  }
                  label="Biomass"
                />
                <Metric
                  value={overCapacityCount > 0 ? String(overCapacityCount) : 'OK'}
                  label={overCapacityCount > 0 ? 'Over cap' : 'Capacity'}
                  alarm={overCapacityCount > 0}
                />
              </div>
            </Card>
          )}
          <AiInsightsCard />
        </section>
      </div>

      <LogSheet open={sheet !== null} onClose={() => setSheet(null)} initialType={sheet?.type} />
    </div>
  );
}

/** Icon hue per shortcut tone — the only colour a shortcut tile carries. */
const SHORTCUT_ICON_CLASS: Record<RowTone, string> = {
  neutral: 'text-ink-3',
  accent: 'text-acc',
  warn: 'text-warn',
  crit: 'text-crit',
  ok: 'text-ok',
  feeding: 'text-type-feeding',
  mortality: 'text-type-mortality',
  water: 'text-type-water',
  cull: 'text-type-cull',
  transfer: 'text-type-transfer',
  harvest: 'text-type-harvest',
};

function SectionHead({ title, meta }: { title: string; meta?: JSX.Element }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between px-1">
      <h2 className="text-body font-semibold text-ink-3">{title}</h2>
      {meta !== undefined && <span className="text-meta text-ink-3">{meta}</span>}
    </div>
  );
}

function Metric({
  value,
  label,
  alarm = false,
}: {
  value: string;
  label: string;
  alarm?: boolean;
}): JSX.Element {
  return (
    <div className="text-center">
      <div
        className={`text-head font-mono font-bold tabular-nums ${alarm ? 'text-crit' : 'text-ink-1'}`}
      >
        {value}
      </div>
      <div className="text-meta text-ink-3">{label}</div>
    </div>
  );
}
