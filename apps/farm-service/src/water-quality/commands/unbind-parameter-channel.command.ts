/**
 * UnbindParameterChannelCommand
 *
 * End a channel source; a primary's backup takes its place.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';

export class UnbindParameterChannelCommand implements ITenantCommand {
  readonly commandName = 'UnbindParameterChannelCommand';

  constructor(
    public readonly tenantId: string,
    public readonly sourceId: string,
    public readonly userId: string,
  ) {}
}
