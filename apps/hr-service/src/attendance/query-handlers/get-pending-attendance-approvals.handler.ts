import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetPendingAttendanceApprovalsQuery } from '../queries/get-pending-attendance-approvals.query';
import { AttendanceRecord, ApprovalStatus } from '../entities/attendance-record.entity';
import { applyApprovalDepartment, resolveApprovalDepartment } from '../../common/approval-scope';
import { applyEmployeeModuleScope } from '../../common/module-scope';
import { Employee } from '../../hr/entities/employee.entity';

/**
 * The pending-approval queue. Which department it narrows to is common/approval-scope.ts — the one
 * rule shared with the leave queue — through the employee's live department.
 */
@QueryHandler(GetPendingAttendanceApprovalsQuery)
export class GetPendingAttendanceApprovalsHandler
  implements IQueryHandler<GetPendingAttendanceApprovalsQuery>
{
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetPendingAttendanceApprovalsQuery): Promise<PaginatedQueryResult<AttendanceRecord>> {
    const { tenantId, approverId, departmentId, moduleCode, narrowToOwnDepartment } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const scope = await resolveApprovalDepartment(this.employeeRepository, {
      tenantId,
      approverId,
      departmentId,
      moduleCode,
      narrowToOwnDepartment,
    });
    if (scope.kind === 'unplaced-approver') {
      // An approver with no department sees an empty queue, never every department's.
      return createPaginatedQueryResult([], page, limit, 0);
    }

    const queryBuilder = this.attendanceRepository
      .createQueryBuilder('ar')
      .leftJoinAndSelect('ar.employee', 'employee')
      .leftJoinAndSelect('ar.shift', 'shift')
      .where('ar.tenantId = :tenantId', { tenantId })
      .andWhere('ar.approvalStatus = :approvalStatus', {
        approvalStatus: ApprovalStatus.PENDING_REVIEW,
      })
      .andWhere('ar.isDeleted = false')
      .orderBy('ar.date', 'DESC');

    // Exclude the approver's own records (only when they are an employee at all).
    if (approverId) {
      queryBuilder.andWhere('ar.employeeId != :approverId', { approverId });
    }

    applyApprovalDepartment(queryBuilder, 'employee', scope.departmentId);

    const [items, total] = await applyEmployeeModuleScope(queryBuilder, 'employee', moduleCode)
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
