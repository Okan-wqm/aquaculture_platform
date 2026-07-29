import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { toIsoCalendarDate } from '../../common/utc-calendar-date';
import { LeaveOverlapResult } from '../dto/leave-admin.types';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { CheckLeaveOverlapQuery } from '../queries/check-leave-overlap.query';

/**
 * Does a proposed [startDate, endDate] range overlap any of the employee's
 * non-voided leave requests? Mirrors the overlap predicate used inside
 * CreateLeaveRequestHandler (CANCELLED/REJECTED/WITHDRAWN are excluded), so the
 * FE pre-check and the server-side create guard agree.
 *
 * `excludeRequestId` lets an edit form ignore the request currently being
 * edited.
 */
@QueryHandler(CheckLeaveOverlapQuery)
export class CheckLeaveOverlapHandler
  implements IQueryHandler<CheckLeaveOverlapQuery>
{
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
  ) {}

  async execute(query: CheckLeaveOverlapQuery): Promise<LeaveOverlapResult> {
    const { tenantId, employeeId, startDate, endDate, excludeRequestId } = query;

    const qb = this.leaveRequestRepository
      .createQueryBuilder('lr')
      .where('lr.tenantId = :tenantId', { tenantId })
      .andWhere('lr.employeeId = :employeeId', { employeeId })
      .andWhere('lr.isDeleted = false')
      .andWhere('lr.status NOT IN (:...excludedStatuses)', {
        excludedStatuses: [
          LeaveRequestStatus.CANCELLED,
          LeaveRequestStatus.REJECTED,
          LeaveRequestStatus.WITHDRAWN,
        ],
      })
      .andWhere('(lr.startDate <= :endDate AND lr.endDate >= :startDate)', {
        startDate,
        endDate,
      });

    if (excludeRequestId) {
      qb.andWhere('lr.id != :excludeRequestId', { excludeRequestId });
    }

    const overlapping = await qb.orderBy('lr.startDate', 'ASC').getMany();

    return {
      hasOverlap: overlapping.length > 0,
      overlappingRequests: overlapping.map((r) => ({
        id: r.id,
        requestNumber: r.requestNumber,
        startDate: toIsoCalendarDate(r.startDate),
        endDate: toIsoCalendarDate(r.endDate),
        status: r.status,
      })),
    };
  }
}
