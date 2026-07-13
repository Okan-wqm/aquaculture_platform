import { clsx } from 'clsx';
import { ArrowLeft, Droplets, Fish, Activity, BarChart3, AlertTriangle } from 'lucide-react';
import type { JSX } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import { TankRiskBadge, GrowthPredictionCard, FeedingAdviceCard } from '@/components/ai';
import { LiveReadingsCard } from '@/components/LiveReadingsCard';
import { useTanks } from '@/hooks/useTanks';


const STATUS_CONFIG: Record<string, { bg: string; text: string; label: string }> = {
  ACTIVE: { bg: 'bg-sea-100 dark:bg-sea-900/30', text: 'text-sea-700 dark:text-sea-300', label: 'Active' },
  MAINTENANCE: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', label: 'Maintenance' },
  QUARANTINE: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', label: 'Quarantine' },
  PREPARING: { bg: 'bg-ocean-100 dark:bg-ocean-900/30', text: 'text-ocean-700 dark:text-ocean-300', label: 'Preparing' },
  HARVESTING: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-700 dark:text-purple-300', label: 'Harvesting' },
  INACTIVE: { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-600 dark:text-gray-400', label: 'Inactive' },
};

function StatCard({ icon: Icon, label, value, unit, warning }: {
  icon: typeof Fish;
  label: string;
  value: string | number;
  unit?: string;
  warning?: boolean;
}): JSX.Element {
  return (
    <div className={clsx(
      'bg-white dark:bg-gray-900 rounded-xl p-4 border',
      warning ? 'border-red-200 dark:border-red-800' : 'border-gray-100 dark:border-gray-800',
    )}>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={16} className={warning ? 'text-red-500' : 'text-gray-400'} />
        <span className="text-xs font-medium text-gray-500">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={clsx(
          'text-xl font-bold',
          warning ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white',
        )}>
          {value}
        </span>
        {unit && <span className="text-sm text-gray-400">{unit}</span>}
      </div>
    </div>
  );
}

export function TankDetailPage(): JSX.Element {
  const { tankId } = useParams<{ tankId: string }>();
  const navigate = useNavigate();
  const { data: tanks, isLoading } = useTanks();

  const tank = tanks?.find((t) => t.id === tankId);
  const metrics = tank?.batchMetrics;
  const hasBatch = !!metrics?.batchId;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-gradient-to-r from-ocean-700 to-ocean-500 text-white px-4 py-4 pt-safe-top">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <h1 className="text-lg font-bold">Tank Detail</h1>
          </div>
        </div>
        <div className="px-4 pt-6 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-2xl skeleton" />
          ))}
        </div>
      </div>
    );
  }

  if (!tank) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-gradient-to-r from-ocean-700 to-ocean-500 text-white px-4 py-4 pt-safe-top">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <h1 className="text-lg font-bold">Tank Detail</h1>
          </div>
        </div>
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <AlertTriangle size={48} className="mb-3 opacity-30" />
          <p className="font-medium">Tank not found</p>
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-ocean-500 font-semibold text-sm"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  const status = STATUS_CONFIG[tank.status] || STATUS_CONFIG.INACTIVE;

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-ocean-700 to-ocean-500 text-white">
        <div className="px-4 py-4 pt-safe-top">
          <div className="flex items-center gap-3 mb-4">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <div className="flex-1">
              <h1 className="text-lg font-bold">{tank.name}</h1>
              <p className="text-ocean-200 text-xs font-medium">{tank.code}</p>
            </div>
            <span className={clsx('px-3 py-1 rounded-lg text-xs font-semibold', status.bg, status.text)}>
              {status.label}
            </span>
          </div>

          {/* Volume info */}
          <div className="grid grid-cols-2 gap-3 pb-2">
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
              <div className="text-xl font-bold">
                {tank.volume > 0 ? `${tank.volume}` : '--'}
              </div>
              <div className="text-ocean-200 text-[11px] font-medium">
                {tank.volume > 0 ? 'm\u00B3 Volume' : 'Not configured'}
              </div>
            </div>
            <div className="bg-white/10 backdrop-blur-sm rounded-xl p-3 text-center">
              <div className="text-xl font-bold">
                {tank.maxBiomass > 0 ? `${formatNumber(tank.maxBiomass)}` : '--'}
              </div>
              <div className="text-ocean-200 text-[11px] font-medium">
                {tank.maxBiomass > 0 ? 'kg Max Capacity' : 'Not configured'}
              </div>
            </div>
          </div>
        </div>

        {/* Curved bottom */}
        <div className="relative -mb-px">
          <svg viewBox="0 0 400 20" fill="none" className="w-full block" preserveAspectRatio="none">
            <path d="M0 20V0c100 15 200 15 400 0v20z" className="fill-gray-50 dark:fill-gray-950" />
          </svg>
        </div>
      </div>

      {/* Active Batch Section */}
      <div className="px-4 pt-2">
        {hasBatch ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              <Fish size={16} className="text-ocean-500" />
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Active Batch
              </h2>
              <span className="text-xs font-semibold text-ocean-600 dark:text-ocean-400 bg-ocean-50 dark:bg-ocean-900/30 px-2 py-0.5 rounded-md">
                {metrics.batchNumber}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <StatCard
                icon={Fish}
                label="Fish Count"
                value={formatNumber(metrics.pieces ?? 0)}
                unit="pcs"
              />
              <StatCard
                icon={Activity}
                label="Avg Weight"
                value={(metrics.avgWeight ?? 0).toFixed(0)}
                unit="g"
              />
              <StatCard
                icon={BarChart3}
                label="Biomass"
                value={(metrics.biomass ?? 0).toFixed(0)}
                unit="kg"
              />
              <StatCard
                icon={Droplets}
                label="Density"
                value={(metrics.density ?? 0).toFixed(1)}
                unit="kg/m\u00B3"
              />
              <StatCard
                icon={BarChart3}
                label="Capacity Used"
                value={`${(metrics.capacityUsedPercent ?? 0).toFixed(0)}`}
                unit="%"
                warning={metrics.isOverCapacity === true}
              />
              <StatCard
                icon={Activity}
                label="Days Since Stocking"
                value={metrics.daysSinceStocking ?? '--'}
                unit="days"
              />
            </div>

            {metrics.isOverCapacity && (
              <div className="mt-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3 flex items-center gap-2">
                <AlertTriangle size={16} className="text-red-500 flex-shrink-0" />
                <p className="text-xs font-medium text-red-700 dark:text-red-300">
                  This tank is over capacity. Consider harvesting or transferring fish.
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-12 text-gray-400">
            <Fish size={48} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No active batch</p>
            <p className="text-sm mt-1">Assign a batch to this tank to see metrics</p>
          </div>
        )}
      </div>

      {/* MOB-MEDIUM-008: live water values (temp/DO/pH…) with per-value
          freshness stamps — the operational data a worker standing at this
          tank actually needs, joined by sensor.tank_id at the resolver. */}
      <div className="px-4 pt-4">
        <LiveReadingsCard tankId={tank.id} />
      </div>

      {/* WHY: AI risk assessment shown on tank detail provides actionable intelligence
          where the user needs it most — when inspecting a specific tank's status.
          Components gracefully degrade to null when MCP is disabled or unavailable. */}
      <div className="px-4">
        <TankRiskBadge tankId={tank.id} />
        {hasBatch && <GrowthPredictionCard batchId={metrics?.batchId} />}
        <FeedingAdviceCard tankId={tank.id} />
      </div>

      {/* Current Biomass (when no batch but has biomass data) */}
      {!hasBatch && (tank.currentBiomass > 0 || tank.maxBiomass > 0) && (
        <div className="px-4 pt-4">
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 size={16} className="text-ocean-500" />
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Tank Metrics
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              icon={BarChart3}
              label="Current Biomass"
              value={tank.currentBiomass > 0 ? tank.currentBiomass.toFixed(0) : '--'}
              unit={tank.currentBiomass > 0 ? 'kg' : undefined}
            />
            <StatCard
              icon={Droplets}
              label="Max Biomass"
              value={tank.maxBiomass > 0 ? formatNumber(tank.maxBiomass) : '--'}
              unit={tank.maxBiomass > 0 ? 'kg' : undefined}
            />
          </div>
        </div>
      )}

      {/* Bottom spacer */}
      <div className="h-24" />
    </div>
  );
}
