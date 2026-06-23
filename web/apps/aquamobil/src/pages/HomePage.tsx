import { clsx } from 'clsx';
import { Fish, Skull, Scissors, Package, RefreshCw, LogOut, Waves, ArrowLeftRight, MapPin, ListChecks, Activity, AlertTriangle, CalendarOff, Droplets, Warehouse, ShieldAlert } from 'lucide-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';

import { AiInsightsCard } from '@/components/ai';
import { TankCard } from '@/components/cards/TankCard';
import { NotificationBell } from '@/components/NotificationBell';
import { useAuth } from '@/hooks/useAuth';
import { useMobilePermissions, type MobileFeature } from '@/hooks/useMobilePermissions';
import { useMyTasks } from '@/hooks/useMyTasks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTanks } from '@/hooks/useTanks';
import { useFeatureAccess } from '@/utils/feature-access';

interface QuickAction {
  feature: MobileFeature;
  path: string;
  icon: typeof Skull;
  label: string;
  gradient: string;
  iconColor: string;
}

// WHY: Quick actions are the primary CTA grid — each maps to a high-frequency field operation.
// Only permitted features are shown, so the grid density adapts to the user's role.
const allQuickActions: QuickAction[] = [
  {
    feature: 'feeding',
    path: '/feeding/record',
    icon: Package,
    label: 'Feeding',
    gradient: 'from-green-600 to-green-500',
    iconColor: 'text-white',
  },
  {
    feature: 'mortality',
    path: '/mortality/record',
    icon: Skull,
    label: 'Mortality',
    gradient: 'from-red-500 to-red-600',
    iconColor: 'text-white',
  },
  {
    feature: 'cull',
    path: '/cull/record',
    icon: Scissors,
    label: 'Culling',
    gradient: 'from-cull to-orange-600',
    iconColor: 'text-white',
  },
  {
    feature: 'harvest',
    path: '/harvest/record',
    icon: Package,
    label: 'Harvest',
    gradient: 'from-harvest to-violet-700',
    iconColor: 'text-white',
  },
  {
    feature: 'waterQuality',
    path: '/water-quality/record',
    icon: Droplets,
    label: 'Water Quality',
    gradient: 'from-cyan-500 to-blue-500',
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
    label: 'Clock In',
    gradient: 'from-emerald-500 to-emerald-600',
    iconColor: 'text-white',
  },
  {
    feature: 'leave',
    path: '/leave',
    icon: CalendarOff,
    label: 'Leave',
    gradient: 'from-indigo-500 to-indigo-600',
    iconColor: 'text-white',
  },
  {
    feature: 'storage',
    path: '/storage',
    icon: Warehouse,
    label: 'Storage',
    gradient: 'from-teal-500 to-teal-600',
    iconColor: 'text-white',
  },
];

export function HomePage(): JSX.Element {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { data: tanks, isLoading, refetch, isRefetching } = useTanks();
  const { pendingCount, isOnline } = useOfflineQueue();
  const { canAccess, permissionsDegraded, permissionSource, refreshPermissions } = useMobilePermissions();
  // SEC-MEDIUM-050: canReach folds the entitlement flag with any feature role
  // floor (harvest => MODULE_MANAGER), so the harvest CTA disappears for a
  // MODULE_USER exactly as the route guard and backend @Roles require.
  const { canReach } = useFeatureAccess();
  const { tasks: todayTasks } = useMyTasks('today');

  const allTanks = tanks || [];
  const activeTanks = allTanks.filter((t) => t.batchMetrics);

  const visibleActions = allQuickActions.filter((a) => canReach(a.feature));

  const pendingTaskCount = todayTasks.length;

  // WHY: Aggregate stats give managers a quick operational pulse without scrolling through individual tanks.
  const totalFish = activeTanks.reduce((sum, t) => sum + (t.batchMetrics?.pieces ?? 0), 0);
  const totalBiomass = activeTanks.reduce((sum, t) => sum + (t.batchMetrics?.biomass ?? t.currentBiomass ?? 0), 0);
  const overCapacityCount = activeTanks.filter((t) => t.batchMetrics?.isOverCapacity).length;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* WHY: Gradient header with decorative circles creates visual depth and brand consistency.
          The ocean-blue gradient is the app's primary brand color from the design system. */}
      <div className="bg-gradient-to-br from-ocean-700 via-ocean-600 to-ocean-500 text-white relative overflow-hidden">
        {/* Decorative elements */}
        <div className="absolute top-0 right-0 w-40 h-40 rounded-full bg-white/5 -translate-y-1/2 translate-x-1/4" />
        <div className="absolute bottom-4 left-0 w-28 h-28 rounded-full bg-white/5 translate-y-1/2 -translate-x-1/4" />
        <div className="absolute top-1/2 right-1/4 w-16 h-16 rounded-full bg-white/3" />

        <div className="relative z-10 px-5 pt-safe-top">
          {/* Top bar */}
          <div className="flex items-center justify-between py-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-white/15 backdrop-blur-sm rounded-2xl flex items-center justify-center shadow-inner-glow">
                <Fish size={24} className="text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">AquaMobil</h1>
                <p className="text-ocean-200 text-xs font-medium">{user?.name}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <NotificationBell />
              <button onClick={() => void logout()} className="p-2.5 bg-white/10 rounded-xl touch-feedback hover:bg-white/20 transition-colors">
                <LogOut size={18} />
              </button>
            </div>
          </div>

          {/* WHY: Four-column stats row provides an operational dashboard at the top of the home screen.
              Pending sync count uses a warning color to draw attention when offline operations are queued. */}
          <div className="grid grid-cols-4 gap-2.5 pb-5">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2.5 text-center">
              <div className="text-xl font-bold tabular-nums">{allTanks.length}</div>
              <div className="text-ocean-200 text-[10px] font-semibold">Tanks</div>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2.5 text-center">
              <div className="text-xl font-bold tabular-nums">{activeTanks.length}</div>
              <div className="text-ocean-200 text-[10px] font-semibold">Batches</div>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-2.5 text-center">
              <div className="text-xl font-bold tabular-nums">
                {totalFish >= 1000 ? `${(totalFish / 1000).toFixed(0)}K` : totalFish}
              </div>
              <div className="text-ocean-200 text-[10px] font-semibold">Total Fish</div>
            </div>
            <div className={clsx(
              'rounded-xl p-2.5 text-center backdrop-blur-sm',
              pendingCount > 0 ? 'bg-coral-500/30' : 'bg-sea-500/20'
            )}>
              <div className="text-xl font-bold tabular-nums">{pendingCount}</div>
              <div className={clsx(
                'text-[10px] font-semibold',
                pendingCount > 0 ? 'text-coral-200' : 'text-sea-200'
              )}>
                Pending
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

      {/* WHY: Alert banners for critical conditions — over-capacity tanks need immediate attention,
          so they appear prominently between the header and content. */}
      {overCapacityCount > 0 && (
        <div className="px-5 pt-4">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-3.5 flex items-center gap-3">
            <div className="w-9 h-9 bg-red-100 dark:bg-red-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
              <AlertTriangle size={18} className="text-red-500" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-bold text-red-700 dark:text-red-300">
                {overCapacityCount} tank{overCapacityCount > 1 ? 's' : ''} over capacity
              </p>
              <p className="text-xs text-red-500 dark:text-red-400 mt-0.5">Consider harvesting or transferring</p>
            </div>
          </div>
        </div>
      )}

      {/* SECURITY: fail-closed degradation banner — informs the user that
          permissions could not be verified and some features may be hidden. */}
      {permissionsDegraded && (
        <div className="px-5 pt-4">
          <button
            onClick={() => { void refreshPermissions(); }}
            className="w-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-3.5 flex items-center gap-3 touch-feedback"
          >
            <div className="w-9 h-9 bg-amber-100 dark:bg-amber-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
              <ShieldAlert size={18} className="text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 text-left">
              <p className="text-sm font-bold text-amber-700 dark:text-amber-300">
                {permissionSource === 'fail-closed'
                  ? 'Permissions unavailable'
                  : 'Using cached permissions'}
              </p>
              <p className="text-xs text-amber-500 dark:text-amber-400 mt-0.5">
                {permissionSource === 'fail-closed'
                  ? 'Some features are hidden. Tap to retry.'
                  : 'Feature access may be outdated. Tap to refresh.'}
              </p>
            </div>
          </button>
        </div>
      )}

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
                {pendingTaskCount} task{pendingTaskCount > 1 ? 's' : ''} waiting for you today
              </p>
              <p className="text-amber-100 text-xs mt-0.5">Tap to view</p>
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
          <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
            Quick Actions
          </h2>
          {/* PERF-09: Use a static lookup map instead of a template literal so Tailwind's
              JIT/PurgeCSS can detect the complete class strings at build time. */}
          <div className={({ 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-3', 6: 'grid-cols-3', 7: 'grid-cols-4' } as Record<number, string>)[Math.min(visibleActions.length, 7)] + ' grid gap-2.5'}>
            {visibleActions.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.feature}
                  onClick={() => navigate(action.path)}
                  className={clsx(
                    'flex flex-col items-center p-3.5 rounded-2xl touch-feedback shadow-card transition-all active:scale-[0.95]',
                    `bg-gradient-to-br ${action.gradient}`
                  )}
                >
                  <Icon className={`${action.iconColor} mb-1.5`} size={24} />
                  <span className="text-[11px] font-bold text-white">{action.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* WHY: Biomass summary bar — provides aggregate farm-level KPI without needing to open reports.
          Field managers use this to track overall farm health between formal reporting periods. */}
      {activeTanks.length > 0 && (
        <div className="px-5 pt-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Activity size={14} className="text-ocean-500" />
              <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Farm Summary</h3>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <div className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                  {totalFish >= 1000000 ? `${(totalFish / 1000000).toFixed(1)}M` : totalFish >= 1000 ? `${(totalFish / 1000).toFixed(1)}K` : totalFish}
                </div>
                <div className="text-[10px] text-gray-400 font-semibold">Total Fish</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                  {totalBiomass >= 1000 ? `${(totalBiomass / 1000).toFixed(1)}t` : `${totalBiomass.toFixed(0)}kg`}
                </div>
                <div className="text-[10px] text-gray-400 font-semibold">Biomass</div>
              </div>
              <div className="text-center">
                <div className={clsx(
                  'text-lg font-bold tabular-nums',
                  overCapacityCount > 0 ? 'text-red-500' : 'text-emerald-500',
                )}>
                  {overCapacityCount > 0 ? overCapacityCount : 'OK'}
                </div>
                <div className="text-[10px] text-gray-400 font-semibold">
                  {overCapacityCount > 0 ? 'Over Cap' : 'Capacity'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* WHY: AI insights card on home dashboard gives the farm manager an at-a-glance
          intelligence summary without navigating to individual tanks. Positioned after
          the Farm Summary and before the Tanks list — supplementary AI intelligence
          above the primary operational data. */}
      <div className="px-5 pt-4">
        <AiInsightsCard />
      </div>

      {/* Tanks */}
      <div className="px-5 pt-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Waves size={14} className="text-ocean-500" />
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
              Tanks ({allTanks.length})
            </h2>
          </div>
          <button
            onClick={() => { void refetch(); }}
            disabled={isRefetching}
            className="p-2 text-ocean-500 touch-feedback rounded-lg hover:bg-ocean-50 dark:hover:bg-ocean-900/20 transition-colors"
          >
            <RefreshCw size={18} className={isRefetching ? 'animate-spin' : ''} />
          </button>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 rounded-2xl skeleton" />
            ))}
          </div>
        ) : allTanks.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <Fish size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No tanks found</p>
            {!isOnline && <p className="text-sm mt-1">You are offline - showing cached data</p>}
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
