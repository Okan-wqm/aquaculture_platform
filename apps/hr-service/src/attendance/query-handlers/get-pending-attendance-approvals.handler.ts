import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetPendingAttendanceApprovalsQuery } from '../queries/get-pending-attendance-approvals.query';
import { AttendanceRecord, ApprovalStatus } from '../entities/attendance-record.entity';
import { Employee } from '../../hr/entities/employee.entity';

export interface PaginatedPendingAttendanceApprovals {
  items: AttendanceRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

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

  async execute(query: GetPendingAttendanceApprovalsQuery): Promise<PaginatedPendingAttendanceApprovals> {
    const { tenantId, approverId, departmentId, limit = 20, offset = 0 } = query;

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const effectiveOffset = Math.max(offset, 0);

    // Get approver's details
    const approver = await this.employeeRepository.findOne({
      where: { id: approverId, tenantId, isDeleted: false },
    });

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

    if (departmentId) {
      queryBuilder.andWhere('ar.departmentId = :departmentId', { departmentId });
    } else if (approver?.departmentHrId) {
      queryBuilder.andWhere('ar.departmentId = :departmentId', {
        departmentId: approver.departmentHrId,
      });
    }

    const [items, total] = await queryBuilder
      .skip(effectiveOffset)
      .take(effectiveLimit)
      .getManyAndCount();

    return {
      items,
      total,
      limit: effectiveLimit,
      offset: effectiveOffset,
      hasMore: effectiveOffset + items.length < total,
    };
  }
}
