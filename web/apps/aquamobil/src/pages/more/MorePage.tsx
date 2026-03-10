import { useNavigate } from 'react-router-dom';
import { Cloud, Bell, LogOut, MoreHorizontal, ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useNotifications } from '@/hooks/useNotifications';

interface MenuItem {
  id: string;
  icon: typeof Cloud;
  label: string;
  path?: string;
  action?: () => void;
  iconColor: string;
  iconBg: string;
  badge?: number;
}

export function MorePage() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { pendingCount } = useOfflineQueue();
  const { unreadCount } = useNotifications();

  const menuItems: MenuItem[] = [
    {
      id: 'sync',
      icon: Cloud,
      label: 'Senkronizasyon',
      path: '/sync',
      iconColor: 'text-ocean-600',
      iconBg: 'bg-ocean-50 dark:bg-ocean-900/30',
      badge: pendingCount,
    },
    {
      id: 'notifications',
      icon: Bell,
      label: 'Bildirimler',
      path: '/notifications',
      iconColor: 'text-amber-600',
      iconBg: 'bg-amber-50 dark:bg-amber-900/30',
      badge: unreadCount,
    },
    {
      id: 'logout',
      icon: LogOut,
      label: 'Cikis Yap',
      action: logout,
      iconColor: 'text-red-600',
      iconBg: 'bg-red-50 dark:bg-red-900/30',
    },
  ];

  const handlePress = (item: MenuItem) => {
    if (item.action) {
      item.action();
    } else if (item.path) {
      navigate(item.path);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white">
        <div className="px-5 pt-safe-top">
          <div className="flex items-center gap-3 py-4">
            <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
              <MoreHorizontal size={22} className="text-white" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">Diger</h1>
          </div>
        </div>
        <div className="relative">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Menu list */}
      <div className="px-5 pt-4">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800">
          {menuItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => handlePress(item)}
                className={`w-full flex items-center gap-4 p-4 touch-feedback transition-all text-left ${
                  index < menuItems.length - 1 ? 'border-b border-gray-50 dark:border-gray-800' : ''
                }`}
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${item.iconBg}`}>
                  <Icon size={20} className={item.iconColor} />
                </div>
                <span className="flex-1 font-medium text-gray-900 dark:text-white">{item.label}</span>
                {item.badge != null && item.badge > 0 && (
                  <span className="bg-red-500 text-white text-[11px] font-bold rounded-full min-w-[22px] h-[22px] flex items-center justify-center px-1.5">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
                {item.path && (
                  <ChevronRight size={18} className="text-gray-300 dark:text-gray-600" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
