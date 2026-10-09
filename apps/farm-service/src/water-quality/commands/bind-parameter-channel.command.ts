/**
 * BindParameterChannelCommand
 *
 * Make a sensor channel a source of a water-quality parameter at a
 * measurement point (FARM-HIGH-373).
 *
 * @module WaterQuality/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import type { SensorChannelKey } from '@platform/event-contracts';

import type { ChannelSourcePriority } from '../entities/water-quality-param-equipment.entity';
import type { SourceLocation } from '../services/parameter-sources';

export interface ChannelSourceTarget {
  parameterConfigId: string;
  location: SourceLocation;
  channel: SensorChannelKey;
}

export interface BindParameterChannelPayload extends ChannelSourceTarget {
  priority: ChannelSourcePriority;
}

export class BindParameterChannelCommand implements ITenantCommand {
  readonly commandName = 'BindParameterChannelCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: BindParameterChannelPayload,
    public readonly userId: string,
  ) {}
}
