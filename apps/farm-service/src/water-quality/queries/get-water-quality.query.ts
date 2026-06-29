/**
 * Get Water Quality Measurement Query
 */
import { IQuery } from '@platform/cqrs';

export class GetWaterQualityQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
