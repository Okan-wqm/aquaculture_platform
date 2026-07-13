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
 */

import type { ReactElement } from 'react';

import { useBatchGrowthPrediction } from '@/hooks/useAiInsights';

interface GrowthPredictionCardProps {
  batchId: string | null | undefined;
}

export function GrowthPredictionCard({ batchId }: GrowthPredictionCardProps): ReactElement | null {
  const { data: prediction, isLoading, isError } = useBatchGrowthPrediction(batchId);

  // WHY: No skeleton for batch prediction — it only appears when a batch exists,
  // and the parent already shows a loading state for batch data.
  if (isLoading) {
    return (
      <div className="mt-4">
        <div className="h-4 w-40 skeleton rounded mb-2" />
        <div className="h-32 skeleton rounded-xl" />
      </div>
    );
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
  const growthDelta = prediction.currentAvgWeight > 0
    ? ((prediction.predictedAvgWeight30d - prediction.currentAvgWeight) / prediction.currentAvgWeight * 100)
    : 0;

  return (
    <div className="mt-4">
      {/* WHY: Section header style matches TankRiskBadge and existing tank detail sections */}
      <div className="flex items-center gap-2 mb-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          30-Day Growth Prediction
        </h2>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
        {/* WHY: Primary metric row — current weight vs. predicted weight with delta indicator.
            The "arrow up/down" visual cue makes growth direction instantly scannable. */}
        <div className="flex items-center justify-between mb-4">
          <div className="text-center">
            <div className="text-xs text-gray-400 font-medium mb-1">Current</div>
            <div className="text-xl font-bold text-gray-900 dark:text-white tabular-nums">
              {prediction.currentAvgWeight.toFixed(0)}
              <span className="text-xs text-gray-400 font-medium ml-0.5">g</span>
            </div>
          </div>
          {/* WHY: Arrow indicator between current and predicted weight — visual growth direction */}
          <div className="flex items-center gap-1 px-3">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-400">
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </div>
          <div className="text-center">
            <div className="text-xs text-gray-400 font-medium mb-1">Predicted (30d)</div>
            <div className="text-xl font-bold text-purple-600 dark:text-purple-400 tabular-nums">
              {prediction.predictedAvgWeight30d.toFixed(0)}
              <span className="text-xs text-gray-400 font-medium ml-0.5">g</span>
            </div>
          </div>
          {/* WHY: Growth delta percentage badge — green for positive growth, red for negative */}
          <div className={`text-xs font-bold px-2 py-1 rounded-lg ${
            growthDelta >= 0
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
          }`}>
            {growthDelta >= 0 ? '+' : ''}{growthDelta.toFixed(0)}%
          </div>
        </div>

        {/* WHY: Secondary KPI grid — SGR, FCR, and estimated biomass provide deeper context
            for operators who want more than the headline weight prediction. */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5 text-center">
            <div className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">
              {prediction.predictedSGR.toFixed(2)}
            </div>
            <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">
              SGR %/d
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5 text-center">
            <div className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">
              {prediction.predictedFCR.toFixed(2)}
            </div>
            <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">
              FCR
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800/60 rounded-lg p-2.5 text-center">
            <div className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">
              {prediction.estimatedBiomass30d >= 1000
                ? `${(prediction.estimatedBiomass30d / 1000).toFixed(1)}t`
                : `${prediction.estimatedBiomass30d.toFixed(0)}kg`}
            </div>
            <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">
              Est. Biomass
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
