/**
 * @module SearchSimilarMessagesQuery
 * @description CQRS query for vector similarity search across messages using
 * pgvector cosine distance. Results are scoped to the requesting user's
 * channels only for data isolation.
 * @see ADR-012 section 12.1 (Embedding Pipeline)
 */
import { IQuery } from '@nestjs/cqrs';

/**
 * Query to search for semantically similar messages using vector embeddings.
 */
export class SearchSimilarMessagesQuery implements IQuery {
  constructor(
    /** Tenant identifier for scoping. */
    public readonly tenantId: string,
    /** Requesting user ID (for channel access scoping). */
    public readonly userId: string,
    /** Natural language search query text. */
    public readonly queryText: string,
    /** Optional channel filter. Null searches across all user's channels. */
    public readonly channelId: string | null,
    /** Maximum results to return (default: 10). */
    public readonly limit: number,
  ) {}
}
