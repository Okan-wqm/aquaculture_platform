import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page } from 'konsta/react';
import { Home, Skull, Scissors, Package, Cloud, CloudOff, Clock } from 'lucide-react';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
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
  feature?: MobileFeature;
}

const allTabs: TabItem[] = [
  { id: 'home', icon: Home, label: 'Home', path: '/', activeColor: 'text-ocean-600' },
  { id: 'mortality', icon: Skull, label: 'Mortality', path: '/mortality/record', activeColor: 'text-mortality', feature: 'mortality' },
  { id: 'cull', icon: Scissors, label: 'Cull', path: '/cull/record', activeColor: 'text-cull', feature: 'cull' },
  { id: 'harvest', icon: Package, label: 'Harvest', path: '/harvest/record', activeColor: 'text-harvest', feature: 'harvest' },
  { id: 'schedule', icon: Clock, label: 'Schedule', path: '/schedule', activeColor: 'text-ocean-600', feature: 'schedule' },
  { id: 'sync', icon: Cloud, label: 'Sync', path: '/sync', activeColor: 'text-ocean-600' },
];

export function MobileLayout({ children }: MobileLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { pendingCount, isOnline, isSyncing } = useOfflineQueue();
  const { canAccess } = useMobilePermissions();

  const tabs = allTabs.filter((tab) => {
    if (!tab.feature) return true;
    return canAccess(tab.feature);
  });

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path.replace('/record', ''));
  };

  return (
    <Page className="pb-safe">
      {/* Offline Banner */}
      {!isOnline && (
        <div className="bg-gradient-to-r from-amber-500 to-amber-600 text-white px-4 py-2.5 flex items-center justify-center gap-2 text-sm font-medium shadow-md">
          <CloudOff size={16} />
          <span>Offline - Changes will sync when connected</span>
        </div>
      )}

      {/* Syncing indicator */}
      {isSyncing && (
        <div className="bg-gradient-to-r from-ocean-500 to-ocean-600 text-white px-4 py-2.5 flex items-center justify-center gap-2 text-sm font-medium shadow-md">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
          <span>Syncing data...</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-auto">{children}</div>

      {/* Bottom Tab Bar */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 dark:bg-gray-900/90 backdrop-blur-lg border-t border-gray-200/60 dark:border-gray-800 pb-safe z-50">
        <div className="flex items-center justify-around h-16 max-w-lg mx-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.path);
            const showBadge = tab.id === 'sync' && pendingCount > 0;

            return (
              <button
                key={tab.id}
                onClick={() => navigate(tab.path)}
                className={clsx(
                  'flex flex-col items-center justify-center w-full h-full gap-0.5 transition-all touch-feedback',
                  active
                    ? tab.activeColor
                    : 'text-gray-400 dark:text-gray-500'
                )}
              >
                <div className="relative">
                  {active && (
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-6 h-0.5 rounded-full bg-current" />
                  )}
                  <Icon
                    size={22}
                    strokeWidth={active ? 2.5 : 2}
                    className="mt-1"
                  />
                  {showBadge && (
                    <span className="absolute -top-1 -right-2.5 bg-coral-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 shadow-sm">
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                </div>
                <span className={clsx('text-[10px] font-semibold', active ? 'opacity-100' : 'opacity-70')}>
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
