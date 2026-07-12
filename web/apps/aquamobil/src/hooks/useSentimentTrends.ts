// ============================================================================
// useSentimentTrends — real weekly sentiment for the channel settings badge
// ============================================================================
//
// MOB-MEDIUM-003: ChannelSettingsPage used to render a hardcoded 'neutral'
// SentimentBadge to TENANT_ADMIN — mock data presented as real analytics. This
// hook binds the badge to the messaging subgraph's `sentimentTrends` weekly
// aggregates over `message_analyses` (TENANT_ADMIN-gated on the backend;
// sentiment is never exposed per-message).
//
// The backend returns avgScore (0.0–1.0) plus a week-over-week direction
// ('improving' | 'declining' | 'stable'). The badge's vocabulary is the sentiment
// LEVEL, so the latest week's avgScore maps to positive (≥0.6) / negative
// (≤0.4) / neutral, and the direction is passed through for callers that want
// it. No rows → `latest: null` so the UI renders nothing, not a fake verdict.

import { useQuery } from '@tanstack/react-query';

import { useAuth } from './useAuth';

import type { SentimentTrend } from '@/components/messaging/SentimentBadge';
import { MOBILE_SENTIMENT_TRENDS } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/** The latest analyzed week, mapped for the settings badge. */
export interface LatestSentiment {
  /** Badge level derived from avgScore: ≥0.6 positive, ≤0.4 negative, else neutral. */
  badge: SentimentTrend;
  /** Raw average sentiment score for the week (0.0–1.0). */
  avgScore: number;
  /** ISO week start of the latest analyzed week. */
  weekStart: string;
  /** Messages analyzed in that week. */
  messageCount: number;
  /** Week-over-week direction from the backend. */
  direction: string;
}

export interface UseSentimentTrendsResult {
  /** Latest week's sentiment, or null when no analysis rows exist. */
  latest: LatestSentiment | null;
  isLoading: boolean;
}

const POSITIVE_FLOOR = 0.6;
const NEGATIVE_CEILING = 0.4;

function scoreToBadge(avgScore: number): SentimentTrend {
  if (avgScore >= POSITIVE_FLOOR) return 'positive';
  if (avgScore <= NEGATIVE_CEILING) return 'negative';
  return 'neutral';
}

/**
 * Fetch the latest weekly sentiment aggregate for a channel.
 *
 * @param channelId — channel to summarize
 * @param enabled — caller-side gate (tenant admin + AI enabled + consent); the
 *   TENANT_ADMIN authorization is backend-enforced, this flag just avoids
 *   firing a guaranteed-403 request for non-admin viewers.
 */
export function useSentimentTrends(
  channelId: string | undefined,
  enabled: boolean,
): UseSentimentTrendsResult {
  const { tenantId } = useAuth();

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'sentiment-trends', channelId ?? 'none'),
    enabled: enabled && Boolean(channelId) && Boolean(tenantId),
    queryFn: async (): Promise<LatestSentiment | null> => {
      const data = await graphqlRequest(MOBILE_SENTIMENT_TRENDS, {
        input: { channelId, weeks: 4 },
      });
      const rows = data.sentimentTrends;
      if (rows.length === 0) return null;

      // The handler sorts week-descending, but the latest-week pick must not
      // depend on transport ordering — reduce to the max weekStart explicitly.
      const latestRow = rows.reduce((latest, current) =>
        current.weekStart > latest.weekStart ? current : latest,
      );

      return {
        badge: scoreToBadge(latestRow.avgScore),
        avgScore: latestRow.avgScore,
        weekStart: latestRow.weekStart,
        messageCount: latestRow.messageCount,
        direction: latestRow.trend,
      };
    },
  });

  return {
    latest: query.data ?? null,
    isLoading: query.isLoading && query.fetchStatus !== 'idle',
  };
}
