// ============================================================================
// FeedingAdviceCard — AI-driven precision feeding recommendation for tank detail
// ============================================================================

/**
 * WHY: Per-tank feeding advice is displayed on the tank detail page so operators
 * can see the AI recommendation exactly where they make feeding decisions.
 * Precision feeding reduces FCR, lowers waste, and improves water quality — it's
 * the #1 operational cost lever in aquaculture and the highest-impact AI feature.
 *
 * Graceful degradation: renders nothing when AI is unavailable.
 */

import { MessageCircle } from 'lucide-react';
import type { ReactElement } from 'react';

import { useFeedingAdvice } from '@/hooks/useAiInsights';

interface FeedingAdviceCardProps {
  tankId: string;
}

export function FeedingAdviceCard({ tankId }: FeedingAdviceCardProps): ReactElement | null {
  const { data: advice, isLoading, isError } = useFeedingAdvice(tankId);

  if (isLoading) {
    return (
      <div className="mt-4">
        <div className="h-4 w-40 skeleton rounded mb-2" />
        <div className="h-24 skeleton rounded-xl" />
      </div>
    );
  }

  // WHY: Renders nothing when AI is unavailable — the tank detail page works
  // identically without this supplementary feature.
  if (isError || !advice) {
    return null;
  }

  return (
    <div className="mt-4">
      {/* WHY: Section header style matches other AI sections on the tank detail page */}
      <div className="flex items-center gap-2 mb-3">
        <MessageCircle className="text-purple-500" size={16} aria-hidden="true" />
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          AI Feeding Advice
        </h2>
      </div>

      <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-100 dark:border-purple-800 rounded-xl p-4">
        {/* WHY: Three-column KPI row — recommended amount, feed type, and frequency
            are the three parameters operators need to execute a feeding event. */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="text-center">
            <div className="text-lg font-bold text-purple-700 dark:text-purple-300 tabular-nums">
              {advice.recommendedAmount.toFixed(1)}
            </div>
            <div className="text-[10px] text-purple-500 dark:text-purple-400 font-semibold uppercase tracking-wider">
              kg/feeding
            </div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-purple-700 dark:text-purple-300">
              {advice.feedType}
            </div>
            <div className="text-[10px] text-purple-500 dark:text-purple-400 font-semibold uppercase tracking-wider">
              Feed Type
            </div>
          </div>
          <div className="text-center">
            <div className="text-lg font-bold text-purple-700 dark:text-purple-300 tabular-nums">
              {advice.feedingFrequency}x
            </div>
            <div className="text-[10px] text-purple-500 dark:text-purple-400 font-semibold uppercase tracking-wider">
              Per Day
            </div>
          </div>
        </div>

        {/* WHY: Rationale text builds operator trust in AI recommendations. Operators
            who understand "why" are more likely to follow the advice, improving FCR. */}
        <div className="bg-white/60 dark:bg-gray-800/40 rounded-lg p-3">
          <p className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">
            Rationale
          </p>
          <p className="text-xs text-purple-700 dark:text-purple-200 font-medium leading-relaxed">
            {advice.rationale}
          </p>
        </div>
      </div>
    </div>
  );
}
