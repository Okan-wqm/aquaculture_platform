import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetLeaveTypesQuery } from '../queries/get-leave-types.query';
import { LeaveType, LeaveCategory } from '../entities/leave-type.entity';

@QueryHandler(GetLeaveTypesQuery)
export class GetLeaveTypesHandler implements IQueryHandler<GetLeaveTypesQuery> {
  constructor(
    @InjectRepository(LeaveType)
    private readonly leaveTypeRepository: Repository<LeaveType>,
  ) {}

  async execute(query: GetLeaveTypesQuery): Promise<LeaveType[]> {
    const { tenantId, isActive, category } = query;

    const queryBuilder = this.leaveTypeRepository
      .createQueryBuilder('lt')
      .where('lt.tenantId = :tenantId', { tenantId })
      .andWhere('lt.isDeleted = false')
      .orderBy('lt.displayOrder', 'ASC')
      .addOrderBy('lt.name', 'ASC');

    if (isActive !== undefined) {
      queryBuilder.andWhere('lt.isActive = :isActive', { isActive });
    }

    if (category) {
      queryBuilder.andWhere('lt.category = :category', { category: category as LeaveCategory });
    }

    return queryBuilder.getMany();
  }
}
