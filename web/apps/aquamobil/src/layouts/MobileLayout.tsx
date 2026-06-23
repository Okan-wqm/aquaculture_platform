import { clsx } from 'clsx';
import { Home, ClipboardList, CheckSquare, MessageSquare, User, CloudOff } from 'lucide-react';
import { ReactNode, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// WHY: Konsta's <Page> applies its own bg-ios-light-surface / bg-md-light-surface background
// classes with dark: variants that use Konsta's internal color tokens (#efeff4 / #1c1c1e).
// These override our Tailwind dark:bg-gray-950 design system. We use a plain div instead
// to maintain full control over light/dark backgrounds via Tailwind's class-based dark mode.
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import { useNotifications } from '@/hooks/useNotifications';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useUnreadCount } from '@/hooks/useUnreadCount';


interface MobileLayoutProps {
  children: ReactNode;
}

interface TabItem {
  id: string;
  icon: typeof Home;
  label: string;
  path: string;
  activeColor?: string;
  activeBg?: string;
  // If features is set, tab shows if ANY of these features are enabled
  features?: MobileFeature[];
  // Child paths that should highlight this tab even though they don't start
  // with the tab's primary path. Essential for the Operations tab where routes
  // like /feeding/record don't share a /operations URL prefix.
  childPaths?: string[];
}

// WHY: MobileLayout is the single shell for all authenticated pages — consistent bottom nav,
// offline banner, and safe area handling across all screens without duplication.
export function MobileLayout({ children }: MobileLayoutProps): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { pendingCount, isOnline, isSyncing } = useOfflineQueue();
  const { canAccess } = useMobilePermissions();
  const { unreadCount } = useNotifications();

  // ADR-012: Unread message count for the Messages tab badge.
  // WHY useUnreadCount hook: Replaces manual fetch + polling with the shared
  // TanStack Query hook that also integrates with Socket.IO cache invalidation
  // from useMessageSocket. The hook polls every 60s as a fallback safety net
  // but is primarily updated in real-time via Socket.IO events.
  const { unreadCount: messageUnreadCount } = useUnreadCount();

  /**
   * Bottom tab navigation — 5 tabs: Home, Operations, Tasks, Messages, Account.
   * Messages tab added per ADR-012 for in-app messaging (replaces WhatsApp/Telegram).
   *
   * The Operations tab uses a `childPaths` array for active-state detection
   * because its child routes (e.g., /feeding/record, /attendance) don't start
   * with /operations. Without this, the tab appears inactive during operations.
   */
  const allTabs: TabItem[] = [
    {
      id: 'home', icon: Home, label: 'Home', path: '/',
      activeColor: 'text-ocean-600', activeBg: 'bg-ocean-50 dark:bg-ocean-900/30',
    },
    {
      id: 'operations', icon: ClipboardList, label: 'Operations', path: '/operations',
      activeColor: 'text-orange-600', activeBg: 'bg-orange-50 dark:bg-orange-900/30',
      features: ['feeding', 'mortality', 'cull', 'harvest', 'transfer', 'waterQuality', 'storage', 'attendance', 'leave', 'schedule'],
      // Child paths that should highlight the Operations tab even though they
      // don't start with /operations. This includes all operation sub-routes
      // and the hub pages they navigate to.
      childPaths: ['/feeding', '/mortality', '/cull', '/harvest', '/transfer', '/water-quality', '/storage', '/attendance', '/leave', '/schedule'],
    },
    {
      id: 'tasks', icon: CheckSquare, label: 'Tasks', path: '/tasks',
      activeColor: 'text-green-600', activeBg: 'bg-green-50 dark:bg-green-900/30',
      features: ['tasks'],
    },
    {
      id: 'messages', icon: MessageSquare, label: 'Messages', path: '/messages',
      activeColor: 'text-indigo-600', activeBg: 'bg-indigo-50 dark:bg-indigo-900/30',
    },
    {
      id: 'account', icon: User, label: 'Account', path: '/account',
      activeColor: 'text-gray-600', activeBg: 'bg-gray-100 dark:bg-gray-800/30',
    },
  ];

  const tabs = allTabs.filter((tab) => {
    if (!tab.features) return true;
    // Show tab if ANY of its features are enabled
    return tab.features.some((f) => canAccess(f));
  });

  // Active state detection: a tab is active if the current path matches
  // the tab's path directly, OR if it matches any of the tab's childPaths.
  // This is essential for the Operations tab which owns routes that don't
  // share a common URL prefix (e.g., /feeding/record, /attendance).
  const isActive = (tab: TabItem): boolean => {
    if (tab.path === '/' && location.pathname === '/') return true;
    if (tab.path !== '/' && location.pathname.startsWith(tab.path)) return true;
    if (tab.childPaths?.some(cp => location.pathname.startsWith(cp))) return true;
    return false;
  };

  // Badge count aggregation — Account tab shows combined pending sync + unread
  // notifications; Messages tab shows total unread message count from messaging service.
  const getBadge = (tabId: string): number => {
    if (tabId === 'account') return pendingCount + unreadCount;
    if (tabId === 'messages') return messageUnreadCount;
    return 0;
  };

  return (
    <div className="flex flex-col h-full w-full overflow-auto pb-safe bg-gray-50 dark:bg-gray-950">
      {/* WHY: Offline banner appears above all content — field workers need clear indication that
          their actions are queuing locally, not syncing to the server in real-time. */}
      {!isOnline && (
        <div className="bg-gradient-to-r from-amber-500 to-amber-600 text-white px-4 py-2.5 flex items-center justify-center gap-2 text-sm font-semibold shadow-md">
          <CloudOff size={15} />
          <span>Offline -- changes will sync when connected</span>
        </div>
      )}

      {/* Syncing indicator */}
      {isSyncing && (
        <div className="bg-gradient-to-r from-ocean-500 to-ocean-600 text-white px-4 py-2.5 flex items-center justify-center gap-2 text-sm font-semibold shadow-md">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
          <span>Syncing data...</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-auto">{children}</div>

      {/* WHY: Bottom tab bar with backdrop-blur creates a modern iOS/Android-style navigation.
          Safe area padding (pb-safe) ensures the tab bar sits above the home indicator on notch devices. */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl border-t border-gray-200/60 dark:border-gray-800/60 pb-safe z-50">
        <div className="flex items-center justify-around h-16 max-w-lg mx-auto px-2">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab);
            const badge = getBadge(tab.id);

            return (
              <button
                key={tab.id}
                onClick={() => navigate(tab.path)}
                className={clsx(
                  'flex flex-col items-center justify-center flex-1 h-full gap-0.5 transition-all duration-150 ease-out touch-feedback relative',
                  active ? tab.activeColor : 'text-gray-400 dark:text-gray-500',
                )}
              >
                {/* WHY: Active indicator bar on top of the icon — follows iOS Human Interface Guidelines
                    for selected tab state, more subtle than a full background fill. */}
                <div className="relative">
                  {active && (
                    <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-current transition-all duration-200" />
                  )}
                  <div className={clsx(
                    'p-1 rounded-xl transition-all duration-150',
                    active ? tab.activeBg : 'bg-transparent',
                  )}>
                    <Icon
                      size={21}
                      strokeWidth={active ? 2.5 : 1.8}
                      className="transition-all duration-150"
                    />
                  </div>
                  {/* WHY: Badge count on tab icons — immediate visibility of pending items without
                      navigating to the tab. Red badge follows platform convention for actionable items. */}
                  {badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 bg-coral-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1 shadow-sm border border-white dark:border-gray-900">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </div>
                <span className={clsx(
                  'text-[10px] font-semibold transition-all duration-150',
                  active ? 'opacity-100' : 'opacity-60',
                )}>
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
