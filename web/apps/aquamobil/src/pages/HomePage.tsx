import { useNavigate } from 'react-router-dom';
import { Fish, Skull, Scissors, Package, RefreshCw, LogOut, Waves, ArrowLeftRight, MapPin, ListChecks } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTanks } from '@/hooks/useTanks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import { useMyTasks } from '@/hooks/useMyTasks';
import { TankCard } from '@/components/cards/TankCard';
import { NotificationBell } from '@/components/NotificationBell';
import { clsx } from 'clsx';

interface QuickAction {
  feature: MobileFeature;
  path: string;
  icon: typeof Skull;
  label: string;
  gradient: string;
  iconColor: string;
}

const allQuickActions: QuickAction[] = [
  {
    feature: 'feeding',
    path: '/feeding/record',
    icon: Package,
    label: 'Yemleme',
    gradient: 'from-green-600 to-green-500',
    iconColor: 'text-white',
  },
  {
    feature: 'mortality',
    path: '/mortality/record',
    icon: Skull,
    label: 'Olum',
    gradient: 'from-red-500 to-red-600',
    iconColor: 'text-white',
  },
  {
    feature: 'cull',
    path: '/cull/record',
    icon: Scissors,
    label: 'Ayiklama',
    gradient: 'from-cull to-orange-600',
    iconColor: 'text-white',
  },
  {
    feature: 'harvest',
    path: '/harvest/record',
    icon: Package,
    label: 'Hasat',
    gradient: 'from-harvest to-violet-700',
    iconColor: 'text-white',
  },
  {
    feature: 'transfer',
    path: '/transfer/record',
    icon: ArrowLeftRight,
    label: 'Transfer',
    gradient: 'from-blue-500 to-blue-600',
    iconColor: 'text-white',
  },
  {
    feature: 'attendance',
    path: '/attendance',
    icon: MapPin,
    label: 'Yoklama',
    gradient: 'from-green-500 to-emerald-600',
    iconColor: 'text-white',
  },
];

export function HomePage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { data: tanks, isLoading, refetch, isRefetching } = useTanks();
  const { pendingCount, isOnline } = useOfflineQueue();
  const { canAccess } = useMobilePermissions();
  const { tasks: todayTasks } = useMyTasks('today');

  const allTanks = tanks || [];
  const activeTanks = allTanks.filter((t) => t.batchMetrics);

  const visibleActions = allQuickActions.filter((a) => canAccess(a.feature));

  const pendingTaskCount = todayTasks.length;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header with gradient */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white relative overflow-hidden">
        {/* Decorative elements */}
        <div className="absolute top-0 right-0 w-32 h-32 rounded-full bg-white/5 -translate-y-1/2 translate-x-1/4" />
        <div className="absolute bottom-0 left-0 w-24 h-24 rounded-full bg-white/5 translate-y-1/2 -translate-x-1/4" />

        <div className="relative z-10 px-5 pt-safe-top">
          {/* Top bar */}
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/15 backdrop-blur-sm rounded-xl flex items-center justify-center">
                <Fish size={22} className="text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">AquaMobil</h1>
                <p className="text-ocean-200 text-xs font-medium">{user?.name}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <NotificationBell />
              <button onClick={logout} className="p-2.5 bg-white/10 rounded-xl touch-feedback hover:bg-white/20 transition-colors">
                <LogOut size={18} />
              </button>
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3 pb-5">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">{allTanks.length}</div>
              <div className="text-ocean-200 text-[11px] font-medium">Toplam Tank</div>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
              <div className="text-2xl font-bold">{activeTanks.length}</div>
              <div className="text-ocean-200 text-[11px] font-medium">Batch'li</div>
            </div>
            <div className={clsx(
              'rounded-xl p-3 text-center backdrop-blur-sm',
              pendingCount > 0 ? 'bg-coral-500/30' : 'bg-sea-500/20'
            )}>
              <div className="text-2xl font-bold">{pendingCount}</div>
              <div className={clsx(
                'text-[11px] font-medium',
                pendingCount > 0 ? 'text-coral-200' : 'text-sea-200'
              )}>
                Bekleyen
              </div>
            </div>
          </div>
        </div>

        {/* Curved bottom edge */}
        <div className="absolute -bottom-px left-0 right-0">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Task Alert Banner */}
      {canAccess('tasks') && pendingTaskCount > 0 && (
        <div className="px-5 pt-4">
          <button
            onClick={() => navigate('/tasks')}
            className="w-full bg-gradient-to-r from-amber-500 to-amber-600 rounded-2xl p-4 shadow-card touch-feedback transition-all active:scale-[0.98] flex items-center gap-3"
          >
            <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
              <ListChecks size={22} className="text-white" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-white font-bold text-sm">
                {pendingTaskCount} gorev bugun sizi bekliyor
              </p>
              <p className="text-amber-100 text-xs mt-0.5">Gorevleri goruntule</p>
            </div>
            <div className="text-white/70">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </div>
          </button>
        </div>
      )}

      {/* Quick Actions */}
      {visibleActions.length > 0 && (
        <div className="px-5 pt-4">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">
            Hizli Islemler
          </h2>
          {/* PERF-09: Use a static lookup map instead of a template literal so Tailwind's
              JIT/PurgeCSS can detect the complete class strings at build time. */}
          <div className={({ 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-3', 6: 'grid-cols-3' } as Record<number, string>)[Math.min(visibleActions.length, 6)] + ' grid gap-3'}>
            {visibleActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.feature}
                  onClick={() => navigate(action.path)}
                  className={clsx(
                    'flex flex-col items-center p-4 rounded-2xl touch-feedback shadow-card',
                    `bg-gradient-to-br ${action.gradient}`
                  )}
                >
                  <Icon className={`${action.iconColor} mb-2`} size={26} />
                  <span className="text-sm font-semibold text-white">{action.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tanks */}
      <div className="px-5 pt-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Waves size={16} className="text-ocean-500" />
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Tanklar ({allTanks.length})
            </h2>
          </div>
          <button
            onClick={() => refetch()}
            disabled={isRefetching}
            className="p-2 text-ocean-500 touch-feedback rounded-lg hover:bg-ocean-50 dark:hover:bg-ocean-900/20 transition-colors"
          >
            <RefreshCw size={18} className={isRefetching ? 'animate-spin' : ''} />
          </button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-28 rounded-2xl skeleton" />
            ))}
          </div>
        ) : allTanks.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <Fish size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">Tank bulunamadi</p>
            {!isOnline && <p className="text-sm mt-1">Cevrimdisiniz - onbellek verisi gosteriliyor</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {allTanks.map((tank) => (
              <TankCard key={tank.id} tank={tank} />
            ))}
          </div>
        )}
      </div>

      {/* Bottom spacer for tab bar */}
      <div className="h-24" />
    </div>
  );
}
