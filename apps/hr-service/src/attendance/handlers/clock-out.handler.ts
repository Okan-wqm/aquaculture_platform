import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ClockOutCommand } from '../commands/clock-out.command';
import {
  AttendanceRecord,
  AttendanceStatus,
  ApprovalStatus,
  convertLocalToUtc,
  getTimezoneOffset,
} from '../entities/attendance-record.entity';
import { Shift } from '../entities/shift.entity';
import { EmployeeClockedOutEvent } from '../events/attendance.events';

/** Default timezone if none specified */
const DEFAULT_TIMEZONE = 'UTC';

/**
 * Safely parse time string in HH:mm format with validation
 * Returns [hours, minutes] or [0, 0] for invalid format
 */
function safeParseTime(time: string | undefined): [number, number] {
  if (!time || typeof time !== 'string') {
    return [0, 0];
  }
  const parts = time.split(':');
  if (parts.length !== 2) {
    return [0, 0];
  }
  const hours = parseInt(parts[0]!, 10);
  const minutes = parseInt(parts[1]!, 10);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return [0, 0];
  }
  return [hours, minutes];
}

@CommandHandler(ClockOutCommand)
export class ClockOutHandler implements ICommandHandler<ClockOutCommand> {
  private readonly logger = new Logger(ClockOutHandler.name);

  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
    private readonly eventBus: EventBus,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ClockOutCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, employeeId, method, location, remarks, breakStartTime, breakEndTime } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Current time in UTC
      const nowUtc = new Date();

      // Find today's attendance record with clock-in
      // We need to search for records that could be from today or yesterday (for overnight shifts)
      const attendanceRecord = await this.findActiveAttendanceRecord(queryRunner, tenantId, employeeId);

      if (!attendanceRecord) {
        throw new NotFoundException('No attendance record found for today. Please clock in first.');
      }

      if (!attendanceRecord.clockIn) {
        throw new BadRequestException('Cannot clock out without clocking in first');
      }

      if (attendanceRecord.clockOut) {
        throw new BadRequestException('Employee has already clocked out today');
      }

      // Use the timezone from the attendance record (set during clock-in)
      const timezone = attendanceRecord.timezone || DEFAULT_TIMEZONE;
      const tzOffset = getTimezoneOffset(timezone, nowUtc);

      const clockInTime = new Date(attendanceRecord.clockIn);

      // Calculate break time
      let actualBreakMinutes = 0;
      let breakStartUtc: Date | undefined;
      let breakEndUtc: Date | undefined;

      if (breakStartTime && breakEndTime) {
        // Convert provided break times to UTC if they're local times
        breakStartUtc = new Date(breakStartTime);
        breakEndUtc = new Date(breakEndTime);
        actualBreakMinutes = Math.max(0, Math.floor((breakEndUtc.getTime() - breakStartUtc.getTime()) / 60000));
      }

      // Calculate total worked minutes using the static helper
      // This properly handles overnight shifts since it uses direct time comparison
      const grossWorkedMinutes = AttendanceRecord.calculateWorkedMinutes(clockInTime, nowUtc, 0);

      // Get shift details if available
      let earlyLeaveMinutes = 0;
      let overtimeMinutes = 0;
      let shift: Shift | null = null;
      let shiftBreakMinutes = 0;

      if (attendanceRecord.shiftId) {
        // SECURITY: Include tenantId to ensure tenant isolation
        shift = await queryRunner.manager.findOne(Shift, {
          where: { id: attendanceRecord.shiftId, tenantId },
        });
      }

      if (shift) {
        shiftBreakMinutes = shift.breakMinutes || 0;

        // Calculate shift end time in UTC
        const shiftEndUtc = this.calculateShiftEndUtc(
          attendanceRecord.date,
          shift,
          timezone
        );

        // Calculate early leave (comparing UTC times)
        if (nowUtc < shiftEndUtc) {
          earlyLeaveMinutes = Math.floor((shiftEndUtc.getTime() - nowUtc.getTime()) / 60000);
        }

        // Calculate overtime (comparing UTC times)
        if (nowUtc > shiftEndUtc) {
          overtimeMinutes = Math.floor((nowUtc.getTime() - shiftEndUtc.getTime()) / 60000);
        }
      }

      // Use actual recorded break time if available, otherwise use shift's default break
      const finalBreakMinutes = actualBreakMinutes > 0 ? actualBreakMinutes : shiftBreakMinutes;

      // Net worked minutes = gross worked - break time
      const netWorkedMinutes = Math.max(0, grossWorkedMinutes - finalBreakMinutes);

      // Update status based on calculations
      let status = attendanceRecord.status;
      if (earlyLeaveMinutes > 0) {
        status = status === AttendanceStatus.LATE ? AttendanceStatus.LATE : AttendanceStatus.EARLY_LEAVE;
      }

      // Update attendance record with UTC times
      attendanceRecord.clockOut = nowUtc;
      attendanceRecord.clockOutMethod = method;
      attendanceRecord.clockOutLocation = location;
      attendanceRecord.workedMinutes = netWorkedMinutes;
      attendanceRecord.overtimeMinutes = overtimeMinutes;
      attendanceRecord.earlyLeaveMinutes = earlyLeaveMinutes;
      attendanceRecord.breakMinutes = finalBreakMinutes;
      attendanceRecord.breakStartTime = breakStartUtc;
      attendanceRecord.breakEndTime = breakEndUtc;
      attendanceRecord.status = status;

      // If there were any irregularities, set for review
      if (earlyLeaveMinutes > 0 || attendanceRecord.lateMinutes > 0) {
        attendanceRecord.approvalStatus = ApprovalStatus.PENDING_REVIEW;
      }

      if (remarks) {
        attendanceRecord.remarks = attendanceRecord.remarks
          ? `${attendanceRecord.remarks}; ${remarks}`
          : remarks;
      }

      attendanceRecord.updatedBy = userId;

      const savedRecord = await queryRunner.manager.save(AttendanceRecord, attendanceRecord);

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(new EmployeeClockedOutEvent(savedRecord)).catch((err: unknown) => {
        this.logger.warn(`Failed to publish EmployeeClockedOutEvent: ${err instanceof Error ? err.message : String(err)}`);
      });

      return savedRecord;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Find an active attendance record for the employee
   * Handles overnight shifts by checking both today and yesterday's records
   */
  private async findActiveAttendanceRecord(
    queryRunner: import('typeorm').QueryRunner,
    tenantId: string,
    employeeId: string
  ): Promise<AttendanceRecord | null> {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // First try to find today's record
    let record = await queryRunner.manager.findOne(AttendanceRecord, {
      where: {
        tenantId,
        employeeId,
        date: today,
        isDeleted: false,
      },
      relations: ['shift'],
    });

    // If found and has clock-in but no clock-out, return it
    if (record && record.clockIn && !record.clockOut) {
      return record;
    }

    // Check yesterday's record for overnight shifts
    const yesterdayRecord = await queryRunner.manager.findOne(AttendanceRecord, {
      where: {
        tenantId,
        employeeId,
        date: yesterday,
        isDeleted: false,
      },
      relations: ['shift'],
    });

    // If yesterday's record exists with clock-in but no clock-out, it's an overnight shift
    if (yesterdayRecord && yesterdayRecord.clockIn && !yesterdayRecord.clockOut) {
      // Verify it's actually an overnight shift by checking if shift crosses midnight
      if (yesterdayRecord.shiftId) {
        // SECURITY: Include tenantId to ensure tenant isolation
        const shift = await queryRunner.manager.findOne(Shift, {
          where: { id: yesterdayRecord.shiftId, tenantId },
        });
        if (shift?.crossesMidnight) {
          return yesterdayRecord;
        }
      }
      // Even if shift doesn't explicitly cross midnight, if clock-in was yesterday
      // and we're still within reasonable hours (before noon today), consider it overnight
      const clockInTime = new Date(yesterdayRecord.clockIn);
      const hoursSinceClockIn = (now.getTime() - clockInTime.getTime()) / (1000 * 60 * 60);
      if (hoursSinceClockIn < 16) { // Less than 16 hours since clock-in
        return yesterdayRecord;
      }
    }

    // Return today's record even if it doesn't have clock-in (will be handled by caller)
    return record;
  }

  /**
   * Calculate the shift end time in UTC
   * Properly handles overnight shifts that cross midnight
   */
  private calculateShiftEndUtc(
    attendanceDate: Date,
    shift: Shift,
    timezone: string
  ): Date {
    const [shiftEndHours, shiftEndMinutes] = safeParseTime(shift.endTime);

    // Create shift end in local time
    const shiftEndLocal = new Date(attendanceDate);
    shiftEndLocal.setHours(shiftEndHours, shiftEndMinutes, 0, 0);

    // For overnight shifts, add a day to the end time
    if (shift.crossesMidnight) {
      shiftEndLocal.setDate(shiftEndLocal.getDate() + 1);
    } else {
      // Additional check: if end time is less than start time, it must cross midnight
      const [shiftStartHours, shiftStartMinutes] = safeParseTime(shift.startTime);
      const startMinutesTotal = shiftStartHours * 60 + shiftStartMinutes;
      const endMinutesTotal = shiftEndHours * 60 + shiftEndMinutes;

      if (endMinutesTotal < startMinutesTotal) {
        // End time is before start time in a 24-hour clock, so it crosses midnight
        shiftEndLocal.setDate(shiftEndLocal.getDate() + 1);
      }
    }

    // Convert to UTC
    return convertLocalToUtc(shiftEndLocal, timezone);
  }
}
