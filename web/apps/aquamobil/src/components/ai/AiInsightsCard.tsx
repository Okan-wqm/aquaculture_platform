// ============================================================================
// AiInsightsCard — Aggregated AI intelligence summary for the home dashboard
// ============================================================================

/**
 * WHY: Dedicated AI insights card for the mobile dashboard. Shows aggregated
 * risk score, active anomalies count, and top feeding recommendation.
 *
 * Graceful degradation strategy:
 *   - Loading: token skeleton (shaped like the card it replaces)
 *   - Error/unavailable: an EmptyState inside the card's own header, so the
 *     card is visibly present-but-down rather than silently absent
 *   - Success: full AI card with risk gauge, anomaly badge, feeding tip
 *
 * v4 / ADVISORY: the purple→indigo gradient header that used to say "this is a
 * prediction, not a live reading" has no token — v4 spends teal on actions and
 * amber/coral/green on state, and it drops gradients because they cost contrast
 * in sunlight. The advisory signal therefore rests on the wording that was
 * already carrying it: the card is titled "AI Insights", the gauge is labelled
 * "Risk" (a score, not a measurement), and the recommendation block is titled
 * "Feeding Tip". Those words are load-bearing now — do not shorten them away.
 */

import { clsx } from 'clsx';
import { Brain, MessageCircle } from 'lucide-react';
import type { ReactElement } from 'react';

import { Card, CardDivider, EmptyState, Skeleton } from '@/components/ui';
import { useAiDashboardInsights } from '@/hooks/useAiInsights';

/**
 * WHY: Risk tier → the semantic tone it wears. Green=safe, amber=watch,
 * coral=alarm, so a field operator triages without reading the label. HIGH and
 * CRITICAL share the `crit` token because the design has exactly one alarm
 * colour — the LABEL ("High Risk" vs "Critical") is what separates them, and it
 * is always rendered beside the gauge.
 */
const RISK_LEVEL_TONE: Record<number, { ring: string; text: string; label: string }> = {
  0: { ring: 'stroke-ok', text: 'text-ok', label: 'Low Risk' },
  1: { ring: 'stroke-warn', text: 'text-warn', label: 'Medium Risk' },
  2: { ring: 'stroke-crit', text: 'text-crit', label: 'High Risk' },
  3: { ring: 'stroke-crit', text: 'text-crit', label: 'Critical' },
};

/**
 * WHY: Maps a 0-100 numeric score to a discrete risk tier for color coding.
 * Thresholds align with the backend's risk classification logic.
 */
function getRiskTier(score: number): number {
  if (score >= 75) return 3; // Critical
  if (score >= 50) return 2; // High
  if (score >= 25) return 1; // Medium
  return 0; // Low
}

/**
 * WHY: Circular gauge component renders the risk score as an SVG ring.
 * Visual gauges are faster to parse than numbers — a farm manager glancing
 * at the dashboard can assess overall health in under 1 second.
 */
function RiskGauge({ score }: { score: number }): ReactElement {
  const tier = getRiskTier(score);
  const tone = RISK_LEVEL_TONE[tier];
  // WHY: SVG circle math — circumference = 2 * PI * radius. The dashoffset
  // controls how much of the ring is "filled" based on the score percentage.
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const dashoffset = circumference - (score / 100) * circumference;

  return (
    <div className="relative w-24 h-24 flex items-center justify-center">
      <svg className="w-24 h-24 -rotate-90" viewBox="0 0 80 80">
        {/* WHY: Background ring shows the full circle track so the progress is visually contextualized */}
        <circle
          cx="40" cy="40" r={radius}
          fill="none"
          strokeWidth="6"
          className="stroke-surface-3"
        />
        {/* WHY: Foreground ring — dasharray/dashoffset technique creates the animated progress arc */}
        <circle
          cx="40" cy="40" r={radius}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className={clsx('transition-all duration-700 ease-out', tone.ring)}
          strokeDasharray={circumference}
          strokeDashoffset={dashoffset}
        />
      </svg>
      {/* WHY: Centered score number inside the ring — the most prominent element on the card */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={clsx('text-display font-mono font-bold tabular-nums', tone.text)}>
          {score}
        </span>
        <span className="text-meta font-semibold text-ink-3">Risk</span>
      </div>
    </div>
  );
}

/**
 * WHY: Severity → tone for anomaly badges. Matches the backend's
 * FarmAnomaly.severity enum. CRITICAL and HIGH both take `crit` because both
 * land in the "needs attention now" bucket this list is filtered to — softening
 * HIGH to amber here would understate an anomaly the app has already decided is
 * urgent enough to surface on the dashboard.
 */
function getSeverityTone(severity: string): string {
  switch (severity.toLowerCase()) {
    case 'critical': return 'bg-crit-dim text-crit';
    case 'high': return 'bg-crit-dim text-crit';
    case 'medium': return 'bg-warn-dim text-warn';
    default: return 'bg-acc-dim text-acc';
  }
}

/** The card's own title row — present in every state, including the down ones. */
function InsightsHeader({ trailing }: { trailing?: ReactElement }): ReactElement {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Brain size={16} className="text-acc" aria-hidden />
        <h3 className="text-title font-semibold text-ink-1">AI Insights</h3>
      </div>
      {trailing}
    </div>
  );
}

export function AiInsightsCard(): ReactElement {
  const { data: insights, isLoading, isError } = useAiDashboardInsights();

  // WHY: Loading skeleton shaped like the card it replaces, so the dashboard
  // does not jump when the insights land.
  if (isLoading) {
    return (
      <Card className="p-4">
        <Skeleton variant="text" className="w-32" />
        <div className="flex items-center gap-4 mt-3">
          <div className="skeleton w-24 h-24 rounded-full shrink-0" aria-hidden />
          <Skeleton variant="text" count={3} className="flex-1" />
        </div>
      </Card>
    );
  }

  // WHY: When AI is unavailable (MCP_ENABLED=false, MCP down, or query error),
  // the dashboard remains fully functional — this is graceful degradation, not a
  // hard failure. But "the advisory service is switched off" and "we could not
  // reach it" are different facts, so the tone (and the wording) tell them apart
  // instead of sharing one grey shrug.
  if (isError || !insights) {
    return (
      <Card className="overflow-hidden">
        <InsightsHeader />
        <CardDivider />
        <EmptyState
          tone={isError ? 'error' : 'empty'}
          icon={<Brain size={22} />}
          title={isError ? 'AI insights could not be loaded' : 'AI insights unavailable'}
          description={
            isError
              ? 'The advisory service could not be reached. Everything else on this screen is unaffected.'
              : 'Advisory intelligence is not switched on for this farm.'
          }
          className="py-6"
        />
      </Card>
    );
  }

  const anomalyCount = insights.anomalies.length;
  const criticalAnomalies = insights.anomalies.filter(
    (a) => a.severity.toLowerCase() === 'critical' || a.severity.toLowerCase() === 'high',
  );
  const topFeeding = insights.feedingAdvice[0];
  const riskTier = getRiskTier(insights.overallRiskScore);
  const riskLabel = RISK_LEVEL_TONE[riskTier].label;
  const elevatedRiskCount = insights.tankRisks.filter((t) => t.riskScore >= 50).length;

  return (
    <Card className="overflow-hidden">
      <InsightsHeader
        // WHY: Anomaly count badge in the header — coral when anomalies exist,
        // green when clear. At-a-glance awareness without scrolling to details.
        trailing={
          <span
            className={clsx(
              'text-meta font-semibold px-2.5 py-0.5 rounded-full shrink-0',
              anomalyCount > 0 ? 'bg-crit-dim text-crit' : 'bg-surface-2 text-ok',
            )}
          >
            {anomalyCount > 0
              ? `${anomalyCount} anomal${anomalyCount > 1 ? 'ies' : 'y'}`
              : 'All clear'}
          </span>
        }
      />
      <CardDivider />

      <div className="p-4">
        {/* WHY: Two-column layout — gauge on left, stats on right. The gauge is the primary
            visual anchor; stats provide supporting context. */}
        <div className="flex items-center gap-4">
          <RiskGauge score={insights.overallRiskScore} />

          <div className="flex-1 min-w-0 space-y-2">
            {/* WHY: Risk level label reinforces the gauge color with text for accessibility */}
            <div>
              <span className={clsx('text-title font-semibold', RISK_LEVEL_TONE[riskTier].text)}>
                {riskLabel}
              </span>
              <p className="text-meta text-ink-3 font-medium">
                {insights.tankRisks.length} tank{insights.tankRisks.length !== 1 ? 's' : ''} monitored
              </p>
            </div>

            {/* WHY: High/critical anomalies surfaced prominently — these need immediate attention */}
            {criticalAnomalies.length > 0 && (
              <div className="space-y-1">
                {criticalAnomalies.slice(0, 2).map((anomaly, idx) => (
                  <div
                    key={idx}
                    className={clsx(
                      'text-meta font-semibold px-2 py-1 rounded-lg truncate',
                      getSeverityTone(anomaly.severity),
                    )}
                  >
                    {anomaly.description}
                  </div>
                ))}
              </div>
            )}

            {/* WHY: Tank risk count summary — tells the manager how many tanks need attention */}
            {elevatedRiskCount > 0 && (
              <p className="text-meta text-ink-3 font-medium">
                {elevatedRiskCount} tank{elevatedRiskCount !== 1 ? 's' : ''} at elevated risk
              </p>
            )}
          </div>
        </div>

        {/* WHY: Top feeding recommendation compact card — shown when at least one tank
            has feeding advice. Gives the manager a quick actionable tip without navigating
            to individual tank details. */}
        {topFeeding && (
          <div className="mt-3 bg-surface-2 border border-line rounded-xl p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <MessageCircle size={12} className="text-acc" aria-hidden />
              <span className="text-meta font-semibold text-ink-3">Feeding Tip</span>
            </div>
            <p className="text-body text-ink-1 font-medium leading-relaxed">
              {topFeeding.rationale}
            </p>
            <p className="text-meta text-ink-3 mt-1">
              {topFeeding.recommendedAmount}kg {topFeeding.feedType} &middot;{' '}
              {topFeeding.feedingFrequency}x/day
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
