/**
 * Ünite → yemleyici atama komutları (CQRS).
 * @module FeedingProtocol/Commands
 */
import { SetUnitFeedersInput } from '../dto/feeder-assignment.inputs';

export class SetUnitFeedersCommand {
  constructor(
    public readonly input: SetUnitFeedersInput,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
