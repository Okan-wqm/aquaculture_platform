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
  const config: Record<SentimentTrend, { bg: string; text: string; Icon: typeof TrendingUp }> = {
    positive: { bg: 'bg-green-50 dark:bg-green-900/20', text: 'text-green-600 dark:text-green-400', Icon: TrendingUp },
    neutral: { bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-500 dark:text-gray-400', Icon: Minus },
    negative: { bg: 'bg-red-50 dark:bg-red-900/20', text: 'text-red-600 dark:text-red-400', Icon: TrendingDown },
  };

  const { bg, text, Icon } = config[trend];
  const displayLabel = label ?? trend.charAt(0).toUpperCase() + trend.slice(1);

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold',
        bg,
        text,
      )}
    >
      <Icon size={12} />
      {displayLabel}
    </span>
  );
}
