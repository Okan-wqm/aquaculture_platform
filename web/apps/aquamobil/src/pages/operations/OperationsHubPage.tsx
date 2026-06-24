/**
 * OperationsHubPage -- Smart landing page with 4 rich summary cards linking
 * to dedicated enterprise hub pages (Daily Ops, Stock Events, Warehouse, Staff).
 *
 * WHY smart landing page (not flat grid): The previous flat card grid forced
 * workers to navigate into each section to discover their current status. The
 * hub summary pattern surfaces live KPIs (shift status, tanks fed, low stock
 * alerts, leave balance) directly on the landing screen, reducing taps by ~60%.
 * Each card acts as a preview + deep-link into its dedicated hub page.
 *
 * Permission-based rendering: Each card auto-hides if the user has no access
 * to ANY of that hub's features. A warehouse-only worker sees just the
 * Warehouse card, not empty stubs for Daily Ops or Staff.
 */

import { clsx } from 'clsx';
import { ClipboardList, ChevronRight } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { useDailyOpsStats } from '@/hooks/useDailyOpsStats';
import { useMobilePermissions } from '@/hooks/useMobilePermissions';
import { useStaffSummary } from '@/hooks/useStaffSummary';
import { useStockEventsSummary } from '@/hooks/useStockEventsSummary';
import { useWarehouseSummary } from '@/hooks/useWarehouseSummary';
import { useFeatureAccess } from '@/utils/feature-access';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Skeleton pulse placeholder for a single metric cell while data loads. */
function MetricSkeleton(): JSX.Element {
  return <div className="h-5 w-12 mx-auto rounded skeleton" />;
}

/**
 * Safe string/number display: returns em-dash for null/undefined values so
 * the card degrades gracefully when a hook fails or returns partial data.
 */
function safe(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '\u2014';
  return String(value);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface MetricCellProps {
  label: string;
  value: string;
  isLoading: boolean;
}

/** Single metric cell inside a summary card's 3-column grid. */
function MetricCell({ label, value, isLoading }: MetricCellProps): JSX.Element {
  return (
    <div>
      <p className="text-xs text-gray-400 dark:text-gray-500">{label}</p>
      {isLoading ? (
        <MetricSkeleton />
      ) : (
        <p className="font-bold text-gray-900 dark:text-white tabular-nums">{value}</p>
      )}
    </div>
  );
}

interface SummaryCardProps {
  title: string;
  ariaLabel: string;
  gradient: string;
  onClick: () => void;
  children: React.ReactNode;
}

/**
 * Reusable summary card shell: gradient header pill + white body + chevron.
 * WHY button (not div): keyboard accessibility — tab-focusable + enter activates.
 */
function SummaryCard({ title, ariaLabel, gradient, onClick, children }: SummaryCardProps): JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      className={clsx(
        'w-full text-left rounded-2xl overflow-hidden',
        'touch-feedback shadow-card motion-safe:active:scale-[0.98]',
        'motion-safe:transition-transform',
      )}
    >
      <div className={clsx('bg-gradient-to-r px-4 py-2.5', gradient)}>
        <h2 className="text-sm font-bold text-white uppercase tracking-wider">{title}</h2>
      </div>
      <div
        className={clsx(
          'bg-white dark:bg-gray-900 p-4',
          'border border-t-0 border-gray-100 dark:border-gray-800',
          'rounded-b-2xl',
        )}
      >
        {children}
        <div className="flex items-center justify-end mt-2 text-gray-300 dark:text-gray-600">
          <ChevronRight size={16} />
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function OperationsHubPage(): JSX.Element {
  const navigate = useNavigate();
  const { canAccess } = useMobilePermissions();
  // SEC-MEDIUM-050: canReach enforces the harvest MODULE_MANAGER role floor, so a
  // MODULE_USER does not see the Stock Events hub on the strength of harvest
  // alone — only via cull/transfer, which carry no floor.
  const { canReach } = useFeatureAccess();

  // WHY permission checks per hub: each hub aggregates multiple features.
  // Show the card if the user can access ANY feature within that hub.
  const hasDailyOps =
    canAccess('attendance') || canAccess('mortality') || canAccess('waterQuality') || canAccess('feeding');
  const hasStockEvents = canReach('cull') || canReach('harvest') || canReach('transfer');
  const hasWarehouse = canAccess('storage');
  const hasStaff = canAccess('attendance') || canAccess('leave') || canAccess('schedule');
  const noCardsVisible = !hasDailyOps && !hasStockEvents && !hasWarehouse && !hasStaff;

  // WHY call all hooks unconditionally: React hooks must not be called
  // conditionally. The hooks themselves are lightweight (React Query dedup)
  // and short-circuit when the user is not authenticated.
  const { stats: dailyStats, isLoading: dailyLoading } = useDailyOpsStats();
  const { summary: stockSummary, isLoading: stockLoading } = useStockEventsSummary();
  const { summary: warehouseSummary, isLoading: warehouseLoading } = useWarehouseSummary();
  const { summary: staffSummary, isLoading: staffLoading } = useStaffSummary();

  // WHY safe wrappers: if a hook fails or the backend resolver is missing,
  // the card shows em-dashes instead of crashing on undefined access.
  const shiftDisplay = dailyStats?.isClockedIn ? '\u25CF On' : '\u25CB Off';
  const fedDisplay = `${safe(dailyStats?.tanksFedToday)}/${safe(dailyStats?.totalTanksToFeed)}`;
  const tasksDisplay = `${safe(dailyStats?.todaysTasksCompleted)}/${safe(dailyStats?.todaysTasksTotal)}`;

  const batchesDisplay = safe(stockSummary?.activeBatchCount);
  const weekEventsDisplay = safe(stockSummary?.thisWeekEventsCount);
  const transfersDisplay = safe(stockSummary?.recentTransferCount);

  const itemsDisplay = safe(warehouseSummary?.totalItems);
  const lowStockDisplay = safe(warehouseSummary?.lowStockAlertCount);
  const movementsDisplay = safe(warehouseSummary?.todaysMovementCount);

  const dutyDisplay = staffSummary?.isClockedIn ? 'On Duty' : 'Off Duty';
  const leaveDisplay = `${safe(staffSummary?.totalLeaveRemaining)}d`;
  const nextShiftDisplay = staffSummary?.nextShiftDate
    ? formatShortDate(staffSummary.nextShiftDate)
    : '\u2014';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Page header -- gradient banner matching the existing app design system */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <ClipboardList size={22} className="text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">Operations</h1>
          </div>
        </div>
        {/* Curved bottom edge -- consistent with HomePage and RecordHubPage */}
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Hub summary cards -- vertical stack */}
      <main className="px-5 pt-4 space-y-4">
        {/* Daily Operations Card */}
        {hasDailyOps && (
          <SummaryCard
            title="Daily Operations"
            ariaLabel="Daily Operations -- tap to view details"
            gradient="from-orange-500 to-amber-500"
            onClick={() => navigate('/operations/daily')}
          >
            <div className="grid grid-cols-3 gap-3 text-center">
              <MetricCell label="Shift" value={shiftDisplay} isLoading={dailyLoading} />
              <MetricCell label="Fed" value={fedDisplay} isLoading={dailyLoading} />
              <MetricCell label="Tasks" value={tasksDisplay} isLoading={dailyLoading} />
            </div>
          </SummaryCard>
        )}

        {/* Stock Events Card */}
        {hasStockEvents && (
          <SummaryCard
            title="Stock Events"
            ariaLabel="Stock Events -- tap to view details"
            gradient="from-purple-500 to-violet-500"
            onClick={() => navigate('/operations/stock')}
          >
            <div className="grid grid-cols-3 gap-3 text-center">
              <MetricCell label="Batches" value={batchesDisplay} isLoading={stockLoading} />
              <MetricCell label="This Week" value={weekEventsDisplay} isLoading={stockLoading} />
              <MetricCell label="Transfers" value={transfersDisplay} isLoading={stockLoading} />
            </div>
          </SummaryCard>
        )}

        {/* Warehouse Card */}
        {hasWarehouse && (
          <SummaryCard
            title="Warehouse"
            ariaLabel="Warehouse -- tap to view details"
            gradient="from-teal-500 to-teal-600"
            onClick={() => navigate('/operations/warehouse')}
          >
            <div className="grid grid-cols-3 gap-3 text-center">
              <MetricCell label="Items" value={itemsDisplay} isLoading={warehouseLoading} />
              <MetricCell label="Low Stock" value={lowStockDisplay} isLoading={warehouseLoading} />
              <MetricCell label="Today" value={movementsDisplay} isLoading={warehouseLoading} />
            </div>
          </SummaryCard>
        )}

        {/* Staff Card */}
        {hasStaff && (
          <SummaryCard
            title="Staff"
            ariaLabel="Staff -- tap to view details"
            gradient="from-indigo-500 to-indigo-600"
            onClick={() => navigate('/operations/staff')}
          >
            <div className="grid grid-cols-3 gap-3 text-center">
              <MetricCell label="Status" value={dutyDisplay} isLoading={staffLoading} />
              <MetricCell label="Leave" value={leaveDisplay} isLoading={staffLoading} />
              <MetricCell label="Next Shift" value={nextShiftDisplay} isLoading={staffLoading} />
            </div>
          </SummaryCard>
        )}

        {/* Empty state -- shown when user has no permissions for any hub */}
        {noCardsVisible && (
          <div className="text-center py-12 text-gray-400">
            <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No operations available</p>
            <p className="text-sm mt-1">Contact your administrator for access</p>
          </div>
        )}
      </main>

      {/* Bottom spacer to prevent content from hiding behind the fixed tab bar */}
      <div className="h-24" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * WHY inline date formatter: Avoids pulling in a date library for a single
 * display. Produces "Mon, Mar 30" style output that fits the KPI cell width.
 */
function formatShortDate(isoDate: string): string {
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
