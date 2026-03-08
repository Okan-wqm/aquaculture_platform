import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ClockInCommand } from '../commands/clock-in.command';
import {
  AttendanceRecord,
  AttendanceStatus,
  ApprovalStatus,
  ClockMethod,
  convertLocalToUtc,
  isValidTimezone,
  getTimezoneOffset,
} from '../entities/attendance-record.entity';
import { Schedule, ScheduleStatus } from '../entities/schedule.entity';
import { Shift } from '../entities/shift.entity';
import { Employee, EmployeeStatus } from '../../hr/entities/employee.entity';
import { EmployeeClockedInEvent } from '../events/attendance.events';

/** Default timezone if none specified */
const DEFAULT_TIMEZONE = 'UTC';

/**
 * Safely parse time string in HH:mm format with validation
 * Returns [hours, minutes] or [0, 0] for invalid format (with logging)
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

@CommandHandler(ClockInCommand)
export class ClockInHandler implements ICommandHandler<ClockInCommand> {
  private readonly logger = new Logger(ClockInHandler.name);

  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    private readonly eventBus: EventBus,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ClockInCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, employeeId, method, location, remarks, workAreaId, timezone: commandTimezone } = command;

    // Current time in UTC for storage - compute before parallel reads so all reads
    // share the same reference point.
    const nowUtc = new Date();

    // Run all three read queries concurrently before opening the transaction.
    // READ COMMITTED isolation means ordering these reads serially provides no
    // additional correctness guarantee; parallelising removes ~2 round-trip latencies
    // from the hot clock-in path.
    const [employee, , schedule] = await Promise.all([
      this.employeeRepository.findOne({
        where: { id: employeeId, tenantId, isDeleted: false },
      }),
      // existingRecord placeholder – re-checked inside the transaction to close the TOCTOU window
      Promise.resolve(null),
      this.scheduleRepository.findOne({
        where: { tenantId, employeeId, status: ScheduleStatus.ACTIVE, isDeleted: false },
        relations: ['shift'],
      }),
    ]);

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    // Prevent terminated or suspended employees from clocking in
    if (
      employee.status === EmployeeStatus.TERMINATED ||
      employee.status === EmployeeStatus.SUSPENDED
    ) {
      throw new BadRequestException(
        `Employee with status '${employee.status}' cannot clock in`,
      );
    }

    // Determine timezone: use command timezone, employee timezone, or default to UTC
    const timezone = commandTimezone && isValidTimezone(commandTimezone)
      ? commandTimezone
      : (employee.timezone && isValidTimezone(employee.timezone) ? employee.timezone : DEFAULT_TIMEZONE);

    // Calculate today's date in the employee's local timezone for record lookup
    const tzOffset = getTimezoneOffset(timezone, nowUtc);
    const localNow = new Date(nowUtc.getTime() - tzOffset * 60000);
    const today = new Date(localNow);
    today.setHours(0, 0, 0, 0);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Re-check for existing clock-in inside the transaction to prevent double clock-in race
      const existingRecord = await queryRunner.manager.findOne(AttendanceRecord, {
        where: {
          tenantId,
          employeeId,
          date: today,
          isDeleted: false,
        },
      });

      if (existingRecord && existingRecord.clockIn) {
        throw new BadRequestException('Employee has already clocked in today');
      }

      let lateMinutes = 0;
      let status: AttendanceStatus = AttendanceStatus.PRESENT;
      let isScheduled = true;

      // Calculate if late based on shift (using local time for comparison)
      if (schedule?.shift) {
        const shift = schedule.shift;
        // Safely parse shift start/end time with validation
        const [shiftHours, shiftMinutes] = safeParseTime(shift.startTime);
        const shiftStartLocal = new Date(today);
        shiftStartLocal.setHours(shiftHours, shiftMinutes, 0, 0);

        const [endHours, endMinutes] = safeParseTime(shift.endTime);
        const shiftEndLocal = new Date(today);
        shiftEndLocal.setHours(endHours, endMinutes, 0, 0);
        // Handle overnight shifts
        if (shift.crossesMidnight && shiftEndLocal <= shiftStartLocal) {
          shiftEndLocal.setDate(shiftEndLocal.getDate() + 1);
        }

        // Convert to UTC for comparison
        const shiftStartUtc = convertLocalToUtc(shiftStartLocal, timezone);
        const shiftEndUtc = convertLocalToUtc(shiftEndLocal, timezone);

        // Time window validation: earliest allowed = shiftStart - earlyClockInMinutes
        // latest allowed = shiftEnd + lateClockOutMinutes
        const earlyClockIn = shift.earlyClockInMinutes ?? 60;
        const lateClockOut = shift.lateClockOutMinutes ?? 300;
        const windowStart = new Date(shiftStartUtc.getTime() - earlyClockIn * 60000);
        const windowEnd = new Date(shiftEndUtc.getTime() + lateClockOut * 60000);

        if (nowUtc < windowStart || nowUtc > windowEnd) {
          const windowStartLocal = new Date(windowStart.getTime() - getTimezoneOffset(timezone, windowStart) * 60000);
          const windowEndLocal = new Date(windowEnd.getTime() - getTimezoneOffset(timezone, windowEnd) * 60000);
          throw new BadRequestException(
            `Clock-in is only allowed between ${windowStartLocal.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} and ${windowEndLocal.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
          );
        }

        const graceEndUtc = new Date(shiftStartUtc.getTime() + (shift.graceMinutes || 0) * 60000);

        if (nowUtc > graceEndUtc) {
          lateMinutes = Math.floor((nowUtc.getTime() - shiftStartUtc.getTime()) / 60000);
          status = AttendanceStatus.LATE;
        }
      } else {
        // No shift assigned - employee can still clock in but marked as unscheduled
        isScheduled = false;
      }

      // Determine if offshore
      const isOffshore = workAreaId ? true : employee.personnelCategory === 'offshore';

      let savedRecord: AttendanceRecord;

      // Create or update attendance record
      // All times are stored in UTC with timezone field for local conversion
      if (existingRecord) {
        // Update existing record (created by schedule)
        existingRecord.clockIn = nowUtc; // Store in UTC
        existingRecord.timezone = timezone;
        existingRecord.clockInMethod = method;
        existingRecord.clockInLocation = location;
        existingRecord.status = status;
        existingRecord.lateMinutes = lateMinutes;
        existingRecord.isOffshore = isOffshore;
        existingRecord.workAreaId = workAreaId;
        existingRecord.remarks = remarks;
        existingRecord.updatedBy = userId;

        savedRecord = await queryRunner.manager.save(AttendanceRecord, existingRecord);
      } else {
        // Create new attendance record
        const effectiveRemarks = !isScheduled
          ? (remarks ? `[Unscheduled] ${remarks}` : '[Unscheduled]')
          : remarks;
        const attendanceRecord = queryRunner.manager.create(AttendanceRecord, {
          tenantId,
          employeeId,
          departmentId: employee.departmentHrId,
          shiftId: schedule?.shiftId,
          date: today,
          clockIn: nowUtc, // Store in UTC
          timezone, // Store timezone for local time conversion
          clockInMethod: method,
          clockInLocation: location,
          status,
          lateMinutes,
          approvalStatus: !isScheduled ? ApprovalStatus.PENDING_REVIEW : (lateMinutes > 0 ? ApprovalStatus.PENDING_REVIEW : ApprovalStatus.AUTO_APPROVED),
          isOffshore,
          workAreaId,
          remarks: effectiveRemarks,
          createdBy: userId,
          updatedBy: userId,
        });

        savedRecord = await queryRunner.manager.save(AttendanceRecord, attendanceRecord);
      }

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(new EmployeeClockedInEvent(savedRecord)).catch((err: unknown) => {
        this.logger.warn(`Failed to publish EmployeeClockedInEvent: ${err instanceof Error ? err.message : String(err)}`);
      });

      return savedRecord;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
