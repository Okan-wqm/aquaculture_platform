/**
 * Get Equipment Delete Preview Query
 * Returns a preview of what will be deleted when an equipment is soft deleted
 */
import { IQuery } from '@nestjs/cqrs';

export class GetEquipmentDeletePreviewQuery implements IQuery {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
  ) {}
}
