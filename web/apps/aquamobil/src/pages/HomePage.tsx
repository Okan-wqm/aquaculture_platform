import { useNavigate } from 'react-router-dom';
import { Navbar, Block, BlockTitle } from 'konsta/react';
import { Fish, Skull, Scissors, Package, RefreshCw, LogOut } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTanks } from '@/hooks/useTanks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { TankCard } from '@/components/cards/TankCard';
import { clsx } from 'clsx';

export function HomePage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { data: tanks, isLoading, refetch, isRefetching } = useTanks();
  const { pendingCount, isOnline } = useOfflineQueue();

  const activeTanks = tanks?.filter((t) => t.currentBatch) || [];
  const emptyTanks = tanks?.filter((t) => !t.currentBatch) || [];

  return (
    <>
      <Navbar
        title="AquaMobil"
        subtitle={user?.name}
        right={
          <button onClick={logout} className="p-2 text-gray-500">
            <LogOut size={20} />
          </button>
        }
      />

      {/* Quick Stats */}
      <Block className="!mt-0">
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-aqua-50 dark:bg-aqua-900/20 rounded-xl p-3 text-center">
            <Fish className="mx-auto text-aqua-500 mb-1" size={24} />
            <div className="text-2xl font-bold text-aqua-700 dark:text-aqua-300">
              {activeTanks.length}
            </div>
            <div className="text-xs text-aqua-600 dark:text-aqua-400">Active Tanks</div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-3 text-center">
            <div className="text-2xl font-bold text-gray-700 dark:text-gray-300">
              {emptyTanks.length}
            </div>
            <div className="text-xs text-gray-500">Empty</div>
          </div>
          <div
            className={clsx(
              'rounded-xl p-3 text-center',
              pendingCount > 0
                ? 'bg-amber-50 dark:bg-amber-900/20'
                : 'bg-green-50 dark:bg-green-900/20'
            )}
          >
            <div
              className={clsx(
                'text-2xl font-bold',
                pendingCount > 0
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-green-700 dark:text-green-300'
              )}
            >
              {pendingCount}
            </div>
            <div
              className={clsx(
                'text-xs',
                pendingCount > 0
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-green-600 dark:text-green-400'
              )}
            >
              Pending Sync
            </div>
          </div>
        </div>
      </Block>

      {/* Quick Actions */}
      <BlockTitle>Quick Actions</BlockTitle>
      <Block>
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={() => navigate('/mortality/record')}
            className="flex flex-col items-center p-4 bg-red-50 dark:bg-red-900/20 rounded-xl touch-feedback"
          >
            <Skull className="text-red-500 mb-2" size={28} />
            <span className="text-sm font-medium text-red-700 dark:text-red-300">Mortality</span>
          </button>
          <button
            onClick={() => navigate('/cull/record')}
            className="flex flex-col items-center p-4 bg-orange-50 dark:bg-orange-900/20 rounded-xl touch-feedback"
          >
            <Scissors className="text-orange-500 mb-2" size={28} />
            <span className="text-sm font-medium text-orange-700 dark:text-orange-300">Cull</span>
          </button>
          <button
            onClick={() => navigate('/harvest/record')}
            className="flex flex-col items-center p-4 bg-purple-50 dark:bg-purple-900/20 rounded-xl touch-feedback"
          >
            <Package className="text-purple-500 mb-2" size={28} />
            <span className="text-sm font-medium text-purple-700 dark:text-purple-300">Harvest</span>
          </button>
        </div>
      </Block>

      {/* Active Tanks */}
      <div className="flex items-center justify-between px-4 mt-4">
        <BlockTitle className="!m-0">Active Tanks</BlockTitle>
        <button
          onClick={() => refetch()}
          disabled={isRefetching}
          className="p-2 text-aqua-500 touch-feedback"
        >
          <RefreshCw size={20} className={isRefetching ? 'animate-spin' : ''} />
        </button>
      </div>

      <Block>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-gray-100 dark:bg-gray-800 rounded-xl skeleton" />
            ))}
          </div>
        ) : activeTanks.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Fish size={48} className="mx-auto mb-2 opacity-30" />
            <p>No active tanks found</p>
            {!isOnline && <p className="text-sm">You're offline - showing cached data</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {activeTanks.map((tank) => (
              <TankCard key={tank.id} tank={tank} />
            ))}
          </div>
        )}
      </Block>

      {/* Spacer for bottom nav */}
      <div className="h-20" />
    </>
  );
}
