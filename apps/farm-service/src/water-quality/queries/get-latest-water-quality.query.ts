/**
 * Get Latest Water Quality (by tank) Query
 */
import { IQuery } from '@platform/cqrs';

export class GetLatestWaterQualityQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly tankId: string,
  ) {}
}
