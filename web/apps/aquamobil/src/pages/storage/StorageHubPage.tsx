/**
 * StorageHubPage -- Mobile warehouse operations hub with KPI header,
 * quick-access cards, low stock alerts, and recent movements feed.
 */

import { clsx } from 'clsx';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  Trash2,
  Package,
  Warehouse,
  AlertTriangle,
  Inbox,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { KpiStrip } from '@/components/hub';
import type { KpiItem } from '@/components/hub';
import { useMobilePermissions } from '@/hooks/useMobilePermissions';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useWarehouseSummary } from '@/hooks/useWarehouseSummary';
import type { LowStockItem, RecentStockMovement, StockMovementType } from '@/types';

// WHY: Five core warehouse operations cover 95%+ of daily warehouse floor activity.
const storageActions = [
  {
    id: 'stock-in',
    path: '/storage/movement?type=IN',
    icon: ArrowDownToLine,
    label: 'Stock In',
    description: 'Receive deliveries',
    gradient: 'from-green-500 to-green-600',
  },
  {
    id: 'stock-out',
    path: '/storage/movement?type=OUT',
    icon: ArrowUpFromLine,
    label: 'Stock Out',
    description: 'Dispense items',
    gradient: 'from-red-500 to-red-600',
  },
  {
    id: 'transfer',
    path: '/storage/transfer',
    icon: ArrowLeftRight,
    label: 'Transfer',
    description: 'Move between locations',
    gradient: 'from-blue-500 to-blue-600',
  },
  {
    id: 'write-off',
    path: '/storage/movement?type=WASTE',
    icon: Trash2,
    label: 'Write Off',
    description: 'Record waste/loss',
    gradient: 'from-gray-500 to-gray-600',
  },
  {
    id: 'view-stock',
    path: '/storage/view',
    icon: Package,
    label: 'View Stock',
    description: 'Check inventory',
    gradient: 'from-cyan-500 to-cyan-600',
  },
];

/** WHY static config: ensures PurgeCSS sees all Tailwind class literals. */
const MOVEMENT_TYPE_CONFIG: Record<StockMovementType, {
  icon: LucideIcon;
  iconColor: string;
  iconBg: string;
  label: string;
}> = {
  IN: {
    icon: ArrowDownToLine,
    iconColor: 'text-green-500',
    iconBg: 'bg-green-50 dark:bg-green-900/20',
    label: 'IN',
  },
  OUT: {
    icon: ArrowUpFromLine,
    iconColor: 'text-red-500',
    iconBg: 'bg-red-50 dark:bg-red-900/20',
    label: 'OUT',
  },
  WASTE: {
    icon: Trash2,
    iconColor: 'text-gray-500',
    iconBg: 'bg-gray-100 dark:bg-gray-800',
    label: 'WASTE',
  },
};

const MAX_MOVEMENTS = 5;

function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(isoDate).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** Low stock alert row with red progress bar showing current vs minimum quantity. */
function LowStockRow({ item }: { item: LowStockItem }): JSX.Element {
  const fillPercent = item.minQty > 0
    ? Math.min(Math.round((item.currentQty / item.minQty) * 100), 100)
    : 0;

  return (
    <li className="bg-white dark:bg-gray-900 rounded-xl shadow-card border border-gray-100 dark:border-gray-800 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">
          {item.name}
        </span>
        <span className="text-xs text-red-600 dark:text-red-400 font-bold tabular-nums flex-shrink-0">
          {item.currentQty}/{item.minQty} {item.unit}
        </span>
      </div>
      <div
        className="h-1.5 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={item.currentQty}
        aria-valuemax={item.minQty}
        aria-label={`${item.name}: ${item.currentQty} of ${item.minQty} ${item.unit} minimum`}
      >
        <div
          className="h-full bg-red-500 rounded-full motion-safe:transition-all motion-safe:duration-500"
          style={{ width: `${fillPercent}%` }}
        />
      </div>
    </li>
  );
}

/** Single movement row with icon and relative timestamp. */
function MovementRow({ movement }: { movement: RecentStockMovement }): JSX.Element {
  const config = MOVEMENT_TYPE_CONFIG[movement.movementType];
  const Icon = config.icon;

  return (
    <li className="bg-white dark:bg-gray-900 rounded-xl shadow-card border border-gray-100 dark:border-gray-800 p-3 flex items-center gap-3">
      <div
        className={clsx(
          'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
          config.iconBg,
        )}
      >
        <Icon size={18} className={config.iconColor} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
          {movement.itemName}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {movement.quantity} {movement.unit}
        </p>
      </div>
      <time
        dateTime={movement.createdAt}
        className="text-xs text-gray-400 dark:text-gray-500 tabular-nums flex-shrink-0"
      >
        {formatRelativeTime(movement.createdAt)}
      </time>
    </li>
  );
}

/** Skeleton loader for sections. */
function SectionSkeleton({ count = 3 }: { count?: number }): JSX.Element {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-14 rounded-xl skeleton" />
      ))}
    </div>
  );
}

export function StorageHubPage(): JSX.Element {
  const navigate = useNavigate();
  const { canAccess } = useMobilePermissions();
  const { isOnline } = useOfflineQueue();
  const { summary, isLoading } = useWarehouseSummary();

  // WHY: Defense-in-depth for direct URL navigation when admin revokes access mid-session.
  const hasAccess = canAccess('storage');

  const totalItems = summary?.totalItems ?? 0;
  const lowStockAlertCount = summary?.lowStockAlertCount ?? 0;
  const todaysMovementCount = summary?.todaysMovementCount ?? 0;
  const lowStockItems = summary?.lowStockItems ?? [];
  const recentMovements = (summary?.recentMovements ?? []).slice(0, MAX_MOVEMENTS);

  const kpiItems: KpiItem[] = [
    {
      label: 'Items',
      value: totalItems,
      ariaLabel: `${totalItems} total inventory items`,
      isLoading,
    },
    {
      label: 'Low Stock',
      value: lowStockAlertCount,
      ariaLabel: `${lowStockAlertCount} items below minimum stock`,
      valueColor: lowStockAlertCount > 0 ? 'text-red-300' : undefined,
      isLoading,
    },
    {
      label: 'Today',
      value: todaysMovementCount,
      ariaLabel: `${todaysMovementCount} stock movements today`,
      isLoading,
    },
  ];

  return (
    <ErrorBoundary fallbackTitle="Storage Error">
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-gradient-to-br from-teal-700 via-teal-600 to-teal-500 text-white">
          <div className="px-5 pt-safe-top">
            <div className="flex items-center gap-3 py-4">
              <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
                <Warehouse size={22} className="text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">Storage Operations</h1>
                <p className="text-xs text-white/80">Warehouse management</p>
              </div>
            </div>

            {/* Phase 2: KPI strip inside the gradient header area */}
            <div className="pb-5">
              <KpiStrip items={kpiItems} />
            </div>
          </div>
          <div className="relative">
            <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
              <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
            </svg>
          </div>
        </div>

        <div className="px-5 pt-4">
          {!isOnline && (
            <p className="text-center text-amber-500 dark:text-amber-400 text-xs font-medium mb-4">
              Data may be outdated
            </p>
          )}

          {hasAccess ? (
            <div className="grid grid-cols-2 gap-4">
              {storageActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.id}
                    onClick={() => navigate(action.path)}
                    className={clsx(
                      'flex flex-col items-center justify-center p-6 rounded-2xl touch-feedback shadow-card transition-all motion-safe:active:scale-[0.97]',
                      `bg-gradient-to-br ${action.gradient}`,
                    )}
                  >
                    <Icon className="text-white mb-3" size={32} />
                    <span className="text-sm font-bold text-white">{action.label}</span>
                    <span className="text-xs text-white/85 mt-0.5">{action.description}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-12 text-gray-400">
              <Warehouse size={48} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">You do not have access</p>
            </div>
          )}
        </div>

        {/* Phase 2: Low Stock Alerts — only shown when alerts exist */}
        {hasAccess && lowStockAlertCount > 0 && (
          <div className="px-5 mt-5">
            <section aria-label="Low stock alerts">
              <h2 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <AlertTriangle size={14} className="text-red-500" />
                Low Stock Alerts
              </h2>

              {isLoading ? (
                <SectionSkeleton count={2} />
              ) : (
                <ul className="space-y-2">
                  {lowStockItems.map((item: LowStockItem) => (
                    <LowStockRow key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {/* Phase 2: Recent Movements */}
        {hasAccess && (
          <div className="px-5 mt-5">
            <section aria-label="Recent stock movements">
              <h2 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
                Recent Movements
              </h2>

              {isLoading ? (
                <SectionSkeleton />
              ) : recentMovements.length === 0 ? (
                <div className="text-center py-8 text-gray-400 dark:text-gray-500">
                  <Inbox size={36} className="mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-medium">No recent movements</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {recentMovements.map((movement: RecentStockMovement) => (
                    <MovementRow key={movement.id} movement={movement} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {/* Bottom spacer for tab bar */}
        <div className="h-24" />
      </div>
    </ErrorBoundary>
  );
}
