import { IQuery } from '@nestjs/cqrs';

/**
 * Query for offline sync: returns messages after a timestamp for a specific channel.
 */
export class GetMessagesSinceQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
    public readonly since: Date,
  ) {}
}
