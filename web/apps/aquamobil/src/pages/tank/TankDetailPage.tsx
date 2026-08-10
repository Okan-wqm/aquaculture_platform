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
 *
 * Those read-only blocks now live in src/components/unit/ because the tablet
 * board's inspector shows the same unit. What stays HERE is what only the
 * handheld has: the log-entry CTA and the sheet behind it. The board renders the
 * same vitals with no way to log, which is the whole point of the board.
 */
import { AlertTriangle } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { FeedingAdviceCard, GrowthPredictionCard, TankRiskBadge } from '@/components/ai';
import { AppHeader } from '@/components/AppHeader';
import { UnitDrivesCard } from '@/components/drive';
import { LiveReadingsCard } from '@/components/LiveReadingsCard';
import { LogSheet } from '@/components/log-sheet/LogSheet';
import { Button, Chip, EmptyState, Skeleton, StatusDot } from '@/components/ui';
import { UnitConfiguration, UnitVitals } from '@/components/unit';
import { useTanks } from '@/hooks/useTanks';
import { unitStatusMeta } from '@/utils/unit-display';

export function TankDetailPage(): JSX.Element {
  const { tankId } = useParams<{ tankId: string }>();
  const navigate = useNavigate();
  const { data: tanks, isLoading, isError } = useTanks();
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
    // A failed fetch is not the same as "this unit does not exist" — saying the
    // second when the first happened is an authorisation claim the app cannot
    // support, and it sends the worker looking for a problem that is not there.
    return (
      <div className="pb-32">
        <AppHeader title="Unit" onBack={() => navigate(-1)} showAvatar={false} />
        <EmptyState
          tone="error"
          icon={<AlertTriangle size={22} />}
          title={isError ? 'Could not load units' : 'Unit not found'}
          description={
            isError
              ? 'The unit list could not be fetched, so this unit cannot be shown. Anything you log is still queued on this device.'
              : 'This unit is not in your current inventory. It may belong to another site, or the list may be stale.'
          }
          action={
            <Button variant="primary" onClick={() => navigate('/units')}>
              Back to units
            </Button>
          }
        />
      </div>
    );
  }

  // The eight-member lookup is exhaustive by type and narrowTankStatus keeps the
  // wire from smuggling a ninth in, so no fallback is needed here any more —
  // dereferencing a missing entry is what crashed this page on fallowing pens.
  const status = unitStatusMeta(tank.status);

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
        {/* Biomass, average weight, density, the consent meter and the
            over-capacity notice — shared with the board's inspector so the
            cabin and the handheld cannot disagree about a pen. */}
        <UnitVitals tank={tank} />

        {/* MOB-MEDIUM-008: live water values with per-value freshness stamps —
            the operational data a worker standing at this unit actually needs,
            joined by sensor.tank_id at the resolver. */}
        <LiveReadingsCard tankId={tank.id} />

        {/* The machinery serving this pen — which drives feed it, whether any is
            running and whether any has faulted. It sits directly under the
            MEASURED water values and above the advisory cards because it is also
            measured: every state here came off a drive's status word, not out of
            a model. Rows link to the drive's own screen, where commanding one is
            a considered act rather than a stray tap. */}
        <UnitDrivesCard tankId={tank.id} />

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
        <UnitConfiguration tank={tank} />
      </div>

      <LogSheet open={logOpen} onClose={() => setLogOpen(false)} initialTankId={tank.id} />
    </div>
  );
}
