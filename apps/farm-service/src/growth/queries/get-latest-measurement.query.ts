/**
 * GetLatestMeasurementQuery
 *
 * Batch için en son büyüme ölçümünü getirir.
 *
 * @module Growth/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export class GetLatestMeasurementQuery implements ITenantQuery {
  readonly queryName = 'GetLatestMeasurementQuery';

  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
  ) {}
}
