import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetPendingApprovalsQuery } from '../queries/get-pending-approvals.query';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { Employee } from '../../hr/entities/employee.entity';

export interface PaginatedPendingApprovals {
  items: LeaveRequest[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetPendingApprovalsQuery)
export class GetPendingApprovalsHandler implements IQueryHandler<GetPendingApprovalsQuery> {
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetPendingApprovalsQuery): Promise<PaginatedPendingApprovals> {
    const { tenantId, approverId, departmentId, limit = 20, offset = 0 } = query;

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const effectiveOffset = Math.max(offset, 0);

    // Get the approver's details to determine which requests they can approve
    const approver = await this.employeeRepository.findOne({
      where: { id: approverId, tenantId, isDeleted: false },
    });

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

    // If departmentId is provided, filter by department
    // FIX: Use departmentHrId - Employee entity has departmentHrId, not departmentId
    if (departmentId) {
      queryBuilder.andWhere('employee.departmentHrId = :departmentId', { departmentId });
    } else if (approver?.departmentHrId) {
      // If approver has a department, show pending requests from their department
      queryBuilder.andWhere('employee.departmentHrId = :departmentId', {
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
