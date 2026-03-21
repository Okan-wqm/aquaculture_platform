import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetLeaveRequestsQuery } from '../queries/get-leave-requests.query';
import { LeaveRequest } from '../entities/leave-request.entity';

@QueryHandler(GetLeaveRequestsQuery)
export class GetLeaveRequestsHandler implements IQueryHandler<GetLeaveRequestsQuery> {
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
  ) {}

  async execute(query: GetLeaveRequestsQuery): Promise<PaginatedQueryResult<LeaveRequest>> {
    const {
      tenantId,
      employeeId,
      status,
      leaveTypeId,
      startDate,
      endDate,
    } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const queryBuilder = this.leaveRequestRepository
      .createQueryBuilder('lr')
      .leftJoinAndSelect('lr.employee', 'employee')
      .leftJoinAndSelect('lr.leaveType', 'leaveType')
      .where('lr.tenantId = :tenantId', { tenantId })
      .andWhere('lr.isDeleted = false')
      .orderBy('lr.createdAt', 'DESC');

    if (employeeId) {
      queryBuilder.andWhere('lr.employeeId = :employeeId', { employeeId });
    }

    if (status) {
      queryBuilder.andWhere('lr.status = :status', { status });
    }

    if (leaveTypeId) {
      queryBuilder.andWhere('lr.leaveTypeId = :leaveTypeId', { leaveTypeId });
    }

    if (startDate) {
      queryBuilder.andWhere('lr.endDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('lr.startDate <= :endDate', { endDate });
    }

    const [items, total] = await queryBuilder
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
