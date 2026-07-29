import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toIsoCalendarDate } from '../../common/utc-calendar-date';
import { GetRotationCalendarQuery } from '../queries/get-rotation-calendar.query';
import { WorkRotation, RotationStatus, RotationType } from '../entities/work-rotation.entity';
import { RotationCalendarEntry } from '../dto/rotation-calendar.dto';

/**
 * Rotations whose date range overlaps the [startDate, endDate] window, flattened
 * into calendar rows (employee + work-area display names joined in). Mirrors
 * GetWorkRotationsHandler tenant scoping and its overlap predicate
 * (endDate >= windowStart AND startDate <= windowEnd). Cancelled rotations are
 * excluded — they never appear on the schedule.
 */
@QueryHandler(GetRotationCalendarQuery)
export class GetRotationCalendarHandler
  implements IQueryHandler<GetRotationCalendarQuery>
{
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetRotationCalendarQuery): Promise<RotationCalendarEntry[]> {
    const { tenantId, startDate, endDate, workAreaId } = query;

    if (isNaN(new Date(startDate).getTime())) {
      throw new BadRequestException(`Invalid start date: ${startDate}`);
    }
    if (isNaN(new Date(endDate).getTime())) {
      throw new BadRequestException(`Invalid end date: ${endDate}`);
    }
    if (new Date(endDate) < new Date(startDate)) {
      throw new BadRequestException('End date must not be before start date');
    }

    const qb = this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .leftJoinAndSelect('wr.workArea', 'workArea')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.isDeleted = false')
      .andWhere('wr.status != :cancelled', { cancelled: RotationStatus.CANCELLED })
      .andWhere('wr.endDate >= :startDate', { startDate })
      .andWhere('wr.startDate <= :endDate', { endDate })
      .orderBy('wr.startDate', 'ASC');

    if (workAreaId) {
      qb.andWhere('wr.workAreaId = :workAreaId', { workAreaId });
    }

    const rotations = await qb.getMany();

    return rotations.map((rotation) => {
      const employee = rotation.employee;
      const workArea = rotation.workArea;
      const entry = new RotationCalendarEntry();
      entry.id = rotation.id;
      entry.employeeId = rotation.employeeId;
      entry.employeeName = employee
        ? `${employee.firstName} ${employee.lastName}`.trim()
        : rotation.employeeId;
      entry.workAreaName = workArea ? workArea.name : rotation.workAreaId;
      entry.rotationType = rotation.rotationType;
      entry.startDate = toIsoCalendarDate(rotation.startDate);
      entry.endDate = toIsoCalendarDate(rotation.endDate);
      entry.status = rotation.status;
      entry.isOffshore = workArea
        ? workArea.isOffshore
        : rotation.rotationType === RotationType.OFFSHORE;
      entry.daysOn = rotation.daysOn;
      entry.daysOff = rotation.daysOff;
      return entry;
    });
  }
}
