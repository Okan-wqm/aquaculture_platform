/**
 * @module SearchSimilarMessagesHandler
 * @description CQRS query handler for pgvector cosine similarity search.
 * Generates an embedding for the query text via ai-service, then performs
 * a vector similarity search using the HNSW index on the messages table.
 *
 * Results are restricted to channels the requesting user belongs to,
 * enforcing data isolation at the query level.
 *
 * @see ADR-012 section 12.1 (Embedding Pipeline)
 * @see ADR-012 section 12.5 (AI Privacy Framework - Embedding search scope)
 */
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout, catchError, of } from 'rxjs';

import { SearchSimilarMessagesQuery } from './search-similar-messages.query';
import { Message } from '../../message/entities/message.entity';
import { AiEgressGateService } from '../services/ai-egress-gate.service';

/** NATS request timeout for embedding generation (30 seconds). */
const NATS_TIMEOUT_MS = 30_000;

/**
 * Message with similarity score for ranked results.
 */
export interface SimilarMessage {
  /** The matching message (partial — only includes fields from the similarity query). */
  message: Pick<Message, 'id' | 'channelId' | 'senderId' | 'content' | 'contentType' | 'createdAt' | 'isDeleted'>;
  /** Cosine similarity score (0.0 to 1.0, higher = more similar). */
  similarity: number;
}

/**
 * Response from ai-service embedding generation.
 */
interface EmbeddingResponse {
  embeddings: number[][];
}

@QueryHandler(SearchSimilarMessagesQuery)
export class SearchSimilarMessagesHandler
  implements IQueryHandler<SearchSimilarMessagesQuery, SimilarMessage[]>
{
  private readonly logger = new Logger(SearchSimilarMessagesHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
    private readonly egressGate: AiEgressGateService,
  ) {}

  /**
   * Execute the similarity search query.
   * 0. Egress gate — the query text is tenant content leaving toward the AI
   * 1. Generate query embedding via ai-service
   * 2. Find user's channel memberships
   * 3. Run pgvector cosine similarity search with channel scope
   */
  async execute(
    query: SearchSimilarMessagesQuery,
  ): Promise<SimilarMessage[]> {
    const { tenantId, userId, queryText, channelId, limit } = query;

    // MSG-HIGH-061: the search text is tenant content leaving messaging toward
    // the AI system (ai-service embeds it). Route it through the same fail-closed
    // egress-gate SSoT the chat path uses (tenant AI master switch + user
    // consent). A disabled tenant / non-consented user gets no AI search and no
    // content leaves.
    const egressAllowed = await this.egressGate.isAllowed(
      tenantId,
      userId,
      'semantic-search',
    );
    if (!egressAllowed) {
      this.logger.debug(
        `Semantic search denied by egress gate (tenant AI off or no consent) — returning empty`,
      );
      return [];
    }

    // 1. Generate embedding for the query text
    const queryEmbedding = await this.generateQueryEmbedding(queryText);
    if (!queryEmbedding) {
      this.logger.warn('Failed to generate query embedding, returning empty results');
      return [];
    }

    // 2. Get user's accessible channel IDs
    const channelIds = await this.getUserChannelIds(userId, channelId);
    if (channelIds.length === 0) {
      return [];
    }

    // 3. Perform pgvector cosine similarity search
    // SECURITY: Include tenantId in WHERE clause to prevent cross-tenant
    // semantic search. Without this filter, vector search returns results
    // from all tenants — cross-tenant information disclosure.
    // @see MSG-HIGH-042 (vector search missing tenantId filter)
    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const cappedLimit = Math.min(limit, 50);

    const results: Array<{
      id: string;
      channelId: string;
      senderId: string;
      content: string | null;
      contentType: string;
      createdAt: Date;
      isDeleted: boolean;
      similarity: number;
    }> = await this.dataSource.query(
      `SELECT
        m."id",
        m."channelId",
        m."senderId",
        m."content",
        m."contentType",
        m."createdAt",
        m."isDeleted",
        1 - (m."embedding" <=> $1::vector) as "similarity"
      FROM "messages" m
      WHERE m."embedding" IS NOT NULL
        AND m."isDeleted" = false
        AND m."tenantId" = $2::uuid
        AND m."channelId" = ANY($3::uuid[])
      ORDER BY m."embedding" <=> $1::vector
      LIMIT $4`,
      [vectorStr, query.tenantId, channelIds, cappedLimit],
    );

    return results.map((row) => ({
      message: {
        id: row.id,
        channelId: row.channelId,
        senderId: row.senderId,
        content: row.content,
        contentType: row.contentType as Message['contentType'],
        createdAt: row.createdAt,
        isDeleted: row.isDeleted,
      },
      similarity: parseFloat(String(row.similarity)),
    }));
  }

  /**
   * Generate an embedding vector for the query text via ai-service NATS.
   */
  private async generateQueryEmbedding(
    text: string,
  ): Promise<number[] | null> {
    const response = await firstValueFrom(
      this.natsClient
        .send<EmbeddingResponse>('request.ai.generateEmbeddings', {
          texts: [text],
        })
        .pipe(
          timeout(NATS_TIMEOUT_MS),
          catchError((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Query embedding generation failed: ${errMsg}`);
            return of(null);
          }),
        ),
    );

    if (!response || !response.embeddings || response.embeddings.length === 0) {
      return null;
    }

    return response.embeddings[0] ?? null;
  }

  /**
   * Get channel IDs the user is an active member of.
   * If channelId is specified, validates the user is a member and returns just that.
   */
  private async getUserChannelIds(
    userId: string,
    channelId: string | null,
  ): Promise<string[]> {
    if (channelId) {
      // Validate membership in the specific channel
      const membership: Array<{ channelId: string }> = await this.dataSource.query(
        `SELECT "channelId" FROM "channel_members"
         WHERE "userId" = $1 AND "channelId" = $2 AND "leftAt" IS NULL
         LIMIT 1`,
        [userId, channelId],
      );
      return membership.map((m) => m.channelId);
    }

    // Get all channels the user belongs to
    const memberships: Array<{ channelId: string }> = await this.dataSource.query(
      `SELECT "channelId" FROM "channel_members"
       WHERE "userId" = $1 AND "leftAt" IS NULL`,
      [userId],
    );
    return memberships.map((m) => m.channelId);
  }
}
