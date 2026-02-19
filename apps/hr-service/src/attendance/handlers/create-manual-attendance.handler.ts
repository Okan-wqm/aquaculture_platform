import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CreateManualAttendanceCommand } from '../commands/create-manual-attendance.command';
import {
  AttendanceRecord,
  AttendanceStatus,
  ApprovalStatus,
  ClockMethod,
  convertLocalToUtc,
  isValidTimezone,
} from '../entities/attendance-record.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { Shift } from '../entities/shift.entity';

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

@CommandHandler(CreateManualAttendanceCommand)
export class CreateManualAttendanceHandler implements ICommandHandler<CreateManualAttendanceCommand> {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
  ) {}

  async execute(command: CreateManualAttendanceCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, employeeId, date, clockIn, clockOut, reason, shiftId } = command;

    // Validate employee
    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    const recordDate = new Date(date);
    recordDate.setHours(0, 0, 0, 0);

    // Check for existing record on this date
    const existingRecord = await this.attendanceRepository.findOne({
      where: {
        tenantId,
        employeeId,
        date: recordDate,
        isDeleted: false,
      },
    });

    if (existingRecord) {
      throw new BadRequestException(`Attendance record already exists for ${date}`);
    }

    // Validate shift if provided
    let shift: Shift | null = null;
    if (shiftId) {
      shift = await this.shiftRepository.findOne({
        where: { id: shiftId, tenantId, isDeleted: false },
      });
      if (!shift) {
        throw new NotFoundException(`Shift with ID ${shiftId} not found`);
      }
    }

    // Resolve the timezone to use for shift comparisons
    const timezone =
      employee.timezone && isValidTimezone(employee.timezone)
        ? employee.timezone
        : 'UTC';

    // Parse clock times (assumed to be UTC timestamps from the command)
    const clockInTime = clockIn ? new Date(clockIn) : undefined;
    const clockOutTime = clockOut ? new Date(clockOut) : undefined;

    // Calculate worked minutes
    let workedMinutes = 0;
    let lateMinutes = 0;
    let earlyLeaveMinutes = 0;
    let status: AttendanceStatus = AttendanceStatus.PRESENT;

    if (clockInTime && clockOutTime) {
      workedMinutes = Math.floor((clockOutTime.getTime() - clockInTime.getTime()) / 60000);

      if (shift) {
        // Build shift start in the employee's LOCAL timezone, then convert to UTC
        // for an apples-to-apples comparison with the UTC clock-in/out times.
        const [shiftStartHours, shiftStartMins] = safeParseTime(shift.startTime);
        const shiftStartLocal = new Date(recordDate);
        shiftStartLocal.setHours(shiftStartHours, shiftStartMins, 0, 0);
        const shiftStartUtc = convertLocalToUtc(shiftStartLocal, timezone);

        if (clockInTime > shiftStartUtc) {
          lateMinutes = Math.floor((clockInTime.getTime() - shiftStartUtc.getTime()) / 60000);
          if (lateMinutes > (shift.graceMinutes || 0)) {
            status = AttendanceStatus.LATE;
          }
        }

        // Build shift end in the employee's LOCAL timezone, then convert to UTC.
        const [shiftEndHours, shiftEndMins] = safeParseTime(shift.endTime);
        const shiftEndLocal = new Date(recordDate);
        shiftEndLocal.setHours(shiftEndHours, shiftEndMins, 0, 0);

        if (shift.crossesMidnight) {
          shiftEndLocal.setDate(shiftEndLocal.getDate() + 1);
        } else {
          // If end time is numerically before start time on a 24-hour clock it crosses midnight
          const startTotal = shiftStartHours * 60 + shiftStartMins;
          const endTotal = shiftEndHours * 60 + shiftEndMins;
          if (endTotal < startTotal) {
            shiftEndLocal.setDate(shiftEndLocal.getDate() + 1);
          }
        }

        const shiftEndUtc = convertLocalToUtc(shiftEndLocal, timezone);

        if (clockOutTime < shiftEndUtc) {
          earlyLeaveMinutes = Math.floor((shiftEndUtc.getTime() - clockOutTime.getTime()) / 60000);
          if (earlyLeaveMinutes > 0) {
            status = status === AttendanceStatus.LATE ? AttendanceStatus.LATE : AttendanceStatus.EARLY_LEAVE;
          }
        }
      }
    } else if (!clockInTime && !clockOutTime) {
      status = AttendanceStatus.ABSENT;
    }

    // Create manual attendance record
    const attendanceRecord = this.attendanceRepository.create({
      tenantId,
      employeeId,
      departmentId: employee.departmentHrId,
      shiftId: shift?.id,
      date: recordDate,
      clockIn: clockInTime,
      clockOut: clockOutTime,
      clockInMethod: clockInTime ? ClockMethod.MANUAL : undefined,
      clockOutMethod: clockOutTime ? ClockMethod.MANUAL : undefined,
      status,
      workedMinutes: Math.max(0, workedMinutes - (shift?.breakMinutes || 0)),
      lateMinutes,
      earlyLeaveMinutes,
      breakMinutes: shift?.breakMinutes || 0,
      approvalStatus: ApprovalStatus.PENDING_REVIEW,
      reason,
      isManualEntry: true,
      createdBy: userId,
      updatedBy: userId,
    });

    return this.attendanceRepository.save(attendanceRecord);
  }
}
