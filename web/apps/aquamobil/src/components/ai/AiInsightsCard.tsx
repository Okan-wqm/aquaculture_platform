// ============================================================================
// AiInsightsCard — Aggregated AI intelligence summary for the home dashboard
// ============================================================================

/**
 * WHY: Dedicated AI insights card for the mobile dashboard. Shows aggregated
 * risk score, active anomalies count, and top feeding recommendation.
 * Uses a gradient header (purple→indigo) to visually distinguish AI-powered
 * content from standard operational data — operators immediately recognize
 * which cards show AI predictions vs. live sensor readings.
 *
 * Graceful degradation strategy:
 *   - Loading: skeleton pulse animation (matches existing app pattern)
 *   - Error/null: subtle "AI insights unavailable" message (not intrusive)
 *   - Success: full AI card with risk gauge, anomaly badge, feeding tip
 */

import { clsx } from 'clsx';
import type { ReactElement } from 'react';

import { useAiDashboardInsights } from '@/hooks/useAiInsights';

/**
 * WHY: Risk level to color mapping follows universal severity conventions.
 * Green=safe, amber=warning, red=danger, deep-red=critical. This enables
 * field operators to triage without reading text labels.
 */
const RISK_LEVEL_COLORS: Record<number, { ring: string; text: string; label: string }> = {
  0: { ring: 'stroke-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Low Risk' },
  1: { ring: 'stroke-amber-500', text: 'text-amber-600 dark:text-amber-400', label: 'Medium Risk' },
  2: { ring: 'stroke-red-500', text: 'text-red-600 dark:text-red-400', label: 'High Risk' },
  3: { ring: 'stroke-red-700', text: 'text-red-700 dark:text-red-300', label: 'Critical' },
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
  const colors = RISK_LEVEL_COLORS[tier];
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
          className="stroke-gray-200 dark:stroke-gray-700"
        />
        {/* WHY: Foreground ring — dasharray/dashoffset technique creates the animated progress arc */}
        <circle
          cx="40" cy="40" r={radius}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className={clsx('transition-all duration-700 ease-out', colors.ring)}
          strokeDasharray={circumference}
          strokeDashoffset={dashoffset}
        />
      </svg>
      {/* WHY: Centered score number inside the ring — the most prominent element on the card */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={clsx('text-2xl font-bold tabular-nums', colors.text)}>
          {score}
        </span>
        <span className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider">
          Risk
        </span>
      </div>
    </div>
  );
}

/**
 * WHY: Severity color mapping for anomaly badges. Matches the backend's
 * FarmAnomaly.severity enum values.
 */
function getSeverityColor(severity: string): string {
  switch (severity.toLowerCase()) {
    case 'critical': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
    case 'high': return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300';
    case 'medium': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    default: return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  }
}

export function AiInsightsCard(): ReactElement {
  const { data: insights, isLoading, isError } = useAiDashboardInsights();

  // WHY: Loading skeleton matches the app's existing skeleton pattern (pulse animation).
  // Shown during initial fetch — subsequent refetches use stale data.
  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-3">
          <div className="h-4 w-32 bg-white/20 rounded skeleton" />
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-4">
            <div className="w-24 h-24 rounded-full skeleton" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-full skeleton rounded" />
              <div className="h-4 w-3/4 skeleton rounded" />
              <div className="h-4 w-1/2 skeleton rounded" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // WHY: When AI is unavailable (MCP_ENABLED=false, MCP down, or query error),
  // show a subtle non-intrusive message. The dashboard remains fully functional
  // without AI — this is graceful degradation, not a hard failure.
  if (isError || !insights) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-3 flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/80">
            <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22" />
            <path d="M8 6a4 4 0 0 1 .68-2.23" />
            <path d="M17 12.5c1.77.77 3 2.53 3 4.5a5 5 0 0 1-10 0c0-1.97 1.23-3.73 3-4.5" />
            <path d="M7 17a5 5 0 0 1-3-4.5" />
          </svg>
          <h3 className="text-sm font-bold text-white">AI Insights</h3>
        </div>
        <div className="p-4 flex items-center justify-center">
          <p className="text-sm text-gray-400 font-medium">AI insights currently unavailable</p>
        </div>
      </div>
    );
  }

  const anomalyCount = insights.anomalies.length;
  const criticalAnomalies = insights.anomalies.filter(
    (a) => a.severity.toLowerCase() === 'critical' || a.severity.toLowerCase() === 'high',
  );
  const topFeeding = insights.feedingAdvice[0];
  const riskTier = getRiskTier(insights.overallRiskScore);
  const riskLabel = RISK_LEVEL_COLORS[riskTier].label;

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card border border-gray-100 dark:border-gray-800 overflow-hidden">
      {/* WHY: Gradient header (purple→indigo) visually distinguishes AI-powered content
          from standard operational cards. Operators learn to associate this color with
          "AI prediction" vs. "live data". */}
      <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/80">
            <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22" />
            <path d="M8 6a4 4 0 0 1 .68-2.23" />
            <path d="M17 12.5c1.77.77 3 2.53 3 4.5a5 5 0 0 1-10 0c0-1.97 1.23-3.73 3-4.5" />
            <path d="M7 17a5 5 0 0 1-3-4.5" />
          </svg>
          <h3 className="text-sm font-bold text-white">AI Insights</h3>
        </div>
        {/* WHY: Anomaly count badge in the header — red when anomalies exist, green when clear.
            Provides at-a-glance anomaly awareness without scrolling to the details section. */}
        <span className={clsx(
          'text-xs font-bold px-2.5 py-0.5 rounded-full',
          anomalyCount > 0
            ? 'bg-red-500/20 text-red-100'
            : 'bg-emerald-500/20 text-emerald-100',
        )}>
          {anomalyCount > 0 ? `${anomalyCount} anomal${anomalyCount > 1 ? 'ies' : 'y'}` : 'All clear'}
        </span>
      </div>

      <div className="p-4">
        {/* WHY: Two-column layout — gauge on left, stats on right. The gauge is the primary
            visual anchor; stats provide supporting context. */}
        <div className="flex items-center gap-4">
          <RiskGauge score={insights.overallRiskScore} />

          <div className="flex-1 space-y-2">
            {/* WHY: Risk level label reinforces the gauge color with text for accessibility */}
            <div>
              <span className={clsx('text-sm font-bold', RISK_LEVEL_COLORS[riskTier].text)}>
                {riskLabel}
              </span>
              <p className="text-[10px] text-gray-400 font-medium">
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
                      'text-[10px] font-semibold px-2 py-1 rounded-lg truncate',
                      getSeverityColor(anomaly.severity),
                    )}
                  >
                    {anomaly.description}
                  </div>
                ))}
              </div>
            )}

            {/* WHY: Tank risk count summary — tells the manager how many tanks need attention */}
            {insights.tankRisks.filter((t) => t.riskScore >= 50).length > 0 && (
              <p className="text-[10px] text-gray-500 font-medium">
                {insights.tankRisks.filter((t) => t.riskScore >= 50).length} tank{insights.tankRisks.filter((t) => t.riskScore >= 50).length !== 1 ? 's' : ''} at elevated risk
              </p>
            )}
          </div>
        </div>

        {/* WHY: Top feeding recommendation compact card — shown when at least one tank
            has feeding advice. Gives the manager a quick actionable tip without navigating
            to individual tank details. */}
        {topFeeding && (
          <div className="mt-3 bg-purple-50 dark:bg-purple-900/20 border border-purple-100 dark:border-purple-800 rounded-xl p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
              <span className="text-[10px] font-bold text-purple-600 dark:text-purple-300 uppercase tracking-wider">
                Feeding Tip
              </span>
            </div>
            <p className="text-xs text-purple-700 dark:text-purple-200 font-medium leading-relaxed">
              {topFeeding.rationale}
            </p>
            <p className="text-[10px] text-purple-500 dark:text-purple-400 mt-1">
              {topFeeding.recommendedAmount}kg {topFeeding.feedType} &middot; {topFeeding.feedingFrequency}x/day
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
