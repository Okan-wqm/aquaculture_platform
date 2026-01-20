/**
 * Get Department Delete Preview Query
 * Returns a preview of what will be deleted when a department is soft deleted
 */
import { IQuery } from '@nestjs/cqrs';

export class GetDepartmentDeletePreviewQuery implements IQuery {
  constructor(
    public readonly departmentId: string,
    public readonly tenantId: string,
  ) {}
}
