import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetPendingApprovalsQuery } from '../queries/get-pending-approvals.query';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { Employee } from '../../hr/entities/employee.entity';

@QueryHandler(GetPendingApprovalsQuery)
export class GetPendingApprovalsHandler implements IQueryHandler<GetPendingApprovalsQuery> {
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetPendingApprovalsQuery): Promise<PaginatedQueryResult<LeaveRequest>> {
    const { tenantId, approverId, departmentId } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    // Resolve the approver employee record when no explicit departmentId is provided.
    // SECURITY: if the approverId cannot be resolved to a known employee we must NOT
    // fall back to returning all-department results — that would expose every tenant's
    // pending leave to any unrecognised caller.  Return empty results instead.
    let effectiveDepartmentId = departmentId;
    if (!effectiveDepartmentId) {
      const approver = await this.employeeRepository.findOne({
        where: { id: approverId, tenantId, isDeleted: false },
        select: ['id', 'departmentHrId'],
      });

      if (!approver) {
        // Unknown approver — return empty set rather than leaking cross-department data
        return createPaginatedQueryResult([], page, limit, 0);
      }

      effectiveDepartmentId = approver.departmentHrId;
    }

    const queryBuilder = this.leaveRequestRepository
      .createQueryBuilder('lr')
      .leftJoinAndSelect('lr.employee', 'employee')
      .leftJoinAndSelect('lr.leaveType', 'leaveType')
      .where('lr.tenantId = :tenantId', { tenantId })
      .andWhere('lr.status = :status', { status: LeaveRequestStatus.PENDING })
      .andWhere('lr.isDeleted = false')
      // Exclude approver's own requests
      .andWhere('lr.employeeId != :approverId', { approverId })
      .orderBy('lr.createdAt', 'ASC');

    // Filter by department (either explicitly provided or inferred from approver)
    if (effectiveDepartmentId) {
      queryBuilder.andWhere('employee.departmentHrId = :departmentId', { departmentId: effectiveDepartmentId });
    }

    const [items, total] = await queryBuilder
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
