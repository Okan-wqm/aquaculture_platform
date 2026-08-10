/**
 * SentimentBadge -- Shows weekly sentiment trend for TENANT_ADMIN.
 *
 * WHY: When AI analysis is enabled on a channel, TENANT_ADMIN users see a
 * color-coded badge showing the weekly sentiment trend. This is a lightweight
 * indicator that links to more detailed analytics elsewhere.
 */

import { clsx } from 'clsx';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sentiment direction. */
export type SentimentTrend = 'positive' | 'neutral' | 'negative';

interface SentimentBadgeProps {
  /** The weekly sentiment trend direction. */
  trend: SentimentTrend;
  /** Optional label override. Defaults to the trend name. */
  label?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** SentimentBadge renders a color-coded pill with trend icon. */
export function SentimentBadge({ trend, label }: SentimentBadgeProps): ReactElement {
  // `--ok` and `--type-harvest` are the same value in every theme, so the
  // harvest tint is the green wash that `--ok` has no dim twin for.
  const config: Record<SentimentTrend, { bg: string; text: string; Icon: typeof TrendingUp }> = {
    positive: { bg: 'bg-type-harvest-dim', text: 'text-ok', Icon: TrendingUp },
    neutral: { bg: 'bg-surface-2', text: 'text-ink-2', Icon: Minus },
    negative: { bg: 'bg-crit-dim', text: 'text-crit', Icon: TrendingDown },
  };

  const { bg, text, Icon } = config[trend];
  const displayLabel = label ?? trend.charAt(0).toUpperCase() + trend.slice(1);

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-meta font-semibold',
        bg,
        text,
      )}
    >
      <Icon size={12} />
      {displayLabel}
    </span>
  );
}
