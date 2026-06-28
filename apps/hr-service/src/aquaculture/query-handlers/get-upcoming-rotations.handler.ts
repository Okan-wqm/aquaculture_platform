import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetUpcomingRotationsQuery } from '../queries/get-upcoming-rotations.query';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';

/**
 * The employee's future rotations — those still in the SCHEDULED state (per the
 * rotation state machine, SCHEDULED is the pre-start state) with a startDate
 * after today, soonest first. Mirrors GetWorkRotationsHandler tenant scoping.
 */
@QueryHandler(GetUpcomingRotationsQuery)
export class GetUpcomingRotationsHandler
  implements IQueryHandler<GetUpcomingRotationsQuery>
{
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetUpcomingRotationsQuery): Promise<WorkRotation[]> {
    const { tenantId, employeeId } = query;
    const limit = Math.min(Math.max(query.limit ?? 5, 1), 100);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .leftJoinAndSelect('wr.workArea', 'workArea')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.employeeId = :employeeId', { employeeId })
      .andWhere('wr.isDeleted = false')
      .andWhere('wr.status = :status', { status: RotationStatus.SCHEDULED })
      .andWhere('wr.startDate > :today', { today })
      .orderBy('wr.startDate', 'ASC')
      .take(limit)
      .getMany();
  }
}
