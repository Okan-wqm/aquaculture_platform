import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetLeaveBalancesQuery } from '../queries/get-leave-balances.query';
import { LeaveBalance } from '../entities/leave-balance.entity';

@QueryHandler(GetLeaveBalancesQuery)
export class GetLeaveBalancesHandler implements IQueryHandler<GetLeaveBalancesQuery> {
  constructor(
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
  ) {}

  async execute(query: GetLeaveBalancesQuery): Promise<LeaveBalance[]> {
    const { tenantId, employeeId, year, leaveTypeId } = query;

    const currentYear = year || new Date().getFullYear();

    const queryBuilder = this.leaveBalanceRepository
      .createQueryBuilder('lb')
      .leftJoinAndSelect('lb.leaveType', 'leaveType')
      .where('lb.tenantId = :tenantId', { tenantId })
      .andWhere('lb.employeeId = :employeeId', { employeeId })
      .andWhere('lb.year = :year', { year: currentYear })
      .andWhere('lb.isDeleted = false')
      .orderBy('leaveType.displayOrder', 'ASC');

    if (leaveTypeId) {
      queryBuilder.andWhere('lb.leaveTypeId = :leaveTypeId', { leaveTypeId });
    }

    return queryBuilder.getMany();
  }
}
