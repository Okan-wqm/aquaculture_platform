/**
 * @module GetSentimentTrendsQuery
 * @description CQRS query to retrieve weekly aggregate sentiment trends
 * per channel. Restricted to TENANT_ADMIN role. Returns average sentiment
 * score, message count, and trend direction per channel per week.
 * @see ADR-012 section 12.2 (Sentiment Analysis Architecture)
 */
import { IQuery } from '@nestjs/cqrs';

/**
 * Query to fetch weekly sentiment trends for one or all channels.
 */
export class GetSentimentTrendsQuery implements IQuery {
  constructor(
    /** Tenant identifier for scoping. */
    public readonly tenantId: string,
    /** Optional channel filter. Null returns trends for all channels. */
    public readonly channelId: string | null,
    /** Number of weeks to look back (default: 4). */
    public readonly weeks: number,
  ) {}
}
