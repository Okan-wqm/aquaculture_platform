/**
 * ReplaceParameterChannelCommand
 *
 * Swap the channel of a live channel source in one transaction, keeping its
 * parameter, place and priority — the parameter is never without a source in
 * between.
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import type { SensorChannelKey } from '@platform/event-contracts';

export class ReplaceParameterChannelCommand implements ITenantCommand {
  readonly commandName = 'ReplaceParameterChannelCommand';

  constructor(
    public readonly tenantId: string,
    public readonly sourceId: string,
    public readonly channel: SensorChannelKey,
    public readonly userId: string,
  ) {}
}
