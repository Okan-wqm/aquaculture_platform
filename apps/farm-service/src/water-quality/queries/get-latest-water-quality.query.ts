/**
 * Get Latest Water Quality (by unit: a tank or water equipment) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetLatestWaterQualityQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly unitId: string,
  ) {}
}
