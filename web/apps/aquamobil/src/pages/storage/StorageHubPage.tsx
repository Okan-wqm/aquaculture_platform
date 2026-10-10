/**
 * StorageHubPage -- Mobile warehouse operations hub with KPI header,
 * quick-access cards, low stock alerts, and recent movements feed.
 */

import { useI18n } from '@aquaculture/shared-ui/i18n';
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
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button, EmptyState, ListRow, Skeleton, StatTile } from '@/components/ui';
import type { MovementType } from '@/generated/graphql';
import { useMobilePermissions } from '@/hooks/useMobilePermissions';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useWarehouseSummary } from '@/hooks/useWarehouseSummary';
import type { LowStockItem, RecentStockMovement, WarehouseFeedCoverage } from '@/types';

/**
 * WHY: Five core warehouse operations cover 95%+ of daily warehouse floor activity.
 *
 * v4: the five per-tile gradients become one semantic tone each, carried by the
 * icon on a shared surface. The tones are not decoration — receiving stock
 * confirms (ok), dispensing it is a watch (warn), a write-off is the one action
 * with a loss behind it (crit), a transfer wears the token layer's own move hue,
 * and reading the inventory is the plain accent action. The previous grey
 * write-off tile made the destructive operation the quietest thing on screen.
 */
const storageActions = [
  {
    id: 'stock-in',
    path: '/storage/movement?type=IN',
    icon: ArrowDownToLine,
    label: 'Stock In',
    description: 'Receive deliveries',
    iconColor: 'text-ok',
  },
  {
    id: 'stock-out',
    path: '/storage/movement?type=OUT',
    icon: ArrowUpFromLine,
    label: 'Stock Out',
    description: 'Dispense items',
    iconColor: 'text-warn',
  },
  {
    id: 'transfer',
    path: '/storage/transfer',
    icon: ArrowLeftRight,
    label: 'Transfer',
    description: 'Move between locations',
    iconColor: 'text-type-transfer',
  },
  {
    id: 'write-off',
    path: '/storage/movement?type=WASTE',
    icon: Trash2,
    label: 'Write Off',
    description: 'Record waste/loss',
    iconColor: 'text-crit',
  },
  {
    id: 'view-stock',
    path: '/storage/view',
    icon: Package,
    label: 'View Stock',
    description: 'Check inventory',
    iconColor: 'text-acc',
  },
];

/**
 * WHY static config: ensures PurgeCSS sees all Tailwind class literals.
 * WHY total over MovementType (FARM-HIGH-319): the feed shows every movement
 * the warehouse recorded, including the kinds the mobile wizard cannot create
 * (transfer/adjustment/return). The record is keyed by the generated enum, so
 * a movement kind without a row is a compile error — not `config.icon` of
 * undefined at render time, which is how this page used to crash.
 */
const MOVEMENT_TYPE_CONFIG: Record<
  MovementType,
  {
    icon: LucideIcon;
    iconColor: string;
    iconBg: string;
    label: string;
  }
> = {
  IN: {
    icon: ArrowDownToLine,
    iconColor: 'text-ok',
    iconBg: 'bg-surface-2',
    label: 'IN',
  },
  OUT: {
    icon: ArrowUpFromLine,
    iconColor: 'text-warn',
    iconBg: 'bg-warn-dim',
    label: 'OUT',
  },
  TRANSFER: {
    icon: ArrowLeftRight,
    iconColor: 'text-type-transfer',
    iconBg: 'bg-type-transfer-dim',
    label: 'TRANSFER',
  },
  WASTE: {
    icon: Trash2,
    iconColor: 'text-crit',
    iconBg: 'bg-crit-dim',
    label: 'WASTE',
  },
  ADJUSTMENT: {
    icon: SlidersHorizontal,
    iconColor: 'text-warn',
    iconBg: 'bg-warn-dim',
    label: 'ADJUSTMENT',
  },
  RETURN: {
    icon: Undo2,
    iconColor: 'text-acc',
    iconBg: 'bg-acc-dim',
    label: 'RETURN',
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
  const { t } = useI18n();
  const fillPercent =
    item.minQty > 0 ? Math.min(Math.round((item.currentQty / item.minQty) * 100), 100) : 0;

  return (
    // Not a ListRow: this row carries a progressbar with its own aria values,
    // and it is a list item inside a labelled list. ListRow renders a div and
    // has no meter slot, so adopting it would cost both.
    <li className="bg-surface-1 rounded-xl shadow-token border border-line p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-body font-semibold text-ink-1 truncate">{item.name}</span>
        <span className="text-meta text-crit font-bold tabular-nums flex-shrink-0">
          {item.currentQty}/{item.minQty} {item.unit}
        </span>
      </div>
      <div
        className="h-1.5 bg-surface-3 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={item.currentQty}
        aria-valuemax={item.minQty}
        aria-label={t('m.storage.lowStockRowAria', {
          name: item.name,
          current: item.currentQty,
          min: item.minQty,
          unit: item.unit,
        })}
      >
        <div
          className="h-full bg-crit rounded-full motion-safe:transition-all motion-safe:duration-500"
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
    // Not a ListRow either, for the list-item reason above and because the
    // timestamp is a time element with a datetime, not a plain trailing string.
    <li className="bg-surface-1 rounded-xl shadow-token border border-line p-3 flex items-center gap-3">
      <div
        className={clsx(
          'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
          config.iconBg,
        )}
      >
        <Icon size={18} className={config.iconColor} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-body font-semibold text-ink-1 truncate">{movement.itemName}</p>
        <p className="text-meta text-ink-3">
          {movement.quantity} {movement.unit}
        </p>
      </div>
      <time
        dateTime={movement.createdAt}
        className="text-meta text-ink-3 tabular-nums flex-shrink-0"
      >
        {formatRelativeTime(movement.createdAt)}
      </time>
    </li>
  );
}

/** Skeleton loader for sections — the shared primitive, kept inside the
 *  aria-busy wrapper so assistive tech still hears that a region is loading. */
function SectionSkeleton({ count = 3 }: { count?: number }): JSX.Element {
  const { t } = useI18n();
  return (
    <div aria-busy="true" aria-label={t('m.common.loading')}>
      <Skeleton variant="row" count={count} />
    </div>
  );
}

export function StorageHubPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { canAccess } = useMobilePermissions();
  const { isOnline } = useOfflineQueue();
  const { summary, isLoading, isError, refetch } = useWarehouseSummary();

  // WHY: Defense-in-depth for direct URL navigation when admin revokes access mid-session.
  const hasAccess = canAccess('storage');

  const totalItems = summary?.totalItems ?? 0;
  const lowStockAlertCount = summary?.lowStockAlertCount ?? 0;
  const todaysMovementCount = summary?.todaysMovementCount ?? 0;
  const lowStockItems = summary?.lowStockItems ?? [];
  // P-27: yalnız aksiyon gerektiren kapsam satırları (CRITICAL|WARNING) —
  // OK satırları hub'da gürültü olur, detay web forecast grafiğinde.
  const feedCoverage = (summary?.feedCoverage ?? []).filter(
    (c: WarehouseFeedCoverage) => c.coverageStatus !== 'OK',
  );
  const recentMovements = (summary?.recentMovements ?? []).slice(0, MAX_MOVEMENTS);

  return (
    <ErrorBoundary fallbackTitle={t('m.storage.error')}>
      <div className="min-h-screen">
        {/* v4: the teal gradient banner and the wave that masked its edge are
            gone — the ground is the <body>'s and the header is the flat one
            every other screen wears. The KPI strip lived inside that gradient
            and was white-on-glass, so it becomes three StatTiles on real
            surfaces; each keeps the role + spoken label it carried. */}
        <AppHeader title={t('m.storage.title')} subtitle={t('m.storage.subtitle')} />

        <div className="px-5">
          {isLoading ? (
            // Shaped like the three tiles it stands in for, so the hub does not
            // jump when the summary lands.
            <div
              className="grid grid-cols-3 gap-2"
              aria-busy="true"
              aria-label={t('m.common.loading')}
            >
              <Skeleton variant="tile" />
              <Skeleton variant="tile" />
              <Skeleton variant="tile" />
            </div>
          ) : isError ? (
            // ORPHAN-MEDIUM-592: a failed fetch used to render "0 Items /
            // 0 Low Stock / 0 Today" — zeroes that read as a clean bill of
            // health. The figures are UNAVAILABLE, not zero, and the hook now
            // says which.
            <EmptyState
              tone="error"
              icon={<AlertTriangle size={22} />}
              title={t('m.storage.loadError')}
              description={t('m.storage.loadErrorHint')}
              action={
                <Button variant="primary" onClick={refetch}>
                  {t('m.common.retry')}
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <div role="status" aria-label={t('m.storage.itemsAria', { count: totalItems })}>
                <StatTile label={t('m.storage.items')} value={totalItems} />
              </div>
              <div
                role="status"
                aria-label={t('m.storage.lowStockAria', { count: lowStockAlertCount })}
              >
                {lowStockAlertCount > 0 ? (
                  <StatTile
                    label={t('m.storage.lowStock')}
                    value={lowStockAlertCount}
                    state="crit"
                    caption={t('m.storage.belowMinimum')}
                  />
                ) : (
                  <StatTile label={t('m.storage.lowStock')} value={lowStockAlertCount} />
                )}
              </div>
              <div
                role="status"
                aria-label={t('m.storage.todayAria', { count: todaysMovementCount })}
              >
                <StatTile label={t('m.storage.today')} value={todaysMovementCount} />
              </div>
            </div>
          )}
        </div>

        <div className="px-5 pt-4">
          {!isOnline && (
            <p className="text-center text-warn text-meta font-medium mb-4">
              {t('m.storage.outdated')}
            </p>
          )}

          {hasAccess ? (
            <div className="grid grid-cols-2 gap-4">
              {storageActions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => navigate(action.path)}
                    className="flex flex-col items-center justify-center p-6 min-h-touch rounded-2xl border border-line bg-surface-1 shadow-token touch-feedback transition-all motion-safe:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
                  >
                    <Icon className={clsx('mb-3', action.iconColor)} size={32} />
                    <span className="text-title font-bold text-ink-1">{action.label}</span>
                    <span className="text-meta text-ink-3 mt-0.5">{action.description}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={<Warehouse size={22} />}
              title={t('m.storage.noAccess')}
              description={t('m.storage.noAccessHint')}
            />
          )}
        </div>

        {/* Faz 7 (P-27): Yem kapsama uyarıları — forecast snapshot'ından */}
        {hasAccess && feedCoverage.length > 0 && (
          <div className="px-5 mt-5">
            <section aria-label={t('m.storage.feedCoverageAria')}>
              <h2 className="text-meta font-bold text-ink-3 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <AlertTriangle size={14} className="text-warn" />
                {t('m.storage.feedCoverage')}
              </h2>
              <ul className="space-y-2">
                {feedCoverage.map((coverage: WarehouseFeedCoverage) => (
                  <li key={coverage.feedId}>
                    <ListRow
                      tone={coverage.coverageStatus === 'CRITICAL' ? 'crit' : 'warn'}
                      leading={<AlertTriangle size={18} />}
                      title={coverage.feedCode}
                      subtitle={coverage.feedName}
                      trailing={
                        <span className="flex flex-col items-end">
                          <span
                            className={
                              coverage.coverageStatus === 'CRITICAL' ? 'text-crit' : 'text-warn'
                            }
                          >
                            {coverage.daysOfCover !== null
                              ? t('m.storage.daysLeft', { days: coverage.daysOfCover })
                              : t('m.storage.coverageOk')}
                          </span>
                          {coverage.stockoutDate && (
                            <span className="text-meta font-normal text-ink-3">
                              {coverage.stockoutDate}
                            </span>
                          )}
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {/* Phase 2: Low Stock Alerts — only shown when alerts exist */}
        {hasAccess && lowStockAlertCount > 0 && (
          <div className="px-5 mt-5">
            <section aria-label={t('m.storage.lowStockAlerts')}>
              <h2 className="text-meta font-bold text-ink-3 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <AlertTriangle size={14} className="text-crit" />
                {t('m.storage.lowStockAlerts')}
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
            <section aria-label={t('m.storage.recentAria')}>
              <h2 className="text-meta font-bold text-ink-3 uppercase tracking-wider mb-3">
                {t('m.storage.recent')}
              </h2>

              {isLoading ? (
                <SectionSkeleton />
              ) : isError ? (
                // The hook now distinguishes an outage from an idle warehouse
                // (ORPHAN-MEDIUM-592), so this no longer has to claim the
                // second when it means the first.
                <EmptyState
                  tone="error"
                  icon={<AlertTriangle size={22} />}
                  title={t('m.storage.movementsError')}
                  description={t('m.storage.movementsErrorHint')}
                  className="py-8"
                />
              ) : recentMovements.length === 0 ? (
                <EmptyState
                  icon={<Inbox size={22} />}
                  title={t('m.storage.noMovements')}
                  description={t('m.storage.noMovementsHint')}
                  className="py-8"
                />
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
      </div>
    </ErrorBoundary>
  );
}
