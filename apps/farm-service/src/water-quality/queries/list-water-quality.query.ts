/**
 * List Water Quality Measurements Query
 */
import { IQuery } from '@platform/cqrs';
import { WaterQualityFilters } from '../water-quality.service';

export class ListWaterQualityQuery implements IQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filters: WaterQualityFilters = {},
  ) {}
}
