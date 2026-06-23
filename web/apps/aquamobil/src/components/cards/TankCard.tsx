import { clsx } from 'clsx';
import { Skull, Scissors, Package, ArrowLeftRight } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Tank } from '@/types';
// BUG-09: feature permissions gate the action buttons so a button that would
// redirect back to / via FeatureRoute is not rendered at all.
// SEC-MEDIUM-050: canReach also enforces feature role floors (harvest => MODULE_MANAGER).
import { useFeatureAccess } from '@/utils/feature-access';

interface TankCardProps {
  tank: Tank;
}

// WHY: Gradient headers make tank status immediately scannable — color encodes operational state
// so field workers can triage at a glance without reading text labels.
const STATUS_CONFIG: Record<string, { dot: string; gradient: string; label: string }> = {
  ACTIVE: { dot: 'bg-sky-400', gradient: 'from-sky-500 to-blue-600', label: 'Active' },
  MAINTENANCE: { dot: 'bg-amber-400', gradient: 'from-amber-500 to-orange-600', label: 'Maintenance' },
  QUARANTINE: { dot: 'bg-red-400', gradient: 'from-red-500 to-rose-600', label: 'Quarantine' },
  PREPARING: { dot: 'bg-cyan-400', gradient: 'from-cyan-500 to-blue-600', label: 'Preparing' },
  HARVESTING: { dot: 'bg-violet-400', gradient: 'from-violet-500 to-purple-600', label: 'Harvesting' },
  INACTIVE: { dot: 'bg-gray-400', gradient: 'from-gray-400 to-gray-500', label: 'Inactive' },
};

export function TankCard({ tank }: TankCardProps): ReactElement {
  const navigate = useNavigate();
  // BUG-09: Check feature permissions so buttons that would redirect back to /
  // via FeatureRoute are not shown at all, avoiding the navigation flash.
  // SEC-MEDIUM-050: canReach folds in the harvest MODULE_MANAGER role floor.
  const { canReach } = useFeatureAccess();
  const metrics = tank.batchMetrics;
  const hasBatch = !!metrics?.batchId;
  const status = STATUS_CONFIG[tank.status] || STATUS_CONFIG.INACTIVE;

  // WHY: Capacity percentage drives the progress bar color — visual urgency scales with fill level
  // so overcrowding risks are immediately apparent without reading numbers.
  const capacityPercent = metrics?.capacityUsedPercent ?? (
    tank.maxBiomass > 0 ? ((tank.currentBiomass / tank.maxBiomass) * 100) : 0
  );
  const capacityColor = capacityPercent > 90
    ? 'bg-red-500'
    : capacityPercent > 70
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg overflow-hidden border border-gray-100 dark:border-gray-800">
      {/* WHY: Gradient header with status color — enables rapid visual scanning across tank list.
          The pulse dot on active tanks draws attention to tanks that need daily operations. */}
      <button
        onClick={() => navigate(`/tank/${tank.id}`)}
        className={clsx(
          'w-full px-4 py-3.5 flex items-center justify-between text-left touch-feedback transition-all',
          `bg-gradient-to-r ${status.gradient}`,
        )}
      >
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <h3 className="font-bold text-white text-[15px] tracking-tight">{tank.name}</h3>
            <p className="text-xs text-white/70 font-medium">
              {tank.code} &middot; {tank.volume > 0 ? `${tank.volume}m\u00B3` : 'Not configured'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {hasBatch && (
            <span className="text-xs font-bold text-white bg-white/20 backdrop-blur-sm px-2.5 py-1 rounded-lg">
              {metrics.batchNumber}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs font-semibold text-white/90">
            {/* WHY: Pulse animation on active tanks signals "alive" status — immediately distinguishes
                operational tanks from idle ones in a scrollable list. */}
            <span className={clsx(
              'w-2.5 h-2.5 rounded-full border border-white/30',
              status.dot,
              tank.status === 'ACTIVE' && 'animate-pulse',
            )} />
            {status.label}
          </span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/60">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </div>
      </button>

      {/* WHY: Stat grid with batch metrics — fish count, avg weight, and biomass are the three
          primary metrics field workers need for daily feeding/health decisions. */}
      {hasBatch ? (
        <div className="px-4 py-3.5">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                {formatNumber(metrics.pieces ?? 0)}
              </div>
              <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Fish</div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                {(metrics.avgWeight ?? 0).toFixed(0)}g
              </div>
              <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Avg Wt</div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                {(metrics.biomass ?? tank.currentBiomass ?? 0).toFixed(0)}
                <span className="text-xs text-gray-400 font-medium">kg</span>
              </div>
              <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Biomass</div>
            </div>
          </div>

          {/* WHY: Capacity progress bar — visual fill indicator is faster to parse than a percentage number.
              Color coding (green/amber/red) follows universal traffic-light convention for urgency. */}
          {capacityPercent > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Capacity</span>
                <span className={clsx(
                  'text-[10px] font-bold',
                  capacityPercent > 90 ? 'text-red-500' : capacityPercent > 70 ? 'text-amber-500' : 'text-emerald-500',
                )}>
                  {capacityPercent.toFixed(0)}%
                </span>
              </div>
              <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={clsx('h-full rounded-full transition-all duration-500 ease-out', capacityColor)}
                  style={{ width: `${Math.min(capacityPercent, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="px-4 py-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                {tank.currentBiomass > 0 ? `${tank.currentBiomass.toFixed(0)}kg` : '--'}
              </div>
              <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">
                {tank.currentBiomass > 0 ? 'Biomass' : 'Not configured'}
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-2.5 text-center">
              <div className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                {tank.maxBiomass > 0 ? `${formatNumber(tank.maxBiomass)}kg` : '--'}
              </div>
              <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">
                {tank.maxBiomass > 0 ? 'Max Cap' : 'Not configured'}
              </div>
            </div>
          </div>
          {/* WHY: "No active batch" badge on otherwise-active tanks signals the tank is ready
              for stocking — prevents confusion about why there are no fish metrics. */}
          {tank.status === 'ACTIVE' && (
            <div className="mt-2.5 flex justify-center">
              <span className="text-xs font-medium text-gray-400 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded-full">
                No active batch
              </span>
            </div>
          )}
        </div>
      )}

      {/* WHY: Action buttons only render for tanks with batches AND for features the user has permission for.
          This prevents dead-end navigation where FeatureRoute would redirect back to home. */}
      {hasBatch && (canReach('mortality') || canReach('cull') || canReach('harvest') || canReach('transfer')) && (
        <div className="flex border-t border-gray-100 dark:border-gray-800">
          {canReach('mortality') && (
            <button
              onClick={() => navigate(`/mortality/record/${tank.id}`)}
              className="flex-1 flex items-center justify-center gap-1.5 py-3 text-mortality hover:bg-mortality-light dark:hover:bg-red-900/20 touch-feedback transition-colors border-r border-gray-100 dark:border-gray-800 last:border-r-0"
            >
              <Skull size={15} />
              <span className="text-xs font-bold">Mortality</span>
            </button>
          )}
          {canReach('cull') && (
            <button
              onClick={() => navigate(`/cull/record/${tank.id}`)}
              className="flex-1 flex items-center justify-center gap-1.5 py-3 text-cull hover:bg-cull-light dark:hover:bg-orange-900/20 touch-feedback transition-colors border-r border-gray-100 dark:border-gray-800 last:border-r-0"
            >
              <Scissors size={15} />
              <span className="text-xs font-bold">Cull</span>
            </button>
          )}
          {canReach('harvest') && (
            <button
              onClick={() => navigate(`/harvest/record/${tank.id}`)}
              className="flex-1 flex items-center justify-center gap-1.5 py-3 text-harvest hover:bg-harvest-light dark:hover:bg-purple-900/20 touch-feedback transition-colors border-r border-gray-100 dark:border-gray-800 last:border-r-0"
            >
              <Package size={15} />
              <span className="text-xs font-bold">Harvest</span>
            </button>
          )}
          {canReach('transfer') && (
            <button
              onClick={() => navigate(`/transfer/record/${tank.id}`)}
              className="flex-1 flex items-center justify-center gap-1.5 py-3 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 touch-feedback transition-colors border-r border-gray-100 dark:border-gray-800 last:border-r-0"
            >
              <ArrowLeftRight size={15} />
              <span className="text-xs font-bold">Transfer</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
