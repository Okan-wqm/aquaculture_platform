/**
 * List Feeder Calibrations Query
 */
import type { TenantScope } from '@aquaculture/backend-common/database';
export class ListFeederCalibrationsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly equipmentId: string,
  ) {}
}
