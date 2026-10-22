import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { applyApprovalDepartment, resolveApprovalDepartment } from '../../common/approval-scope';
import { applyEmployeeModuleScope } from '../../common/module-scope';
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
    const { tenantId, approverId, departmentId, moduleCode, narrowToOwnDepartment } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    // Which department the queue narrows to is common/approval-scope.ts, the one rule shared with
    // the attendance queue.
    const scope = await resolveApprovalDepartment(this.employeeRepository, {
      tenantId,
      approverId,
      departmentId,
      moduleCode,
      narrowToOwnDepartment,
    });
    if (scope.kind === 'unknown-approver') {
      // Return an empty set rather than leaking cross-department data
      return createPaginatedQueryResult([], page, limit, 0);
    }

    const queryBuilder = this.leaveRequestRepository
      .createQueryBuilder('lr')
      .leftJoinAndSelect('lr.employee', 'employee')
      .leftJoinAndSelect('lr.leaveType', 'leaveType')
      .where('lr.tenantId = :tenantId', { tenantId })
      .andWhere('lr.status = :status', { status: LeaveRequestStatus.PENDING })
      .andWhere('lr.isDeleted = false')
      .orderBy('lr.createdAt', 'ASC');

    // Exclude approver's own requests (only when approverId is available)
    if (approverId) {
      queryBuilder.andWhere('lr.employeeId != :approverId', { approverId });
    }

    applyApprovalDepartment(queryBuilder, 'employee', scope.departmentId);

    const [items, total] = await applyEmployeeModuleScope(queryBuilder, 'employee', moduleCode)
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
