import { IQuery } from '@nestjs/cqrs';

/**
 * Query for full-text search across messages using PostgreSQL tsvector.
 */
export class SearchMessagesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly searchQuery: string,
    public readonly channelId: string | null,
    public readonly limit: number,
  ) {}
}
