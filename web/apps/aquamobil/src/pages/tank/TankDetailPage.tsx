/**
 * TankDetailPage — the v4 unit detail.
 *
 * The screen a worker opens standing in front of a pen. It answers, in order:
 * is this unit in trouble, how much is in it, how close is it to the consent
 * limit, and what has been logged here recently.
 *
 * WHAT CHANGED: the old page led with a gradient banner carrying volume and max
 * capacity — two configuration values that never change — then a six-tile grid
 * where every metric had equal weight. Density against consent, the number that
 * actually constrains what a farm may do, was one tile among six with no
 * threshold context at all: "93%" of what, and is that bad?
 *
 * v4 promotes the four metrics a shift check reads (biomass, average weight,
 * density, capacity) to hero numerals, and gives density its own meter with the
 * watch and limit thresholds labelled — so 93% is legible as "past the watch
 * line, approaching consent" without the worker knowing the numbers by heart.
 */
import { AlertTriangle, Fish } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { FeedingAdviceCard, GrowthPredictionCard, TankRiskBadge } from '@/components/ai';
import { AppHeader } from '@/components/AppHeader';
import { LiveReadingsCard } from '@/components/LiveReadingsCard';
import { LogSheet } from '@/components/log-sheet/LogSheet';
import {
  Button,
  CapacityMeter,
  Card,
  Chip,
  EmptyState,
  Skeleton,
  StatTile,
  StatusDot,
} from '@/components/ui';
import { useTanks } from '@/hooks/useTanks';
import type { Tank } from '@/types';

/** Status → label plus the tone its dot takes. */
const STATUS_META: Record<Tank['status'], { label: string; tone: 'ok' | 'warn' | 'crit' }> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  MAINTENANCE: { label: 'Maintenance', tone: 'crit' },
  QUARANTINE: { label: 'Quarantine', tone: 'crit' },
  PREPARING: { label: 'Preparing', tone: 'warn' },
  HARVESTING: { label: 'Harvesting', tone: 'warn' },
  INACTIVE: { label: 'Inactive', tone: 'warn' },
};

function compact(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toLocaleString();
}

export function TankDetailPage(): JSX.Element {
  const { tankId } = useParams<{ tankId: string }>();
  const navigate = useNavigate();
  const { data: tanks, isLoading } = useTanks();
  const [logOpen, setLogOpen] = useState(false);

  const tank = tanks?.find((t) => t.id === tankId);
  const metrics = tank?.batchMetrics;
  const hasBatch = Boolean(metrics?.batchId);

  if (isLoading) {
    return (
      <div className="pb-32">
        <AppHeader title="Unit" onBack={() => navigate(-1)} showAvatar={false} />
        <div className="px-4">
          <Skeleton variant="tile" count={3} />
        </div>
      </div>
    );
  }

  if (!tank) {
    return (
      <div className="pb-32">
        <AppHeader title="Unit" onBack={() => navigate(-1)} showAvatar={false} />
        <EmptyState
          tone="error"
          icon={<AlertTriangle size={22} />}
          title="Unit not found"
          description="This unit is not in your current inventory. It may belong to another site, or the list may be stale."
          action={
            <Button variant="primary" onClick={() => navigate('/units')}>
              Back to units
            </Button>
          }
        />
      </div>
    );
  }

  const status = STATUS_META[tank.status];
  const capacityPct = metrics?.capacityUsedPercent ?? 0;

  return (
    <div className="pb-32">
      <AppHeader
        title={tank.code || tank.name}
        subtitle={tank.code ? tank.name : undefined}
        onBack={() => navigate(-1)}
        showAvatar={false}
        actions={
          <Chip tone={status.tone}>
            <StatusDot tone={status.tone} live={tank.status === 'ACTIVE'} />
            {status.label}
          </Chip>
        }
      />

      <div className="px-4 flex flex-col gap-5">
        {hasBatch && metrics ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <StatTile
                label="Standing biomass"
                value={((metrics.biomass ?? 0) / 1000).toFixed(1)}
                unit="t"
                caption={`${compact(metrics.pieces ?? 0)} fish`}
              />
              <StatTile
                label="Average weight"
                value={(metrics.avgWeight ?? 0).toFixed(0)}
                unit="g"
                caption={
                  metrics.daysSinceStocking != null
                    ? `${metrics.daysSinceStocking} d since stocking`
                    : undefined
                }
              />
              <StatTile label="Density" value={(metrics.density ?? 0).toFixed(1)} unit="kg/m³" />
              {/* The capacity tile is the one that may turn colour, and it can
                  only do so with the caption that names the threshold — the
                  StatTile type enforces that pairing. */}
              {metrics.isOverCapacity === true ? (
                <StatTile
                  label="Capacity used"
                  value={capacityPct.toFixed(0)}
                  unit="%"
                  state="crit"
                  caption="Over consent limit"
                />
              ) : (
                <StatTile label="Capacity used" value={capacityPct.toFixed(0)} unit="%" />
              )}
            </div>

            {/* Density against consent gets its own meter because it is the
                regulated number: the thresholds are what make it readable. */}
            <Card className="p-4">
              <CapacityMeter
                percent={capacityPct}
                readout={`${capacityPct.toFixed(0)}% · ${(metrics.density ?? 0).toFixed(1)} kg/m³`}
              />
            </Card>

            {metrics.isOverCapacity === true && (
              <Card className="p-3.5 flex items-center gap-3 border-crit">
                <span className="w-9 h-9 shrink-0 rounded-xl bg-crit-dim text-crit inline-flex items-center justify-center">
                  <AlertTriangle size={18} />
                </span>
                <span className="text-body text-ink-1">
                  This unit is over capacity. Consider harvesting or transferring.
                </span>
              </Card>
            )}
          </>
        ) : (
          <EmptyState
            icon={<Fish size={22} />}
            title="No active batch"
            description="Assign a batch to this unit to see biomass, density and growth."
          />
        )}

        {/* MOB-MEDIUM-008: live water values with per-value freshness stamps —
            the operational data a worker standing at this unit actually needs,
            joined by sensor.tank_id at the resolver. */}
        <LiveReadingsCard tankId={tank.id} />

        {/* Advisory intelligence, which degrades to null when the AI surface is
            disabled or unavailable. */}
        <div className="flex flex-col gap-3">
          <TankRiskBadge tankId={tank.id} />
          {hasBatch && <GrowthPredictionCard batchId={metrics?.batchId} />}
          <FeedingAdviceCard tankId={tank.id} />
        </div>

        {/* The primary action of this screen. The v4 design puts it here rather
            than in a menu because the worker is already standing at the unit —
            reaching a log entry should not cost a navigation. */}
        {hasBatch && (
          <Button variant="primary" size="save" block onClick={() => setLogOpen(true)}>
            Log entry for {tank.code || tank.name}
          </Button>
        )}

        {/* The unit's configuration, demoted from the old header banner: volume
            and max capacity are set once and read rarely, so they belong at the
            bottom rather than above the numbers that change every day. */}
        <Card className="p-4">
          <div className="text-meta text-ink-3 mb-3">Unit configuration</div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-title font-mono font-semibold text-ink-1 tabular-nums">
                {tank.volume > 0 ? `${tank.volume}` : '—'}
              </div>
              <div className="text-meta text-ink-3">
                {tank.volume > 0 ? 'm³ volume' : 'Volume not configured'}
              </div>
            </div>
            <div>
              <div className="text-title font-mono font-semibold text-ink-1 tabular-nums">
                {tank.maxBiomass > 0 ? compact(tank.maxBiomass) : '—'}
              </div>
              <div className="text-meta text-ink-3">
                {tank.maxBiomass > 0 ? 'kg max capacity' : 'Capacity not configured'}
              </div>
            </div>
          </div>
        </Card>
      </div>

      <LogSheet open={logOpen} onClose={() => setLogOpen(false)} initialTankId={tank.id} />
    </div>
  );
}
