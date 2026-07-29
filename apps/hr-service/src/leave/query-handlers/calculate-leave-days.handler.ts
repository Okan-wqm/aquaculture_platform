import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Holiday } from '../../scheduling/entities/holiday.entity';
import {
  addUtcCalendarDays,
  getUtcCalendarWeekday,
  toIsoCalendarDate,
  toUtcCalendarDate,
} from '../../common/utc-calendar-date';
import { LeaveDaysResult } from '../dto/leave-admin.types';
import { LeaveType } from '../entities/leave-type.entity';
import { CalculateLeaveDaysQuery } from '../queries/calculate-leave-days.query';

/**
 * Pure calendar calculation of leave days across [startDate, endDate].
 *
 * Honors weekends (Sat/Sun) and active tenant holidays (Holiday entity, the
 * same source scheduling conflict-detection consults). No entity write — this
 * is a read-only computation used by the request form to preview day counts.
 *
 * Half-day flags subtract 0.5 from BOTH the calendar total and the working-day
 * count for the start/end day (a half-day on a weekend/holiday is a no-op since
 * those days are not working days to begin with).
 */
@QueryHandler(CalculateLeaveDaysQuery)
export class CalculateLeaveDaysHandler
  implements IQueryHandler<CalculateLeaveDaysQuery>
{
  constructor(
    @InjectRepository(LeaveType)
    private readonly leaveTypeRepository: Repository<LeaveType>,
    @InjectRepository(Holiday)
    private readonly holidayRepository: Repository<Holiday>,
  ) {}

  async execute(query: CalculateLeaveDaysQuery): Promise<LeaveDaysResult> {
    const { tenantId, leaveTypeId, startDate, endDate, isHalfDayStart, isHalfDayEnd } = query;

    // The leave type is part of the FE contract; validate it exists/active so a
    // stale FE selection surfaces a 404 rather than a silently-meaningless calc.
    const leaveType = await this.leaveTypeRepository.findOne({
      where: { id: leaveTypeId, tenantId, isActive: true, isDeleted: false },
    });
    if (!leaveType) {
      throw new NotFoundException(`Leave type with ID ${leaveTypeId} not found or inactive`);
    }

    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate);
    if (start > end) {
      throw new BadRequestException('Start date must be before or equal to end date');
    }

    // Load holiday dates affecting this tenant within the range.
    const holidays = await this.holidayRepository
      .createQueryBuilder('h')
      .where('h.tenantId = :tenantId', { tenantId })
      .andWhere('h.isActive = true')
      .andWhere('h.affectsScheduling = true')
      .andWhere('h.startDate <= :end AND h.endDate >= :start', {
        start: this.toIsoDate(start),
        end: this.toIsoDate(end),
      })
      .getMany();

    const holidayDates = new Set<string>();
    for (const holiday of holidays) {
      const hStart = this.parseDate(holiday.startDate);
      const hEnd = this.parseDate(holiday.endDate);
      for (
        let d = new Date(hStart);
        d <= hEnd;
        d = addUtcCalendarDays(d, 1)
      ) {
        holidayDates.add(this.toIsoDate(d));
      }
    }

    let totalCalendarDays = 0;
    let weekends = 0;
    let holidayCount = 0;
    let workingDays = 0;

    for (
      let d = new Date(start);
      d <= end;
      d = addUtcCalendarDays(d, 1)
    ) {
      totalCalendarDays++;
      const day = getUtcCalendarWeekday(d); // 0 = Sun, 6 = Sat
      const isWeekend = day === 0 || day === 6;
      const isHoliday = holidayDates.has(this.toIsoDate(d));

      if (isWeekend) {
        weekends++;
      }
      // Count a holiday only when it is NOT also a weekend, so the two buckets
      // never double-count the same calendar day.
      if (isHoliday && !isWeekend) {
        holidayCount++;
      }
      if (!isWeekend && !isHoliday) {
        workingDays++;
      }
    }

    // Half-day adjustments: only meaningful when the boundary day is a working day.
    let totalDays = totalCalendarDays;
    const startIsWorking = this.isWorkingDay(start, holidayDates);
    const endIsWorking = this.isWorkingDay(end, holidayDates);
    const sameDay = this.toIsoDate(start) === this.toIsoDate(end);

    if (isHalfDayStart && startIsWorking) {
      totalDays -= 0.5;
      workingDays -= 0.5;
    }
    // A single-day request cannot be a half-day on both ends; guard against it.
    if (isHalfDayEnd && endIsWorking && !sameDay) {
      totalDays -= 0.5;
      workingDays -= 0.5;
    }

    return {
      totalDays: Math.max(0, totalDays),
      workingDays: Math.max(0, workingDays),
      weekends,
      holidays: holidayCount,
    };
  }

  private isWorkingDay(d: Date, holidayDates: ReadonlySet<string>): boolean {
    const day = getUtcCalendarWeekday(d);
    if (day === 0 || day === 6) {
      return false;
    }
    return !holidayDates.has(this.toIsoDate(d));
  }

  private parseDate(value: Date | string): Date {
    try {
      return toUtcCalendarDate(value);
    } catch {
      throw new BadRequestException(`Invalid date: ${String(value)}`);
    }
  }

  private toIsoDate(value: Date | string): string {
    return toIsoCalendarDate(value);
  }
}
