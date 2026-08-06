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
import { DataSource, QueryRunner } from 'typeorm';

import { pinTenantSchemaTransactionSearchPath } from '@aquaculture/backend-common/database';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';
import { AiEgressGateService } from './ai-egress-gate.service';

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
    private readonly egressGate: AiEgressGateService,
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
  /**
   * Enumerate the tenant schemas this sweep must visit.
   *
   * WHY THIS EXISTS (ORPHAN-HIGH-585): `messages` is a per-tenant table —
   * messaging-service omits `schema:` so search_path routes it into
   * `tenant_<uuid>` at runtime. A `@Cron` has no HTTP request behind it, so no
   * middleware seeds the tenant frame and the pool-checkout patch sets nothing;
   * an unqualified `FROM "messages"` therefore resolved against whatever
   * search_path the pooled connection happened to carry. Which tenant's rows
   * this cron embedded was decided by whoever used that connection last.
   *
   * Same shape as retention-policy.service.ts, which hit this first
   * (MT-MEDIUM-054) — the regex guard is not decoration: the schema name is
   * interpolated into `set_config`, so it must never be caller-shaped text.
   */
  private async listTenantSchemas(): Promise<string[]> {
    const rows: { schema_name: string }[] = await this.dataSource.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );
    return rows.map((row) => row.schema_name);
  }

  /**
   * Execute one batch per tenant schema.
   *
   * Each schema gets its own transaction, and the transaction is held across
   * the embedding call on purpose. `FOR UPDATE SKIP LOCKED` was already here
   * (MSG-HIGH-039) but ran under `dataSource.query`, i.e. autocommit: the row
   * locks were released the moment the SELECT returned, so two replicas could
   * still claim the same rows and pay for the same embeddings twice. A lock
   * that ends before the work it guards is not a lock.
   */
  private async runBatch(): Promise<void> {
    const schemas = await this.listTenantSchemas();
    if (schemas.length === 0) {
      this.logger.debug('No tenant schemas found; nothing to embed');
      return;
    }

    for (const schema of schemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      try {
        await pinTenantSchemaTransactionSearchPath(queryRunner, 'messaging', schema);
        await this.runBatchForSchema(queryRunner);
        await queryRunner.commitTransaction();
      } catch (err: unknown) {
        try {
          await queryRunner.rollbackTransaction();
        } catch {
          /* rollback on an already-closed transaction throws — nothing to undo */
        }
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Embedding batch failed for schema ${schema}: ${message}`);
      } finally {
        await queryRunner.release();
      }
    }
  }

  /**
   * One tenant schema's batch, inside a transaction whose search_path is
   * already pinned to it.
   */
  private async runBatchForSchema(queryRunner: QueryRunner): Promise<void> {
    // SECURITY: SELECT FOR UPDATE SKIP LOCKED prevents two replicas claiming
    // the same rows. It only means anything because the caller holds the
    // transaction open until the write-back below.
    // @see MSG-HIGH-039 (embedding worker SKIP LOCKED)
    //
    // SECURITY: the explicit `tenantId` column feeds the consent gate; the
    // schema pin decides which tenant's table is read in the first place.
    const messages: UnembeddedMessage[] = await queryRunner.query(
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

    // Filter by privacy gates — use explicit tenantId from the message row
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
      const canAnalyze = await this.egressGate.isAllowed(tenantId, senderId, 'embedding');
      consentMap.set(senderId, canAnalyze);
    }

    const consentedMessages = messages.filter((m) => consentMap.get(m.senderId) ?? false);

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

    // Write embeddings back to messages table using per-item error tracking.
    // IMPORTANT: Previous implementation used a single transaction for the entire batch.
    // If any single embedding write failed mid-way (e.g., 50/100), ALL successfully
    // written embeddings were rolled back, wasting the AI API call cost and delaying
    // the entire batch until next cycle. Per-item approach: commit each successful
    // embedding individually, track failed items for retry on the next cycle.
    // @see MSG-MEDIUM-041
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < consentedMessages.length; i++) {
      const embedding = response.embeddings[i];
      if (!embedding) continue;

      // A SAVEPOINT per item, because the batch now shares one transaction.
      // Without it a single failed write would poison the transaction and take
      // every successful embedding in the batch down with it — the outcome
      // MSG-MEDIUM-041 was written to prevent when each write was its own
      // autocommit statement. The independence is kept; what changed is that
      // it no longer costs the row lock.
      const savepoint = `embed_${i}`;
      try {
        await queryRunner.query(`SAVEPOINT ${savepoint}`);
        const vectorStr = `[${embedding.join(',')}]`;
        await queryRunner.query(
          `UPDATE "messages" SET "embedding" = $1::vector
           WHERE "id" = $2 AND "createdAt" = $3`,
          [vectorStr, consentedMessages[i]!.id, consentedMessages[i]!.createdAt],
        );
        await queryRunner.query(`RELEASE SAVEPOINT ${savepoint}`);
        successCount++;
      } catch (err: unknown) {
        failCount++;
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Embedding write failed for message ${consentedMessages[i]!.id}: ${errMsg}. ` +
            'Will retry on next batch cycle.',
        );
      }
    }

    if (successCount > 0) {
      this.logger.log(
        `Embedded ${successCount}/${consentedMessages.length} messages successfully` +
        (failCount > 0 ? ` (${failCount} failed, will retry)` : ''),
      );
    }
  }
}
