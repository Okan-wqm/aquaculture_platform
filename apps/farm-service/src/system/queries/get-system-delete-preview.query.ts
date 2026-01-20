/**
 * Get System Delete Preview Query
 * Returns a preview of what will be deleted when a system is soft deleted
 */
import { IQuery } from '@nestjs/cqrs';

export class GetSystemDeletePreviewQuery implements IQuery {
  constructor(
    public readonly systemId: string,
    public readonly tenantId: string,
  ) {}
}
