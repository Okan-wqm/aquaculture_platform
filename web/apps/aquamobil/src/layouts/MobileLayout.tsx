import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page } from 'konsta/react';
import { Home, ClipboardList, CheckSquare, Users, MoreHorizontal, CloudOff } from 'lucide-react';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import { useNotifications } from '@/hooks/useNotifications';
import { clsx } from 'clsx';

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
}

// WHY: MobileLayout is the single shell for all authenticated pages — consistent bottom nav,
// offline banner, and safe area handling across all screens without duplication.
export function MobileLayout({ children }: MobileLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { pendingCount, isOnline, isSyncing } = useOfflineQueue();
  const { canAccess } = useMobilePermissions();
  const { unreadCount } = useNotifications();

  // WHY: Tab definitions with feature guards — tabs only appear if the user has access to at least
  // one feature in that category. This prevents showing nav items that lead to "no access" screens.
  const allTabs: TabItem[] = [
    { id: 'home', icon: Home, label: 'Home', path: '/', activeColor: 'text-ocean-600', activeBg: 'bg-ocean-50 dark:bg-ocean-900/30' },
    {
      id: 'record',
      icon: ClipboardList,
      label: 'Record',
      path: '/record',
      activeColor: 'text-orange-600',
      activeBg: 'bg-orange-50 dark:bg-orange-900/30',
      features: ['feeding', 'mortality', 'cull', 'harvest', 'transfer', 'waterQuality'],
    },
    {
      id: 'tasks',
      icon: CheckSquare,
      label: 'Tasks',
      path: '/tasks',
      activeColor: 'text-green-600',
      activeBg: 'bg-green-50 dark:bg-green-900/30',
      features: ['tasks'],
    },
    {
      id: 'hr',
      icon: Users,
      label: 'HR',
      path: '/hr',
      activeColor: 'text-violet-600',
      activeBg: 'bg-violet-50 dark:bg-violet-900/30',
      features: ['attendance', 'leave', 'schedule'],
    },
    {
      id: 'more',
      icon: MoreHorizontal,
      label: 'More',
      path: '/more',
      activeColor: 'text-gray-600',
      activeBg: 'bg-gray-100 dark:bg-gray-800',
    },
  ];

  const tabs = allTabs.filter((tab) => {
    if (!tab.features) return true;
    // Show tab if ANY of its features are enabled
    return tab.features.some((f) => canAccess(f));
  });

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  // WHY: Badge count aggregation — More tab shows pending sync count, we can also show
  // unread notifications as a combined indicator. Tasks tab could show today's count.
  const getBadge = (tabId: string): number => {
    if (tabId === 'more') return pendingCount + unreadCount;
    return 0;
  };

  return (
    <Page className="pb-safe">
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
            const active = isActive(tab.path);
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
    </Page>
  );
}
