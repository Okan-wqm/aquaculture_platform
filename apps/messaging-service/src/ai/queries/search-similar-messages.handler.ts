/**
 * @module SearchSimilarMessagesHandler
 * @description CQRS query handler for pgvector cosine similarity search.
 * Generates an embedding for the query text via ai-service, then performs
 * a vector similarity search using the HNSW index on the messages table.
 *
 * Results are restricted to channels the requesting user belongs to,
 * enforcing data isolation at the query level.
 *
 * K10 layer 5 (PR-T1, MT-HIGH-062): this is the AI retrieval (RAG) read. The
 * channel scope and the vector search run inside ONE fail-closed
 * `runInTenantRead` (tenant search_path + RLS GUC pinned and asserted), and
 * every table is also filtered by the request tenant, so no ambient pooled
 * connection decides whose messages are searched.
 *
 * @see ADR-012 section 12.1 (Embedding Pipeline)
 * @see ADR-012 section 12.5 (AI Privacy Framework - Embedding search scope)
 */
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Logger, Inject } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { runInTenantRead } from '@aquaculture/backend-common/database';
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
  message: Pick<
    Message,
    'id' | 'channelId' | 'senderId' | 'content' | 'contentType' | 'createdAt' | 'isDeleted'
  >;
  /** Cosine similarity score (0.0 to 1.0, higher = more similar). */
  similarity: number;
}

/** One row of the similarity query. */
interface SimilarityRow {
  id: string;
  channelId: string;
  senderId: string;
  content: string | null;
  contentType: string;
  createdAt: Date;
  isDeleted: boolean;
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
  async execute(query: SearchSimilarMessagesQuery): Promise<SimilarMessage[]> {
    const { tenantId, userId, queryText, channelId, limit } = query;

    // MSG-HIGH-061: the search text is tenant content leaving messaging toward
    // the AI system (ai-service embeds it). Route it through the same fail-closed
    // egress-gate SSoT the chat path uses (tenant AI master switch + user
    // consent). A disabled tenant / non-consented user gets no AI search and no
    // content leaves.
    const egressAllowed = await this.egressGate.isAllowed(tenantId, userId, 'semantic-search');
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

    // 2 + 3. The user's channel scope and the pgvector cosine search, read
    // inside ONE tenant boundary (K10 layer 5). The embedding request above
    // stays OUTSIDE it, so no transaction is held open across a NATS call.
    // SECURITY: every table is ALSO filtered by tenantId — without it a vector
    // search returns results from all tenants (MSG-HIGH-042).
    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const cappedLimit = Math.min(limit, 50);
    const results = await runInTenantRead(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner): Promise<SimilarityRow[]> => {
        const channelIds = await this.getUserChannelIds(queryRunner, tenantId, userId, channelId);
        if (channelIds.length === 0) {
          return [];
        }
        const rows: SimilarityRow[] = await queryRunner.query(
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
          [vectorStr, tenantId, channelIds, cappedLimit],
        );
        return rows;
      },
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
  private async generateQueryEmbedding(text: string): Promise<number[] | null> {
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
   * Channel IDs the user is an active member of, read through the caller's
   * tenant-bound query runner. If channelId is specified, validates the user is
   * a member and returns just that.
   */
  private async getUserChannelIds(
    queryRunner: QueryRunner,
    tenantId: string,
    userId: string,
    channelId: string | null,
  ): Promise<string[]> {
    if (channelId) {
      // Validate membership in the specific channel
      const membership: Array<{ channelId: string }> = await queryRunner.query(
        `SELECT "channelId" FROM "channel_members"
         WHERE "tenantId" = $1 AND "userId" = $2 AND "channelId" = $3 AND "leftAt" IS NULL
         LIMIT 1`,
        [tenantId, userId, channelId],
      );
      return membership.map((m) => m.channelId);
    }

    // Get all channels the user belongs to
    const memberships: Array<{ channelId: string }> = await queryRunner.query(
      `SELECT "channelId" FROM "channel_members"
       WHERE "tenantId" = $1 AND "userId" = $2 AND "leftAt" IS NULL`,
      [tenantId, userId],
    );
    return memberships.map((m) => m.channelId);
  }
}
