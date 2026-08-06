// ============================================================================
// GrowthPredictionCard — AI-powered 30-day growth forecast for tank detail page
// ============================================================================

/**
 * WHY: Shows the AI-predicted growth trajectory for the current batch, including
 * projected weight, SGR, FCR, and estimated biomass at 30 days. This enables
 * farm managers to make proactive harvest timing and feed procurement decisions
 * instead of reacting to lagging indicators.
 *
 * Graceful degradation: renders nothing when no batch is active or AI unavailable.
 *
 * v4 / ADVISORY: the purple that used to say "this is a forecast, not a
 * measurement" has no token, so the advisory signal rests on the wording that
 * was already carrying it — the section head "30-Day Growth Prediction" and the
 * "Predicted (30d)" column label. Both are load-bearing: keep them. Emphasis
 * now separates the two numbers instead of hue — the prediction takes the
 * primary ink and the current weight the secondary, so the card still reads
 * "here is where this batch is going" at a glance.
 */

import { clsx } from 'clsx';
import { Activity, ArrowRight } from 'lucide-react';
import type { ReactElement } from 'react';

import { Card, Skeleton } from '@/components/ui';
import { useBatchGrowthPrediction } from '@/hooks/useAiInsights';

interface GrowthPredictionCardProps {
  batchId: string | null | undefined;
}

export function GrowthPredictionCard({ batchId }: GrowthPredictionCardProps): ReactElement | null {
  const { data: prediction, isLoading, isError } = useBatchGrowthPrediction(batchId);

  // WHY: No skeleton for batch prediction — it only appears when a batch exists,
  // and the parent already shows a loading state for batch data.
  if (isLoading) {
    return <Skeleton variant="tile" />;
  }

  // WHY: Renders nothing when AI is unavailable or no batch — the tank detail
  // page works identically without this supplementary prediction.
  if (isError || !prediction) {
    return null;
  }

  /**
   * WHY: Growth delta percentage shows whether the batch is growing faster or slower
   * than current pace. A positive delta means acceleration (good); negative means deceleration.
   */
  const growthDelta =
    prediction.currentAvgWeight > 0
      ? ((prediction.predictedAvgWeight30d - prediction.currentAvgWeight) /
          prediction.currentAvgWeight) *
        100
      : 0;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <Activity size={14} className="text-acc" />
        <h2 className="text-body font-semibold text-ink-3">30-Day Growth Prediction</h2>
      </div>

      <Card className="p-4">
        {/* WHY: Primary metric row — current weight vs. predicted weight with delta indicator.
            The "arrow" visual cue makes growth direction instantly scannable. */}
        <div className="flex items-center justify-between mb-4">
          <div className="text-center">
            <div className="text-meta text-ink-3 font-medium mb-1">Current</div>
            <div className="text-head font-mono font-bold text-ink-2 tabular-nums">
              {prediction.currentAvgWeight.toFixed(0)}
              <span className="text-meta text-ink-3 font-medium font-sans ml-0.5">g</span>
            </div>
          </div>
          {/* WHY: Arrow indicator between current and predicted weight — visual growth direction */}
          <div className="flex items-center gap-1 px-3">
            <ArrowRight size={20} className="text-ink-3" aria-hidden />
          </div>
          <div className="text-center">
            <div className="text-meta text-ink-3 font-medium mb-1">Predicted (30d)</div>
            <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
              {prediction.predictedAvgWeight30d.toFixed(0)}
              <span className="text-meta text-ink-3 font-medium font-sans ml-0.5">g</span>
            </div>
          </div>
          {/* WHY: Growth delta badge — ok for acceleration, crit for deceleration */}
          <div
            className={clsx(
              'text-meta font-mono font-semibold px-2 py-1 rounded-lg tabular-nums',
              growthDelta >= 0 ? 'bg-surface-2 text-ok' : 'bg-crit-dim text-crit',
            )}
          >
            {growthDelta >= 0 ? '+' : ''}
            {growthDelta.toFixed(0)}%
          </div>
        </div>

        {/* WHY: Secondary KPI grid — SGR, FCR, and estimated biomass provide deeper context
            for operators who want more than the headline weight prediction. */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-surface-2 rounded-lg p-2.5 text-center">
            <div className="text-title font-mono font-bold text-ink-1 tabular-nums">
              {prediction.predictedSGR.toFixed(2)}
            </div>
            <div className="text-meta text-ink-3 font-semibold">SGR %/d</div>
          </div>
          <div className="bg-surface-2 rounded-lg p-2.5 text-center">
            <div className="text-title font-mono font-bold text-ink-1 tabular-nums">
              {prediction.predictedFCR.toFixed(2)}
            </div>
            <div className="text-meta text-ink-3 font-semibold">FCR</div>
          </div>
          <div className="bg-surface-2 rounded-lg p-2.5 text-center">
            <div className="text-title font-mono font-bold text-ink-1 tabular-nums">
              {prediction.estimatedBiomass30d >= 1000
                ? `${(prediction.estimatedBiomass30d / 1000).toFixed(1)}t`
                : `${prediction.estimatedBiomass30d.toFixed(0)}kg`}
            </div>
            <div className="text-meta text-ink-3 font-semibold">Est. Biomass</div>
          </div>
        </div>
      </Card>
    </section>
  );
}
