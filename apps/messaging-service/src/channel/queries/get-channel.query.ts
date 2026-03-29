import { IQuery } from '@platform/cqrs';

/**
 * Query to retrieve a single channel by ID, including its active members.
 */
export class GetChannelQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string,
  ) {}
}
