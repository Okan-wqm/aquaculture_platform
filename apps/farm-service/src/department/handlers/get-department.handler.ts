/**
 * Get Department Query Handler
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { InjectDataSource } from '@nestjs/typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { Department } from '../entities/department.entity';
import { GetDepartmentQuery } from '../queries/get-department.query';

@QueryHandler(GetDepartmentQuery)
export class GetDepartmentHandler implements IQueryHandler<GetDepartmentQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetDepartmentQuery): Promise<Department | null> {
    const { departmentId, tenantId, includeRelations } = query;

    const relations: string[] = [];
    if (includeRelations) {
      relations.push('site');
    }

    // Read through the fail-closed tenant boundary. A lost tenant context or a
    // wrong/un-provisioned tenant schema now throws TenantContextError at the
    // boundary instead of silently resolving zero rows, so the `null` below is
    // an honest "no such department" — not a masked search_path failure.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const department = await queryRunner.manager.findOne(Department, {
        where: { id: departmentId, tenantId },
        relations,
      });
      return department ?? null;
    });
  }
}
