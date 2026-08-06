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
 *
 * v4 / ADVISORY: the purple fill that marked this as a recommendation rather
 * than an instruction has no token. The advisory signal therefore rests on the
 * wording already carrying it — the section head "AI Feeding Advice" and the
 * "Rationale" block, which exists so an operator can judge the advice instead
 * of just obeying it. Keep both; with the purple gone they are the only thing
 * separating a suggestion from a measured value.
 */

import { MessageCircle } from 'lucide-react';
import type { ReactElement } from 'react';

import { Card, Skeleton } from '@/components/ui';
import { useFeedingAdvice } from '@/hooks/useAiInsights';

interface FeedingAdviceCardProps {
  tankId: string;
}

export function FeedingAdviceCard({ tankId }: FeedingAdviceCardProps): ReactElement | null {
  const { data: advice, isLoading, isError } = useFeedingAdvice(tankId);

  if (isLoading) {
    return <Skeleton variant="tile" />;
  }

  // WHY: Renders nothing when AI is unavailable — the tank detail page works
  // identically without this supplementary feature.
  if (isError || !advice) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <MessageCircle size={14} className="text-acc" />
        <h2 className="text-body font-semibold text-ink-3">AI Feeding Advice</h2>
      </div>

      <Card className="p-4">
        {/* WHY: Three-column KPI row — recommended amount, feed type, and frequency
            are the three parameters operators need to execute a feeding event. */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="text-center">
            <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
              {advice.recommendedAmount.toFixed(1)}
            </div>
            <div className="text-meta text-ink-3 font-semibold">kg/feeding</div>
          </div>
          <div className="text-center">
            <div className="text-head font-semibold text-ink-1">{advice.feedType}</div>
            <div className="text-meta text-ink-3 font-semibold">Feed Type</div>
          </div>
          <div className="text-center">
            <div className="text-head font-mono font-bold text-ink-1 tabular-nums">
              {advice.feedingFrequency}x
            </div>
            <div className="text-meta text-ink-3 font-semibold">Per Day</div>
          </div>
        </div>

        {/* WHY: Rationale text builds operator trust in AI recommendations. Operators
            who understand "why" are more likely to follow the advice, improving FCR. */}
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-meta font-semibold text-ink-3 mb-1">Rationale</p>
          <p className="text-body text-ink-1 font-medium leading-relaxed">{advice.rationale}</p>
        </div>
      </Card>
    </section>
  );
}
