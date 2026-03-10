import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page } from 'konsta/react';
import { Home, ClipboardList, CheckSquare, Users, MoreHorizontal, CloudOff } from 'lucide-react';
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
  // If features is set, tab shows if ANY of these features are enabled
  features?: MobileFeature[];
  getBadge?: () => number;
}

export function MobileLayout({ children }: MobileLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { pendingCount, isOnline, isSyncing } = useOfflineQueue();
  const { canAccess } = useMobilePermissions();

  const allTabs: TabItem[] = [
    { id: 'home', icon: Home, label: 'Ana Sayfa', path: '/', activeColor: 'text-ocean-600' },
    {
      id: 'record',
      icon: ClipboardList,
      label: 'Kayit',
      path: '/record',
      activeColor: 'text-orange-600',
      features: ['feeding', 'mortality', 'cull', 'harvest', 'transfer'],
    },
    {
      id: 'tasks',
      icon: CheckSquare,
      label: 'Gorevler',
      path: '/tasks',
      activeColor: 'text-green-600',
      features: ['tasks'],
    },
    {
      id: 'hr',
      icon: Users,
      label: 'IK',
      path: '/hr',
      activeColor: 'text-violet-600',
      features: ['attendance', 'leave', 'schedule'],
    },
    {
      id: 'more',
      icon: MoreHorizontal,
      label: 'Diger',
      path: '/more',
      activeColor: 'text-gray-600',
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

  return (
    <Page className="pb-safe">
      {/* Offline Banner */}
      {!isOnline && (
        <div className="bg-gradient-to-r from-amber-500 to-amber-600 text-white px-4 py-2.5 flex items-center justify-center gap-2 text-sm font-medium shadow-md">
          <CloudOff size={16} />
          <span>Cevrimdisi - Degisiklikler baglaninca senkronize edilecek</span>
        </div>
      )}

      {/* Syncing indicator */}
      {isSyncing && (
        <div className="bg-gradient-to-r from-ocean-500 to-ocean-600 text-white px-4 py-2.5 flex items-center justify-center gap-2 text-sm font-medium shadow-md">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
          <span>Veri senkronize ediliyor...</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-auto">{children}</div>

      {/* Bottom Tab Bar */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-t border-gray-200/60 pb-safe z-50">
        <div className="flex items-center justify-around h-16 max-w-lg mx-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.path);
            // Badge logic: More tab shows pending + unread, Tasks could show count
            const showBadge = tab.id === 'more' && pendingCount > 0;

            return (
              <button
                key={tab.id}
                onClick={() => navigate(tab.path)}
                className={clsx(
                  'flex flex-col items-center justify-center w-full h-full gap-0.5 transition-all touch-feedback',
                  active
                    ? tab.activeColor
                    : 'text-gray-400'
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
