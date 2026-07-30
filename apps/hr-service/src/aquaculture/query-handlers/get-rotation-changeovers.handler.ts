import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toIsoCalendarDate } from '../../common/utc-calendar-date';
import { GetRotationChangeoversQuery } from '../queries/get-rotation-changeovers.query';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import {
  RotationChangeoverDay,
  ChangeoverMovement,
} from '../dto/rotation-changeover.dto';

/**
 * Crew changeover events within [startDate, endDate], grouped by day.
 *
 * A rotation contributes a "goingOffshore" movement on its startDate (outbound
 * transport leg) and a "returningOnshore" movement on its endDate (inbound
 * transport leg). Only changeovers that actually fall inside the window are
 * emitted (a rotation spanning the whole window with both ends outside it yields
 * nothing). Mirrors GetWorkRotationsHandler tenant scoping; cancelled rotations
 * are excluded.
 */
@QueryHandler(GetRotationChangeoversQuery)
export class GetRotationChangeoversHandler
  implements IQueryHandler<GetRotationChangeoversQuery>
{
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(
    query: GetRotationChangeoversQuery,
  ): Promise<RotationChangeoverDay[]> {
    const { tenantId, startDate, endDate } = query;

    if (isNaN(new Date(startDate).getTime())) {
      throw new BadRequestException(`Invalid start date: ${startDate}`);
    }
    if (isNaN(new Date(endDate).getTime())) {
      throw new BadRequestException(`Invalid end date: ${endDate}`);
    }
    if (new Date(endDate) < new Date(startDate)) {
      throw new BadRequestException('End date must not be before start date');
    }

    // A rotation can contribute a changeover if EITHER endpoint lands in the
    // window: it starts within the window OR it ends within the window.
    const rotations = await this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .leftJoinAndSelect('wr.workArea', 'workArea')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.isDeleted = false')
      .andWhere('wr.status != :cancelled', { cancelled: RotationStatus.CANCELLED })
      .andWhere(
        '(wr.startDate BETWEEN :startDate AND :endDate OR wr.endDate BETWEEN :startDate AND :endDate)',
        { startDate, endDate },
      )
      .orderBy('wr.startDate', 'ASC')
      .getMany();

    // date (YYYY-MM-DD) -> changeover bucket
    const byDate = new Map<string, RotationChangeoverDay>();

    const bucket = (date: string): RotationChangeoverDay => {
      let day = byDate.get(date);
      if (!day) {
        day = new RotationChangeoverDay();
        day.date = date;
        day.goingOffshore = [];
        day.returningOnshore = [];
        byDate.set(date, day);
      }
      return day;
    };

    for (const rotation of rotations) {
      const employee = rotation.employee;
      const workArea = rotation.workArea;
      const employeeName = employee
        ? `${employee.firstName} ${employee.lastName}`.trim()
        : rotation.employeeId;
      const workAreaName = workArea ? workArea.name : rotation.workAreaId;

      const start = toIsoCalendarDate(rotation.startDate);
      const end = toIsoCalendarDate(rotation.endDate);

      if (start >= startDate && start <= endDate) {
        const movement = new ChangeoverMovement();
        movement.employeeId = rotation.employeeId;
        movement.employeeName = employeeName;
        movement.workAreaName = workAreaName;
        movement.transportMethod = rotation.outboundTransport?.method;
        movement.rotationId = rotation.id;
        bucket(start).goingOffshore.push(movement);
      }

      if (end >= startDate && end <= endDate) {
        const movement = new ChangeoverMovement();
        movement.employeeId = rotation.employeeId;
        movement.employeeName = employeeName;
        movement.workAreaName = workAreaName;
        movement.transportMethod = rotation.inboundTransport?.method;
        movement.rotationId = rotation.id;
        bucket(end).returningOnshore.push(movement);
      }
    }

    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }
}
