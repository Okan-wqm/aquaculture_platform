/**
 * List Critical Water Quality Tanks Query (life-safety surface).
 */
import { IQuery } from '@platform/cqrs';

export class ListCriticalWaterQualityQuery implements IQuery {
  constructor(public readonly tenantId: string) {}
}
