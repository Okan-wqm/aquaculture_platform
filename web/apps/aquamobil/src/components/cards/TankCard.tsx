import { useNavigate } from 'react-router-dom';
import { Skull, Scissors, Package } from 'lucide-react';
import type { Tank } from '@/types';
import { clsx } from 'clsx';
// BUG-09: Import permissions hook to conditionally render action buttons
import { useMobilePermissions } from '@/hooks/useMobilePermissions';

interface TankCardProps {
  tank: Tank;
}

const STATUS_CONFIG: Record<string, { dot: string; label: string }> = {
  ACTIVE: { dot: 'bg-sea-500', label: 'Active' },
  MAINTENANCE: { dot: 'bg-amber-500', label: 'Maintenance' },
  QUARANTINE: { dot: 'bg-red-500', label: 'Quarantine' },
  PREPARING: { dot: 'bg-ocean-500', label: 'Preparing' },
  HARVESTING: { dot: 'bg-harvest', label: 'Harvesting' },
  INACTIVE: { dot: 'bg-gray-400', label: 'Inactive' },
};

export function TankCard({ tank }: TankCardProps) {
  const navigate = useNavigate();
  // BUG-09: Check feature permissions so buttons that would redirect back to /
  // via FeatureRoute are not shown at all, avoiding the navigation flash.
  const { canAccess } = useMobilePermissions();
  const metrics = tank.batchMetrics;
  const hasBatch = !!metrics?.batchId;
  const status = STATUS_CONFIG[tank.status] || STATUS_CONFIG.INACTIVE;

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card overflow-hidden border border-gray-100 dark:border-gray-800">
      {/* BUG-06: Header — clickable to navigate to tank detail */}
      <button
        onClick={() => navigate(`/tank/${tank.id}`)}
        className="w-full px-4 py-3 flex items-center justify-between text-left touch-feedback hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <h3 className="font-semibold text-gray-900 dark:text-white text-[15px]">{tank.name}</h3>
            <p className="text-xs text-gray-400 font-medium">{tank.code} &middot; {tank.volume > 0 ? `${tank.volume}m\u00B3` : 'Not configured'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasBatch && (
            <span className="text-xs font-semibold text-ocean-600 dark:text-ocean-400 bg-ocean-50 dark:bg-ocean-900/30 px-2 py-0.5 rounded-md">
              {metrics.batchNumber}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
            <span className={clsx('w-2 h-2 rounded-full', status.dot)} />
            {status.label}
          </span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </div>
      </button>

      {/* Stats */}
      {hasBatch ? (
        <div className="grid grid-cols-3 border-t border-gray-50 dark:border-gray-800">
          <div className="px-4 py-3 text-center">
            <div className="text-lg font-bold text-gray-900 dark:text-white">
              {formatNumber(metrics.pieces ?? 0)}
            </div>
            <div className="text-[11px] text-gray-400 font-medium">Fish</div>
          </div>
          <div className="px-4 py-3 text-center border-x border-gray-50 dark:border-gray-800">
            <div className="text-lg font-bold text-gray-900 dark:text-white">
              {(metrics.avgWeight ?? 0).toFixed(0)}g
            </div>
            <div className="text-[11px] text-gray-400 font-medium">Avg Weight</div>
          </div>
          <div className="px-4 py-3 text-center">
            <div className="text-lg font-bold text-gray-900 dark:text-white">
              {(metrics.biomass ?? tank.currentBiomass ?? 0).toFixed(0)}kg
            </div>
            <div className="text-[11px] text-gray-400 font-medium">Biomass</div>
          </div>
        </div>
      ) : (
        <div className="border-t border-gray-50 dark:border-gray-800">
          <div className="grid grid-cols-2">
            <div className="px-4 py-3 text-center">
              <div className="text-lg font-bold text-gray-900 dark:text-white">
                {tank.currentBiomass > 0 ? `${tank.currentBiomass.toFixed(0)}kg` : '--'}
              </div>
              <div className="text-[11px] text-gray-400 font-medium">
                {tank.currentBiomass > 0 ? 'Biomass' : 'Not configured'}
              </div>
            </div>
            <div className="px-4 py-3 text-center border-l border-gray-50 dark:border-gray-800">
              <div className="text-lg font-bold text-gray-900 dark:text-white">
                {tank.maxBiomass > 0 ? `${formatNumber(tank.maxBiomass)}kg` : '--'}
              </div>
              <div className="text-[11px] text-gray-400 font-medium">
                {tank.maxBiomass > 0 ? 'Max Capacity' : 'Not configured'}
              </div>
            </div>
          </div>
          {tank.status === 'ACTIVE' && (
            <p className="text-xs text-gray-300 text-center pb-3">No active batch</p>
          )}
        </div>
      )}

      {/* Action buttons - only for tanks with batches, only for permitted features */}
      {hasBatch && (canAccess('mortality') || canAccess('cull') || canAccess('harvest')) && (
        <div className="flex border-t border-gray-50 dark:border-gray-800">
          {canAccess('mortality') && (
            <button
              onClick={() => navigate(`/mortality/record/${tank.id}`)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-mortality hover:bg-mortality-light dark:hover:bg-red-900/20 touch-feedback transition-colors border-r border-gray-50 dark:border-gray-800 last:border-r-0"
            >
              <Skull size={16} />
              <span className="text-xs font-semibold">Mortality</span>
            </button>
          )}
          {canAccess('cull') && (
            <button
              onClick={() => navigate(`/cull/record/${tank.id}`)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-cull hover:bg-cull-light dark:hover:bg-orange-900/20 touch-feedback transition-colors border-r border-gray-50 dark:border-gray-800 last:border-r-0"
            >
              <Scissors size={16} />
              <span className="text-xs font-semibold">Cull</span>
            </button>
          )}
          {canAccess('harvest') && (
            <button
              onClick={() => navigate(`/harvest/record/${tank.id}`)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-harvest hover:bg-harvest-light dark:hover:bg-purple-900/20 touch-feedback transition-colors border-r border-gray-50 dark:border-gray-800 last:border-r-0"
            >
              <Package size={16} />
              <span className="text-xs font-semibold">Harvest</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
