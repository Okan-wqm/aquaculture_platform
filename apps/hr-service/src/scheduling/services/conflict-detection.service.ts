import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { LeaveRequest, LeaveRequestStatus } from '../../leave/entities/leave-request.entity';
import { Holiday } from '../entities/holiday.entity';

export enum ConflictType {
  LEAVE_OVERLAP = 'leave_overlap',
  HOLIDAY_SCHEDULED = 'holiday_scheduled',
  MAX_HOURS_EXCEEDED = 'max_hours_exceeded',
  MAX_CONSECUTIVE_DAYS = 'max_consecutive_days',
  INSUFFICIENT_REST = 'insufficient_rest',
  DOUBLE_BOOKING = 'double_booking',
}

export enum ConflictSeverity {
  ERROR = 'error',
  WARNING = 'warning',
  INFO = 'info',
}

export interface SchedulingConflict {
  type: ConflictType;
  severity: ConflictSeverity;
  message: string;
  date?: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class ConflictDetectionService {
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(SchedulingSettings)
    private readonly settingsRepository: Repository<SchedulingSettings>,
    @InjectRepository(Holiday)
    private readonly holidayRepository: Repository<Holiday>,
  ) {}

  /**
   * Detect all conflicts in weekly plan entries
   */
  async detectConflicts(
    tenantId: string,
    employeeId: string,
    entries: WeeklyPlanEntry[],
    weekStart: Date,
    weekEnd: Date,
  ): Promise<SchedulingConflict[]> {
    const conflicts: SchedulingConflict[] = [];
    const settings = await this.settingsRepository.findOne({ where: { tenantId } });

    // Check for leave overlaps
    const leaveConflicts = await this.checkLeaveOverlaps(tenantId, employeeId, entries, weekStart, weekEnd);
    conflicts.push(...leaveConflicts);

    // Check for holiday conflicts
    const holidayConflicts = await this.checkHolidayOverlaps(tenantId, entries, weekStart, weekEnd);
    conflicts.push(...holidayConflicts);

    // Check max weekly hours
    const hoursConflicts = this.checkMaxHours(entries, settings);
    conflicts.push(...hoursConflicts);

    // Check consecutive work days
    const consecutiveConflicts = this.checkConsecutiveDays(entries, settings);
    conflicts.push(...consecutiveConflicts);

    // Check minimum rest between shifts
    const restConflicts = this.checkMinimumRest(entries, settings);
    conflicts.push(...restConflicts);

    return conflicts;
  }

  /**
   * Check for conflicts with approved leave requests
   */
  async checkLeaveOverlaps(
    tenantId: string,
    employeeId: string,
    entries: WeeklyPlanEntry[],
    weekStart: Date,
    weekEnd: Date,
  ): Promise<SchedulingConflict[]> {
    const conflicts: SchedulingConflict[] = [];

    // Get approved leave requests for this period
    const leaveRequests = await this.leaveRequestRepository
      .createQueryBuilder('lr')
      .where('lr.tenantId = :tenantId', { tenantId })
      .andWhere('lr.employeeId = :employeeId', { employeeId })
      .andWhere('lr.status = :status', { status: LeaveRequestStatus.APPROVED })
      .andWhere('lr.startDate <= :weekEnd AND lr.endDate >= :weekStart', {
        weekStart,
        weekEnd,
      })
      .getMany();

    // Build date set of leave days
    const leaveDates = new Set<string>();
    for (const lr of leaveRequests) {
      const start = new Date(lr.startDate);
      const end = new Date(lr.endDate);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        leaveDates.add(d.toISOString().split('T')[0]!);
      }
    }

    // Check each work entry against leave dates
    for (const entry of entries) {
      if (entry.entryType === WeeklyPlanEntryType.WORK || entry.entryType === WeeklyPlanEntryType.TRAINING) {
        const entryDateStr = new Date(entry.date).toISOString().split('T')[0]!;
        if (leaveDates.has(entryDateStr)) {
          conflicts.push({
            type: ConflictType.LEAVE_OVERLAP,
            severity: ConflictSeverity.ERROR,
            message: `Work scheduled on ${entryDateStr} conflicts with approved leave`,
            date: entryDateStr,
            details: { entryId: entry.id },
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Check for conflicts with public holidays
   */
  async checkHolidayOverlaps(
    tenantId: string,
    entries: WeeklyPlanEntry[],
    weekStart: Date,
    weekEnd: Date,
  ): Promise<SchedulingConflict[]> {
    const conflicts: SchedulingConflict[] = [];

    // Get active holidays for this period that affect scheduling
    const holidays = await this.holidayRepository
      .createQueryBuilder('h')
      .where('h.tenantId = :tenantId', { tenantId })
      .andWhere('h.isActive = true')
      .andWhere('h.affectsScheduling = true')
      .andWhere('h.startDate <= :weekEnd AND h.endDate >= :weekStart', {
        weekStart,
        weekEnd,
      })
      .getMany();

    if (holidays.length === 0) {
      return conflicts;
    }

    // Build date set of holiday days
    const holidayDates = new Map<string, Holiday>();
    for (const holiday of holidays) {
      const start = new Date(holiday.startDate);
      const end = new Date(holiday.endDate);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0]!;
        holidayDates.set(dateStr, holiday);
      }
    }

    // Check each work entry against holiday dates
    for (const entry of entries) {
      if (entry.entryType === WeeklyPlanEntryType.WORK || entry.entryType === WeeklyPlanEntryType.TRAINING) {
        const entryDateStr = new Date(entry.date).toISOString().split('T')[0]!;
        const holiday = holidayDates.get(entryDateStr);

        if (holiday) {
          const holidayName = holiday.localName || holiday.name;
          conflicts.push({
            type: ConflictType.HOLIDAY_SCHEDULED,
            severity: ConflictSeverity.WARNING,
            message: `Work scheduled on ${entryDateStr} falls on holiday: ${holidayName}`,
            date: entryDateStr,
            details: {
              entryId: entry.id,
              holidayId: holiday.id,
              holidayName,
              holidayType: holiday.type,
              isPaidLeave: holiday.isPaidLeave,
            },
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Check if max weekly hours is exceeded
   */
  checkMaxHours(entries: WeeklyPlanEntry[], settings?: SchedulingSettings | null): SchedulingConflict[] {
    const conflicts: SchedulingConflict[] = [];

    let totalMinutes = 0;
    for (const entry of entries) {
      if (entry.entryType === WeeklyPlanEntryType.WORK || entry.entryType === WeeklyPlanEntryType.TRAINING) {
        totalMinutes += entry.plannedMinutes;
      }
    }

    const standardMinutes = settings?.standardWeeklyMinutes ?? 2700;
    const maxOvertimeMinutes = settings?.maxOvertimeMinutesPerWeek ?? 720;
    const maxTotalMinutes = standardMinutes + maxOvertimeMinutes;

    if (totalMinutes > maxTotalMinutes) {
      const totalHours = Math.round(totalMinutes / 60 * 10) / 10;
      const maxHours = Math.round(maxTotalMinutes / 60 * 10) / 10;

      conflicts.push({
        type: ConflictType.MAX_HOURS_EXCEEDED,
        severity: ConflictSeverity.ERROR,
        message: `Total weekly hours (${totalHours}h) exceeds maximum allowed (${maxHours}h)`,
        details: {
          totalMinutes,
          maxMinutes: maxTotalMinutes,
        },
      });
    } else if (totalMinutes > standardMinutes) {
      const overtimeMinutes = totalMinutes - standardMinutes;
      const overtimeHours = Math.round(overtimeMinutes / 60 * 10) / 10;

      conflicts.push({
        type: ConflictType.MAX_HOURS_EXCEEDED,
        severity: ConflictSeverity.WARNING,
        message: `Schedule includes ${overtimeHours}h of overtime`,
        details: {
          totalMinutes,
          standardMinutes,
          overtimeMinutes,
        },
      });
    }

    return conflicts;
  }

  /**
   * Check for max consecutive work days violation
   */
  checkConsecutiveDays(entries: WeeklyPlanEntry[], settings?: SchedulingSettings | null): SchedulingConflict[] {
    const conflicts: SchedulingConflict[] = [];
    const maxConsecutive = settings?.maxConsecutiveWorkDays ?? 6;

    // Sort entries by date
    const sortedEntries = [...entries].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    let consecutiveCount = 0;
    let startDate: string | null = null;

    for (const entry of sortedEntries) {
      if (entry.entryType === WeeklyPlanEntryType.WORK || entry.entryType === WeeklyPlanEntryType.TRAINING) {
        if (consecutiveCount === 0) {
          startDate = new Date(entry.date).toISOString().split('T')[0]!;
        }
        consecutiveCount++;
      } else {
        // Reset on off/leave day
        if (consecutiveCount > maxConsecutive) {
          conflicts.push({
            type: ConflictType.MAX_CONSECUTIVE_DAYS,
            severity: ConflictSeverity.WARNING,
            message: `${consecutiveCount} consecutive work days starting ${startDate} exceeds maximum of ${maxConsecutive}`,
            date: startDate!,
            details: { consecutiveCount, maxConsecutive },
          });
        }
        consecutiveCount = 0;
        startDate = null;
      }
    }

    // Check final streak
    if (consecutiveCount > maxConsecutive) {
      conflicts.push({
        type: ConflictType.MAX_CONSECUTIVE_DAYS,
        severity: ConflictSeverity.WARNING,
        message: `${consecutiveCount} consecutive work days starting ${startDate} exceeds maximum of ${maxConsecutive}`,
        date: startDate!,
        details: { consecutiveCount, maxConsecutive },
      });
    }

    return conflicts;
  }

  /**
   * Check minimum rest time between shifts
   * Note: This is a simplified check within the same week
   */
  checkMinimumRest(entries: WeeklyPlanEntry[], settings?: SchedulingSettings | null): SchedulingConflict[] {
    const conflicts: SchedulingConflict[] = [];
    const minRestMinutes = settings?.minRestMinutesBetweenShifts ?? 660; // 11 hours

    // Sort entries by date
    const sortedEntries = [...entries]
      .filter(e => e.entryType === WeeklyPlanEntryType.WORK && e.shiftId)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    for (let i = 0; i < sortedEntries.length - 1; i++) {
      const currentEntry = sortedEntries[i]!;
      const nextEntry = sortedEntries[i + 1]!;

      // If both entries have end/start times, check rest period
      const currentEndTime = currentEntry.plannedEndTime || currentEntry.shift?.endTime;
      const nextStartTime = nextEntry.plannedStartTime || nextEntry.shift?.startTime;

      if (currentEndTime && nextStartTime) {
        // Calculate rest minutes (simplified - assumes consecutive days)
        const currentDate = new Date(currentEntry.date);
        const nextDate = new Date(nextEntry.date);
        const daysDiff = (nextDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24);

        if (daysDiff === 1) {
          // Consecutive days - calculate actual rest
          const [endHours, endMins] = currentEndTime.split(':').map(Number);
          const [startHours, startMins] = nextStartTime.split(':').map(Number);

          const endMinutes = endHours! * 60 + endMins!;
          const startMinutes = startHours! * 60 + startMins!;
          const restMinutes = (24 * 60 - endMinutes) + startMinutes;

          if (restMinutes < minRestMinutes) {
            const restHours = Math.round(restMinutes / 60 * 10) / 10;
            const minRestHours = Math.round(minRestMinutes / 60 * 10) / 10;

            conflicts.push({
              type: ConflictType.INSUFFICIENT_REST,
              severity: ConflictSeverity.WARNING,
              message: `Only ${restHours}h rest between shifts on ${currentDate.toISOString().split('T')[0]} and ${nextDate.toISOString().split('T')[0]}. Minimum is ${minRestHours}h`,
              date: nextDate.toISOString().split('T')[0]!,
              details: {
                restMinutes,
                minRestMinutes,
                previousShiftEnd: currentEndTime,
                nextShiftStart: nextStartTime,
              },
            });
          }
        }
      }
    }

    return conflicts;
  }
}
