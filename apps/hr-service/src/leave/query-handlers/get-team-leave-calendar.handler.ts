import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetTeamLeaveCalendarQuery } from '../queries/get-team-leave-calendar.query';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { ObjectType, Field, ID } from '@nestjs/graphql';

@ObjectType()
export class LeaveCalendarEntry {
  @Field(() => ID)
  id!: string;

  @Field()
  employeeId!: string;

  @Field()
  employeeName!: string;

  @Field()
  leaveTypeName!: string;

  @Field()
  leaveTypeColor!: string;

  @Field()
  startDate!: Date;

  @Field()
  endDate!: Date;

  @Field()
  totalDays!: number;

  @Field(() => LeaveRequestStatus)
  status!: LeaveRequestStatus;

  @Field()
  isHalfDayStart!: boolean;

  @Field()
  isHalfDayEnd!: boolean;
}

@QueryHandler(GetTeamLeaveCalendarQuery)
export class GetTeamLeaveCalendarHandler implements IQueryHandler<GetTeamLeaveCalendarQuery> {
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
  ) {}

  async execute(query: GetTeamLeaveCalendarQuery): Promise<LeaveCalendarEntry[]> {
    const { tenantId, departmentId, startDate, endDate } = query;

    const queryBuilder = this.leaveRequestRepository
      .createQueryBuilder('lr')
      .leftJoinAndSelect('lr.employee', 'employee')
      .leftJoinAndSelect('lr.leaveType', 'leaveType')
      .where('lr.tenantId = :tenantId', { tenantId })
      .andWhere('lr.status IN (:...statuses)', {
        statuses: [LeaveRequestStatus.APPROVED, LeaveRequestStatus.PENDING],
      })
      .andWhere('lr.isDeleted = false')
      .andWhere('lr.endDate >= :startDate', { startDate })
      .andWhere('lr.startDate <= :endDate', { endDate })
      .orderBy('lr.startDate', 'ASC');

    if (departmentId) {
      queryBuilder.andWhere('employee.departmentId = :departmentId', { departmentId });
    }

    const leaveRequests = await queryBuilder.getMany();

    return leaveRequests.map((lr) => ({
      id: lr.id,
      employeeId: lr.employeeId,
      employeeName: lr.employee
        ? `${lr.employee.firstName} ${lr.employee.lastName}`
        : 'Unknown',
      leaveTypeName: lr.leaveType?.name || 'Unknown',
      leaveTypeColor: lr.leaveType?.colorCode || '#6B7280',
      startDate: lr.startDate,
      endDate: lr.endDate,
      totalDays: Number(lr.totalDays),
      status: lr.status,
      isHalfDayStart: lr.isHalfDayStart,
      isHalfDayEnd: lr.isHalfDayEnd,
    }));
  }
}
