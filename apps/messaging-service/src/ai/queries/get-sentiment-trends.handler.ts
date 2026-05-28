/**
 * @module GetSentimentTrendsHandler
 * @description CQRS query handler that computes weekly aggregate sentiment
 * per channel. Uses PostgreSQL date_trunc for week bucketing and AVG for
 * sentiment score aggregation. Only processes sentiment-type analyses.
 *
 * Visibility rule: sentiment data is NEVER shown per-message. Only weekly
 * aggregates are exposed, and only to TENANT_ADMIN role.
 *
 * @see ADR-012 section 12.2 (Sentiment Analysis Architecture)
 */
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { GetSentimentTrendsQuery } from './get-sentiment-trends.query';

/**
 * A single week's sentiment trend for a channel.
 */
export interface SentimentTrend {
  /** Channel UUID. */
  channelId: string;
  /** Channel display name. */
  channelName: string;
  /** Start of the ISO week (Monday). */
  weekStart: string;
  /** Average sentiment score (0.0 - 1.0). */
  avgScore: number;
  /** Total messages analyzed in this week. */
  messageCount: number;
  /** Trend direction compared to previous week: 'improving', 'declining', or 'stable'. */
  trend: 'improving' | 'declining' | 'stable';
}

@QueryHandler(GetSentimentTrendsQuery)
export class GetSentimentTrendsHandler
  implements IQueryHandler<GetSentimentTrendsQuery, SentimentTrend[]>
{
  private readonly logger = new Logger(GetSentimentTrendsHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Execute the sentiment trends query.
   * Returns weekly aggregated sentiment scores per channel, sorted by week descending.
   */
  async execute(query: GetSentimentTrendsQuery): Promise<SentimentTrend[]> {
    const { tenantId, channelId, weeks } = query;

    const weeksAgo = new Date();
    weeksAgo.setDate(weeksAgo.getDate() - weeks * 7);

    const params: (string | Date)[] = [tenantId, weeksAgo];
    let channelFilter = '';

    if (channelId) {
      channelFilter = 'AND m."channelId" = $3::uuid';
      params.push(channelId);
    }

    const rawResults: Array<{
      channelId: string;
      channelName: string | null;
      weekStart: Date;
      avgScore: string;
      messageCount: string;
    }> = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      (queryRunner) => queryRunner.manager.query(
      `SELECT
        m."channelId",
        c."name" as "channelName",
        date_trunc('week', ma."analyzedAt") as "weekStart",
        AVG(CAST(ma."result"->>'score' AS DOUBLE PRECISION)) as "avgScore",
        COUNT(*)::text as "messageCount"
      FROM "message_analysis" ma
      INNER JOIN "messages" m
        ON ma."tenantId" = m."tenantId"
        AND ma."messageId" = m."id"
        AND ma."messageCreatedAt" = m."createdAt"
      LEFT JOIN "channels" c
        ON c."id" = m."channelId"
       AND c."tenantId" = $1::uuid
      WHERE ma."analysisType" = 'sentiment'
        AND ma."tenantId" = $1::uuid
        AND m."tenantId" = $1::uuid
        AND ma."analyzedAt" >= $2
        ${channelFilter}
      GROUP BY m."channelId", c."name", date_trunc('week', ma."analyzedAt")
      ORDER BY date_trunc('week', ma."analyzedAt") DESC, m."channelId"`,
      params,
      ),
    ) as Array<{
      channelId: string;
      channelName: string | null;
      weekStart: Date;
      avgScore: string;
      messageCount: string;
    }>;

    // Compute trend by comparing consecutive weeks per channel
    const trendMap = new Map<string, number[]>();
    for (const row of rawResults) {
      const key = row.channelId;
      if (!trendMap.has(key)) {
        trendMap.set(key, []);
      }
      trendMap.get(key)!.push(parseFloat(row.avgScore));
    }

    return rawResults.map((row) => {
      const scores = trendMap.get(row.channelId) ?? [];
      const currentIdx = scores.indexOf(parseFloat(row.avgScore));
      const previousScore = scores[currentIdx + 1]; // older week (DESC order)

      let trend: 'improving' | 'declining' | 'stable' = 'stable';
      if (previousScore !== undefined) {
        const delta = parseFloat(row.avgScore) - previousScore;
        if (delta > 0.05) trend = 'improving';
        else if (delta < -0.05) trend = 'declining';
      }

      return {
        channelId: row.channelId,
        channelName: row.channelName ?? 'Unknown',
        weekStart: row.weekStart instanceof Date
          ? row.weekStart.toISOString()
          : String(row.weekStart),
        avgScore: parseFloat(row.avgScore),
        messageCount: parseInt(row.messageCount, 10),
        trend,
      };
    });
  }
}
