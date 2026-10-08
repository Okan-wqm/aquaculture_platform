/**
 * Read side of the parameter channel binding (FARM-HIGH-373).
 *
 * @module WaterQuality/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

import type { ChannelSourceTarget } from '../commands/bind-parameter-channel.command';
import type { MeasurementPoint } from '../services/parameter-sources';

/** Whether a channel could be bound as a source, without binding it (the bind's own rule). */
export class CheckParameterChannelBindingQuery implements ITenantQuery {
  readonly queryName = 'CheckParameterChannelBindingQuery';

  constructor(
    public readonly tenantId: string,
    public readonly target: ChannelSourceTarget,
  ) {}
}

/** Every live source at a point, with each channel's status and problems now. */
export class ListParameterSourcesAtPointQuery implements ITenantQuery {
  readonly queryName = 'ListParameterSourcesAtPointQuery';

  constructor(
    public readonly tenantId: string,
    public readonly point: MeasurementPoint,
  ) {}
}

/** The declaration history of a parameter, newest first. */
export class ListParameterQuantityDeclarationsQuery implements ITenantQuery {
  readonly queryName = 'ListParameterQuantityDeclarationsQuery';

  constructor(
    public readonly tenantId: string,
    public readonly parameterConfigId: string,
  ) {}
}
