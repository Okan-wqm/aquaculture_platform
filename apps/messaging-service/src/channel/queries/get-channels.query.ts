import { IQuery } from '@platform/cqrs';

/**
 * Query to retrieve the paginated list of channels the user is an active member of.
 */
export class GetChannelsQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly limit: number,
    public readonly offset: number,
  ) {}
}
