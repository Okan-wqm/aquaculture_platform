import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetDepartmentsQuery, GetDepartmentQuery } from '../queries/get-departments.query';
import { DepartmentHR } from '../entities/department.entity';

@Injectable()
@QueryHandler(GetDepartmentsQuery)
export class GetDepartmentsHandler implements IQueryHandler<GetDepartmentsQuery, DepartmentHR[]> {
  constructor(
    @InjectRepository(DepartmentHR)
    private readonly departmentRepository: Repository<DepartmentHR>,
  ) {}

  async execute(query: GetDepartmentsQuery): Promise<DepartmentHR[]> {
    const { tenantId, siteId, isDeleted } = query;

    const where: FindOptionsWhere<DepartmentHR> = {
      tenantId,
      isDeleted: isDeleted ?? false,
    };

    if (siteId) {
      where.siteId = siteId;
    }

    return this.departmentRepository.find({
      where,
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
  }
}

@Injectable()
@QueryHandler(GetDepartmentQuery)
export class GetDepartmentHandler implements IQueryHandler<GetDepartmentQuery, DepartmentHR> {
  constructor(
    @InjectRepository(DepartmentHR)
    private readonly departmentRepository: Repository<DepartmentHR>,
  ) {}

  async execute(query: GetDepartmentQuery): Promise<DepartmentHR> {
    const { tenantId, id } = query;

    const department = await this.departmentRepository.findOne({
      where: { tenantId, id },
    });

    if (!department) {
      throw new NotFoundException(`Department ${id} not found`);
    }

    return department;
  }
}
