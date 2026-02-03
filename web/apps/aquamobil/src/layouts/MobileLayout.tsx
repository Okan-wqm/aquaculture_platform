import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page } from 'konsta/react';
import { Home, Skull, Scissors, Package, Cloud, CloudOff } from 'lucide-react';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { clsx } from 'clsx';

interface MobileLayoutProps {
  children: ReactNode;
}

interface TabItem {
  id: string;
  icon: typeof Home;
  label: string;
  path: string;
  color?: string;
}

const tabs: TabItem[] = [
  { id: 'home', icon: Home, label: 'Home', path: '/' },
  { id: 'mortality', icon: Skull, label: 'Mortality', path: '/mortality/record', color: 'text-red-500' },
  { id: 'cull', icon: Scissors, label: 'Cull', path: '/cull/record', color: 'text-orange-500' },
  { id: 'harvest', icon: Package, label: 'Harvest', path: '/harvest/record', color: 'text-purple-500' },
  { id: 'sync', icon: Cloud, label: 'Sync', path: '/sync' },
];

export function MobileLayout({ children }: MobileLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { pendingCount, isOnline, isSyncing } = useOfflineQueue();

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path.replace('/record', ''));
  };

  return (
    <Page className="pb-safe">
      {/* Offline Banner */}
      {!isOnline && (
        <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium">
          <CloudOff size={16} />
          <span>Offline - Changes will sync when connected</span>
        </div>
      )}

      {/* Syncing indicator */}
      {isSyncing && (
        <div className="bg-aqua-500 text-white px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
          <span>Syncing data...</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-auto">{children}</div>

      {/* Bottom Tab Bar */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 pb-safe z-50">
        <div className="flex items-center justify-around h-16">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.path);
            const showBadge = tab.id === 'sync' && pendingCount > 0;

            return (
              <button
                key={tab.id}
                onClick={() => navigate(tab.path)}
                className={clsx(
                  'flex flex-col items-center justify-center w-full h-full gap-1 transition-colors touch-feedback',
                  active
                    ? tab.color || 'text-aqua-500'
                    : 'text-gray-500 dark:text-gray-400'
                )}
              >
                <div className="relative">
                  <Icon
                    size={24}
                    className={clsx(active && 'scale-110 transition-transform')}
                  />
                  {showBadge && (
                    <span className="absolute -top-1 -right-2 bg-red-500 text-white text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                </div>
                <span className="text-xs font-medium">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </Page>
  );
}
