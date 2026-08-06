// ============================================================================
// TankRiskBadge — AI risk assessment section for the tank detail page
// ============================================================================

/**
 * WHY: Shows the per-tank AI risk assessment with a visual risk gauge, contributing
 * factors, and actionable recommendations. Placed on the tank detail page so operators
 * see intelligence exactly where they need it — when inspecting a specific tank.
 *
 * Graceful degradation: renders nothing when AI is unavailable or loading fails,
 * so the tank detail page works identically with or without MCP.
 *
 * v4 / ADVISORY: the purple chrome that used to mark this card as AI-produced
 * has no token — the palette is teal for actions, amber/coral/green for state,
 * and the per-log-type hues. The advisory signal therefore rests entirely on
 * the wording that was already carrying it: the section head reads "AI Risk
 * Assessment" at the same prominence as every other section head, and the
 * "Contributing Factors" / "Recommendations" labels describe a judgement rather
 * than a measurement. Nothing here is presented as a sensor value. Do not
 * delete or demote that heading — with the purple gone it is the only thing
 * separating this card from the measured readings directly above it.
 */

import { clsx } from 'clsx';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import type { ReactElement } from 'react';

import { Card, Skeleton, StatusDot } from '@/components/ui';
import { useTankRiskAssessment } from '@/hooks/useAiInsights';

interface TankRiskBadgeProps {
  tankId: string;
}

/**
 * WHY: risk level → the semantic tone it wears. Aligns with the backend
 * TankRiskAssessment.riskLevel values. HIGH and CRITICAL share the `crit` token
 * because the design has one alarm colour; the LEVEL WORD beside the dot is
 * what tells them apart, and it is always rendered.
 */
const RISK_TONE: Record<string, { border: string; text: string; dot: 'ok' | 'warn' | 'crit' }> = {
  LOW: { border: 'border-line', text: 'text-ok', dot: 'ok' },
  MEDIUM: { border: 'border-warn', text: 'text-warn', dot: 'warn' },
  HIGH: { border: 'border-crit', text: 'text-crit', dot: 'crit' },
  CRITICAL: { border: 'border-crit', text: 'text-crit', dot: 'crit' },
};

const DEFAULT_TONE = RISK_TONE.LOW;

export function TankRiskBadge({ tankId }: TankRiskBadgeProps): ReactElement | null {
  const { data: risk, isLoading, isError } = useTankRiskAssessment(tankId);

  // WHY: Skeleton shown only during initial load — subtle enough to not distract
  // from the core tank metrics above.
  if (isLoading) {
    return <Skeleton variant="tile" />;
  }

  // WHY: When AI is unavailable, render nothing — the tank detail page remains
  // fully functional without AI. No error banner needed for a supplementary feature.
  if (isError || !risk) {
    return null;
  }

  const tone = RISK_TONE[risk.riskLevel.toUpperCase()] || DEFAULT_TONE;

  return (
    <section className="flex flex-col gap-2">
      {/* Section head matches every other v4 section head, and carries the
          "AI" word that marks everything below it as advisory. */}
      <div className="flex items-center gap-2 px-1">
        <AlertTriangle size={14} className="text-acc" />
        <h2 className="text-body font-semibold text-ink-3">AI Risk Assessment</h2>
      </div>

      <Card className={clsx('p-4', tone.border)}>
        {/* WHY: Risk level header with score and label — the primary information */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <StatusDot tone={tone.dot} />
            <span className={clsx('text-title font-semibold', tone.text)}>{risk.riskLevel}</span>
          </div>
          <span className={clsx('text-display font-mono font-bold tabular-nums', tone.text)}>
            {risk.riskScore}
            <span className="text-meta font-medium text-ink-3 ml-0.5 font-sans">/100</span>
          </span>
        </div>

        {/* WHY: Risk factors explain "why" the score is what it is — builds operator trust */}
        {risk.factors.length > 0 && (
          <div className="mb-3">
            <p className="text-meta font-semibold text-ink-3 mb-1.5">Contributing Factors</p>
            <div className="flex flex-wrap gap-1.5">
              {risk.factors.map((factor, idx) => (
                <span
                  key={idx}
                  className="text-meta font-medium bg-surface-2 text-ink-2 px-2 py-0.5 rounded-md"
                >
                  {factor}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* WHY: Recommendations provide actionable next steps — the highest-value part of
            the risk assessment. Operators can act immediately without consulting a manual. */}
        {risk.recommendations.length > 0 && (
          <div>
            <p className="text-meta font-semibold text-ink-3 mb-1.5">Recommendations</p>
            <ul className="space-y-1">
              {risk.recommendations.map((rec, idx) => (
                <li key={idx} className="flex items-start gap-1.5">
                  <ChevronRight size={12} className="text-acc mt-1 shrink-0" aria-hidden />
                  <span className="text-body text-ink-2 font-medium leading-relaxed">{rec}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </section>
  );
}
