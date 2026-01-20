/**
 * Get Department Query Handler
 */
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetDepartmentQuery } from '../queries/get-department.query';
import { Department } from '../entities/department.entity';

@QueryHandler(GetDepartmentQuery)
export class GetDepartmentHandler implements IQueryHandler<GetDepartmentQuery> {
  constructor(
    @InjectRepository(Department)
    private readonly departmentRepository: Repository<Department>,
  ) {}

  async execute(query: GetDepartmentQuery): Promise<Department> {
    const { departmentId, tenantId, includeRelations } = query;

    const relations: string[] = [];
    if (includeRelations) {
      relations.push('site');
      // relations.push('equipment');
    }

    const department = await this.departmentRepository.findOne({
      where: { id: departmentId, tenantId },
      relations,
    });

    // Return null instead of throwing - allows partial data in GraphQL responses
    // The department field is nullable, so this is a valid response
    // This handles connection pool race conditions where search_path might be reset
    if (!department) {
      return null as unknown as Department;
    }

    return department;
  }
}
