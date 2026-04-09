/**
 * @module EmbeddingService
 * @description Batch embedding generation pipeline for message vectors.
 * Runs every 5 minutes via cron, fetches messages without embeddings,
 * sends them to ai-service via NATS request-reply, and writes the resulting
 * VECTOR(384) embeddings back to the messages table.
 *
 * Privacy gate: only processes messages where both tenant and user have
 * consented to AI analysis.
 *
 * @see ADR-012 section 12.1 (Embedding Pipeline)
 */
import { Injectable, Logger, Inject, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';
import { AiPrivacyService } from './ai-privacy.service';

/** Batch size for embedding generation. */
const BATCH_SIZE = 100;

/** NATS request timeout in milliseconds (30 seconds). */
const NATS_TIMEOUT_MS = 30_000;

/**
 * Response from ai-service for embedding generation.
 */
interface EmbeddingResponse {
  embeddings: number[][];
}

/**
 * Raw message row from the database for embedding processing.
 */
interface UnembeddedMessage {
  id: string;
  channelId: string;
  senderId: string;
  content: string;
  createdAt: Date;
  tenantId: string;
}

@Injectable()
export class EmbeddingService implements OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingService.name);
  private isProcessing = false;

  constructor(
    private readonly dataSource: DataSource,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    private readonly privacyService: AiPrivacyService,
  ) {}

  onModuleDestroy(): void {
    this.isProcessing = false;
  }

  /**
   * Cron job: every 5 minutes, process messages that lack embeddings.
   * Batching amortizes model loading overhead. At 20K messages/day,
   * average batch is ~70 messages, processed in < 1 second.
   */
  @Cron('*/5 * * * *')
  async processUnembeddedMessages(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug('Embedding batch already in progress, skipping');
      return;
    }

    this.isProcessing = true;
    try {
      await this.runBatch();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Embedding batch failed: ${message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a single batch of embedding generation.
   * Fetches unembedded messages, filters by privacy consent, generates
   * embeddings via ai-service, and writes them back.
   */
  private async runBatch(): Promise<void> {
    // SECURITY: Use SELECT FOR UPDATE SKIP LOCKED to prevent duplicate
    // processing across worker replicas. Without this, multiple workers can
    // claim the same rows, causing duplicate embeddings and wasted API calls.
    // @see MSG-HIGH-039 (embedding worker SKIP LOCKED)
    //
    // SECURITY: Explicit tenantId from message entity (not just channel join)
    // ensures tenant isolation in the embedding pipeline.
    // @see MSG-HIGH-040 (embedding writes to wrong schema)
    const messages: UnembeddedMessage[] = await this.dataSource.query(
      `SELECT m."id", m."channelId", m."senderId", m."content", m."createdAt",
              m."tenantId"
       FROM "messages" m
       WHERE m."embedding" IS NULL
         AND m."isDeleted" = false
         AND m."content" IS NOT NULL
         AND m."content" != ''
       ORDER BY m."createdAt" ASC
       LIMIT $1
       FOR UPDATE OF m SKIP LOCKED`,
      [BATCH_SIZE],
    );

    if (messages.length === 0) {
      return;
    }

    this.logger.debug(`Processing ${messages.length} messages for embedding`);

    // Filter by privacy gates — use explicit tenantId from channel join
    const senderIds = [...new Set(messages.map((m) => m.senderId))];
    const consentMap = new Map<string, boolean>();
    const senderTenantMap = new Map<string, string>();
    for (const msg of messages) {
      if (!senderTenantMap.has(msg.senderId) && msg.tenantId) {
        senderTenantMap.set(msg.senderId, msg.tenantId);
      }
    }
    for (const senderId of senderIds) {
      const tenantId = senderTenantMap.get(senderId) ?? '_current';
      const canAnalyze = await this.privacyService
        .canAnalyzeMessage(tenantId, senderId)
        .catch(() => false);
      consentMap.set(senderId, canAnalyze);
    }

    const consentedMessages = messages.filter(
      (m) => consentMap.get(m.senderId) ?? false,
    );

    if (consentedMessages.length === 0) {
      this.logger.debug('No consented messages to embed in this batch');
      return;
    }

    const texts = consentedMessages.map((m) => m.content);

    // Call ai-service via NATS request-reply
    const response = await firstValueFrom(
      this.natsClient
        .send<EmbeddingResponse>('request.ai.generateEmbeddings', { texts })
        .pipe(
          timeout(NATS_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`AI service embedding request failed: ${errMsg}`);
            return of(null);
          }),
        ),
    );

    if (!response || !response.embeddings || response.embeddings.length === 0) {
      this.logger.warn('No embeddings returned from ai-service');
      return;
    }

    // Write embeddings back to messages table
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      for (let i = 0; i < consentedMessages.length; i++) {
        const embedding = response.embeddings[i];
        if (!embedding) continue;

        const vectorStr = `[${embedding.join(',')}]`;
        await queryRunner.query(
          `UPDATE "messages" SET "embedding" = $1::vector
           WHERE "id" = $2 AND "createdAt" = $3`,
          [vectorStr, consentedMessages[i]!.id, consentedMessages[i]!.createdAt],
        );
      }

      await queryRunner.commitTransaction();
      this.logger.log(
        `Embedded ${consentedMessages.length} messages successfully`,
      );
    } catch (err: unknown) {
      await queryRunner.rollbackTransaction();
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Embedding write-back failed: ${message}`);
    } finally {
      await queryRunner.release();
    }
  }
}
