import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetCurrentRotationQuery } from '../queries/get-current-rotation.query';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { RotationDetail } from '../dto/rotation-detail.dto';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * The employee's active-now rotation. "Active" is defined by the rotation
 * state machine's non-terminal in-flight states (IN_PROGRESS, EXTENDED) whose
 * date window covers today. Mirrors GetWorkRotationsHandler tenant scoping.
 *
 * Returns null when the employee has no active rotation. The result is enriched
 * with computed daysRemaining + progressPercent for the current-rotation widget.
 */
@QueryHandler(GetCurrentRotationQuery)
export class GetCurrentRotationHandler
  implements IQueryHandler<GetCurrentRotationQuery>
{
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetCurrentRotationQuery): Promise<RotationDetail | null> {
    const { tenantId, employeeId } = query;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const rotation = await this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .leftJoinAndSelect('wr.workArea', 'workArea')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.employeeId = :employeeId', { employeeId })
      .andWhere('wr.isDeleted = false')
      .andWhere('wr.status IN (:...activeStatuses)', {
        activeStatuses: [RotationStatus.IN_PROGRESS, RotationStatus.EXTENDED],
      })
      .andWhere('wr.startDate <= :today', { today })
      .andWhere('wr.endDate >= :today', { today })
      .orderBy('wr.startDate', 'DESC')
      .getOne();

    if (!rotation) {
      return null;
    }

    return this.enrich(rotation);
  }

  private enrich(rotation: WorkRotation): RotationDetail {
    const now = new Date();
    const start = rotation.actualStartTime
      ? new Date(rotation.actualStartTime)
      : new Date(rotation.startDate);
    const end = new Date(rotation.endDate);

    let daysRemaining = 0;
    if (now < end) {
      daysRemaining = Math.ceil((end.getTime() - now.getTime()) / MS_PER_DAY);
    }

    let progressPercent: number;
    const totalMs = end.getTime() - start.getTime();
    if (now <= start) {
      progressPercent = 0;
    } else if (now >= end || totalMs <= 0) {
      progressPercent = 100;
    } else {
      progressPercent = Math.round(((now.getTime() - start.getTime()) / totalMs) * 100);
    }

    const detail = Object.assign(new RotationDetail(), rotation);
    detail.daysRemaining = daysRemaining;
    detail.progressPercent = progressPercent;
    return detail;
  }
}
