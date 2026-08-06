import { clsx } from 'clsx';
import { BarChart3, CalendarDays, CloudOff, LayoutGrid, MessageSquare, QrCode } from 'lucide-react';
import { ReactNode, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { CriticalAlertBanner } from '@/components/CriticalAlertBanner';
import { StatusDot } from '@/components/ui';
import { useFarmRealtimeSync } from '@/hooks/useFarmRealtimeSync';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useUnreadCount } from '@/hooks/useUnreadCount';

interface MobileLayoutProps {
  children: ReactNode;
}

interface TabItem {
  id: string;
  icon: typeof CalendarDays;
  label: string;
  path: string;
  /** If set, the tab shows when ANY of these features is enabled. */
  features?: MobileFeature[];
  /**
   * Child paths that light this tab up even though they do not share its URL
   * prefix — the record routes belong to Today's shortcuts, not to a hub.
   */
  childPaths?: string[];
}

/**
 * MobileLayout — the v4 app shell.
 *
 * WHAT CHANGED FROM V3, and why:
 *
 * The dock is now Today · Units · [Scan] · Reports · Chat. The old five were
 * Home, Operations, Tasks, Messages, Account, and three of those were in the
 * wrong place for a field app:
 *
 * - ACCOUNT left the dock. Settings is not something a worker touches during a
 *   shift; it now hangs off the avatar in AppHeader. Its slot went to Units,
 *   the app's central noun, which previously had no route of its own at all.
 * - TASKS folded into Today. A task list separated from the alarms it competes
 *   with makes the worker hold the priority order in their head; v4 puts alarms
 *   and tasks on one screen so the order is visible.
 * - OPERATIONS, a hub of hubs, stopped being a destination. Its ten features are
 *   reached from Today's shortcuts and from the unit they apply to. The routes
 *   are untouched and every guard still applies — nothing was orphaned, the
 *   entry point moved.
 *
 * The centre slot is a raised scan button rather than a tab: it is the one
 * control a worker uses standing at a pen with one hand, so it gets the largest
 * target, the accent fill and the thumb's natural resting position.
 *
 * The dock floats above the content on a blurred surface instead of sitting in a
 * bordered bar, so a long list scrolls under it rather than stopping short.
 */
export function MobileLayout({ children }: MobileLayoutProps): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { pendingCount, isOnline, isSyncing } = useOfflineQueue();
  const { canAccess } = useMobilePermissions();

  // MOB-MEDIUM-008: a live-channel drop while HTTP is fine means the "~1s
  // freshness" promise is silently broken, and the worker must see that data
  // may lag (the degraded-live strip below).
  const { isConnected: isLiveConnected } = useFarmRealtimeSync();

  // ADR-012: unread messages for the Chat badge, kept live by Socket.IO with a
  // 60s poll as the safety net.
  const { unreadCount: messageUnreadCount } = useUnreadCount();

  const allTabs: TabItem[] = [
    {
      id: 'today',
      icon: CalendarDays,
      label: 'Today',
      path: '/',
      // Today owns the tasks it absorbed plus the alarm and notification
      // surfaces it links out to.
      childPaths: ['/tasks', '/alerts', '/notifications', '/operations'],
    },
    {
      id: 'units',
      icon: LayoutGrid,
      label: 'Units',
      path: '/units',
      childPaths: ['/tank'],
    },
    {
      id: 'reports',
      icon: BarChart3,
      label: 'Reports',
      path: '/reports',
      features: ['reports'],
    },
    {
      id: 'chat',
      icon: MessageSquare,
      label: 'Chat',
      path: '/messages',
    },
  ];

  const tabs = allTabs.filter((tab) => {
    if (!tab.features) return true;
    return tab.features.some((f) => canAccess(f));
  });

  const isActive = (tab: TabItem): boolean => {
    if (tab.path === '/' && location.pathname === '/') return true;
    if (tab.path !== '/' && location.pathname.startsWith(tab.path)) return true;
    return tab.childPaths?.some((cp) => location.pathname.startsWith(cp)) ?? false;
  };

  // The scan button is only useful if the worker may log something against the
  // unit it resolves to; with none of the log features granted it would lead to
  // a screen whose every action is denied.
  const canScan = (
    ['mortality', 'cull', 'harvest', 'feeding', 'transfer', 'waterQuality'] as const
  ).some((f) => canAccess(f));

  return (
    <div className="flex flex-col h-full w-full overflow-auto pb-safe">
      {/* MOB-HIGH-006: unacknowledged CRITICAL alarms top every screen and stay
          until acknowledged — life-safety alerts never hide behind a badge. */}
      <CriticalAlertBanner />

      {/* Field workers need to know their actions are queuing locally rather
          than reaching the farm. */}
      {!isOnline && (
        <div className="bg-warn-dim text-warn px-4 py-2.5 flex items-center justify-center gap-2 text-body font-semibold border-b border-line">
          <CloudOff size={15} />
          <span>Offline — changes will sync when connected</span>
        </div>
      )}

      {/* Online but the real-time channel is down: requests still work,
          freshness does not. Distinct from the offline banner on purpose. */}
      {isOnline && !isLiveConnected && (
        <div className="bg-surface-2 text-ink-2 px-4 py-1.5 flex items-center justify-center gap-2 text-meta font-semibold">
          <StatusDot tone="warn" live />
          <span>Live updates unavailable — data may lag</span>
        </div>
      )}

      {isSyncing && (
        <div className="bg-acc-dim text-acc px-4 py-2.5 flex items-center justify-center gap-2 text-body font-semibold border-b border-line">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-acc border-t-transparent" />
          <span>Syncing…</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">{children}</div>

      <nav
        aria-label="Main"
        className={clsx(
          'fixed left-3 right-3 bottom-3 z-30 h-[68px] rounded-[22px]',
          'bg-dock backdrop-blur-xl border border-line-strong',
          'shadow-[0_18px_40px_rgba(2,8,18,0.45)]',
          'grid items-center',
          canScan ? 'grid-cols-[1fr_1fr_1.1fr_1fr_1fr]' : 'grid-cols-4',
        )}
        // The dock floats, so the safe-area inset is applied as margin rather
        // than padding — otherwise the blur panel itself grows on notch devices.
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        {tabs.slice(0, 2).map((tab) => (
          <DockTab
            key={tab.id}
            tab={tab}
            active={isActive(tab)}
            onSelect={() => navigate(tab.path)}
          />
        ))}

        {canScan && (
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => navigate('/scan')}
              aria-label="Scan a unit tag"
              // Raised out of the dock: the one control used one-handed at a
              // pen edge gets the biggest target and the accent fill.
              className="w-14 h-14 -mt-7 rounded-[20px] bg-acc border-[3px] border-surface-0 inline-flex items-center justify-center shadow-acc touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
            >
              <QrCode size={22} className="text-acc-on" />
            </button>
          </div>
        )}

        {tabs.slice(2).map((tab) => (
          <DockTab
            key={tab.id}
            tab={tab}
            active={isActive(tab)}
            badge={tab.id === 'chat' ? messageUnreadCount : tab.id === 'today' ? pendingCount : 0}
            onSelect={() => navigate(tab.path)}
          />
        ))}
      </nav>
    </div>
  );
}

function DockTab({
  tab,
  active,
  badge = 0,
  onSelect,
}: {
  tab: TabItem;
  active: boolean;
  badge?: number;
  onSelect: () => void;
}): ReactElement {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'relative h-[52px] mx-1 rounded-2xl flex flex-col items-center justify-center gap-1',
        'touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
        active ? 'bg-acc-dim text-acc' : 'text-ink-3',
      )}
    >
      {badge > 0 && (
        <span className="absolute top-1 right-2 min-w-[16px] h-4 px-1 rounded-full bg-crit text-white text-meta font-mono font-semibold inline-flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      <Icon size={19} strokeWidth={active ? 2.2 : 1.7} />
      <span className="text-meta font-semibold">{tab.label}</span>
    </button>
  );
}
