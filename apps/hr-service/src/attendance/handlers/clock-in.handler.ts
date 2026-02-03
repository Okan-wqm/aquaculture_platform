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
import { Employee } from '../../hr/entities/employee.entity';
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

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate employee
      const employee = await queryRunner.manager.findOne(Employee, {
        where: { id: employeeId, tenantId, isDeleted: false },
      });

      if (!employee) {
        throw new NotFoundException(`Employee with ID ${employeeId} not found`);
      }

      // Determine timezone: use command timezone, employee timezone, or default to UTC
      const timezone = commandTimezone && isValidTimezone(commandTimezone)
        ? commandTimezone
        : (employee.timezone && isValidTimezone(employee.timezone) ? employee.timezone : DEFAULT_TIMEZONE);

      // Current time in UTC for storage
      const nowUtc = new Date();

      // Calculate today's date in the employee's local timezone for record lookup
      const tzOffset = getTimezoneOffset(timezone, nowUtc);
      const localNow = new Date(nowUtc.getTime() - tzOffset * 60000);
      const today = new Date(localNow);
      today.setHours(0, 0, 0, 0);

      // Check for existing clock-in today
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

      // Get employee's schedule for today
      const schedule = await queryRunner.manager.findOne(Schedule, {
        where: {
          tenantId,
          employeeId,
          status: ScheduleStatus.ACTIVE,
          isDeleted: false,
        },
        relations: ['shift'],
      });

      let lateMinutes = 0;
      let status: AttendanceStatus = AttendanceStatus.PRESENT;

      // Calculate if late based on shift (using local time for comparison)
      if (schedule?.shift) {
        // Safely parse shift start time with validation
        const [shiftHours, shiftMinutes] = safeParseTime(schedule.shift.startTime);
        const shiftStartLocal = new Date(today);
        shiftStartLocal.setHours(shiftHours, shiftMinutes, 0, 0);

        // Convert shift start to UTC for comparison
        const shiftStartUtc = convertLocalToUtc(shiftStartLocal, timezone);
        const graceEndUtc = new Date(shiftStartUtc.getTime() + (schedule.shift.graceMinutes || 0) * 60000);

        if (nowUtc > graceEndUtc) {
          lateMinutes = Math.floor((nowUtc.getTime() - shiftStartUtc.getTime()) / 60000);
          status = AttendanceStatus.LATE;
        }
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
          approvalStatus: lateMinutes > 0 ? ApprovalStatus.PENDING_REVIEW : ApprovalStatus.AUTO_APPROVED,
          isOffshore,
          workAreaId,
          remarks,
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
