import { QueryHandler, IQueryHandler, PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetPendingAttendanceApprovalsQuery } from '../queries/get-pending-attendance-approvals.query';
import { AttendanceRecord, ApprovalStatus } from '../entities/attendance-record.entity';
import { Employee } from '../../hr/entities/employee.entity';

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
    const { tenantId, approverId, departmentId } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    // Only look up the approver's department when the caller has NOT supplied an explicit
    // departmentId — avoids a wasted round-trip on every call where departmentId is known.
    let effectiveDepartmentId = departmentId;
    if (!effectiveDepartmentId) {
      const approver = await this.employeeRepository.findOne({
        where: { id: approverId, tenantId, isDeleted: false },
        select: ['id', 'departmentHrId'],
      });
      if (!approver) {
        return createPaginatedQueryResult([], page, limit, 0);
      }
      effectiveDepartmentId = approver.departmentHrId;
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
      // Exclude approver's own records
      .andWhere('ar.employeeId != :approverId', { approverId })
      .orderBy('ar.date', 'DESC');

    if (effectiveDepartmentId) {
      queryBuilder.andWhere('ar.departmentId = :departmentId', { departmentId: effectiveDepartmentId });
    }

    const [items, total] = await queryBuilder
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
