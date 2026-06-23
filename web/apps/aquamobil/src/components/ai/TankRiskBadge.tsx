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
 */

import { clsx } from 'clsx';
import type { ReactElement } from 'react';

import { useTankRiskAssessment } from '@/hooks/useAiInsights';

interface TankRiskBadgeProps {
  tankId: string;
}

/**
 * WHY: Color mapping by risk level string — aligns with backend TankRiskAssessment.riskLevel values
 */
const RISK_COLORS: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  LOW: {
    bg: 'bg-emerald-50 dark:bg-emerald-900/20',
    text: 'text-emerald-700 dark:text-emerald-300',
    border: 'border-emerald-200 dark:border-emerald-800',
    dot: 'bg-emerald-500',
  },
  MEDIUM: {
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    text: 'text-amber-700 dark:text-amber-300',
    border: 'border-amber-200 dark:border-amber-800',
    dot: 'bg-amber-500',
  },
  HIGH: {
    bg: 'bg-red-50 dark:bg-red-900/20',
    text: 'text-red-700 dark:text-red-300',
    border: 'border-red-200 dark:border-red-800',
    dot: 'bg-red-500',
  },
  CRITICAL: {
    bg: 'bg-red-100 dark:bg-red-900/30',
    text: 'text-red-800 dark:text-red-200',
    border: 'border-red-300 dark:border-red-700',
    dot: 'bg-red-700',
  },
};

const DEFAULT_COLORS = RISK_COLORS.LOW;

export function TankRiskBadge({ tankId }: TankRiskBadgeProps): ReactElement | null {
  const { data: risk, isLoading, isError } = useTankRiskAssessment(tankId);

  // WHY: Skeleton shown only during initial load — subtle enough to not distract
  // from the core tank metrics above.
  if (isLoading) {
    return (
      <div className="mt-4">
        <div className="h-4 w-40 skeleton rounded mb-2" />
        <div className="h-20 skeleton rounded-xl" />
      </div>
    );
  }

  // WHY: When AI is unavailable, render nothing — the tank detail page remains
  // fully functional without AI. No error banner needed for a supplementary feature.
  if (isError || !risk) {
    return null;
  }

  const colors = RISK_COLORS[risk.riskLevel.toUpperCase()] || DEFAULT_COLORS;

  return (
    <div className="mt-4">
      {/* WHY: Section header matches the existing tank detail page's heading style */}
      <div className="flex items-center gap-2 mb-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          AI Risk Assessment
        </h2>
      </div>

      <div className={clsx('rounded-xl border p-4', colors.bg, colors.border)}>
        {/* WHY: Risk level header with score and label — the primary information */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={clsx('w-2.5 h-2.5 rounded-full', colors.dot)} />
            <span className={clsx('text-sm font-bold', colors.text)}>
              {risk.riskLevel}
            </span>
          </div>
          <span className={clsx('text-2xl font-bold tabular-nums', colors.text)}>
            {risk.riskScore}
            <span className="text-xs font-medium text-gray-400 ml-0.5">/100</span>
          </span>
        </div>

        {/* WHY: Risk factors explain "why" the score is what it is — builds operator trust */}
        {risk.factors.length > 0 && (
          <div className="mb-3">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
              Contributing Factors
            </p>
            <div className="flex flex-wrap gap-1.5">
              {risk.factors.map((factor, idx) => (
                <span
                  key={idx}
                  className="text-[10px] font-medium bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300 px-2 py-0.5 rounded-md"
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
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
              Recommendations
            </p>
            <ul className="space-y-1">
              {risk.recommendations.map((rec, idx) => (
                <li key={idx} className="flex items-start gap-1.5">
                  <span className="text-purple-500 mt-0.5 flex-shrink-0">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </span>
                  <span className="text-xs text-gray-600 dark:text-gray-300 font-medium leading-relaxed">
                    {rec}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
