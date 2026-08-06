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

import { AppHeader } from '@/components/AppHeader';
import { Card, CardDivider, EmptyState } from '@/components/ui';
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
      <p className="text-meta text-ink-3">{label}</p>
      {isLoading ? (
        <MetricSkeleton />
      ) : (
        <p className="text-title font-mono font-semibold text-ink-1 tabular-nums">{value}</p>
      )}
    </div>
  );
}

interface SummaryCardProps {
  title: string;
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
}

/**
 * Reusable summary card shell: title row, divider, metrics body, chevron.
 * WHY button (not div): keyboard accessibility — tab-focusable + enter activates.
 *
 * v4: the coloured header pill is gone. Four cards on one screen meant four
 * competing gradients, and none of them said anything the title did not — the
 * card's job is to preview its hub's numbers, and the numbers are what should
 * carry the ink.
 */
function SummaryCard({ title, ariaLabel, onClick, children }: SummaryCardProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={clsx(
        'w-full text-left min-h-touch touch-feedback',
        'motion-safe:active:scale-[0.98] motion-safe:transition-transform',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc rounded-2xl',
      )}
    >
      <Card className="overflow-hidden">
        <div className="px-4 py-2.5">
          <h2 className="text-body font-semibold text-ink-2">{title}</h2>
        </div>
        <CardDivider />
        <div className="p-4">
          {children}
          <div className="flex items-center justify-end mt-2 text-ink-3">
            <ChevronRight size={16} />
          </div>
        </div>
      </Card>
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
    <div>
      <AppHeader title="Operations" showAvatar={false} />

      {/* Hub summary cards -- vertical stack */}
      <main className="px-4 space-y-4">
        {/* Daily Operations Card */}
        {hasDailyOps && (
          <SummaryCard
            title="Daily Operations"
            ariaLabel="Daily Operations -- tap to view details"
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
          <EmptyState
            icon={<ClipboardList size={22} />}
            title="No operations available"
            description="Contact your administrator for access"
          />
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
