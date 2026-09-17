import { clsx } from 'clsx';
import { Skull, Scissors, Package, ArrowLeftRight, ChevronRight } from 'lucide-react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { Card, StatusDot } from '@/components/ui';
import type { Tank } from '@/types';
// BUG-09: feature permissions gate the action buttons so a button that would
// redirect back to / via FeatureRoute is not rendered at all.
// SEC-MEDIUM-050: canReach also enforces feature role floors (harvest => MODULE_MANAGER).
import { useFeatureAccess } from '@/utils/feature-access';

interface TankCardProps {
  tank: Tank;
}

/**
 * WHY NOT <ListRow/>: the four permission-gated action buttons along the bottom
 * (BUG-09 / SEC-MEDIUM-050) are the point of this card, and ListRow has one
 * `onClick` and no action row. Reducing it to a row would delete the log
 * shortcuts, which is a capability change, not a restyle. UnitsPage renders the
 * unit LIST as ListRows because it offers no per-row actions; this card keeps
 * its own shape.
 *
 * v4: the per-status gradient header is gone. Gradients cost contrast in
 * sunlight — the reason AppHeader dropped its own — and status now reads as a
 * dot + label in the semantic tones, matching TankDetailPage's STATUS_META so
 * one status means one colour on both screens.
 */
type StatusTone = 'ok' | 'warn' | 'crit';

const STATUS_CONFIG: Record<string, { tone: StatusTone; label: string }> = {
  ACTIVE: { tone: 'ok', label: 'Active' },
  MAINTENANCE: { tone: 'crit', label: 'Maintenance' },
  QUARANTINE: { tone: 'crit', label: 'Quarantine' },
  PREPARING: { tone: 'warn', label: 'Preparing' },
  HARVESTING: { tone: 'warn', label: 'Harvesting' },
  INACTIVE: { tone: 'warn', label: 'Inactive' },
};

const STATUS_TEXT_CLASS: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
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
  const capacityPercent =
    metrics?.capacityUsedPercent ??
    (tank.maxBiomass > 0 ? (tank.currentBiomass / tank.maxBiomass) * 100 : 0);
  const capacityTone = capacityPercent > 90 ? 'crit' : capacityPercent > 70 ? 'warn' : 'ok';
  const capacityFill = { crit: 'bg-crit', warn: 'bg-warn', ok: 'bg-ok' }[capacityTone];
  const capacityText = { crit: 'text-crit', warn: 'text-warn', ok: 'text-ok' }[capacityTone];

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  return (
    <Card className="overflow-hidden">
      {/* WHY: the header row is the tap target for the unit itself. It sits one
          tone above the card so it still reads as a distinct band, without the
          gradient that used to cost contrast outdoors. */}
      <button
        type="button"
        onClick={() => navigate(`/tank/${tank.id}`)}
        className="w-full min-h-touch px-4 py-3.5 flex items-center justify-between text-left bg-surface-2 touch-feedback transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col min-w-0">
            <h3 className="text-title font-semibold text-ink-1 truncate">{tank.name}</h3>
            <p className="text-meta text-ink-3 truncate">
              {tank.code} &middot; {tank.volume > 0 ? `${tank.volume}m³` : 'Not configured'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {hasBatch && (
            <span className="text-meta font-mono font-semibold text-ink-2 bg-surface-3 px-2.5 py-1 rounded-lg">
              {metrics.batchNumber}
            </span>
          )}
          <span
            className={clsx(
              'flex items-center gap-1.5 text-meta font-semibold',
              STATUS_TEXT_CLASS[status.tone],
            )}
          >
            {/* WHY: the live blip on active tanks signals "alive" — it distinguishes
                operational tanks from idle ones in a scrollable list. */}
            <StatusDot tone={status.tone} live={tank.status === 'ACTIVE'} />
            {status.label}
          </span>
          <ChevronRight size={16} className="text-ink-3" aria-hidden />
        </div>
      </button>

      {/* WHY: Stat grid with batch metrics — fish count, avg weight, and biomass are the three
          primary metrics field workers need for daily feeding/health decisions. */}
      {hasBatch ? (
        <div className="px-4 py-3.5">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-surface-2 rounded-xl p-2.5 text-center">
              <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {formatNumber(metrics.pieces ?? 0)}
              </div>
              <div className="text-meta text-ink-3 font-semibold">Fish</div>
            </div>
            <div className="bg-surface-2 rounded-xl p-2.5 text-center">
              <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {(metrics.avgWeight ?? 0).toFixed(0)}g
              </div>
              <div className="text-meta text-ink-3 font-semibold">Avg Wt</div>
            </div>
            <div className="bg-surface-2 rounded-xl p-2.5 text-center">
              <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {(metrics.biomass ?? tank.currentBiomass ?? 0).toFixed(0)}
                <span className="text-meta text-ink-3 font-medium font-sans">kg</span>
              </div>
              <div className="text-meta text-ink-3 font-semibold">Biomass</div>
            </div>
          </div>

          {/* WHY: Capacity progress bar — visual fill indicator is faster to parse than a percentage number.
              Colour coding (ok/warn/crit) follows the same traffic-light convention as the rest of v4. */}
          {capacityPercent > 0 && (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-meta font-semibold text-ink-3">Capacity</span>
                <span className={clsx('text-meta font-mono font-bold tabular-nums', capacityText)}>
                  {capacityPercent.toFixed(0)}%
                </span>
              </div>
              <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className={clsx(
                    'h-full rounded-full transition-all duration-500 ease-out',
                    capacityFill,
                  )}
                  style={{ width: `${Math.min(capacityPercent, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="px-4 py-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface-2 rounded-xl p-2.5 text-center">
              <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {tank.currentBiomass > 0 ? `${tank.currentBiomass.toFixed(0)}kg` : '--'}
              </div>
              <div className="text-meta text-ink-3 font-semibold">
                {tank.currentBiomass > 0 ? 'Biomass' : 'Not configured'}
              </div>
            </div>
            <div className="bg-surface-2 rounded-xl p-2.5 text-center">
              <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {tank.maxBiomass > 0 ? `${formatNumber(tank.maxBiomass)}kg` : '--'}
              </div>
              <div className="text-meta text-ink-3 font-semibold">
                {tank.maxBiomass > 0 ? 'Max Cap' : 'Not configured'}
              </div>
            </div>
          </div>
          {/* WHY: "No active batch" badge on otherwise-active tanks signals the tank is ready
              for stocking — prevents confusion about why there are no fish metrics. */}
          {tank.status === 'ACTIVE' && (
            <div className="mt-2.5 flex justify-center">
              <span className="text-meta font-medium text-ink-3 bg-surface-2 px-3 py-1 rounded-full">
                No active batch
              </span>
            </div>
          )}
        </div>
      )}

      {/* WHY: Action buttons only render for tanks with batches AND for features the user has permission for.
          This prevents dead-end navigation where FeatureRoute would redirect back to home.
          The per-log-type hues are the one place v4 lets colour be decorative — a worker
          identifies an entry type by hue before reading the word. */}
      {hasBatch &&
        (canReach('mortality') ||
          canReach('cull') ||
          canReach('harvest') ||
          canReach('transfer')) && (
          <div className="flex border-t border-line">
            {canReach('mortality') && (
              <button
                type="button"
                onClick={() => navigate(`/mortality/record/${tank.id}`)}
                className="flex-1 min-h-touch flex items-center justify-center gap-1.5 py-3 text-type-mortality hover:bg-type-mortality-dim touch-feedback transition-colors border-r border-line last:border-r-0"
              >
                <Skull size={15} />
                <span className="text-meta font-semibold">Mortality</span>
              </button>
            )}
            {canReach('cull') && (
              <button
                type="button"
                onClick={() => navigate(`/cull/record/${tank.id}`)}
                className="flex-1 min-h-touch flex items-center justify-center gap-1.5 py-3 text-type-cull hover:bg-type-cull-dim touch-feedback transition-colors border-r border-line last:border-r-0"
              >
                <Scissors size={15} />
                <span className="text-meta font-semibold">Cull</span>
              </button>
            )}
            {canReach('harvest') && (
              <button
                type="button"
                onClick={() => navigate(`/harvest/record/${tank.id}`)}
                className="flex-1 min-h-touch flex items-center justify-center gap-1.5 py-3 text-type-harvest hover:bg-type-harvest-dim touch-feedback transition-colors border-r border-line last:border-r-0"
              >
                <Package size={15} />
                <span className="text-meta font-semibold">Harvest</span>
              </button>
            )}
            {canReach('transfer') && (
              <button
                type="button"
                onClick={() => navigate(`/transfer/record/${tank.id}`)}
                className="flex-1 min-h-touch flex items-center justify-center gap-1.5 py-3 text-type-transfer hover:bg-type-transfer-dim touch-feedback transition-colors border-r border-line last:border-r-0"
              >
                <ArrowLeftRight size={15} />
                <span className="text-meta font-semibold">Transfer</span>
              </button>
            )}
          </div>
        )}
    </Card>
  );
}
