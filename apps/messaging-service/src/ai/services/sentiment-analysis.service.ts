/**
 * @module SentimentAnalysisService
 * @description Subscribes to MessageSent events via the outbox consumer pattern
 * and runs sentiment analysis via ai-service NATS request-reply. Stores results
 * in the message_analysis table. Triggers SentimentAlert events when 3+
 * consecutive negative messages are detected from the same sender.
 *
 * Privacy: dual consent (tenant + user) is checked before every analysis.
 * Graceful degradation: ai-service unavailability does not block messaging.
 *
 * @see ADR-012 section 12.2 (Sentiment Analysis Architecture)
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, BaseEvent } from '@platform/event-contracts';
import { MessageAnalysis, AnalysisType } from '../entities/message-analysis.entity';
import { AiEgressGateService } from './ai-egress-gate.service';
import type { SentimentResult } from '../entities/message-analysis.entity';

/** NATS request timeout in milliseconds (30 seconds). */
const NATS_TIMEOUT_MS = 30_000;

/** Threshold for negative sentiment (below this triggers alert counting). */
const NEGATIVE_THRESHOLD = 0.3;

/** Number of consecutive negative messages before triggering an alert. */
const CONSECUTIVE_NEGATIVE_ALERT_COUNT = 3;

/** Model version identifier for sentiment analysis results. */
const SENTIMENT_MODEL_VERSION = 'distilbert-sst2-v1.0';

/**
 * Response from ai-service sentiment analysis endpoint.
 */
interface SentimentResponse {
  label: 'POSITIVE' | 'NEGATIVE';
  score: number;
  confidence: number;
}

/**
 * Payload from the MessageSent outbox event.
 */
export interface MessageSentPayload {
  tenantId: string;
  channelId: string;
  messageId: string;
  senderId: string;
  contentType: string;
  createdAt: string;
}

@Injectable()
export class SentimentAnalysisService {
  private readonly logger = new Logger(SentimentAnalysisService.name);

  constructor(
    @InjectRepository(MessageAnalysis)
    private readonly analysisRepo: Repository<MessageAnalysis>,
    private readonly dataSource: DataSource,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    private readonly egressGate: AiEgressGateService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Analyze a single message for sentiment. Called by the AnalyzeMessageHandler.
   * Checks privacy gates, calls ai-service, stores result, and checks for alert triggers.
   *
   * @param tenantId - Tenant identifier
   * @param channelId - Channel the message belongs to
   * @param messageId - UUID of the message
   * @param messageCreatedAt - Partition key timestamp
   * @param senderId - User who sent the message
   * @param content - Message text content
   */
  async analyzeMessage(
    tenantId: string,
    channelId: string,
    messageId: string,
    messageCreatedAt: Date,
    senderId: string,
    content: string,
  ): Promise<void> {
    // Privacy gate: route through the single fail-closed AI-egress boundary.
    if (!(await this.egressGate.isAllowed(tenantId, senderId, 'sentiment'))) {
      this.logger.debug(
        `Skipping sentiment analysis for message ${messageId}: AI egress denied`,
      );
      return;
    }

    // Call ai-service via NATS
    const response = await firstValueFrom(
      this.natsClient
        .send<SentimentResponse>('request.ai.analyzeSentiment', { text: content })
        .pipe(
          timeout(NATS_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Sentiment analysis failed for ${messageId}: ${errMsg}`);
            return of(null);
          }),
        ),
    );

    if (!response) {
      return;
    }

    // Store analysis result
    const result: SentimentResult = {
      label: response.label,
      score: response.score,
      confidence: response.confidence,
    };

    const analysis = this.analysisRepo.create({
      messageId,
      messageCreatedAt,
      analysisType: AnalysisType.SENTIMENT,
      result,
      modelVersion: SENTIMENT_MODEL_VERSION,
      analyzedAt: new Date(),
    });

    await this.analysisRepo.save(analysis);

    // Check for consecutive negative sentiment alert trigger
    if (response.score < NEGATIVE_THRESHOLD) {
      await this.checkNegativeTrend(tenantId, channelId, senderId);
    }
  }

  /**
   * Check if the last N messages from a sender in a channel are all negative.
   * If so, publish a SentimentAlert event via NATS.
   */
  private async checkNegativeTrend(
    tenantId: string,
    channelId: string,
    senderId: string,
  ): Promise<void> {
    try {
      // Get last N sentiment analyses for this sender in this channel
      const recentAnalyses: Array<{ score: string }> = await this.dataSource.query(
        `SELECT (ma."result"->>'score')::text as score
         FROM "message_analysis" ma
         INNER JOIN "messages" m ON ma."messageId" = m."id" AND ma."messageCreatedAt" = m."createdAt"
         WHERE m."channelId" = $1
           AND m."senderId" = $2
           AND ma."analysisType" = 'sentiment'
         ORDER BY ma."analyzedAt" DESC
         LIMIT $3`,
        [channelId, senderId, CONSECUTIVE_NEGATIVE_ALERT_COUNT],
      );

      if (recentAnalyses.length < CONSECUTIVE_NEGATIVE_ALERT_COUNT) {
        return;
      }

      const allNegative = recentAnalyses.every(
        (a) => parseFloat(a.score) < NEGATIVE_THRESHOLD,
      );

      if (allNegative) {
        const avgScore =
          recentAnalyses.reduce((sum, a) => sum + parseFloat(a.score), 0) /
          recentAnalyses.length;

        // Store SentimentAlert in the outbox instead of direct NATS emit.
        // BEFORE: this.natsClient.emit(...) — fire-and-forget with no durability guarantee.
        // If NATS was down/restarting at this moment, the alert was silently dropped forever.
        // SentimentAlert consumers (notification-service, hr-service) use this for staff
        // welfare monitoring — a dropped alert could delay intervention.
        // WHY: All other domain events in this service go through the outbox for exactly
        // this reason (guaranteed at-least-once delivery via the outbox worker).
        // Wrapped in dataSource.transaction() because OutboxPublisher.enqueue() requires
        // an active transaction context.
        await this.dataSource.transaction(async (manager) => {
          await this.outboxPublisher.enqueue({
            ...createBaseEvent('SentimentAlert', tenantId),
            channelId,
            userId: senderId,
            avgScore,
            messageCount: CONSECUTIVE_NEGATIVE_ALERT_COUNT,
            detectedAt: new Date().toISOString(),
          },  manager);
        });

        this.logger.warn(
          `SentimentAlert queued via outbox: ${CONSECUTIVE_NEGATIVE_ALERT_COUNT}+ consecutive negative messages ` +
            `from user ${senderId} in channel ${channelId} (avg score: ${avgScore.toFixed(2)})`,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Negative trend check failed: ${message}`);
    }
  }
}
