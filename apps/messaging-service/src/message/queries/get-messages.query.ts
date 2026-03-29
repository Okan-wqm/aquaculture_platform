import { IQuery } from '@nestjs/cqrs';

/**
 * Query to get messages for a channel with cursor-based pagination.
 */
export class GetMessagesQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
    public readonly limit: number,
    public readonly cursor: string | null,
    public readonly before: Date | null,
    public readonly after: Date | null,
  ) {}
}
