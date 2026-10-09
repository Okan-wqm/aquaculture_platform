/**
 * Read side of the parameter channel binding (FARM-HIGH-373).
 *
 * @module WaterQuality/Queries
 */
import type { Role } from '@aquaculture/backend-common/decorators';
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

/** Who reads the sources at a point: a MODULE_USER only at a site assigned to them. */
export interface SourceReader {
  sub: string;
  roles: Role[];
  assignedSiteIds?: string[];
}

/** Every live source at a point, with each channel's status and problems now. */
export class ListParameterSourcesAtPointQuery implements ITenantQuery {
  readonly queryName = 'ListParameterSourcesAtPointQuery';

  constructor(
    public readonly tenantId: string,
    public readonly point: MeasurementPoint,
    public readonly caller: SourceReader,
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

/** How many live channel sources a parameter has anywhere (its meaning is fixed while any exists). */
export class CountLiveChannelSourcesQuery implements ITenantQuery {
  readonly queryName = 'CountLiveChannelSourcesQuery';

  constructor(
    public readonly tenantId: string,
    public readonly parameterConfigId: string,
  ) {}
}
