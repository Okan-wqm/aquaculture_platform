import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
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

  async execute(query: GetPendingAttendanceApprovalsQuery): Promise<AttendanceRecord[]> {
    const { tenantId, approverId, departmentId } = query;

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
    } else if (approver?.departmentId) {
      queryBuilder.andWhere('ar.departmentId = :departmentId', {
        departmentId: approver.departmentId,
      });
    }

    return queryBuilder.getMany();
  }
}
